"""Expose ChatGPT Codex rate limits through a small authenticated HTTP API."""

from __future__ import annotations

import argparse
import asyncio
import copy
import hmac
import json
import logging
import os
import shutil
import signal
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

APP_VERSION = "0.1.0"
LOGGER = logging.getLogger("usage-server")


class UsageServerError(RuntimeError):
    """Raised for configuration or Codex protocol failures."""


def load_env_file(path: Path) -> None:
    """Load a minimal KEY=VALUE env file without overriding exported values."""

    if not path.exists():
        return

    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not key.replace("_", "").isalnum() or not key[0].isalpha():
            raise UsageServerError(f"Invalid environment entry at {path}:{line_number}")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def _positive_int(name: str, default: int) -> int:
    raw_value = os.getenv(name, str(default))
    try:
        value = int(raw_value)
    except ValueError as error:
        raise UsageServerError(f"{name} must be an integer") from error
    if value <= 0:
        raise UsageServerError(f"{name} must be greater than zero")
    return value


def resolve_codex_binary(configured: str | None = None) -> str:
    """Find an executable Codex CLI, including the common user npm location."""

    candidates: list[str] = []
    if configured:
        candidates.append(configured)
    discovered = shutil.which("codex")
    if discovered:
        candidates.append(discovered)
    candidates.extend(
        [
            str(Path.home() / ".local" / "npm" / "bin" / "codex"),
            str(Path.home() / ".local" / "bin" / "codex"),
            "/usr/local/bin/codex",
        ]
    )

    for candidate in candidates:
        expanded = str(Path(candidate).expanduser())
        if os.path.isfile(expanded) and os.access(expanded, os.X_OK):
            return expanded
        resolved = shutil.which(expanded)
        if resolved:
            return resolved

    raise UsageServerError(
        "Codex CLI was not found. Install it or set CODEX_BIN to its executable path."
    )


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    api_token: str
    codex_bin: str
    refresh_seconds: int
    codex_timeout_seconds: int
    limit_id: str

    @classmethod
    def from_environment(cls, *, require_token: bool = True) -> Settings:
        token = os.getenv("USAGE_API_TOKEN", "")
        if require_token and len(token) < 32:
            raise UsageServerError(
                "USAGE_API_TOKEN must contain at least 32 characters. "
                "Generate one with: openssl rand -hex 32"
            )
        port = _positive_int("USAGE_PORT", 8787)
        if port > 65535:
            raise UsageServerError("USAGE_PORT must be no greater than 65535")
        return cls(
            host=os.getenv("USAGE_HOST", "127.0.0.1"),
            port=port,
            api_token=token,
            codex_bin=resolve_codex_binary(os.getenv("CODEX_BIN")),
            refresh_seconds=_positive_int("USAGE_REFRESH_SECONDS", 300),
            codex_timeout_seconds=_positive_int("CODEX_TIMEOUT_SECONDS", 20),
            limit_id=os.getenv("CODEX_LIMIT_ID", "codex"),
        )


async def _read_response(
    process: asyncio.subprocess.Process,
    request_id: int,
    timeout_seconds: int,
) -> dict[str, Any]:
    if process.stdout is None:
        raise UsageServerError("Codex app-server stdout is unavailable")

    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise UsageServerError(f"Timed out waiting for Codex response {request_id}")
        try:
            raw_line = await asyncio.wait_for(process.stdout.readline(), remaining)
        except TimeoutError as error:
            raise UsageServerError(
                f"Timed out waiting for Codex response {request_id}"
            ) from error
        if not raw_line:
            raise UsageServerError(
                f"Codex app-server exited before response {request_id}"
            )
        try:
            message = json.loads(raw_line)
        except json.JSONDecodeError:
            LOGGER.debug("Ignoring non-JSON Codex output")
            continue
        if message.get("id") != request_id:
            continue
        if "error" in message:
            error = message["error"]
            raise UsageServerError(
                f"Codex request {request_id} failed: {error.get('message', error)}"
            )
        result = message.get("result")
        if not isinstance(result, dict):
            raise UsageServerError(f"Codex response {request_id} has no result object")
        return result


async def _query_codex_async(settings: Settings) -> dict[str, Any]:
    process = await asyncio.create_subprocess_exec(
        settings.codex_bin,
        "app-server",
        "--stdio",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    if process.stdin is None:
        raise UsageServerError("Codex app-server stdin is unavailable")

    async def send(message: dict[str, Any]) -> None:
        process.stdin.write(json.dumps(message, separators=(",", ":")).encode() + b"\n")
        await process.stdin.drain()

    try:
        await send(
            {
                "method": "initialize",
                "id": 1,
                "params": {
                    "clientInfo": {
                        "name": "ios_lockscreen_chatgpt_usage",
                        "title": "iOS Lockscreen ChatGPT Usage",
                        "version": APP_VERSION,
                    }
                },
            }
        )
        await _read_response(process, 1, settings.codex_timeout_seconds)
        await send({"method": "initialized", "params": {}})
        await send({"method": "account/rateLimits/read", "id": 2})
        return await _read_response(process, 2, settings.codex_timeout_seconds)
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except TimeoutError:
                process.kill()
                await process.wait()


def query_codex(settings: Settings) -> dict[str, Any]:
    return asyncio.run(_query_codex_async(settings))


def _normalize_window(value: Any) -> dict[str, int | float] | None:
    if not isinstance(value, dict):
        return None
    required = ("usedPercent", "windowDurationMins", "resetsAt")
    if any(not isinstance(value.get(key), (int, float)) for key in required):
        return None
    return {
        "usedPercent": value["usedPercent"],
        "windowDurationMins": int(value["windowDurationMins"]),
        "resetsAt": int(value["resetsAt"]),
    }


def normalize_rate_limits(
    result: dict[str, Any],
    limit_id: str = "codex",
    *,
    now: int | None = None,
) -> dict[str, Any]:
    """Reduce app-server output to the fields needed by the phone widget."""

    rate_limit: Any = None
    by_id = result.get("rateLimitsByLimitId")
    if isinstance(by_id, dict):
        rate_limit = by_id.get(limit_id)
    if not isinstance(rate_limit, dict):
        rate_limit = result.get("rateLimits")
    if not isinstance(rate_limit, dict):
        raise UsageServerError(f"Codex returned no rate limit bucket for {limit_id!r}")

    primary = _normalize_window(rate_limit.get("primary"))
    secondary = _normalize_window(rate_limit.get("secondary"))
    if primary is None and secondary is None:
        raise UsageServerError(
            "Codex returned a rate limit bucket without usable windows"
        )

    return {
        "primary": primary,
        "secondary": secondary,
        "updatedAt": int(time.time()) if now is None else now,
    }


class UsageCache:
    def __init__(self, refresh_seconds: int) -> None:
        self._refresh_seconds = refresh_seconds
        self._lock = threading.Lock()
        self._snapshot: dict[str, Any] | None = None
        self._last_refresh_failed = False

    def record_success(self, snapshot: dict[str, Any]) -> None:
        with self._lock:
            self._snapshot = copy.deepcopy(snapshot)
            self._last_refresh_failed = False

    def record_failure(self) -> None:
        with self._lock:
            self._last_refresh_failed = True

    def snapshot(self) -> dict[str, Any] | None:
        with self._lock:
            if self._snapshot is None:
                return None
            snapshot = copy.deepcopy(self._snapshot)
            snapshot["stale"] = self._last_refresh_failed or (
                time.time() - snapshot["updatedAt"] > self._refresh_seconds * 2
            )
            return snapshot


class UsageRefresher(threading.Thread):
    def __init__(self, settings: Settings, cache: UsageCache) -> None:
        super().__init__(name="usage-refresher", daemon=True)
        self._settings = settings
        self._cache = cache
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        while not self._stop_event.is_set():
            started_at = time.monotonic()
            try:
                raw_result = query_codex(self._settings)
                snapshot = normalize_rate_limits(
                    raw_result,
                    self._settings.limit_id,
                )
                self._cache.record_success(snapshot)
                LOGGER.info("Refreshed ChatGPT usage data")
            except Exception:
                self._cache.record_failure()
                LOGGER.exception("Could not refresh ChatGPT usage data")
            elapsed = time.monotonic() - started_at
            wait_seconds = max(1, self._settings.refresh_seconds - elapsed)
            self._stop_event.wait(wait_seconds)


class UsageHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, settings: Settings, cache: UsageCache) -> None:
        super().__init__((settings.host, settings.port), UsageRequestHandler)
        self.api_token = settings.api_token
        self.usage_cache = cache


class UsageRequestHandler(BaseHTTPRequestHandler):
    server: UsageHTTPServer
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/healthz":
            self._send_json(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "hasSnapshot": self.server.usage_cache.snapshot() is not None,
                },
            )
            return
        if path != "/v1/usage":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self._authorized():
            self._send_json(
                HTTPStatus.UNAUTHORIZED,
                {"error": "unauthorized"},
                extra_headers={"WWW-Authenticate": "Bearer"},
            )
            return
        snapshot = self.server.usage_cache.snapshot()
        if snapshot is None:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "usage_not_ready"},
                extra_headers={"Retry-After": "5"},
            )
            return
        self._send_json(HTTPStatus.OK, snapshot)

    def _authorized(self) -> bool:
        provided = self.headers.get("Authorization", "").encode("utf-8")
        expected = f"Bearer {self.server.api_token}".encode()
        return hmac.compare_digest(provided, expected)

    def _send_json(
        self,
        status: HTTPStatus,
        payload: dict[str, Any],
        *,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for name, value in extra_headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, message: str, *args: Any) -> None:
        LOGGER.info("%s - %s", self.address_string(), message % args)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file",
        type=Path,
        default=Path(".env"),
        help="environment file to load (default: .env)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="query Codex once, print normalized JSON, and exit",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_arguments()
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    load_env_file(args.env_file)
    settings = Settings.from_environment(require_token=not args.once)

    if args.once:
        result = normalize_rate_limits(query_codex(settings), settings.limit_id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    cache = UsageCache(settings.refresh_seconds)
    refresher = UsageRefresher(settings, cache)
    server = UsageHTTPServer(settings, cache)

    def request_shutdown(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    refresher.start()
    LOGGER.info("Listening on http://%s:%d", settings.host, settings.port)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        LOGGER.info("Shutting down")
    finally:
        server.server_close()
        refresher.stop()
        refresher.join(timeout=3)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except UsageServerError as error:
        LOGGER.error("%s", error)
        raise SystemExit(2) from error

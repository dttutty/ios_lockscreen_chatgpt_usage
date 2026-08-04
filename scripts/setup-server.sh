#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$project_dir/.env"
service_name="ios-lockscreen-chatgpt-usage.service"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_file="$unit_dir/$service_name"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

find_codex() {
  local candidate
  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return
  fi
  for candidate in \
    "$HOME/.local/npm/bin/codex" \
    "$HOME/.local/bin/codex" \
    /usr/local/bin/codex; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

port_is_available() {
  python3 - "$1" <<'PY'
import socket
import sys

port = int(sys.argv[1])
with socket.socket() as sock:
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        raise SystemExit(1)
PY
}

read_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$env_file" | tail -n 1
}

command -v uv >/dev/null 2>&1 || fail "uv is required but was not found."
command -v python3 >/dev/null 2>&1 || fail "python3 is required but was not found."
command -v openssl >/dev/null 2>&1 || fail "openssl is required but was not found."
command -v curl >/dev/null 2>&1 || fail "curl is required but was not found."
[[ "$project_dir" != *[[:space:]]* ]] || \
  fail "The project path must not contain whitespace for the generated systemd unit."

uv_bin="$(command -v uv)"
codex_bin="$(find_codex)" || fail "Codex CLI was not found. Install it before continuing."

if [[ ! -f "$env_file" ]]; then
  selected_port="${USAGE_PORT:-8787}"
  while ! port_is_available "$selected_port"; do
    selected_port=$((selected_port + 1))
    if ((selected_port > 8899)); then
      fail "Could not find an available port between 8787 and 8899."
    fi
  done

  api_token="$(openssl rand -hex 32)"
  old_umask="$(umask)"
  umask 077
  {
    printf 'USAGE_API_TOKEN=%s\n' "$api_token"
    printf 'CODEX_BIN=%s\n' "$codex_bin"
    printf 'USAGE_HOST=127.0.0.1\n'
    printf 'USAGE_PORT=%s\n' "$selected_port"
    printf 'USAGE_REFRESH_SECONDS=300\n'
    printf 'CODEX_TIMEOUT_SECONDS=20\n'
    printf 'CODEX_LIMIT_ID=codex\n'
  } > "$env_file"
  umask "$old_umask"
  printf 'Created %s with mode 600. The Token was not printed.\n' "$env_file"
else
  chmod 600 "$env_file"
  printf 'Keeping existing %s and tightening its mode to 600.\n' "$env_file"
fi

selected_port="$(read_env_value USAGE_PORT)"
api_token="$(read_env_value USAGE_API_TOKEN)"
[[ "$selected_port" =~ ^[0-9]+$ ]] || fail "USAGE_PORT in .env is invalid."
(( ${#api_token} >= 32 )) || fail "USAGE_API_TOKEN in .env must be at least 32 characters."

printf 'Running a read-only Codex usage query...\n'
"$uv_bin" run --project "$project_dir" python "$project_dir/server.py" \
  --env-file "$env_file" --once

mkdir -p "$unit_dir"
unit_tmp="$(mktemp)"
trap 'rm -f "$unit_tmp"' EXIT
{
  printf '[Unit]\n'
  printf 'Description=iOS Lockscreen ChatGPT Usage API\n'
  printf 'After=network-online.target\n'
  printf 'Wants=network-online.target\n\n'
  printf '[Service]\n'
  printf 'Type=simple\n'
  printf 'WorkingDirectory=%s\n' "$project_dir"
  printf 'EnvironmentFile=%s\n' "$env_file"
  printf 'ExecStart=%s run --project %s python %s/server.py --env-file %s\n' \
    "$uv_bin" "$project_dir" "$project_dir" "$env_file"
  printf 'Restart=on-failure\n'
  printf 'RestartSec=5\n'
  printf 'NoNewPrivileges=true\n'
  printf 'PrivateTmp=true\n\n'
  printf '[Install]\n'
  printf 'WantedBy=default.target\n'
} > "$unit_tmp"
install -m 0644 "$unit_tmp" "$unit_file"

systemctl --user daemon-reload
systemctl --user enable "$service_name" >/dev/null
systemctl --user restart "$service_name"

for _attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 2 \
    "http://127.0.0.1:${selected_port}/healthz" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl --fail --silent --max-time 2 \
  "http://127.0.0.1:${selected_port}/healthz" >/dev/null; then
  systemctl --user status "$service_name" --no-pager || true
  fail "The service did not become healthy."
fi

printf '\nServer setup completed.\n'
printf '  Local API: http://127.0.0.1:%s/v1/usage\n' "$selected_port"
printf '  Service:   %s\n' "$service_name"
printf '  Secret:    %s (not printed)\n' "$env_file"
printf '\nIf this must survive logout, run once:\n'
printf '  sudo loginctl enable-linger %q\n' "$USER"
printf '\nNext, install the HTTPS route:\n'
printf '  sudo %q usage.example.com\n' "$project_dir/scripts/install-caddy-route.sh"

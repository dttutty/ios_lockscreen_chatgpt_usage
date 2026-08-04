# iOS Lockscreen ChatGPT Usage

**English** | [简体中文](README.zh-CN.md)

Read ChatGPT Codex rate limits from the Codex CLI on your server and display
remaining quota and reset times in Scriptable widgets on your iPhone Lock
Screen.

```text
Codex app-server → local cached API → HTTPS → Scriptable Lock Screen widget
```

The service returns only the quota usage, window duration, reset time, and last
update time required by the phone. It never exposes the Codex app-server,
`~/.codex/auth.json`, or ChatGPT credentials to the public internet.

## Features

- Reads ChatGPT Codex rate limits through the official
  [Codex App Server](https://developers.openai.com/codex/app-server)
  `account/rateLimits/read` JSON-RPC method.
- Supports accounts with either one or two quota windows without hard-coding
  `5h` or `7d`.
- Refreshes the server-side cache every five minutes by default and keeps the
  last successful result, marked as stale, when a refresh fails.
- Binds the HTTP API to `127.0.0.1` by default and authenticates requests with a
  random Bearer Token.
- Stores the API URL and Token in the iOS Keychain and caches the last successful
  response on the phone.
- Shows remaining quota rather than consumed quota, with separate weekly and
  short-window circular widget modes.
- Requests the next widget refresh after 15 minutes; the actual schedule is
  controlled by iOS WidgetKit.

## 1. Prepare the server

You need Python 3.11+, `uv`, and a Codex CLI installation signed in with
ChatGPT:

```bash
codex --version
codex login status
uv --version
```

### Automated setup

On a systemd-based Linux server, the bundled setup script generates `.env` with
a random Token, automatically selects an available local port, verifies the
Codex query, and installs and starts the user service:

```bash
./scripts/setup-server.sh
```

The script never prints the generated Token. If port 8787 is already occupied,
it selects the next available port and writes it to `.env`.

If the server uses Caddy, install an HTTPS route after the local service is
healthy. Replace the example hostname with your own domain:

```bash
sudo ./scripts/install-caddy-route.sh usage.example.com
```

The Caddy installer validates the candidate configuration before replacing the
active file and keeps a timestamped backup. The hostname still needs a proxied
Cloudflare DNS record that points to this server.

After DNS is active, display the two values to enter on the iPhone:

```bash
./scripts/show-scriptable-config.sh https://usage.example.com/v1/usage
```

The commands below describe the same setup manually.

### Manual setup

If `codex` is not available in the systemd `PATH`, locate it first:

```bash
command -v codex
```

Copy the configuration template and generate a random Token used only by your
phone:

```bash
cp .env.example .env
openssl rand -hex 32
```

Paste the generated value into `USAGE_API_TOKEN` in `.env`, then set `CODEX_BIN`
to the absolute path printed by `command -v codex`. The real `.env` file is
excluded by `.gitignore`.

Run a read-only query first to verify the Codex login and protocol:

```bash
uv run python server.py --once
```

Start the local service:

```bash
uv run python server.py
```

In another terminal, load the configuration and verify both the health check and
authenticated endpoint:

```bash
set -a
source .env
set +a
curl http://127.0.0.1:8787/healthz
curl -H "Authorization: Bearer $USAGE_API_TOKEN" \
  http://127.0.0.1:8787/v1/usage
```

Example response:

```json
{
  "primary": {
    "usedPercent": 26,
    "windowDurationMins": 10080,
    "resetsAt": 1786436095
  },
  "secondary": null,
  "updatedAt": 1785878356,
  "stale": false
}
```

## 2. Run in the background

The repository includes a systemd user service that assumes the project is at
`~/Projects/ios_lockscreen_chatgpt_usage`:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/ios-lockscreen-chatgpt-usage.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ios-lockscreen-chatgpt-usage.service
systemctl --user status ios-lockscreen-chatgpt-usage.service
```

Enable user lingering if the service must continue running after you disconnect
from SSH:

```bash
sudo loginctl enable-linger "$USER"
```

Follow the service logs with:

```bash
journalctl --user -u ios-lockscreen-chatgpt-usage.service -f
```

If the repository is stored elsewhere, update `WorkingDirectory`,
`EnvironmentFile`, and `ExecStart` in the service file before installing it.

## 3. Configure HTTPS

Do not expose the Codex app-server or this service's plain HTTP port directly to
the internet. Point a domain at your public IP and let Caddy terminate TLS:

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Replace `usage.example.com` with your domain and point its DNS record at the
server. Caddy only needs to proxy requests to `127.0.0.1:8787`. Allow SSH, ports
80 and 443 through the firewall, but do not open port 8787.

If you prefer not to expose the service publicly, connect the iPhone and server
to the same Tailscale network and access it through a valid HTTPS hostname. Keep
Bearer Token authentication enabled in either setup.

## 4. Install the Scriptable widget

1. Install and open Scriptable on your iPhone.
2. Create a script and copy the complete contents of
   [`scriptable/chatgpt-usage-widget.js`](scriptable/chatgpt-usage-widget.js)
   into it.
3. Run the script manually once. Enter `https://your-domain/v1/usage` and the
   Token from `.env`.
4. Long-press the Lock Screen, choose Customize, and add two circular Scriptable
   widgets to the widget area.
5. Tap the first widget, select this script, and set its Parameter to `weekly`.
6. Tap the second widget, select this script, and set its Parameter to `short`.

Both widgets run the same script. The `weekly` widget selects the longest quota
window, while `short` selects a window shorter than one day. They display quota
remaining, not quota consumed:

```text
┌─────────┐  ┌─────────┐
│ 1W LEFT │  │ 5H LEFT │
│   70%   │  │    —    │
│  ↻ TUE  │  │   N/A   │
└─────────┘  └─────────┘
```

`N/A` means the server did not return that quota window; it is deliberately not
shown as `0%` or `100%`. If you prefer one rectangular widget, add a rectangular
Scriptable widget and leave Parameter empty (or set it to `combined`).

When the script is run manually in Scriptable, its menu can preview the weekly
circle, the 5-hour circle, or the combined rectangle.

`refreshAfterDate` only asks iOS to refresh no earlier than 15 minutes later.
WidgetKit chooses the actual execution time based on its refresh budget, battery
state, and usage frequency, so the Lock Screen widget cannot guarantee an exact
15-minute interval.

## Security boundaries

- Never put `~/.codex/auth.json`, ChatGPT cookies, or OAuth tokens in Scriptable.
- Do not bind to `0.0.0.0` and expose port 8787 directly. Let Caddy or another
  HTTPS reverse proxy reach the loopback service.
- Generate a dedicated high-entropy Token for this service. Rotate it and restart
  the service immediately if you suspect it has leaked.
- Commit only `.env.example` to GitHub, never the real `.env` file.

## Development and tests

```bash
uv run python -m unittest discover -s tests -v
uv run python -m compileall -q server.py tests
```

The Codex app-server is still an experimental interface. After upgrading the
Codex CLI, run `--once` and the tests before restarting the background service
to verify that the new response remains compatible.

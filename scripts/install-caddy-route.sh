#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$project_dir/.env"
caddyfile="${CADDYFILE:-/etc/caddy/Caddyfile}"
hostname="${1:-}"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

if ((EUID != 0)); then
  printf 'This step updates %s and reloads Caddy; requesting sudo.\n' "$caddyfile"
  exec sudo -- "$0" "$@"
fi

[[ -n "$hostname" ]] || fail "Usage: $0 usage.example.com"
[[ "$hostname" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || \
  fail "Invalid hostname: $hostname"
[[ -r "$env_file" ]] || fail "$env_file does not exist. Run setup-server.sh first."
[[ -r "$caddyfile" ]] || fail "$caddyfile is not readable."
command -v caddy >/dev/null 2>&1 || fail "caddy is required but was not found."
command -v curl >/dev/null 2>&1 || fail "curl is required but was not found."

port="$(sed -n 's/^USAGE_PORT=//p' "$env_file" | tail -n 1)"
[[ "$port" =~ ^[0-9]+$ ]] || fail "USAGE_PORT in .env is invalid."
curl --fail --silent --max-time 3 "http://127.0.0.1:${port}/healthz" >/dev/null || \
  fail "The local usage service is not healthy on port $port."

if grep -Fq "$hostname {" "$caddyfile"; then
  printf '%s is already present in %s; no route was added.\n' "$hostname" "$caddyfile"
else
  candidate="$(mktemp)"
  backup="${caddyfile}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  trap 'rm -f "${candidate:-}"' EXIT
  cp "$caddyfile" "$candidate"
  {
    printf '\n%s {\n' "$hostname"
    printf '\tencode zstd gzip\n'
    printf '\treverse_proxy 127.0.0.1:%s\n' "$port"
    printf '}\n'
  } >> "$candidate"

  caddy fmt --overwrite "$candidate"
  caddy validate --config "$candidate" --adapter caddyfile
  cp -a "$caddyfile" "$backup"
  install -m 0644 "$candidate" "$caddyfile"
  systemctl reload caddy
  printf 'Installed the Caddy route and saved a backup at %s.\n' "$backup"
fi

printf '\nCaddy route ready: https://%s/v1/usage\n' "$hostname"
printf 'Cloudflare DNS must contain a proxied record for %s pointing to this server.\n' "$hostname"
printf 'After DNS is active, verify with:\n'
printf '  curl https://%s/healthz\n' "$hostname"
printf 'Then run this locally to display the iPhone configuration:\n'
printf '  %q https://%s/v1/usage\n' \
  "$project_dir/scripts/show-scriptable-config.sh" "$hostname"

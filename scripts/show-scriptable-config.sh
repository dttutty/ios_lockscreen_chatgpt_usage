#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$project_dir/.env"
api_url="${1:-https://usage.dttutty.com/v1/usage}"

if [[ ! -r "$env_file" ]]; then
  printf 'Error: %s is missing. Run setup-server.sh first.\n' "$env_file" >&2
  exit 1
fi

token="$(sed -n 's/^USAGE_API_TOKEN=//p' "$env_file" | tail -n 1)"
if (( ${#token} < 32 )); then
  printf 'Error: USAGE_API_TOKEN is missing or invalid.\n' >&2
  exit 1
fi

printf 'Enter these values when the Scriptable script asks for configuration.\n\n'
printf 'API URL:\n%s\n\n' "$api_url"
printf 'Bearer Token (keep private):\n%s\n' "$token"

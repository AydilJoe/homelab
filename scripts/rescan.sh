#!/usr/bin/env bash
# Reconcile the addon's index with what is actually on disk — spec open item O4
# ("Jellyfin and addon library state can diverge, no reconciliation job").
#
# Jellyfin has a filesystem watcher and self-heals within ~2 minutes of any
# change. The addon has no watcher: it indexes at startup and on demand, so a
# file deleted outside the addon leaves a row pointing at a path that no longer
# exists, and a file added outside an import is invisible until something asks.
# This script is that something.
#
# Cheap by design: POST /admin/rescan returns 202 immediately and the addon
# rebuilds in one transaction (a full 5,000-file pass is ~70 ms plus the *arr
# API round-trips — spec N3). Running it every 15 minutes costs nothing.
#
# Overrides come from the unit's EnvironmentFile (/etc/default/homelab-rescan).

set -euo pipefail

ADDON_URL="${ADDON_URL:-http://127.0.0.1:7000}"
TIMEOUT="${RESCAN_TIMEOUT:-30}"

die() { printf 'rescan: %s\n' "$*" >&2; exit 1; }

# The token is required. Read it from the environment, or fall back to the
# repo's .env so a manual run needs no arguments. Never echo it.
if [[ -z "${ADDON_ADMIN_TOKEN:-}" ]]; then
  ENV_FILE="${ENV_FILE:-/opt/homelab/.env}"
  if [[ -r "$ENV_FILE" ]]; then
    # Match the key exactly; tolerate optional quotes and trailing whitespace.
    ADDON_ADMIN_TOKEN="$(sed -n 's/^[[:space:]]*ADDON_ADMIN_TOKEN[[:space:]]*=[[:space:]]*"\?\([^"]*\)"\?[[:space:]]*$/\1/p' "$ENV_FILE" | tail -n 1)"
  fi
fi
[[ -n "${ADDON_ADMIN_TOKEN:-}" ]] || die "ADDON_ADMIN_TOKEN is unset and not readable from ${ENV_FILE:-/opt/homelab/.env}"

# Don't wake a sleeping problem: if the addon is not serving, say so plainly
# rather than emitting a curl stack trace every 15 minutes.
health="$(curl -fsS --max-time "$TIMEOUT" "${ADDON_URL}/health" 2>/dev/null)" \
  || die "addon not responding at ${ADDON_URL}/health"

before="$(printf '%s' "$health" | sed -n 's/.*"count"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p')"

# 202 Accepted is the success case: the rebuild runs asynchronously.
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
  -X POST -H "Authorization: Bearer ${ADDON_ADMIN_TOKEN}" \
  "${ADDON_URL}/admin/rescan")"

case "$code" in
  202) ;;
  401) die "rescan rejected (401) — ADDON_ADMIN_TOKEN does not match the addon's" ;;
  403) die "rescan rejected (403) — going through Caddy? use the loopback URL, not the site address" ;;
  *)   die "rescan returned HTTP $code" ;;
esac

# Report the delta so the journal shows what the timer is actually achieving.
# Best-effort: a slow rebuild just means we log the pre-rescan count.
sleep "${RESCAN_SETTLE:-5}"
after="$(curl -fsS --max-time "$TIMEOUT" "${ADDON_URL}/health" 2>/dev/null \
  | sed -n 's/.*"count"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p')" || after=""

if [[ -n "$before" && -n "$after" && "$before" != "$after" ]]; then
  printf 'rescan: accepted — index %s -> %s rows\n' "$before" "$after"
else
  printf 'rescan: accepted — index %s rows\n' "${after:-${before:-unknown}}"
fi

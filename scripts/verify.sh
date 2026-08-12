#!/usr/bin/env bash
# =============================================================================
# homelab — phase gates as runnable checks           (spec §7, working rule §0.3)
#
# Every build phase in §7 has a verification gate. This script is those gates.
# A failing gate stops the build: the script exits non-zero and you do not
# advance to the next phase.
#
#   ./scripts/verify.sh 1          run the Phase 1 gate
#   ./scripts/verify.sh 3 4        run several
#   ./scripts/verify.sh all        run all seven
#   ./scripts/verify.sh --tailnet 2
#
# Run it INSIDE LXC 101 — that is where the devices, the containers, the
# bind mount and the backup timer live. The one exception is Phase 5, which
# can only be finished on the Proxmox HOST; it prints the host commands rather
# than failing on something the LXC structurally cannot see.
#
# INGRESS MODE
#   LAN (default)  Caddy serves plain HTTP on :80. The Phase 2 tailnet gates
#                  are reported as SKIPPED, not failed — nothing in LAN mode
#                  depends on a tailnet existing.
#   Tailnet (§5.2) --tailnet, or HOMELAB_MODE=tailnet, or an active Caddyfile
#                  that asks tailscaled for a certificate (auto-detected).
#
# Exit codes: 0 all gates passed · 1 a gate failed · 2 bad usage
#
# NOTE: this script deliberately does NOT use `set -e`. Checks are expected to
# fail; failures are counted and reported, not fatal on the first one.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

CONFIG_ROOT="${CONFIG_ROOT:-/srv/config}"
DATA_ROOT="${DATA_ROOT:-/srv/data}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_ROOT/backups}"
MEDIA_ROOT="${MEDIA_ROOT:-$DATA_ROOT/media}"
TORRENT_ROOT="${TORRENT_ROOT:-$DATA_ROOT/torrents}"
CURL_TIMEOUT="${CURL_TIMEOUT:-10}"

MODE="${HOMELAB_MODE:-}"
PHASES=()

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --lan)      MODE=lan ;;
    --tailnet)  MODE=tailnet ;;
    --repo)     REPO_DIR="${2:?--repo needs a path}"; shift ;;
    -h|--help)  usage; exit 0 ;;
    all)        PHASES=(1 2 3 4 5 6 7) ;;
    [1-7])      PHASES+=("$1") ;;
    *)          printf 'verify.sh: unknown argument %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ "${#PHASES[@]}" -eq 0 ]; then
  printf 'verify.sh: which phase? (1..7, or "all")\n\n' >&2
  usage >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# .env reader — read values without sourcing the file (no code execution)
# ---------------------------------------------------------------------------
env_get() {
  local key="$1" f="$REPO_DIR/.env" line
  [ -f "$f" ] || return 1
  line="$(grep -E "^[[:space:]]*${key}=" "$f" 2>/dev/null | tail -n1)" || return 1
  [ -n "$line" ] || return 1
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-$(env_get PUBLIC_BASE_URL || true)}"
TAILNET="${TAILNET:-$(env_get TAILNET || true)}"
CADDYFILE_SETTING="${CADDYFILE:-$(env_get CADDYFILE || true)}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"

# Which Caddyfile is actually in force: an explicit CADDYFILE, else the one
# mounted under CONFIG_ROOT (§4 layout), else the repo default.
resolve_caddyfile() {
  local c="$CADDYFILE_SETTING"
  if [ -n "$c" ]; then
    case "$c" in
      /*) [ -f "$c" ] && { printf '%s' "$c"; return 0; } ;;
      *)  [ -f "$REPO_DIR/${c#./}" ] && { printf '%s' "$REPO_DIR/${c#./}"; return 0; } ;;
    esac
  fi
  [ -f "$CONFIG_ROOT/caddy/Caddyfile" ] && { printf '%s' "$CONFIG_ROOT/caddy/Caddyfile"; return 0; }
  [ -f "$REPO_DIR/caddy/Caddyfile.lan" ] && { printf '%s' "$REPO_DIR/caddy/Caddyfile.lan"; return 0; }
  return 1
}
ACTIVE_CADDYFILE="$(resolve_caddyfile || true)"

# Mode detection: flag/env wins, then the active Caddyfile, then LAN.
if [ -z "$MODE" ]; then
  if [ -n "$ACTIVE_CADDYFILE" ] && grep -qE 'get_certificate[[:space:]]+tailscale|\.ts\.net[[:space:]]*\{' "$ACTIVE_CADDYFILE" 2>/dev/null; then
    MODE=tailnet
  else
    MODE=lan
  fi
fi

# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------
n_pass=0; n_fail=0; n_warn=0; n_skip=0
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_NO=$'\033[31m'; C_WA=$'\033[33m'; C_SK=$'\033[36m'; C_Z=$'\033[0m'
else
  C_OK=""; C_NO=""; C_WA=""; C_SK=""; C_Z=""
fi
pass() { printf '  %s[ OK ]%s  %s\n'   "$C_OK" "$C_Z" "$*"; n_pass=$((n_pass+1)); }
fail() { printf '  %s[FAIL]%s  %s\n'   "$C_NO" "$C_Z" "$*"; n_fail=$((n_fail+1)); }
warn() { printf '  %s[WARN]%s  %s\n'   "$C_WA" "$C_Z" "$*"; n_warn=$((n_warn+1)); }
skip() { printf '  %s[SKIP]%s  %s\n'   "$C_SK" "$C_Z" "$*"; n_skip=$((n_skip+1)); }
note() { printf '          %s\n' "$*"; }
head1(){ printf '\n=== %s ===\n' "$*"; }

# check "description" <command...>
check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi
}
have() { command -v "$1" >/dev/null 2>&1; }

COMPOSE=(docker compose --project-directory "$REPO_DIR" -f "$REPO_DIR/docker-compose.yml")

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$@" 2>/dev/null; }

json_field() { # json_field <json> <key>   — jq when available, crude fallback otherwise
  local json="$1" key="$2"
  if have jq; then
    printf '%s' "$json" | jq -r ".${key} // empty" 2>/dev/null
  else
    printf '%s' "$json" | grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|[0-9]+)" \
      | head -n1 | sed -E 's/.*:[[:space:]]*"?([^"]*)"?/\1/'
  fi
}

# ---------------------------------------------------------------------------
# percent-encoding for the §6.4 stream URL shape
#
# RFC 3986 escapes BYTES. The obvious bash one-liner — printf '%%%02X' "'$c" —
# escapes the CHARACTER's codepoint instead, so "Amélie" comes out as "Am%E9lie"
# (should be "Am%C3%A9lie") and a CJK character produces "%6620", which is not a
# valid escape at all. Any non-ASCII filename would then 404 and fail the Phase
# 6 range gate on a system that is working perfectly.
#
# So: jq, else python3, else a byte-wise loop over od(1) output. Each of those
# is byte-correct. If none is available urlencode_path returns non-zero and the
# caller skips the check rather than reporting a false failure.
# ---------------------------------------------------------------------------
urlencode_seg() {
  local seg="$1"
  if have jq; then
    printf '%s' "$seg" | jq -sRr @uri
    return 0
  fi
  if have python3; then
    python3 -c 'import sys,urllib.parse; sys.stdout.write(urllib.parse.quote(sys.argv[1], safe=""))' "$seg"
    return 0
  fi
  if have od; then
    local hex i b n out=""
    hex="$(printf '%s' "$seg" | od -An -tx1 -v 2>/dev/null | tr -d ' \n')"
    [ -n "$hex" ] || return 1
    for ((i=0; i<${#hex}; i+=2)); do
      b="${hex:i:2}"
      n=$((16#$b))
      # unreserved: A-Z a-z 0-9 - . _ ~
      if { [ "$n" -ge 48 ] && [ "$n" -le 57 ]; } \
        || { [ "$n" -ge 65 ] && [ "$n" -le 90 ]; } \
        || { [ "$n" -ge 97 ] && [ "$n" -le 122 ]; } \
        || [ "$n" -eq 45 ] || [ "$n" -eq 46 ] || [ "$n" -eq 95 ] || [ "$n" -eq 126 ]; then
        out+="$(printf '%b' "\\x$b")"
      else
        out+="%$(printf '%s' "$b" | tr 'a-f' 'A-F')"
      fi
    done
    printf '%s' "$out"
    return 0
  fi
  return 1
}

# percent-encode a relative path, keeping the slashes
urlencode_path() {
  local path="$1" out="" seg enc
  local -a segs
  IFS='/' read -r -a segs <<< "$path"
  for seg in "${segs[@]}"; do
    [ -n "$seg" ] || continue
    enc="$(urlencode_seg "$seg")" || return 1
    out+="/$enc"
  done
  printf '%s' "${out#/}"
}

# Validate a Caddyfile with the same image the stack runs (§5.2). Returns 2
# when it cannot be checked here (no docker) so the caller can skip.
caddy_validate() {
  local file="$1"
  have docker || return 2
  docker run --rm -v "$file:/etc/caddy/Caddyfile:ro" caddy:alpine \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
}

# =============================================================================
# Phase 1 — Base (§7 Phase 1)
# =============================================================================
phase1() {
  head1 "Phase 1 — Base: LXC 101, devices, Docker, bind mount"

  check "/dev/dri/renderD128 present (iGPU passthrough, §2)"  test -e /dev/dri/renderD128
  check "/dev/dri/card0 present"                              test -e /dev/dri/card0
  check "/dev/net/tun present (needed by tailscaled, §2/§5.2)" test -e /dev/net/tun

  if [ ! -e /dev/dri/renderD128 ]; then
    note "Missing renderD128 means no hardware transcoding. Check dev0/dev1 in"
    note "/etc/pve/lxc/101.conf on the Proxmox host, and 'ls /dev/dri' there."
  fi

  if have docker; then
    check "docker run hello-world (nesting=1,keyctl=1 correct)" docker run --rm hello-world
    if docker run --rm -u 1000:1000 -v "$DATA_ROOT":/data alpine \
         sh -c 'touch /data/.rwtest && rm /data/.rwtest' >/dev/null 2>&1; then
      pass "unprivileged uid 1000 can write $DATA_ROOT (idmap/chown, §3.3)"
    else
      fail "uid 1000 cannot write $DATA_ROOT (idmap/chown, §3.3)"
      note "On the Proxmox HOST: chown -R 101000:101000 $DATA_ROOT"
      note "Inside the LXC, 'ls -lan $DATA_ROOT' must show uid/gid 1000, not 65534/nobody."
    fi
  else
    fail "docker is not installed inside LXC 101"
  fi

  # §3.1: /srv/data must be the SATA disk, not the container rootfs
  if [ -d "$DATA_ROOT" ]; then
    local dev_data dev_root
    dev_data="$(stat -c '%d' "$DATA_ROOT" 2>/dev/null)"
    dev_root="$(stat -c '%d' / 2>/dev/null)"
    if [ -n "$dev_data" ] && [ "$dev_data" != "$dev_root" ]; then
      pass "$DATA_ROOT is a separate filesystem from / (bind mount of /dev/sda)"
    else
      fail "$DATA_ROOT is on the same filesystem as / — the /dev/sda bind mount is missing"
    fi
    note "$(df -h "$DATA_ROOT" 2>/dev/null | tail -n1)"
  else
    fail "$DATA_ROOT does not exist"
  fi

  # §2: compose group_add must match the container's own render/video gids
  local gid_render gid_video
  gid_render="$(getent group render 2>/dev/null | cut -d: -f3)"
  gid_video="$(getent group video 2>/dev/null | cut -d: -f3)"
  if [ -n "$gid_render" ] && [ -n "$gid_video" ]; then
    note "render gid=$gid_render, video gid=$gid_video (inside this container/LXC)"
    if [ -f "$REPO_DIR/docker-compose.yml" ]; then
      if grep -q "group_add" "$REPO_DIR/docker-compose.yml" \
         && grep -qE "group_add.*\"$gid_render\"" "$REPO_DIR/docker-compose.yml" \
         && grep -qE "group_add.*\"$gid_video\"" "$REPO_DIR/docker-compose.yml"; then
        pass "docker-compose.yml group_add matches render/video gids (§2)"
      else
        warn "docker-compose.yml group_add does not list [$gid_render, $gid_video] — Jellyfin will not be able to open /dev/dri (§2)"
      fi
    fi
  else
    warn "no render/video group in this container — cannot cross-check compose group_add"
  fi
}

# =============================================================================
# Phase 2 — Networking (§7 Phase 2)  [tailnet only]
# =============================================================================
phase2() {
  head1 "Phase 2 — Networking (mode: $MODE)"

  # Both ingress files must actually adapt, in both modes. The tailnet file is
  # only mounted after the switch, so without this a syntax error in it stays
  # invisible until the switch takes ingress down. (§5.2 prints the tls block
  # on one line; the Caddyfile parser rejects that form — see caddy/Caddyfile.)
  local cf rc
  for cf in "$REPO_DIR/caddy/Caddyfile.lan" "$REPO_DIR/caddy/Caddyfile"; do
    [ -f "$cf" ] || { fail "missing ingress file: $cf"; continue; }
    caddy_validate "$cf"; rc=$?
    case "$rc" in
      0) pass "caddy validate: $(basename "$cf")" ;;
      2) skip "caddy validate: $(basename "$cf") — docker not available here" ;;
      *) fail "caddy validate FAILED for $cf — Caddy will not start with this file"
         note "docker run --rm -v \"$cf:/etc/caddy/Caddyfile:ro\" caddy:alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" ;;
    esac
  done

  if [ "$MODE" = lan ]; then
    skip "tailscale status — SKIPPED in LAN mode (no tailnet required)"
    skip "Tailscale-issued certificate — SKIPPED in LAN mode (Caddy serves plain HTTP on :80)"
    note "Phase 2 is the §5.2 end state, deliberately deferred. Re-run with"
    note "--tailnet once tailscaled is up in LXC 101 as node 'media'."
    note ""

    # LAN-mode equivalents: ingress must still actually be up.
    if have curl; then
      local code
      code="$(http_code http://127.0.0.1/)"
      if [ "$code" != "000" ]; then
        pass "Caddy answers on http://127.0.0.1/ (HTTP $code)"
      else
        fail "nothing answering on http://127.0.0.1/ — is the caddy container up?"
      fi
    else
      warn "curl not installed — cannot probe the LAN listener"
    fi

    if [ -n "$ACTIVE_CADDYFILE" ]; then
      pass "active Caddyfile: $ACTIVE_CADDYFILE"
      if grep -q '\.ts\.net' "$ACTIVE_CADDYFILE" 2>/dev/null; then
        warn "the active Caddyfile references a .ts.net site address but the mode is LAN — check CADDYFILE in .env"
      fi
    else
      fail "no Caddyfile found (looked at CADDYFILE, $CONFIG_ROOT/caddy/Caddyfile, $REPO_DIR/caddy/Caddyfile.lan)"
    fi

    case "$PUBLIC_BASE_URL" in
      http://*)  pass "PUBLIC_BASE_URL is a plain-HTTP LAN URL: $PUBLIC_BASE_URL" ;;
      https://*) warn "PUBLIC_BASE_URL is https but the mode is LAN: $PUBLIC_BASE_URL" ;;
      "")        fail "PUBLIC_BASE_URL is not set (.env) — every stream URL the addon returns depends on it" ;;
      *)         fail "PUBLIC_BASE_URL does not look like a URL: $PUBLIC_BASE_URL" ;;
    esac
    note "LAN-mode client limitation: Stremio DESKTOP accepts plain-HTTP addon"
    note "URLs and works today. Stremio Web / iOS / Android refuse plain HTTP —"
    note "they need the tailnet phase. There is no LAN workaround."
    return
  fi

  # --- tailnet mode -------------------------------------------------------
  if ! have tailscale; then
    fail "tailscale CLI not found inside LXC 101 — tailscaled must run HERE, not on the host (§5.2)"
    return
  fi

  check "tailscale status (daemon up inside LXC 101)" tailscale status

  local self=""
  if have jq && tailscale status --json >/dev/null 2>&1; then
    self="$(tailscale status --json 2>/dev/null | jq -r '.Self.HostName // empty')"
  fi
  if [ -z "$self" ]; then
    self="$(tailscale status 2>/dev/null | awk 'NR==1{print $2}')"
  fi
  if [ "$self" = "media" ]; then
    pass "tailnet node name is 'media'"
  else
    fail "tailnet node name is '${self:-unknown}', expected 'media' — a cert for media.<tailnet>.ts.net is only issuable on a node named media (§5.2)"
  fi

  if [ -z "$TAILNET" ] || [ "$TAILNET" = "your-tailnet-name" ]; then
    fail "TAILNET is not set in .env — cannot check the certificate"
    return
  fi

  local host="media.${TAILNET}.ts.net"
  if ! have openssl; then
    warn "openssl not installed — cannot inspect the certificate"
    return
  fi
  local certinfo
  certinfo="$(echo | openssl s_client -connect "${host}:443" -servername "$host" 2>/dev/null \
              | openssl x509 -noout -issuer -enddate 2>/dev/null)"
  if [ -z "$certinfo" ]; then
    fail "no TLS certificate presented at ${host}:443"
    note "Check: MagicDNS and HTTPS certificates enabled in the tailnet admin console;"
    note "the tailscaled socket mounted into the Caddy container (§4); Caddy running as root"
    note "in its container, or TS_PERMIT_CERT_UID set on tailscaled (§5.2)."
  else
    note "$certinfo"
    if printf '%s' "$certinfo" | grep -qi 'self.signed\|CN *= *Caddy Local'; then
      fail "the presented certificate is self-signed — tailscaled did not issue it"
    else
      pass "a real issued certificate is presented for $host"
    fi
  fi
}

# =============================================================================
# Phase 3 — Media services (§7 Phase 3)
# =============================================================================
phase3() {
  head1 "Phase 3 — Media services"

  if ! have docker; then fail "docker not installed"; return; fi
  if [ ! -f "$REPO_DIR/docker-compose.yml" ]; then fail "no docker-compose.yml at $REPO_DIR"; return; fi

  local services svc cid state all_up=1
  services="$("${COMPOSE[@]}" config --services 2>/dev/null)"
  if [ -z "$services" ]; then
    fail "docker compose config --services returned nothing (is .env present and valid?)"
    return
  fi

  for svc in $services; do
    cid="$("${COMPOSE[@]}" ps -q "$svc" 2>/dev/null | head -n1)"
    if [ -z "$cid" ]; then
      fail "service '$svc' has no container (not started)"
      all_up=0
      continue
    fi
    state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)"
    if [ "$state" = "running" ]; then
      pass "service '$svc' is running"
    else
      fail "service '$svc' is '$state', expected running"
      all_up=0
    fi
  done
  [ "$all_up" -eq 1 ] || note "docker compose logs <service> — start with the ones above"

  if ! have curl; then warn "curl not installed — skipping service health probes"; return; fi

  # A response of any kind means the service is listening; *arr UIs answer 200
  # on /ping, the web UIs may answer 200/302/401 depending on auth setup.
  probe() { # probe <label> <url> <acceptable codes...>
    local label="$1" url="$2"; shift 2
    local code want
    code="$(http_code "$url")"
    for want in "$@"; do
      if [ "$code" = "$want" ]; then pass "$label ($url -> $code)"; return; fi
    done
    if [ "$code" = "000" ] || [ -z "$code" ]; then
      fail "$label ($url -> no response) — expected one of: $*"
    else
      fail "$label ($url -> $code) — expected one of: $*"
    fi
  }

  probe "Jellyfin health"   "http://localhost:8096/health" 200
  probe "Sonarr ping"       "http://localhost:8989/ping"   200
  probe "Radarr ping"       "http://localhost:7878/ping"   200
  probe "Prowlarr ping"     "http://localhost:9696/ping"   200
  probe "Bazarr UI"         "http://localhost:6767/"       200 302 401
  probe "qBittorrent UI"    "http://localhost:8080/"       200 302 401
  probe "addon health"      "http://127.0.0.1:7000/health" 200

  note "Prowlarr ships with NO indexers and stays that way. Indexer selection is"
  note "an operator decision made by hand (§13) — it is not part of any gate here."
}

# =============================================================================
# Phase 4 — Hardlink verification (§7 Phase 4)
# =============================================================================
phase4() {
  head1 "Phase 4 — Hardlinks (the gate that catches the most common mistake)"

  if [ ! -d "$MEDIA_ROOT" ]; then fail "$MEDIA_ROOT does not exist"; return; fi

  # Root cause first: if these are different filesystems, hardlinking is
  # impossible no matter what the *arr settings say (C4, §3.2).
  if [ -d "$TORRENT_ROOT" ]; then
    local d1 d2
    d1="$(stat -c '%d' "$TORRENT_ROOT" 2>/dev/null)"
    d2="$(stat -c '%d' "$MEDIA_ROOT" 2>/dev/null)"
    if [ -n "$d1" ] && [ "$d1" = "$d2" ]; then
      pass "$TORRENT_ROOT and $MEDIA_ROOT are on one filesystem (C4)"
    else
      fail "$TORRENT_ROOT and $MEDIA_ROOT are on DIFFERENT filesystems — imports can only ever copy"
    fi
  else
    warn "$TORRENT_ROOT does not exist yet — cannot compare filesystems"
  fi

  local files total=0 linked=0 single=0 shown=0
  files="$(find "$MEDIA_ROOT" -type f \( -name '*.mkv' -o -name '*.mp4' -o -name '*.avi' \) 2>/dev/null)"
  if [ -z "$files" ]; then
    fail "no media files under $MEDIA_ROOT — do one test import, then re-run this gate"
    return
  fi

  local nlink name
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    nlink="$(stat -c '%h' "$f" 2>/dev/null)"
    total=$((total+1))
    if [ "${nlink:-1}" -ge 2 ]; then
      linked=$((linked+1))
    else
      single=$((single+1))
      if [ "$shown" -lt 5 ]; then
        name="$f"
        warn "link count 1: $name"
        shown=$((shown+1))
      fi
    fi
  done <<< "$files"

  note "$total media file(s): $linked hardlinked, $single with a single link"
  if [ "$linked" -gt 0 ]; then
    pass "hardlinked imports confirmed (link count 2+)"
  else
    fail "every media file has link count 1 — the import COPIED instead of linking"
    note "Fix the mounts before continuing: qbittorrent, sonarr, radarr and bazarr"
    note "must all mount \$DATA_ROOT at /data — one mount, one filesystem, identical"
    note "paths (§3.2). A broken setup silently doubles storage consumption."
  fi
  if [ "$single" -gt 0 ] && [ "$linked" -gt 0 ]; then
    note "Files whose torrent was removed after seeding legitimately drop to 1 link;"
    note "verify this gate against a FRESH import, not against an aged library."
  fi
}

# =============================================================================
# Phase 5 — Transcode verification (§7 Phase 5)
# =============================================================================
phase5() {
  head1 "Phase 5 — Transcode (final confirmation belongs on the Proxmox HOST)"

  local in_container="no"
  if have systemd-detect-virt; then
    in_container="$(systemd-detect-virt --container 2>/dev/null || echo none)"
  elif [ -f /run/systemd/container ]; then
    in_container="$(cat /run/systemd/container)"
  fi

  check "/dev/dri/renderD128 visible here" test -e /dev/dri/renderD128

  if have docker && [ -f "$REPO_DIR/docker-compose.yml" ]; then
    if "${COMPOSE[@]}" ps -q jellyfin 2>/dev/null | grep -q .; then
      check "Jellyfin container can see /dev/dri/renderD128" \
        "${COMPOSE[@]}" exec -T jellyfin ls /dev/dri/renderD128
    else
      warn "jellyfin container is not running — cannot check its view of /dev/dri"
    fi
  fi

  skip "intel_gpu_top video-engine check — cannot run in here"
  note ""
  note "i915 PMU (perf) access is blocked inside both the Jellyfin container and"
  note "the unprivileged LXC on PVE 9 (AppArmor) — even though transcoding itself"
  note "works fine here. Running intel_gpu_top in the LXC produces a FALSE gate"
  note "failure. Detected environment: container=${in_container}."
  note ""
  note "On the Proxmox HOST, while a forced transcode is playing in Jellyfin:"
  note "    apt install intel-gpu-tools"
  note "    intel_gpu_top          # 'Video' engine must show busy"
  note ""
  note "And in the Jellyfin dashboard the session must read 'Transcoding (hw)',"
  note "not software. AV1 decodes in hardware; AV1 ENCODE is unavailable on the"
  note "UHD 770 by design (§1, §9) — do not treat that as a failure."
  note ""
  note "This phase does not fail from inside the LXC. Confirm it on the host."
}

# =============================================================================
# Phase 6 — Addon (§7 Phase 6)
# =============================================================================
phase6() {
  head1 "Phase 6 — Addon (base URL: ${PUBLIC_BASE_URL:-<unset>})"

  if ! have curl; then fail "curl not installed"; return; fi
  if [ -z "$PUBLIC_BASE_URL" ]; then
    fail "PUBLIC_BASE_URL is not set — set it in .env (LAN: http://<lxc-lan-ip>)"
    return
  fi

  # manifest
  local manifest id
  manifest="$(curl -s --max-time "$CURL_TIMEOUT" "$PUBLIC_BASE_URL/addon/manifest.json" 2>/dev/null)"
  id="$(json_field "$manifest" id)"
  if [ -n "$id" ]; then
    pass "manifest served: id=$id"
  else
    fail "no manifest at $PUBLIC_BASE_URL/addon/manifest.json"
    note "Caddy strips /addon via handle_path, so the addon must serve /manifest.json at its root."
  fi

  # health + row count
  local health count
  health="$(curl -s --max-time "$CURL_TIMEOUT" "$PUBLIC_BASE_URL/addon/health" 2>/dev/null)"
  count="$(json_field "$health" count)"
  case "$count" in
    ''|*[!0-9]*) fail "/addon/health did not return a numeric index count (got: ${health:-<empty>})" ;;
    *)
      pass "/addon/health reports $count indexed row(s)"
      [ "$count" -gt 0 ] || warn "the index is empty — POST /admin/rescan from a shell on the LXC"
      ;;
  esac

  # CORS on every route (N4) — /health is the custom route the SDK router misses
  local acao
  acao="$(curl -s -D - -o /dev/null --max-time "$CURL_TIMEOUT" "$PUBLIC_BASE_URL/addon/health" 2>/dev/null \
          | grep -i '^access-control-allow-origin:' | tr -d '\r')"
  if printf '%s' "$acao" | grep -q '\*'; then
    pass "CORS header present on /health (N4)"
  else
    fail "no 'Access-Control-Allow-Origin: *' on /addon/health (N4)"
  fi

  # Range request -> 206 (this is what makes seeking work)
  local rel enc url hdrs status
  rel="${TEST_MEDIA_REL:-$(cd "$MEDIA_ROOT" 2>/dev/null && find . -type f \( -name '*.mkv' -o -name '*.mp4' \) -printf '%P\n' 2>/dev/null | head -n1)}"
  if [ -z "$rel" ]; then
    fail "no media file under $MEDIA_ROOT to range-test (set TEST_MEDIA_REL=<path relative to $MEDIA_ROOT>)"
  elif ! enc="$(urlencode_path "$rel")"; then
    # Reporting a 404 caused by our own bad encoding would stop the build on a
    # system that is fine (§0.3). Skip instead, and say how to fix it.
    skip "ranged GET — no byte-correct URL encoder available (need jq, python3 or od)"
    warn "install one of them (apt install jq) and re-run: this gate cannot be evaluated without it"
  else
    url="$PUBLIC_BASE_URL/media/$enc"
    hdrs="$(curl -s -D - -o /dev/null --max-time "$CURL_TIMEOUT" -H 'Range: bytes=0-1000' "$url" 2>/dev/null | tr -d '\r')"
    status="$(printf '%s' "$hdrs" | awk 'toupper($1) ~ /^HTTP/ {print $2}' | tail -n1)"
    if [ "$status" = "206" ] && printf '%s' "$hdrs" | grep -qi '^content-range:'; then
      pass "ranged GET returns 206 Partial Content with Content-Range ($rel)"
    elif [ -z "$status" ]; then
      fail "ranged GET got no response from $url"
      note "Is Caddy up, and is PUBLIC_BASE_URL reachable from HERE as well as from the client?"
    else
      fail "ranged GET returned $status for $url — anything but 206 means seeking will be broken in the player"
      note "Caddy's file_server handles Range natively; check the /media/* handle_path block and the :ro media mount."
    fi
  fi

  # admin surface
  local admin_code
  # §6.5 is unconditional — "Caddy refuses /addon/admin/*" — and BOTH shipped
  # Caddyfiles implement the same `handle /addon/admin/* { respond 403 }`.
  # So this is a hard gate in either mode; downgrading it in LAN mode (the
  # active default) would let a removed admin block ship unnoticed.
  admin_code="$(http_code -X POST "$PUBLIC_BASE_URL/addon/admin/rescan")"
  if [ "$admin_code" = "403" ]; then
    pass "/addon/admin/rescan is refused by Caddy (403) (§5.2, §6.5)"
  else
    fail "/addon/admin/rescan returned $admin_code through Caddy, expected 403 (§6.5)"
    note "The admin surface is never routed through Caddy. Check the"
    note "'handle /addon/admin/* { respond 403 }' block in ${ACTIVE_CADDYFILE:-the active Caddyfile} —"
    note "it must come BEFORE handle_path /addon/*, so the longer matcher wins."
  fi

  # loopback binding (§4, §6.5) — a 0.0.0.0 publish exposes /admin tailnet-wide
  if have docker && [ -f "$REPO_DIR/docker-compose.yml" ]; then
    local binding
    binding="$("${COMPOSE[@]}" port addon 7000 2>/dev/null)"
    if [ -z "$binding" ]; then
      warn "could not read the addon's published port"
    elif printf '%s' "$binding" | grep -q '^127\.0\.0\.1:'; then
      pass "addon port is bound to loopback ($binding) (§6.5)"
    else
      fail "addon port is published on $binding — it must be 127.0.0.1:7000 only (§6.5)"
    fi
  fi

  if [ "$MODE" = lan ]; then
    note ""
    note "Install in Stremio DESKTOP: $PUBLIC_BASE_URL/addon/manifest.json"
    note "Stremio Web / iOS / Android refuse plain-HTTP addon URLs — those clients"
    note "need the tailnet phase (§5.2). No LAN workaround exists."
  fi
}

# =============================================================================
# Phase 7 — Backups (§7 Phase 7, §8)
# =============================================================================
phase7() {
  head1 "Phase 7 — Backups"

  if have systemctl; then
    if systemctl list-unit-files homelab-backup.timer >/dev/null 2>&1 \
       && systemctl cat homelab-backup.timer >/dev/null 2>&1; then
      pass "homelab-backup.timer is installed"
    else
      fail "homelab-backup.timer is not installed — see systemd/ in the repo and docs/runbook.md"
    fi
    check "homelab-backup.timer is enabled" systemctl is-enabled --quiet homelab-backup.timer
    check "homelab-backup.timer is active"  systemctl is-active  --quiet homelab-backup.timer
    note "$(systemctl list-timers homelab-backup.timer --no-pager --no-legend 2>/dev/null | head -n1)"
  else
    warn "no systemctl here — the timer runs inside LXC 101 (§7 Phase 7)"
  fi

  if [ ! -d "$BACKUP_DIR" ]; then
    fail "$BACKUP_DIR does not exist"
    return
  fi

  local newest count
  count="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'config-*.tar.*' ! -name '*.part' 2>/dev/null | wc -l)"
  if [ "$count" -ge 1 ]; then
    pass "$count config archive(s) present in $BACKUP_DIR"
  else
    fail "no config-*.tar.* archives in $BACKUP_DIR — run scripts/backup.sh once by hand"
    return
  fi

  # ! -name '*.part': an in-progress (or abandoned) archive is not a backup.
  # backup.sh names it .config-<stamp>.<ext>.part so it cannot match the glob
  # either — both guards, because being wrong here means either pruning a good
  # archive a night early or failing this gate against a truncated stream.
  newest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'config-*.tar.*' ! -name '*.part' -printf '%T@ %p\n' 2>/dev/null \
            | sort -rn | head -n1 | cut -d' ' -f2-)"
  note "newest: $newest"

  local age_h
  age_h="$(( ( $(date +%s) - $(stat -c %Y "$newest" 2>/dev/null || echo 0) ) / 3600 ))"
  if [ "$age_h" -le 48 ]; then
    pass "newest archive is ${age_h}h old"
  else
    warn "newest archive is ${age_h}h old — the nightly timer may not be firing (journalctl -u homelab-backup)"
  fi

  check "newest archive is readable end to end" tar -tf "$newest"

  # §8: backups must not share a disk with what they protect
  local d1 d2
  d1="$(stat -c '%d' "$BACKUP_DIR" 2>/dev/null)"
  d2="$(stat -c '%d' "$CONFIG_ROOT" 2>/dev/null)"
  if [ -n "$d1" ] && [ "$d1" != "$d2" ]; then
    pass "$BACKUP_DIR is on a different filesystem from $CONFIG_ROOT (§8)"
  else
    fail "$BACKUP_DIR shares a filesystem with $CONFIG_ROOT — an NVMe failure would take the config and its backups together (§8)"
  fi

  # §8/N5: the addon index is derived state and must not be in the archive
  if tar -tf "$newest" 2>/dev/null | grep -qE '(^|/)config/addon/.*\.db'; then
    fail "the addon SQLite index is inside the archive — scripts/backup.sh must exclude config/addon/*.db* (§8)"
  else
    pass "addon index excluded from the archive (derived state, §8/N5)"
  fi

  note "vzdump archives are a separate, weekly, HOST-side job (§8):"
  note "  /srv/data/backups/vzdump/ added as a directory storage in Proxmox."
}

# =============================================================================
main() {
  printf 'homelab verify — mode: %s | repo: %s\n' "$MODE" "$REPO_DIR"
  [ -n "$ACTIVE_CADDYFILE" ] && printf 'active Caddyfile: %s\n' "$ACTIVE_CADDYFILE"

  local p
  for p in "${PHASES[@]}"; do
    "phase$p"
  done

  printf '\n---------------------------------------------------------------\n'
  printf 'phases: %s | mode: %s\n' "${PHASES[*]}" "$MODE"
  printf 'passed %d, failed %d, warnings %d, skipped %d\n' "$n_pass" "$n_fail" "$n_warn" "$n_skip"
  if [ "$n_fail" -gt 0 ]; then
    printf '%sGATE FAILED%s — stop here and fix it. Do not advance a phase (§0.3).\n' "$C_NO" "$C_Z"
    exit 1
  fi
  printf '%sGATE PASSED%s\n' "$C_OK" "$C_Z"
  exit 0
}

main

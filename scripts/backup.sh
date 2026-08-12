#!/usr/bin/env bash
# =============================================================================
# homelab — nightly configuration backup            (spec §8, §7 Phase 7)
#
# Runs INSIDE LXC 101. That is where /srv/config lives; running this on the
# Proxmox host would archive an empty directory and "succeed".
#
# What it does, in order:
#   1. Takes a consistent snapshot of every SQLite database under /srv/config
#      (*arr, qBittorrent, Jellyfin) with `sqlite3 <db> ".backup <out>"`.
#      Copying a live SQLite file produces corrupt backups that fail silently
#      until you need them — spec §8 gotcha. Never copy the live files.
#   2. Archives /srv/config into /srv/data/backups/config-<timestamp>.tar.<ext>,
#      substituting the snapshots for the live DB files and EXCLUDING
#      config/addon/*.db* — the addon index is derived state, rebuildable from
#      the filesystem + *arr APIs + Cinemeta (§8, N5).
#   3. Verifies the archive is readable, then prunes to the newest $RETENTION.
#
# Backups land on /dev/sda (/srv/data) deliberately: /srv/config is on the NVMe,
# so an NVMe death cannot take the config and its backups together (§8).
#
# Usage:   backup.sh            (normally invoked by homelab-backup.timer)
#          backup.sh --dry-run  (report what would happen, write nothing)
#
# Environment (all optional; systemd unit sets the first three):
#   CONFIG_ROOT          default /srv/config       what gets backed up
#   BACKUP_DIR           default /srv/data/backups where archives go
#   RETENTION            default 14                archives kept
#   BACKUP_COMPRESSION   auto|zstd|gzip (default auto — zstd if available)
#   BACKUP_EXTRA_EXCLUDES  space-separated tar patterns, e.g.
#                          "config/jellyfin/cache/* config/jellyfin/log/*"
#
# Exit codes: 0 ok · 1 failure (anything at all — read the log)
# =============================================================================
set -euo pipefail

# Archives contain *arr API keys and qBittorrent credentials. Keep them 0600.
umask 077

CONFIG_ROOT="${CONFIG_ROOT:-/srv/config}"
BACKUP_DIR="${BACKUP_DIR:-/srv/data/backups}"
# strip any trailing slash — member paths are derived from these by prefix
CONFIG_ROOT="${CONFIG_ROOT%/}"
BACKUP_DIR="${BACKUP_DIR%/}"
RETENTION="${RETENTION:-14}"
BACKUP_COMPRESSION="${BACKUP_COMPRESSION:-auto}"
BACKUP_EXTRA_EXCLUDES="${BACKUP_EXTRA_EXCLUDES:-}"
LOCK_FILE="${LOCK_FILE:-/run/homelab-backup.lock}"
DRY_RUN=0

case "${1:-}" in
  --dry-run|-n) DRY_RUN=1 ;;
  '') ;;
  *) printf 'usage: %s [--dry-run]\n' "$0" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# logging — everything to stderr so journalctl -u homelab-backup captures it
# ---------------------------------------------------------------------------
log()  { printf '%s [backup] %s\n'        "$(date -Is)" "$*" >&2; }
warn() { printf '%s [backup] WARNING: %s\n' "$(date -Is)" "$*" >&2; }
die()  { printf '%s [backup] FATAL: %s\n'   "$(date -Is)" "$*" >&2; exit 1; }

STAGE=""
ARCHIVE_TMP=""
cleanup() {
  # C5 note: this rm -rf only ever targets a directory this script created with
  # mktemp -d, and only when the name still matches that pattern. It never
  # touches an operator-supplied path.
  if [ -n "$STAGE" ] && [ -d "$STAGE" ] && case "$STAGE" in */.sqlite-stage.*) true;; *) false;; esac; then
    rm -rf -- "$STAGE"
  fi
  # A half-written archive from a killed run must never survive: the retention
  # scan and the Phase 7 gate both walk this directory.
  if [ -n "$ARCHIVE_TMP" ] && [ -f "$ARCHIVE_TMP" ]; then
    rm -f -- "$ARCHIVE_TMP"
  fi
}
trap cleanup EXIT
trap 'warn "aborting at line $LINENO"' ERR

# ---------------------------------------------------------------------------
# preflight — fail loudly and early
# ---------------------------------------------------------------------------
for bin in tar sqlite3 find df du date; do
  command -v "$bin" >/dev/null 2>&1 || die "missing required command: $bin (apt install sqlite3 tar)"
done

case "$RETENTION" in
  ''|*[!0-9]*) die "RETENTION must be a positive integer, got '$RETENTION'" ;;
esac
[ "$RETENTION" -ge 1 ] || die "RETENTION must be >= 1, got '$RETENTION'"

[ -d "$CONFIG_ROOT" ] || die "CONFIG_ROOT does not exist: $CONFIG_ROOT (is this running inside LXC 101?)"
[ -n "$(ls -A "$CONFIG_ROOT" 2>/dev/null)" ] || die "CONFIG_ROOT is empty: $CONFIG_ROOT — refusing to write a backup of nothing"

mkdir -p "$BACKUP_DIR" || die "cannot create BACKUP_DIR: $BACKUP_DIR"
[ -w "$BACKUP_DIR" ] || die "BACKUP_DIR not writable: $BACKUP_DIR"

# §8: config and its backups must not share a disk. Warn, do not block — a test
# run on a single-disk box is still better than no backup at all.
dev_config=$(stat -c '%d' "$CONFIG_ROOT")
dev_backup=$(stat -c '%d' "$BACKUP_DIR")
if [ "$dev_config" = "$dev_backup" ]; then
  warn "$BACKUP_DIR is on the SAME filesystem as $CONFIG_ROOT — §8 wants backups on /dev/sda so an NVMe failure cannot take both"
fi

# Leftover staging dirs mean a previous run was killed. Report, do not delete
# (C5: no unattended rm -rf of anything this run did not create).
leftovers=$(find "$BACKUP_DIR" -maxdepth 1 \( -type d -name '.sqlite-stage.*' -o -type f -name '.config-*.part' \) 2>/dev/null || true)
if [ -n "$leftovers" ]; then
  warn "stale staging files/directories from a killed run are taking up space; remove them by hand:"
  printf '%s\n' "$leftovers" >&2
fi

# Free space. The run holds an uncompressed intermediate tar plus the compressed
# result, so budget ~2x the uncompressed config size.
raw_bytes=$(du -sb "$CONFIG_ROOT" 2>/dev/null | awk '{print $1}')
avail_bytes=$(df -B1 --output=avail "$BACKUP_DIR" 2>/dev/null | tail -n1 | tr -d ' ')
if [ -n "$raw_bytes" ] && [ -n "$avail_bytes" ]; then
  need_bytes=$(( raw_bytes * 2 ))
  log "config size ${raw_bytes} B, free at $BACKUP_DIR ${avail_bytes} B"
  [ "$avail_bytes" -gt "$need_bytes" ] || die "not enough free space at $BACKUP_DIR (need > ${need_bytes} B, have ${avail_bytes} B)"
fi

# Overlap guard — a slow run must not be lapped by the next timer firing
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "another backup run already holds $LOCK_FILE"
fi

# ---------------------------------------------------------------------------
# compression selection
# ---------------------------------------------------------------------------
case "$BACKUP_COMPRESSION" in
  zstd) COMPRESSOR=(zstd -q -T0 -c); EXT="tar.zst" ;;
  gzip) COMPRESSOR=(gzip -6 -c);     EXT="tar.gz"  ;;
  auto)
    if command -v zstd >/dev/null 2>&1; then
      COMPRESSOR=(zstd -q -T0 -c); EXT="tar.zst"
    else
      COMPRESSOR=(gzip -6 -c); EXT="tar.gz"
    fi
    ;;
  *) die "BACKUP_COMPRESSION must be auto|zstd|gzip, got '$BACKUP_COMPRESSION'" ;;
esac
command -v "${COMPRESSOR[0]}" >/dev/null 2>&1 || die "missing compressor: ${COMPRESSOR[0]}"

STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUP_DIR/config-$STAMP.$EXT"
# Leading dot on purpose: the in-progress file must NOT match the
# `config-*.tar.*` glob used by the retention scan below and by verify.sh
# Phase 7. A `.part` left behind by a killed run would otherwise be counted as
# a real archive, sort newest, and fail the "readable end to end" gate.
ARCHIVE_TMP="$BACKUP_DIR/.config-$STAMP.$EXT.part"

CONFIG_PARENT="$(dirname "$CONFIG_ROOT")"   # /srv
CONFIG_NAME="$(basename "$CONFIG_ROOT")"    # config

log "starting: $CONFIG_ROOT -> $ARCHIVE (retention $RETENTION)"
if [ "$DRY_RUN" -eq 1 ]; then log "DRY RUN — nothing will be written"; fi

# ---------------------------------------------------------------------------
# 1. SQLite snapshots (§8 gotcha)
# ---------------------------------------------------------------------------
is_sqlite() { [ "$(head -c 15 "$1" 2>/dev/null)" = "SQLite format 3" ]; }

DBS=()
while IFS= read -r f; do
  if [ -n "$f" ]; then DBS+=("$f"); fi
done < <(find "$CONFIG_ROOT" -type f \
           \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) \
           -not -path "$CONFIG_ROOT/addon/*" 2>/dev/null | sort)

if [ "$DRY_RUN" -eq 0 ]; then
  STAGE="$(mktemp -d "$BACKUP_DIR/.sqlite-stage.XXXXXX")"
fi

EXCLUDES=()
SNAP_MEMBERS=()
SNAPPED=0
for db in "${DBS[@]:-}"; do
  [ -n "${db:-}" ] || continue
  rel="${db#"$CONFIG_PARENT"/}"            # e.g. config/sonarr/sonarr.db

  if ! is_sqlite "$db"; then
    log "skip (not a SQLite file, archived as-is): $rel"
    continue
  fi

  log "snapshot: $rel"
  if [ "$DRY_RUN" -eq 0 ]; then
    out="$STAGE/$rel"
    mkdir -p "$(dirname "$out")"
    # .timeout tolerates a service holding a write lock mid-run.
    sqlite3 "$db" ".timeout 15000" ".backup '$out'" \
      || die "sqlite3 .backup failed for $rel — refusing to ship a backup with a missing database"
    [ -s "$out" ] || die "sqlite3 .backup produced an empty file for $rel"
    qc="$(sqlite3 "$out" 'PRAGMA quick_check;' 2>/dev/null || true)"
    if [ "$qc" != "ok" ]; then
      die "snapshot of $rel fails PRAGMA quick_check ($qc) — the source database may be damaged"
    fi

    # The snapshot is created by THIS process (root, umask 077), so without
    # this it enters the archive as root:root 0600 while every other member
    # keeps its 1000:1000. After a restore the linuxserver services (PUID=1000)
    # then cannot open their own databases — the restore looks fine and the
    # stack will not start. Carry the live file's identity onto the snapshot.
    chown --reference="$db" "$out" 2>/dev/null || warn "could not copy ownership of $rel onto its snapshot"
    chmod --reference="$db" "$out" 2>/dev/null || warn "could not copy mode of $rel onto its snapshot"
  fi

  # the live file and its WAL/journal siblings must NOT enter the archive;
  # the consistent snapshot takes their place (appended in step 2)
  EXCLUDES+=(--exclude="$rel" --exclude="$rel-wal" --exclude="$rel-shm" --exclude="$rel-journal")
  SNAP_MEMBERS+=("$rel")
  SNAPPED=$((SNAPPED + 1))
done
log "snapshotted $SNAPPED SQLite database(s)"
if [ "$SNAPPED" -eq 0 ]; then
  warn "no SQLite databases found under $CONFIG_ROOT — expected sonarr/radarr/prowlarr/bazarr/jellyfin. Has the stack ever started?"
fi

# ---------------------------------------------------------------------------
# 2. archive
# ---------------------------------------------------------------------------
# §8: the addon's SQLite index is derived state (N5) and is rebuilt on startup.
# Excluding it also avoids archiving a live SQLite file.
EXCLUDES+=(--exclude="$CONFIG_NAME/addon/*.db*")
EXCLUDES+=(--exclude='*.sock')

for pat in $BACKUP_EXTRA_EXCLUDES; do
  EXCLUDES+=(--exclude="$pat")
done

if [ "$DRY_RUN" -eq 1 ]; then
  log "would run: tar -c -f <tmp.tar> ${EXCLUDES[*]} -C $CONFIG_PARENT $CONFIG_NAME"
  log "would append ${SNAPPED} snapshot(s), then compress to $ARCHIVE"
  log "DRY RUN complete"
  exit 0
fi

# Built in two passes on purpose. tar's --exclude list is global: a single-pass
# "live tree + snapshot tree" invocation applies the DB exclusions to the
# snapshot tree as well and silently ships an archive with no databases in it.
# So: pass 1 archives the live tree minus the live DB files, pass 2 appends the
# snapshots at the same member paths with no exclusions in effect. Append (-r)
# only works on an uncompressed archive, hence the intermediate tar.
TAR_PLAIN="$STAGE/archive.tar"

set +e
tar -c -f "$TAR_PLAIN" \
    --numeric-owner \
    --warning=no-file-changed \
    --warning=no-file-removed \
    "${EXCLUDES[@]}" \
    -C "$CONFIG_PARENT" "$CONFIG_NAME"
tar_rc=$?
set -e

case "$tar_rc" in
  0) ;;
  1) warn "tar exit 1 — a file changed or vanished while being read (a running service rewriting a log). The archive is still usable; the integrity check below is the real gate." ;;
  *) die "tar failed with exit $tar_rc — no archive written" ;;
esac

if [ "$SNAPPED" -gt 0 ]; then
  # --no-recursion + explicit members: add exactly the snapshot files, reusing
  # the directory entries pass 1 already created.
  tar -r -f "$TAR_PLAIN" --numeric-owner --no-recursion \
      -C "$STAGE" "${SNAP_MEMBERS[@]}" \
    || die "failed to append SQLite snapshots to the archive"
fi

log "compressing with ${COMPRESSOR[0]}"
"${COMPRESSOR[@]}" < "$TAR_PLAIN" > "$ARCHIVE_TMP" \
  || { rm -f -- "$ARCHIVE_TMP"; die "compression failed"; }
rm -f -- "$TAR_PLAIN"

[ -s "$ARCHIVE_TMP" ] || { rm -f -- "$ARCHIVE_TMP"; die "produced an empty archive"; }

# Integrity: the archive must be readable end to end before it replaces
# anything. One pass, listing captured so the member count is free.
LISTING="$STAGE/.listing"
tar -tf "$ARCHIVE_TMP" > "$LISTING" 2>/dev/null \
  || { rm -f -- "$ARCHIVE_TMP"; die "archive failed its read-back check — discarded"; }

# and it must actually contain the config tree, not just an empty directory
member_count=$(grep -c "^$CONFIG_NAME/" "$LISTING" || true)
[ "${member_count:-0}" -gt 1 ] \
  || { rm -f -- "$ARCHIVE_TMP"; die "archive contains only ${member_count:-0} member(s) under $CONFIG_NAME/ — discarded"; }

# the §8 exclusion must actually have held
if grep -qE "^$CONFIG_NAME/addon/.*\.db" "$LISTING"; then
  rm -f -- "$ARCHIVE_TMP"
  die "addon index database leaked into the archive — the §8 exclusion is broken"
fi

# ...and every database that was excluded must have come back as a snapshot.
# Without this check a broken exclusion/append pairing ships an archive whose
# *arr databases are simply missing, and nothing notices until a restore.
for member in "${SNAP_MEMBERS[@]:-}"; do
  [ -n "${member:-}" ] || continue
  if ! grep -qxF "$member" "$LISTING"; then
    rm -f -- "$ARCHIVE_TMP"
    die "$member is missing from the archive — the live file was excluded but its snapshot was not appended"
  fi
done

# ...and each snapshot must carry the SAME uid/gid as the live file it stands
# in for. A snapshot archived as root:root restores as root:root, and the
# linuxserver services (PUID=1000) then cannot open their own databases. The
# restore would look successful and the stack would not start.
if [ "$SNAPPED" -gt 0 ]; then
  VLISTING="$STAGE/.listing-v"
  if tar -tvf "$ARCHIVE_TMP" --numeric-owner > "$VLISTING" 2>/dev/null; then
    for member in "${SNAP_MEMBERS[@]:-}"; do
      [ -n "${member:-}" ] || continue
      want="$(stat -c '%u/%g' "$CONFIG_PARENT/$member" 2>/dev/null || true)"
      got="$(awk -v m="$member" '{ if ($NF == m) { print $2; exit } }' "$VLISTING")"
      [ -n "$want" ] && [ -n "$got" ] || { warn "could not verify archived ownership of $member"; continue; }
      if [ "$want" != "$got" ]; then
        rm -f -- "$ARCHIVE_TMP"
        die "$member is archived as $got but the live file is $want — a restore would leave the database unreadable by PUID/PGID. Run this script as root, or as the owner of $CONFIG_ROOT."
      fi
    done
    log "snapshot ownership verified against the live files"
  else
    warn "could not read a verbose listing — skipping the snapshot ownership check"
  fi
fi

chmod 600 "$ARCHIVE_TMP"
mv -f "$ARCHIVE_TMP" "$ARCHIVE"
size_h=$(du -h "$ARCHIVE" | awk '{print $1}')
log "wrote $ARCHIVE ($size_h, $member_count members)"

# ---------------------------------------------------------------------------
# 3. retention — keep the newest $RETENTION archives
# ---------------------------------------------------------------------------
ARCHIVES=()
while IFS= read -r f; do
  if [ -n "$f" ]; then ARCHIVES+=("$f"); fi
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'config-*.tar.*' ! -name '*.part' -printf '%f\n' 2>/dev/null | sort -r)

total=${#ARCHIVES[@]}
if [ "$total" -gt "$RETENTION" ]; then
  for old in "${ARCHIVES[@]:$RETENTION}"; do
    # Narrow by construction: one directory, fixed name pattern, plain files
    # this script wrote itself. Never a recursive delete (C5).
    if rm -f -- "$BACKUP_DIR/$old"; then
      log "pruned $old"
    else
      warn "could not prune $old"
    fi
  done
fi

remaining=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'config-*.tar.*' ! -name '*.part' 2>/dev/null | wc -l)
log "done — $remaining archive(s) retained in $BACKUP_DIR"
exit 0

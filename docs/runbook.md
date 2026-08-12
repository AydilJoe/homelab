# Runbook

Operating procedures for the media stack: start, stop, update, back up,
restore, and the failure modes the spec warns about.

The build spec is kept private; section references (§x.y) point at it. This is the
day-two document.

---

## 0. Where things are

| Thing | Location | Which machine |
|---|---|---|
| This repo | `/opt/homelab` | LXC 101 |
| Compose stack | `/opt/homelab/docker-compose.yml` | LXC 101 |
| Service config (stateful) | `/srv/config` | LXC 101, on the NVMe |
| Media + torrents + backups | `/srv/data` | bind mount of `/dev/sda` |
| Backup timer | `/etc/systemd/system/homelab-backup.{service,timer}` | LXC 101 |
| Container config | `/etc/pve/lxc/101.conf` | Proxmox host |
| vzdump archives | `/srv/data/backups/vzdump/` | written by the host |

Almost everything below runs **inside LXC 101**. Get there from the host with
`pct enter 101`. Steps that must run on the Proxmox host say so explicitly.

First checkout on the LXC — the repo is authored on Windows, so the executable
bit may not survive:

```bash
git clone <remote> /opt/homelab && cd /opt/homelab
chmod +x scripts/*.sh
cp .env.example .env && ${EDITOR:-nano} .env

# The addon container runs as uid 1000 from its first instruction (the
# linuxserver images start as root and chown /config themselves — the addon
# cannot). Docker would otherwise create this bind-mount source as root:root
# and the addon would crash-loop on "unable to open database file".
mkdir -p /srv/config/addon && chown 1000:1000 /srv/config/addon
```

Always run `docker compose` from `/opt/homelab`: the `${CADDYFILE}` mount source
is repo-relative, which is what makes the ingress switch one `.env` line
(ADR-013).

---

## 1. Start / stop / status

```bash
cd /opt/homelab

docker compose up -d                 # start everything
docker compose ps                    # what is running
docker compose logs -f --tail=100 sonarr
docker compose restart jellyfin      # one service
docker compose stop                  # stop, keep containers
docker compose down                  # stop and remove containers (data is in volumes/binds, safe)
```

Whole container, from the **Proxmox host**:

```bash
pct start 101
pct shutdown 101
pct enter 101
```

`restart: unless-stopped` means the stack comes back by itself after a reboot
or a smart-plug power cycle — provided the BIOS is set to power on after power
loss (§5.3, `docs/manual-config.md` #8).

---

## 2. Update

Snapshot first. That is the entire reason this is Proxmox and not bare Debian.

```bash
# ---- on the Proxmox HOST ----
pct snapshot 101 pre-update-$(date +%F)

# ---- inside LXC 101 ----
cd /opt/homelab
git pull
docker compose pull                  # new images
docker compose up -d                 # recreate what changed
docker compose ps

./scripts/verify.sh 3                # services still healthy
./scripts/verify.sh 4                # hardlinks still intact
./scripts/verify.sh 6                # addon + Range still good
```

If it went wrong, roll back on the host: `pct rollback 101 pre-update-<date>`.

Once the new version has proven itself for a few days:

```bash
docker image prune -f                # reclaim the old images
# on the host:
pct delsnapshot 101 pre-update-<date>
```

Rebuild just the addon after code changes:

```bash
docker compose build addon && docker compose up -d addon
curl -s -X POST -H "Authorization: Bearer $ADDON_ADMIN_TOKEN" \
  http://127.0.0.1:7000/admin/rescan          # from a shell on the LXC only
```

`/admin/*` is deliberately unreachable through Caddy (403) and the addon's port
is bound to `127.0.0.1` (§6.5). Do not loosen either to make a rescan more
convenient.

---

## 3. Switching ingress mode (LAN ⇄ tailnet)

LAN is the active default. The tailnet config is written and committed; it is
simply not switched on yet.

**To go tailnet (§5.2), after Phase 2 passes:**

1. `.env`: `CADDYFILE=./caddy/Caddyfile` and
   `PUBLIC_BASE_URL=https://media.<tailnet>.ts.net`
2. `caddy/Caddyfile`: replace `<tailnet>` with the real tailnet name
3. `docker-compose.yml`: uncomment the tailscaled socket mount on the caddy
   service
4. `docker compose up -d caddy addon` (the addon must be recreated — the base
   URL is baked into every stream URL it returns)
5. `./scripts/verify.sh --tailnet 2 6`

**Back to LAN:** reverse steps 1–3, `docker compose up -d caddy addon`.

Any change to `PUBLIC_BASE_URL` invalidates addon stream URLs that Stremio has
cached. Reinstall the addon in the client from the new manifest URL.

---

## 4. Backups

**What runs:** `homelab-backup.timer` fires `scripts/backup.sh` nightly at
03:30 (+ up to 15 min jitter) **inside LXC 101**. `Persistent=true`, so a night
the box was switched off is caught up on the next boot.

**What it produces:** `/srv/data/backups/config-<YYYYmmdd-HHMMSS>.tar.zst`
(or `.tar.gz` if zstd is unavailable), mode 0600, newest 14 kept.

**What is in it:** all of `/srv/config`, with every SQLite database replaced by
a `sqlite3 .backup` snapshot taken at archive time. Copying a live SQLite file
produces corrupt backups that fail silently until you need them (§8) — the
script never does that, and it refuses to ship an archive whose snapshots did
not make it in.

**What is deliberately not in it:** `config/addon/*.db*`. The addon index is
derived state, rebuilt from the filesystem + the *arr APIs + Cinemeta (§8, N5).

**What is not covered at all:** `/srv/data/media` (re-acquirable), and the
container itself (that is the weekly host-side vzdump job).

```bash
systemctl status homelab-backup.timer
systemctl list-timers homelab-backup.timer
journalctl -u homelab-backup -n 100 --no-pager

systemctl start homelab-backup.service     # run one now
/opt/homelab/scripts/backup.sh --dry-run   # show what it would do, write nothing

./scripts/verify.sh 7                      # the Phase 7 gate
```

Tuning without editing the unit — `/etc/default/homelab-backup`:

```
RETENTION=30
BACKUP_COMPRESSION=gzip
BACKUP_EXTRA_EXCLUDES=config/jellyfin/cache/* config/jellyfin/log/*
```

Then `systemctl restart homelab-backup.timer` (no daemon-reload needed for the
env file).

### Restore `/srv/config` from a nightly archive

```bash
cd /opt/homelab
docker compose down                       # nothing may hold the databases open

# Keep the broken config, do not delete it (C5). Disk is cheap; evidence is not.
mv /srv/config /srv/config.broken-$(date +%F-%H%M)
mkdir -p /srv/config

ls -lt /srv/data/backups/config-*          # pick one
tar -xpf /srv/data/backups/config-<stamp>.tar.zst -C /srv --numeric-owner

ls -lan /srv/config                        # linuxserver dirs must be 1000:1000
docker compose up -d
./scripts/verify.sh 3
```

`tar` auto-detects the compression, so the same command works for `.tar.gz`.
Run it as **root**: `-p --numeric-owner` restores exactly the uid/gid recorded in
the archive, and only root may set an owner other than itself.

Then check the ownership before starting anything — this is the step that bites:

```bash
ls -lan /srv/config/*/                     # everything must read 1000 1000
find /srv/config -uid 0 ! -path '/srv/config/addon/*'   # should print nothing
```

The SQLite databases are the ones to watch. They enter the archive as
`sqlite3 .backup` snapshots written by the backup process, so `backup.sh`
explicitly copies each live file's owner and mode onto its snapshot (and refuses
to ship an archive where that did not take). If you are restoring an archive
written before that fix, or you extracted as a non-root user, repair it by hand:

```bash
chown -R 1000:1000 /srv/config/{qbittorrent,prowlarr,sonarr,radarr,bazarr,jellyfin,addon}
```

A database owned by root is the classic silent-failure restore: the extract
reports success and the service will not start, because PUID=1000 cannot open
its own `*.db`.

Restoring **one** service instead of everything:

```bash
mkdir -p /tmp/restore
tar -xpf /srv/data/backups/config-<stamp>.tar.zst -C /tmp/restore --numeric-owner config/sonarr
docker compose stop sonarr
mv /srv/config/sonarr /srv/config/sonarr.broken-$(date +%F-%H%M)
mv /tmp/restore/config/sonarr /srv/config/sonarr
docker compose start sonarr
```

The addon needs no restore — delete its DB and it rebuilds itself:
`docker compose restart addon`, then `curl -s http://127.0.0.1:7000/health`.

### Restore the whole container from vzdump (Proxmox host)

vzdump archives are written by the weekly host job into
`/srv/data/backups/vzdump/` (`docs/manual-config.md` #10).

```bash
# ---- on the Proxmox HOST ----
ls -lt /srv/data/backups/vzdump/

# Safest: restore into a SPARE ctid first and look at it before touching 101.
pct restore 999 /srv/data/backups/vzdump/vzdump-lxc-101-<stamp>.tar.zst \
    --storage local-lvm
pct start 999 && pct enter 999
```

Only overwrite the live container when you are sure. `pct restore 101 ...
--force` **destroys the existing 101** — that is a C5 "ask first" action, and
it is worth taking `pct snapshot 101 pre-restore-$(date +%F)` beforehand even
though you are about to replace it.

Two things to know before relying on this:

- **Bind mounts are not in the vzdump.** `/srv/data` is a host directory bound
  into the container; vzdump skips it. Media, torrents and the backup archives
  themselves are outside the container image by design. A vzdump restore gives
  you the OS, Docker, `/srv/config` and the units — not the library.
- After restoring, re-check `/etc/pve/lxc/101.conf` for the `features:
  nesting=1,keyctl=1` line and the `dev0`/`dev1`/`dev2` passthroughs (§2), then
  run `./scripts/verify.sh 1` inside the container.

---

## 5. Verification

```bash
cd /opt/homelab
./scripts/verify.sh 1          # devices, docker, idmap, bind mount
./scripts/verify.sh 2          # networking (tailnet gates SKIP in LAN mode)
./scripts/verify.sh 3          # compose up + service health
./scripts/verify.sh 4          # hardlinks
./scripts/verify.sh 5          # transcode preconditions + host instructions
./scripts/verify.sh 6          # addon manifest / health / Range 206
./scripts/verify.sh 7          # timer + archives
./scripts/verify.sh all
./scripts/verify.sh --tailnet 2 6
```

Non-zero exit means a gate failed. Stop there; do not advance a phase (§0.3).

---

## 6. Failure modes

### 6.1 Hardlinks broken — link count 1

**Symptom:** `stat -c '%h %n' /srv/data/media/movies/*/*.mkv` reports `1`.
Free space falls twice as fast as it should. `verify.sh 4` fails.

**Meaning:** the import **copied**. Every imported file now exists twice.

**Cause, in order of likelihood:**

1. A container mounts a *subpath* instead of `${DATA_ROOT}:/data`. qBittorrent,
   Sonarr, Radarr and Bazarr must all mount the same root at the same path — a
   hardlink cannot cross a mount boundary even when both sides are the same
   physical disk (§3.2, C4).
2. Download path and library path are on different filesystems (`stat -c '%d'`
   on both — `verify.sh 4` checks this first because it is the root cause).
3. "Use Hardlinks instead of Copy" is off in Sonarr/Radarr → Media Management.
4. Permissions: the *arr cannot create the link and silently falls back to copy.

**Fix:** correct the mounts, `docker compose up -d`, then re-import **one** test
file and re-check. Old copied files stay duplicated until you re-import them.

**False alarm:** a file whose torrent was removed after seeding legitimately
drops to 1 link. Test the gate on a *fresh* import, not an aged library.

### 6.2 Certificate fetch failing (tailnet mode)

**Symptom:** Caddy logs `failed to get certificate` / clients get a self-signed
cert; `verify.sh --tailnet 2` fails on the openssl check.

**Check in this order:**

1. `tailscale status` **inside LXC 101** — the node must exist and be named
   `media`. A host-level Tailscale acting as a subnet router cannot produce this
   cert: Tailscale issues certs only for a node's own MagicDNS name (§5.2).
2. Tailnet admin console → DNS: MagicDNS **and** HTTPS Certificates both on
   (`docs/manual-config.md` #7). This is the usual answer.
3. The tailscaled socket is mounted into the Caddy container:
   `/var/run/tailscale/tailscaled.sock` — uncommented in `docker-compose.yml`
   for tailnet mode.
4. tailscaled must permit the fetch. Caddy runs as root in its image, which is
   sufficient; if you changed that, set `TS_PERMIT_CERT_UID` on tailscaled.
5. `/dev/net/tun` present in the container (`dev2` in `101.conf`) — without it
   tailscaled never comes up at all.

Nothing here affects LAN mode. If certs are fighting you, switch back to
`caddy/Caddyfile.lan` and keep building; Phase 2 is deferrable.

### 6.3 `unmatched` keeps growing in the addon

**Symptom:** `/addon/health` row count stalls while the library grows; the
`unmatched` table fills up.

**Meaning:** files are being found but not resolved to an IMDb ID. They are
never silently dropped — each row carries a reason (§6.3, §6.4).

**Check:**

```bash
sqlite3 /srv/config/addon/*.db 'SELECT reason, COUNT(*) FROM unmatched GROUP BY reason;'
sqlite3 /srv/config/addon/*.db 'SELECT rel_path, reason FROM unmatched LIMIT 20;'
```

**Common causes:**

1. `RADARR_API_KEY` / `SONARR_API_KEY` missing or stale in `.env` — the primary
   resolution path is the *arr APIs, and without it everything falls to the
   Cinemeta fallback, which is far less reliable.
2. Files dropped into `/srv/data/media` by hand that no *arr knows about. The
   Cinemeta fallback parses the filename; badly named files do not resolve.
   Rename to `Title (Year)/Title (Year) [quality].ext` and rescan.
3. Non-English titles — the known accuracy gap (open item O1). Only affects
   `cinemeta`-matched rows; the *arr path is unaffected.
4. Sonarr occasionally has no `imdbId` for a series; those route through the
   Cinemeta fallback too.

**Fix:** correct the cause, then `POST /admin/rescan` from a shell on the LXC.
The index is disposable — deleting the DB and restarting the addon is always
safe (N5), which is exactly why the nightly backup excludes it.

### 6.4 Transcode gate "fails" — but only inside the LXC

**Symptom:** `intel_gpu_top` run in LXC 101 shows no engine activity, or dies
with a permission error, while Jellyfin is visibly transcoding fine.

**This is a false failure.** i915 PMU (perf) access is blocked inside both the
Jellyfin container and the unprivileged LXC on PVE 9 (AppArmor). Transcoding
itself works there; only the *measurement* is blocked (§7 Phase 5).

**Do this instead — on the Proxmox HOST:**

```bash
apt install intel-gpu-tools
intel_gpu_top          # 'Video' engine busy while a transcode plays
```

And confirm the Jellyfin dashboard says "Transcoding (hw)", not software.
`verify.sh 5` never fails on this; it checks what the LXC *can* see (the device
node, and the Jellyfin container's view of it) and prints the host commands.

AV1 **encode** is unavailable on the UHD 770 by design. AV1 decode works. Do
not chase it (§1, §9).

### 6.5 `/srv/data` shows up as `nobody:nogroup`

**Symptom:** imports fail with permission errors; `ls -lan /srv/data` inside the
LXC shows `65534`; `verify.sh 1` fails the uid-1000 write test.

**Cause:** the unprivileged LXC maps container UID `X` to host `100000+X`, and
`/srv/data` on the host is not owned by `101000:101000` (§3.3).

**Fix, on the Proxmox HOST:** `chown -R 101000:101000 /srv/data`, then re-check
inside the LXC — it must read `1000 1000`.

### 6.6 Docker will not start / `hello-world` fails inside the LXC

`features: nesting=1,keyctl=1` is missing from `/etc/pve/lxc/101.conf` (§2).
Set it on the host, `pct stop 101 && pct start 101` (a reboot from inside does
not re-read the config), re-run `verify.sh 1`.

### 6.7 Stremio will not install the addon

- **Desktop, LAN mode:** should work. Use `http://<lxc-lan-ip>/addon/manifest.json`
  — the LXC's LAN IP, matching `PUBLIC_BASE_URL`. `localhost` will not do.
- **Web / iOS / Android, LAN mode:** they refuse plain-HTTP addon URLs. This is
  a client policy, not a bug, and there is no LAN workaround — those clients
  need the tailnet phase (§5.2).
- **Streams appear but will not play or seek:** check `verify.sh 6`. A ranged
  GET must return **206** with `Content-Range`. A 200 means the player cannot
  seek. Caddy's `file_server` does this natively; the usual cause is the
  `/media/*` route or the read-only media mount being wrong.
- **Manifest 404s:** Caddy strips the `/addon` prefix (`handle_path`), so the
  addon serves `/manifest.json` at its own root, not `/addon/manifest.json`.

### 6.8 Backups stopped happening

```bash
systemctl list-timers homelab-backup.timer     # is there a next elapse?
journalctl -u homelab-backup -n 200 --no-pager
df -h /srv/data                                # out of space?
```

The script fails loudly rather than writing a bad archive. Likely causes: the
disk is full (it needs roughly twice the size of `/srv/config` free), a stale
`.sqlite-stage.*` directory or `.config-*.part` file in `/srv/data/backups` from
a killed run (it warns and lists them; remove by hand), or `sqlite3` missing
after a rebuild (`apt install sqlite3`).

Both stale names start with a dot deliberately, so a half-written archive can
never be mistaken for a real one by the retention scan or the Phase 7 gate.

A backup you have never restored is a hypothesis. Do a restore drill into a
throwaway directory once, at the start.

---

### 6.9 A URL base was changed and something broke quietly

Symptom: an integration stops working with no visible error — the addon starts
resolving everything through Cinemeta, library refreshes stop, Prowlarr syncs
nothing, or Seerr cannot reach an *arr.

Cause: every app is served at a path (`/radarr`, `/sonarr`, `/jellyfin`,
`/bazarr`, `/prowlarr` — manual-config 19) and **every internal caller must
carry that base too**. Four callers broke this way on 2026-08-12 and none of
them logged an obvious failure.

```bash
# the four places a base path has to appear
grep -E 'RADARR_URL|SONARR_URL' docker-compose.yml     # addon
# Radarr/Sonarr -> Settings -> Connect -> Jellyfin      -> urlBase = /jellyfin
# Prowlarr      -> Settings -> Apps                     -> baseUrl = http://radarr:7878/radarr
# Seerr         -> Settings -> Services                 -> Base URL = /radarr
```

Also: a `202` from an *arr `config/host` PUT writes `UrlBase` to `config.xml`
but does **not** reload it. Restart the container or it keeps serving at root
while the file says otherwise — which looks like the setting "did not save".

### 6.10 Nothing is running after a reboot (dev box)

Every container is `restart: unless-stopped`, so the whole stack returns on its
own once the Docker engine is up — a full `compose down` / `up` reached serving
in 12 seconds with the tailnet node keeping its IP. If nothing is running, the
engine itself never started.

Docker Desktop starts at **login**, not at boot, and only if
*Settings → General → "Start Docker Desktop when you sign in"* is enabled
(manual-config 21). A remote power-cycle therefore leaves the machine at the
lock screen with nothing serving. LXC 101 has no equivalent problem.

```bash
docker compose ps                     # expect 10 Up
cd /opt/homelab && docker compose up -d
```

First HTTPS request after a restart can take ~20 s while Caddy re-fetches the
certificate from tailscaled. That is expected, not a failure — retry once.

## 7. Out-of-scope reminders

- `miaarief.vercel.app` is not part of this and never gets proxied here (C1).
- VM 201 (Ollama) is not created until RAM is 32 GB (C6).
- Prowlarr indexers are an operator decision, recorded in
  `docs/manual-config.md` — the build never selects or recommends one (§13).

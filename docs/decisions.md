# Architecture decisions

Short-form ADRs. Each one records what was decided, why, and what it costs —
so a future change is an informed reversal rather than an accident.

Status values: **Accepted** · **Superseded** · **Deferred**.
Unless noted, decisions are carried over from build spec v2.1 (2026-08-12).

| ADR | Decision | Status |
|-----|----------|--------|
| [001](#adr-001) | Proxmox, not bare Debian | Accepted |
| [002](#adr-002) | Proxmox VE 9, not 8 | Accepted |
| [003](#adr-003) | LXC, not a VM, for the media stack | Accepted |
| [004](#adr-004) | ext4 on a single drive, not ZFS | Accepted |
| [005](#adr-005) | Tailscale inside LXC 101, not on the host | Accepted |
| [006](#adr-006) | The addon returns URLs, not bytes | Accepted |
| [007](#adr-007) | No `meta` handler | Accepted |
| [008](#adr-008) | O2 — duplicate qualities: return all, best first | Accepted |
| [009](#adr-009) | LAN-first rollout, tailnet deferred | Accepted |
| [010](#adr-010) | Backups on the SATA disk; addon index excluded | Accepted |
| [011](#adr-011) | Indexer selection belongs to the operator | Accepted |
| [012](#adr-012) | Repo at `/opt/homelab`; backup timer inside LXC 101 | Accepted |
| [013](#adr-013) | Caddyfile mounted from the repo, not `${CONFIG_ROOT}/caddy` (§4 deviation) | Accepted |
| [014](#adr-014) | Local Windows dev box runs both trees on one drive | Accepted (dev only) |
| [015](#adr-015) | Interim HTTPS via a host-level Tailscale cert | **Superseded by 016** |
| [016](#adr-016) | tailscaled as a container; Caddy shares its netns | Accepted |
| [017](#adr-017) | Every UI on one origin at a path; Seerr on a port | Accepted |

---

## ADR-001 — Proxmox, not bare Debian {#adr-001}

**Status:** Accepted · 2026-08-12 (supersedes spec v1.0, which assumed bare Debian)

**Context.** One physical box carries two roles: a media stack that should be
boring and stable, and a dev host for Ollama, Kafka experiments, staging
environments and agent runs — the exact workloads that get torn down and
rebuilt.

**Decision.** Run Proxmox VE on the metal; put the media stack in LXC 101, dev
work in LXC 102, and (later) Ollama in VM 201.

**Consequences.** Snapshot before every risky change and roll back in seconds.
A dev environment can be destroyed without touching media. Costs ~1.5 GB RAM
for the hypervisor and one more layer to understand. Docker-in-LXC then needs
`nesting=1,keyctl=1`, which is a real footgun if forgotten — it is the Phase 1
gate.

---

## ADR-002 — Proxmox VE 9, not 8 {#adr-002}

**Status:** Accepted · 2026-08-12

**Context.** The build starts after 2026-08-30. PVE 8 is Debian 12-based; PVE 9
is Debian 13-based.

**Decision.** Install PVE 9.

**Consequences.** A fresh install on PVE 8 would buy an immediate major-version
upgrade for no benefit. The cost is that some third-party guides still assume
PVE 8, and PVE 9's AppArmor policy is what blocks i915 PMU access inside
unprivileged containers — the reason the transcode check moved to the host
(ADR-003, §7 Phase 5).

---

## ADR-003 — LXC, not a VM, for the media stack {#adr-003}

**Status:** Accepted · 2026-08-12

**Context.** Jellyfin needs the Intel UHD 770 for Quick Sync. There is exactly
one iGPU and the host also uses it.

**Decision.** Unprivileged LXC 101 with device passthrough for `/dev/dri`
(`dev0` renderD128, `dev1` card0), plus `/dev/net/tun` for tailscaled.

**Consequences.** Device binding into a container is far more robust than
GPU passthrough of a single iGPU to a VM, which requires taking the device away
from the host. The cost is container-shaped: uid mapping (container 1000 → host
101000) has to be got right or the bind mount appears as `nobody:nogroup`
(§3.3); container gids for `render`/`video` must match `group_add` in compose;
and performance counters (`intel_gpu_top`) are unavailable inside the LXC, so
the transcode gate is confirmed on the host instead.

---

## ADR-004 — ext4 on a single drive, not ZFS {#adr-004}

**Status:** Accepted · 2026-08-12

**Context.** One 3.5" CMR SATA drive for bulk storage, 16 GB RAM at build time
shared with the dev-host role. The workload is write-once, read-many media.

**Decision.** ext4 on `/dev/sda`, mounted `/srv/data` on the host and bind
mounted into LXC 101.

**Consequences.** No checksumming, no send/receive, no cheap snapshots of the
media pool. In exchange, ARC does not compete with dev workloads for RAM, and
there is no pool to babysit. ZFS on a single drive would detect corruption it
could not repair anyway. Growth path is mergerfs + SnapRAID once a second drive
exists (§3.4) — documented, not implemented. The residual risk is open item O3:
one drive, no redundancy.

---

## ADR-005 — Tailscale inside LXC 101, not on the Proxmox host {#adr-005}

**Status:** Accepted · 2026-08-12 (supersedes spec v2.0, which put tailscaled on the host)

**Context.** Caddy needs a TLS certificate for `media.<tailnet>.ts.net`.
Tailscale issues certificates only for a node's **own** MagicDNS name.

**Decision.** Run tailscaled inside LXC 101 with the node name `media`; Caddy
fetches the cert through the tailscaled socket mounted into its container.

**Consequences.** A host-level Tailscale acting as a subnet router cannot
produce that certificate — this is an identity constraint, not a routing one.
Requires `/dev/net/tun` in `101.conf`. The security consequence is sharp and
load-bearing: because tailscaled lives in this LXC, any `0.0.0.0` port publish
is exposed tailnet-wide, which is why the addon binds to `127.0.0.1:7000` and
Caddy answers 403 for `/addon/admin/*` (§6.5). A subnet router on the host for
reaching the Proxmox UI stays optional and nothing depends on it.

---

## ADR-006 — The addon returns URLs, not bytes {#adr-006}

**Status:** Accepted · 2026-08-12

**Context.** Stremio needs a playable URL per stream. The addon could proxy the
file itself or hand back a URL to something else.

**Decision.** The addon returns
`PUBLIC_BASE_URL + "/media/" + urlencode(rel_path)`. Caddy's `file_server`
serves the bytes.

**Consequences.** Range requests, seeking, and throughput become Caddy's
problem — a static file server does that well and the addon stays inside its
256 MB ceiling (N6) while streaming 4K. A Node process proxying video would be
the bottleneck and the memory risk. The cost is that `PUBLIC_BASE_URL` is baked
into every returned URL, so changing ingress mode means recreating the addon
and reinstalling it in the client; and the "does seeking work" gate becomes a
Caddy property — a ranged GET must return 206, not 200 (§7 Phase 6).

---

## ADR-007 — No `meta` handler {#adr-007}

**Status:** Accepted · 2026-08-12

**Context.** Stremio addons may serve their own detail-page metadata.

**Decision.** Do not implement one. Use IMDb IDs (`idPrefixes: ["tt"]`) and let
Cinemeta supply descriptions, cast and artwork.

**Consequences.** No metadata to maintain, scrape, or keep fresh, and the
detail page looks native because it *is* the standard one. The cost: everything
hinges on resolving files to IMDb IDs (§6.3), and titles that never resolve
land in `unmatched` rather than appearing with degraded metadata. Catalog tiles
are the one thing Cinemeta cannot help with, so the addon supplies `poster`
from `images.metahub.space` in its own catalog responses — still no local
poster hosting.

---

## ADR-008 — O2: duplicate qualities return all streams, best first {#adr-008}

**Status:** Accepted · **Owner decision, 2026-08-12** (resolves open item O2)

**Context.** The library can hold several files for one title — a 1080p and a
2160p rip, or two different releases. §6.6 was undefined on whether the stream
response should return one or many. The spec required asking rather than
guessing.

**Decision.** Return **all** matching files as separate streams, sorted best
first: **resolution descending, then size descending**.

**Consequences.** The viewer chooses, which matters on a mixed setup where the
"best" file is not always the playable one — a 2160p HEVC file may not direct
play on a client that handles the 1080p H.264 copy fine (§9). Each stream
carries its own `description`/`title` line (`1080p • H.264 • 4.2 GB`) so the
choice is legible, and `behaviorHints.bingeGroup` keeps binge-play coherent.
The cost is a busier stream list for titles with duplicates, and a sort that
must stay deterministic so the list does not reshuffle between requests. No
deduplication happens: if the list is noisy, the fix is in the library, not in
the addon.

---

## ADR-009 — LAN-first rollout, tailnet deferred {#adr-009}

**Status:** Accepted · 2026-08-12 · **current active mode**

**Context.** The spec's end state is HTTPS on the tailnet (§5.2). That depends
on a tailnet, MagicDNS, HTTPS certificates and a working cert fetch — none of
which are needed to build, test or use the stack on the local network.

**Decision.** Ship LAN mode as the active default: Caddy serves plain HTTP on
`:80` (`caddy/Caddyfile.lan`), `PUBLIC_BASE_URL=http://<lxc-lan-ip>`. The
tailnet configuration is written, committed and unchanged — just not switched
on. Mode is one line in `.env`.

**Consequences.** Nothing requires a tailnet to work today, and Phase 2 becomes
a deferrable gate that `verify.sh` reports as SKIPPED rather than failed.

The cost is a real client limitation, and it is the reason this is an ADR and
not a footnote: **Stremio Desktop accepts plain-HTTP addon URLs and works over
the LAN; Stremio Web, iOS and Android refuse plain HTTP and will not install
the addon at all.** There is no LAN workaround — those clients need TLS, which
means completing Phase 2. Jellyfin's own clients are unaffected.

Also deferred with it: remote access from outside the house, and the §5.3
smart-plug recovery path being reachable alongside the stack. Revisit by
following `docs/runbook.md` §3.

---

## ADR-010 — Backups live on the SATA disk; the addon index is excluded {#adr-010}

**Status:** Accepted · 2026-08-12

**Context.** `/srv/config` is the one thing that is not re-acquirable. It lives
on the NVMe. The addon's SQLite index also lives under `/srv/config`.

**Decision.** Write nightly archives to `/srv/data/backups` on `/dev/sda`, and
exclude `config/addon/*.db*` from them. Every other SQLite database is captured
with `sqlite3 .backup`, never copied live.

**Consequences.** An NVMe failure cannot take the config and its backups
together — the whole point of putting them on the other spindle. The index is
derived state, fully rebuildable from the filesystem, the *arr APIs and
Cinemeta (N5), so archiving it would only add a live-SQLite copy and bulk.
Copying a live SQLite file yields backups that fail silently until you need
them, so `.backup` is mandatory, and `scripts/backup.sh` refuses to ship an
archive whose snapshots did not make it in. Costs: the backup run needs roughly
twice the size of `/srv/config` free on `/srv/data`, and this covers nothing
offsite — parity and snapshots are not backups.

---

## ADR-011 — Indexer selection belongs to the operator {#adr-011}

**Status:** Accepted · 2026-08-12

**Context.** Prowlarr ships with no indexers. The rest of the stack is
completely source-agnostic: it behaves identically against Internet Archive
collections, public-domain film libraries, Creative Commons material, Linux
distribution trackers and paid Usenet providers.

**Decision.** The build does not select, configure, or recommend any indexer,
anywhere — not in code, not in compose, not in docs. Prowlarr is left empty and
flagged for manual setup in `docs/manual-config.md`.

**Consequences.** Phase 3 is not "done" until a human makes that choice, and
the stack does nothing useful until they do. That is intentional: automation
raises acquisition volume substantially over manual use, and under Malaysian
law this sits with the Copyright Act 1987, with ISPs acting on rightsholder
notices. Indexer selection is the single point where the deployment's legal
profile is determined, which is why it is an operator decision and not a build
step.

---

## ADR-012 — Repo at `/opt/homelab`; the backup timer runs inside LXC 101 {#adr-012}

**Status:** Accepted · 2026-08-12

**Context.** The units, the scripts and the compose file all reference paths.
Something had to fix them.

**Decision.** The repo is checked out at `/opt/homelab` **inside LXC 101**.
`homelab-backup.service` runs `/opt/homelab/scripts/backup.sh`; the timer is
installed in the container, not on the host. Overrides go in
`/etc/default/homelab-backup` so the committed unit never needs local edits.

**Consequences.** `/srv/config` only exists inside LXC 101 — a host-side timer
would archive an empty directory and report success, which is the worst
possible failure mode for a backup. Compose is also run from the repo directory
because `${CADDYFILE}` is a relative path (ADR-013). Moving the checkout means
editing `ExecStart` and `WorkingDirectory` in the service unit — the only place
the path is assumed. The host keeps its own separate job: weekly vzdump into
`/srv/data/backups/vzdump/`.

---

## ADR-013 — The Caddyfile is mounted from the repo, not `${CONFIG_ROOT}/caddy` {#adr-013}

**Status:** Accepted · 2026-08-12 · **deliberate deviation from spec §4**

**Context.** The §4 compose fragment mounts
`${CONFIG_ROOT}/caddy/Caddyfile:/etc/caddy/Caddyfile:ro` — one ingress file,
living in the stateful tree, edited in place. This build ships **two** ingress
configurations (ADR-009: LAN active, tailnet written but not switched on), and
the switch between them has to be reviewable and revertable.

**Decision.** Mount `${CADDYFILE:-./caddy/Caddyfile.lan}` instead: a
repo-relative path selected by one `.env` variable. Both files are committed.
`${CONFIG_ROOT}/caddy/data` is still mounted for cert storage exactly as §4
says — only the config file's source moved.

**Consequences.** Both ingress modes stay under version control and a mode
switch is a diffable one-line change rather than an in-place edit of an
unversioned file. Three costs, all real:

- The mount source is **relative**, so `docker compose` must be invoked from the
  repo directory (or with `--project-directory`). The systemd unit sets
  `WorkingDirectory` and the runbook says so; nothing else may assume otherwise.
- The file no longer lives under `/srv/config`, so it is not in the nightly
  archive (§8). It does not need to be — it is in git, which is the recoverable
  column of §8's table.
- It is a documented departure from a spec fragment. Anyone reconciling §4
  against `docker-compose.yml` will find this line different; that is what this
  ADR exists to explain. The alternative — a deploy-time symlink
  `${CONFIG_ROOT}/caddy/Caddyfile` → the chosen repo file — was rejected as one
  more piece of unversioned state that can silently disagree with `.env`.

Selecting the file is one `.env` line. The **full** tailnet switch is not:
`<tailnet>` must be substituted in `caddy/Caddyfile` and the tailscaled socket
mount uncommented in compose. `docs/runbook.md` §3 is the authoritative
sequence, and `scripts/verify.sh 2` runs `caddy validate` against both files so
a syntax error in the inactive one cannot lie in wait for the switch.

---

## ADR-014 — On the local Windows dev box both trees share one drive {#adr-014}

**Status:** Accepted · 2026-08-12 · **development host only — must not carry over**

**Context.** The target is the Proxmox LXC of §3.1: `/srv/config` on the NVMe,
`/srv/data` (media, torrents, backups) on `/dev/sda`. The machine this repo is
being built on is a Windows box with one data drive, `E:`.

**Decision.** On the dev box, `CONFIG_ROOT=E:/AIO_JELL_CONFIG` and
`DATA_ROOT=E:/AIO_JELL_MEDIA` — two sibling trees on one filesystem. `.env` on
the LXC uses `/srv/config` and `/srv/data`, as `.env.example` ships.

**Consequences.** The trees are separate, which is what §3.2 actually requires:
`${DATA_ROOT}` is bind-mounted at `/data` in qBittorrent, Sonarr, Radarr and
Bazarr for the hardlink contract, so a `CONFIG_ROOT` nested inside `DATA_ROOT`
would expose every *arr database and API key read-write at `/data/config` in all
four containers. That must never happen in either environment.

What is **not** satisfied on the dev box is §8's disk separation: backups land on
the same physical drive as the config they protect, so a drive failure takes
both. `scripts/backup.sh` warns about this (it does not block — a single-disk
test run still beats no backup), and `verify.sh 7` **fails** its same-filesystem
check there by design. That failure is expected on the dev box and is a genuine
gate failure on the LXC. §8's guarantee is void until the stack runs on the real
two-device layout.

**Hardlinks DO work on the dev box — correcting an earlier claim (see also ADR-015).** During the
2026-08-12 build it was asserted (twice, in conversation) that Docker Desktop
bind mounts cannot hardlink and that imports on Windows would therefore cost
double the space. **That is wrong.** Verified on a real import:

```
> fsutil hardlink list "E:\AIO_JELL_MEDIA\media\movies\...\<file>.mkv"
\AIO_JELL_MEDIA\media\movies\...\<file>.mkv
\AIO_JELL_MEDIA\torrents\...\<file>.mkv          # same on-disk data, 4.95 GB once
```

Both `${DATA_ROOT}` paths are on one NTFS volume, so `link()` from inside the
container succeeds exactly as it would on ext4. The §7 Phase 4 gate passes here.

The false conclusion came from testing with `importMode: Move`, which by
definition leaves a link count of 1 — there is only ever one name after a move.
That `1` was misread as "hardlinks unavailable". **When checking this on
Windows, use `fsutil hardlink list <file>` and expect two paths;** `stat -c '%h'`
through `docker exec` reports `1` on NTFS-backed bind mounts even for genuinely
linked files, so it is not a usable check on this host. On the LXC, `stat -c
'%h'` returning `2` is authoritative, as §7 Phase 4 specifies.

---

## ADR-015 — Interim HTTPS via a host-level Tailscale certificate {#adr-015}

**Status:** ~~Accepted~~ **Superseded by [ADR-016](#adr-016) the same day** — the
socket-sharing approach turned out to work in Docker, removing the expiry and
the wrong node name entirely. Retained because the reasoning about why Stremio
rejects plain HTTP still applies, and because `caddy/Caddyfile.tshost` and
`scripts/tscert-renew.ps1` remain in the tree.

**Context.** Stremio Web and the iOS/Android apps run on an HTTPS origin
(`web.stremio.com`). Browsers block an HTTPS page from fetching a plain-HTTP
URL, so adding the addon over LAN HTTP fails with `Failed to fetch` before a
request leaves the client — the server never sees it, and `curl` against the
same URL succeeds, which makes it look like a client bug. Modern Stremio
*Desktop* (v5) loads the same web UI in a webview and is affected too; the
repo's earlier note that "Stremio Desktop accepts plain-HTTP addon URLs" was
true of v4 and is now wrong.

§5.2's answer is TLS from a Tailscale-issued certificate, fetched by Caddy from
tailscaled over a unix socket. That requires tailscaled in the same context as
Caddy — true in LXC 101, false here, where Tailscale is a Windows service and a
Linux container has no socket to mount.

**Decision.** Issue the certificate out-of-band with `tailscale cert` for this
machine's own MagicDNS name, mount the files read-only at `/tscert`, and point
Caddy at them with a static `tls <cert> <key>`. Third ingress file,
`caddy/Caddyfile.tshost`, selected via `CADDYFILE` in `.env`. It also keeps the
plain-HTTP `:80` site so nothing that already worked on the LAN breaks.

```
node:  <host-node>.<tailnet>.ts.net    (NOT media.<tailnet> — see below)
cert:  ${CONFIG_ROOT}/caddy/tscert/tsnode.{crt,key} -> /tscert:ro
```

**Consequences.**

- **It does not self-renew.** A static `tls` pair is read at load. Certs last 90
  days; this one expires **2026-11-10**. `scripts/tscert-renew.ps1` re-issues,
  restarts Caddy, and verifies a 200 — it no-ops above 30 days remaining, so a
  weekly Task Scheduler job is the intended use. If it stops running, HTTPS
  simply dies on that date. The §5.2 socket approach has no such failure mode,
  which is the clearest argument that this is scaffolding.
- **The name is wrong for the target.** The cert is for this Windows host, not
  the `media` node LXC 101 will register. A cert for `media.<tailnet>.ts.net` is
  obtainable only on a node actually named `media` — the entire reason §5.2 puts
  tailscaled in the LXC. So `PUBLIC_BASE_URL` and every stream URL derived from
  it change again at migration; the addon rebuilds them on rescan, so it is a
  `.env` edit plus a rescan, not a data migration.
- **Reachability is tailnet-only.** `<host-node>.<tailnet>.ts.net` resolves
  only for devices signed in to this tailnet. Phones need the Tailscale app.
  That is strictly better than the LAN-only status quo (it works away from home)
  but it is not "works on any device" — see O5.
- **Discovered while implementing:** `tailscale cert` intermittently fails with
  `SetDNS ... unexpected EOF` from the control plane. Transient; the renew
  script retries four times. Network health was verified independently
  (`netcheck` clean, control plane reachable in 200 ms) before concluding this.

**Migration back to §5.2.** Set `CADDYFILE=./caddy/Caddyfile.tshost` back to
`./caddy/Caddyfile`, substitute the real tailnet in it, uncomment the tailscaled
socket mount in `docker-compose.yml`, drop the `/tscert` mount, update
`PUBLIC_BASE_URL`, and delete `scripts/tscert-renew.ps1`. Nothing in the addon,
the compose services, or the media layout is affected.

---

## ADR-016 — tailscaled as a container, superseding the host-level cert {#adr-016}

**Status:** Accepted · 2026-08-12 · **supersedes ADR-015**

**Context.** ADR-015 got HTTPS working but on borrowed time: a static
`tls <cert> <key>` pair issued from the *host* Tailscale, for the wrong node
name, expiring 2026-11-10 and dependent on a scheduled task nobody would notice
failing. §5.2's design — tailscaled beside Caddy, `get_certificate tailscale`,
self-renewing — was assumed to need the LXC. It does not; it needs tailscaled
and Caddy to share a socket, which Docker can arrange anywhere.

**Decision.** Run `tailscale/tailscale` as a service with `hostname: media`, and
give Caddy `network_mode: "service:tailscale"` so it listens inside that node's
network namespace. The tailscaled socket is shared through a named volume, and
`caddy/Caddyfile` — the §5.2 file already in the repo — becomes the active
ingress.

```
node:  media.<tailnet>.ts.net     100.122.44.27
cert:  issued and renewed by tailscaled, fetched over the shared socket
```

**Consequences.**

- **No expiry to manage.** Caddy renews through tailscaled.
  `scripts/tscert-renew.ps1` and `caddy/Caddyfile.tshost` are now dead weight,
  kept only as the documented record of ADR-015.
- **The name is the target name.** `media.<tailnet>.ts.net` is what LXC 101
  will register, so `PUBLIC_BASE_URL` and every stream URL derived from it
  survive the migration untouched — the addon is installed in Stremio once.
- **Ports and networks move to the tailscale service.** Caddy declares neither;
  both belong to the namespace owner. `jellyfin`/`addon` still resolve because
  that namespace sits on `medianet`.
- **Two traps, both hit during implementation:**
  1. `TS_SOCKET` **must** be set to the shared path. By default the image puts
     the real socket at `/tmp/tailscaled.sock` and leaves a *symlink* at
     `/var/run/tailscale/tailscaled.sock`. `/tmp` is not shared, so Caddy
     follows the symlink into its own empty `/tmp` and every handshake fails
     with `connect: no such file or directory` — while `ls` in both containers
     shows the path present, which is thoroughly misleading.
  2. A bare tailnet-only site makes Caddy's automatic HTTPS redirect `:80` to
     `https://<lan-ip>/`, which the tailnet certificate does not cover, so
     non-tailnet LAN devices get a certificate error instead of the dashboard.
     An explicit `:80` block restores plain HTTP for them. This is an addition
     to §5.2 and should be kept when the config moves to the LXC.
- **First handshake is slow** (~24 s) while tailscaled obtains the certificate,
  and logs one `unexpected output: no delimiter` error before succeeding.
  Expected once per certificate, not a fault.
- **Reachability is still tailnet-only** for the HTTPS name (O5 unchanged), and
  the host-level Tailscale node `<host-node>` remains — harmless, but its old
  stream URLs stop working the moment this Caddyfile takes over, which is why
  the addon must be recreated (not merely rescanned) to re-read
  `PUBLIC_BASE_URL`.


---

## ADR-017 — Every UI on one origin at a path; Seerr on a port {#adr-017}

**Status:** Accepted · 2026-08-12

**Context.** With tailscaled in a container (ADR-016), Caddy answers on the
`media` node — but the service ports publish on the *host's* network stack, so
`media:8096` refused while `<host-node>:8096` answered. The dashboard papered
over this by linking management UIs at a second hostname over plain HTTP. That
worked, exposed two hostnames, dropped TLS, and would not survive the move to
LXC 101 where the split does not exist.

**Decision.** Give every app a URL base matching a Caddy path and serve them all
from the single `media` origin:

```
/jellyfin/  /radarr/  /sonarr/  /prowlarr/  /bazarr/  /qbittorrent/  /addon/
```

`handle`, not `handle_path`, for all but qBittorrent — the prefix must reach the
app, which builds its own asset links from it. qBittorrent has no URL-base
setting, so its prefix *is* stripped and `Origin`/`Referer` are rewritten to
satisfy its CSRF check.

**Seerr is the exception and gets its own TLS port (5055).** It inherits
Overseerr's lack of subpath support: behind `/seerr/*` the HTML loads and every
script and API call 404s. Same hostname and certificate, so it remains one
origin in practice. A companion plain-HTTP `:5055` block was tried and removed —
Caddy cannot serve TLS and HTTP on one port, and it made every LAN request
answer *"Client sent an HTTP request to an HTTPS server"*.

**Consequences.**

- One hostname, one certificate, no `PORT_HOST` map in the dashboard, and the
  configuration is *more* correct for LXC 101 than what it replaced.
- **Every internal caller must carry the base path.** Four broke silently on the
  day: the *arr → Jellyfin notifications (400), Prowlarr → Radarr/Sonarr, the
  addon's `RADARR_URL`/`SONARR_URL` (fell back to Cinemeta without erroring),
  and Seerr's own service entries. This is the standing tax of the decision and
  is written up in manual-config 19 and runbook 6.9.
- A `202` from an *arr config PUT persists `UrlBase` but does not reload it;
  the container must be restarted. Easy to misread as "the setting did not save".
- Native Jellyfin apps still take a bare `host` and find the base themselves, so
  the dashboard offers the proxied path for browsers and the bare origin for apps.
- Seerr sitting on a port means a plain-HTTP LAN page cannot probe its status —
  the dashboard shows a hollow "unknown" dot there rather than a red one, since
  "cannot check" is not "down".

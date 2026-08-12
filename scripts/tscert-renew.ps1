# Renew the Tailscale TLS certificate used by caddy/Caddyfile.tshost (ADR-015).
#
# NOTE: ASCII only, deliberately. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless the file has a UTF-8 BOM, so non-ASCII punctuation in comments gets
# mangled and can break the parser. Keep it plain.
#
# WHY THIS SCRIPT EXISTS. The spec's section 5.2 ingress has Caddy fetch certs
# from tailscaled over a unix socket and renew them itself. That needs
# tailscaled in the same context as Caddy: true in LXC 101, false on this
# Windows box where tailscaled is a host service. So the cert is issued
# out-of-band and mounted as static files, and static files expire.
#
# Tailscale/Let's Encrypt certs last 90 days. This script no-ops while more
# than 30 days remain, so running it weekly is safe and cheap.
#
#   powershell -ExecutionPolicy Bypass -File scripts\tscert-renew.ps1
#
# To automate, register a weekly Task Scheduler job (run as SYSTEM or admin):
#
#   schtasks /Create /TN "homelab-tscert-renew" /SC WEEKLY /D SUN /ST 04:00 /RU SYSTEM ^
#     /TR "powershell -ExecutionPolicy Bypass -File C:\path\to\homelab\scripts\tscert-renew.ps1"
#
# Windows-only scaffolding. No counterpart on the LXC and must not be carried
# across: the section 5.2 socket approach renews itself.

$ErrorActionPreference = 'Stop'

$TailscaleExe = $env:TAILSCALE_EXE; if (-not $TailscaleExe) { $TailscaleExe = 'C:\Program Files\Tailscale\tailscale.exe' }
$CertDir      = $env:TSCERT_DIR;    if (-not $CertDir)      { $CertDir      = 'E:\AIO_JELL_CONFIG\caddy\tscert' }
$NodeName     = $env:TSCERT_NAME;   if (-not $NodeName)     { $NodeName     = '<host-node>.<tailnet>.ts.net' }
$RepoDir      = $env:HOMELAB_DIR;   if (-not $RepoDir)      { $RepoDir      = 'C:\path\to\homelab' }
$RenewIfUnder = 30

function Fail($msg) {
    Write-Error "tscert-renew: $msg"
    exit 1
}

if (-not (Test-Path $TailscaleExe)) { Fail "tailscale.exe not found at $TailscaleExe" }
if (-not (Test-Path $CertDir)) { New-Item -ItemType Directory -Force $CertDir | Out-Null }

$crt = Join-Path $CertDir 'tsnode.crt'
$key = Join-Path $CertDir 'tsnode.key'

# Skip the work if the current cert still has plenty of life. Tailscale would
# no-op anyway; this keeps the log quiet and avoids a pointless Caddy restart.
if (Test-Path $crt) {
    $existing = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $crt
    $daysLeft = [math]::Round(($existing.NotAfter - (Get-Date)).TotalDays, 0)
    Write-Output "tscert-renew: current cert expires $($existing.NotAfter) ($daysLeft days left)"
    if ($daysLeft -gt $RenewIfUnder) {
        Write-Output "tscert-renew: more than $RenewIfUnder days remain, nothing to do"
        exit 0
    }
}

# The control plane occasionally drops the set-dns call mid-request with an
# "unexpected EOF" (observed during initial issuance on 2026-08-12). Transient,
# so retry rather than waking a human.
$issued = $false
foreach ($attempt in 1..4) {
    Write-Output "tscert-renew: issuing (attempt $attempt) for $NodeName"
    & $TailscaleExe cert --cert-file $crt --key-file $key $NodeName 2>&1 | ForEach-Object { Write-Output "  $_" }
    if ($LASTEXITCODE -eq 0) {
        $issued = $true
        break
    }
    Start-Sleep -Seconds 20
}
if (-not $issued) { Fail "could not issue a certificate for $NodeName after 4 attempts" }

$new = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $crt
Write-Output "tscert-renew: issued, valid until $($new.NotAfter)"

# Caddy holds the cert in memory. A static 'tls <cert> <key>' pair is only
# re-read on reload, so without this the new file on disk changes nothing.
Push-Location $RepoDir
try {
    docker compose restart caddy | Out-Null
    $restartCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
if ($restartCode -ne 0) { Fail "cert renewed but 'docker compose restart caddy' failed; Caddy still serves the old cert" }

Start-Sleep -Seconds 5
$code = (curl.exe -s -o NUL -w "%{http_code}" "https://$NodeName/addon/manifest.json")
if ($code -ne '200') { Fail "Caddy restarted but https://$NodeName/addon/manifest.json returned $code" }

Write-Output "tscert-renew: done, HTTPS serving on $NodeName"

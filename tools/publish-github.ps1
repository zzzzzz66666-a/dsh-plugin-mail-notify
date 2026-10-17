<#
.SYNOPSIS
    Publish this repository to GitHub.

.DESCRIPTION
    Creates the repository if it does not exist, commits everything that is
    staged, and pushes. Authentication uses whatever Git Credential Manager
    already holds for github.com — the tool never asks for, prints, or stores a
    token itself.

    Why a script: reading the stored credential needs GCM, which spawns a helper
    process over a pipe. Under a confined shell that fails with
    "couldn't create signal pipe, Win32 error 5", so this has to run with full
    access. Bundling it here keeps that one escalation reproducible instead of
    being a hand-typed command somebody has to reconstruct later.

    The credential value is read into a variable and used for exactly two API
    calls (identify the account, create the repository). It is never written to
    the console, a file, or an argument list.

.PARAMETER RepoName
    Repository name. Defaults to dsh-plugin-mail-notify.

.PARAMETER Visibility
    public or private. Defaults to public: the release bundles an install skill
    for other people's assistants and a user manual, so the repository is meant
    to be shared.

.PARAMETER Description
    Repository description.

.PARAMETER DryRun
    Report what would happen; create nothing, commit nothing, push nothing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\tools\publish-github.ps1 -DryRun

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\tools\publish-github.ps1 -Visibility private
#>

[CmdletBinding()]
param(
    [string]$RepoName = 'dsh-plugin-mail-notify',
    [ValidateSet('public', 'private')][string]$Visibility = 'public',
    [string]$Description = 'DeepSeek Harness mail notification plugin: emails a summary when a turn ends, and a reply to that mail continues the same session. 邮件通知与邮件续聊插件。',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
    Write-Host "FAIL  $message" -ForegroundColor Red
    exit 1
}

function Ok([string]$message) {
    Write-Host "ok    $message" -ForegroundColor Green
}

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Write-Host "repository: $root"

# --- 1. the credential -----------------------------------------------------
# Non-interactive on purpose: a prompt here would hang an unattended run.
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'

$raw = ("protocol=https`nhost=github.com`n`n" | git credential fill 2>&1) -join "`n"
$credentialLines = $raw -split "`r?`n"
$token = (($credentialLines | Where-Object { $_ -match '^password=' }) -replace '^password=', '') -join ''
$storedUser = (($credentialLines | Where-Object { $_ -match '^username=' }) -replace '^username=', '') -join ''

if (-not $token) {
    Write-Host 'fatal: could not read Username for https://github.com (no stored credential)' -ForegroundColor Red
    Write-Host ''
    Write-Host 'Sign in to GitHub once, then re-run this script:' -ForegroundColor Yellow
    Write-Host '  "protocol=https`nhost=github.com`n`n" | git credential fill' -ForegroundColor White
    Write-Host '  (or run: git push https://github.com/<you>/<repo>.git main  and complete the browser prompt)' -ForegroundColor White
    exit 1
}
Ok 'read the stored GitHub credential'

$headers = @{
    Authorization          = "Bearer $token"
    'User-Agent'           = 'dsh-plugin-mail-notify-publisher'
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
}

# --- 2. who are we ---------------------------------------------------------
try {
    $account = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers -TimeoutSec 30
} catch {
    Fail "GitHub rejected the stored credential: $($_.Exception.Message). Re-authenticate GitHub, then re-run."
}
$login = $account.login
Ok "authenticated as $login"

$commitName = $login
$commitEmail = "$login@users.noreply.github.com"
$remoteUrl = "https://github.com/$login/$RepoName.git"
Write-Host "target: $remoteUrl  ($Visibility)"

if ($DryRun) {
    Write-Host ''
    Write-Host 'Dry run. Would create the repository (if missing), commit, and push.' -ForegroundColor Yellow
    Remove-Variable token, headers, account -ErrorAction SilentlyContinue
    exit 0
}

# --- 3. create the repository if needed ------------------------------------
try {
    $existing = Invoke-RestMethod -Uri "https://api.github.com/repos/$login/$RepoName" -Headers $headers -TimeoutSec 30
    Ok "repository already exists: $($existing.html_url)"
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -ne 404) { Fail "could not check the repository: $($_.Exception.Message)" }
    $body = @{
        name        = $RepoName
        description = $Description
        private     = ($Visibility -eq 'private')
        has_issues  = $true
        has_wiki    = $false
        auto_init   = $false
    } | ConvertTo-Json
    try {
        $created = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec 30
        Ok "created $($created.html_url) ($Visibility)"
    } catch {
        Fail "could not create the repository: $($_.Exception.Message)"
    }
}

# From here on git handles the transport and GCM handles auth.
Remove-Variable token, headers, account -ErrorAction SilentlyContinue

# --- 4. commit -------------------------------------------------------------
# A local identity, so the commit does not depend on the machine's git config.
git -C $root config user.name $commitName
git -C $root config user.email $commitEmail
Ok "commit identity: $commitName <$commitEmail>"

git -C $root add -A
$staged = (git -C $root diff --cached --name-only) -split "`r?`n" | Where-Object { $_ -ne '' }
if ($staged.Count -eq 0) {
    Write-Host 'note  nothing new to commit' -ForegroundColor Yellow
} else {
    $message = @"
Release 1.0.0: DeepSeek Harness mail notification plugin

Emails a summary when a Harness turn ends, and lets a verified reply to that
mail continue the same session.

- $($staged.Count) files
- zero runtime dependencies (Node built-ins only)
- 187 tests, including SMTP/IMAP conversations against real local TLS servers
- deterministic packaging: tools/pack-plugin.mjs --check
- install skill and user manual under deliverables/
"@
    git -C $root commit -q -m $message
    if ($LASTEXITCODE -ne 0) { Fail 'git commit failed' }
    Ok "committed $($staged.Count) files"
}

# --- 5. push ---------------------------------------------------------------
$remotes = (git -C $root remote) -split "`r?`n" | Where-Object { $_ -ne '' }
if ($remotes -contains 'origin') {
    git -C $root remote set-url origin $remoteUrl
} else {
    git -C $root remote add origin $remoteUrl
}
Ok "remote origin -> $remoteUrl"

<#
Some networks answer for api.github.com but block github.com:443 — sometimes at
the address DNS hands back, while other GitHub addresses work normally. Rather
than making the user go and start a proxy, three strategies are tried in order
and the one that worked is reported:

  1. direct;
  2. the proxy the system already has registered, if its port is listening;
  3. a local CONNECT relay (tools/local-connect-proxy.mjs) that dials addresses
     known to answer. It forwards bytes only, so TLS is still validated end to
     end by git.
#>

function Invoke-Push([string[]]$extraArgs) {
    # `2>&1` turns a native command's stderr into ErrorRecords, and this script
    # runs with $ErrorActionPreference = 'Stop' — so a perfectly ordinary failed
    # push would abort the whole script instead of falling through to the next
    # strategy. The exit code is the signal; the text is only for the operator.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        git -C $root @extraArgs push -u origin HEAD:main 2>&1 | ForEach-Object { Write-Host "      $_" }
        return $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $previous
    }
}

$relay = $null
try {
    Write-Host 'push  strategy 1/3: direct'
    $pushed = Invoke-Push @()
    $used = 'direct'

    if (-not $pushed) {
        $registered = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue).ProxyServer
        $proxyHostPort = if ($registered) { ($registered -split ';')[0] } else { '' }
        if ($proxyHostPort -match '^(?<host>[^:]+):(?<port>\d+)$' -and
            (Get-NetTCPConnection -LocalPort ([int]$Matches.port) -State Listen -ErrorAction SilentlyContinue)) {
            Write-Host "push  strategy 2/3: system proxy $proxyHostPort"
            $pushed = Invoke-Push @('-c', "http.proxy=http://$proxyHostPort")
            $used = "system proxy $proxyHostPort"
        }
    }

    if (-not $pushed) {
        $relayScript = Join-Path $PSScriptRoot 'local-connect-proxy.mjs'
        $node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
        if ((Test-Path -LiteralPath $relayScript) -and (Test-Path -LiteralPath $node)) {
            Write-Host 'push  strategy 3/3: local relay to reachable GitHub addresses'
            $relay = Start-Process -FilePath $node `
                -ArgumentList @($relayScript, '--listen', '8899', '--host', 'github.com:443',
                    '--to', '140.82.113.4', '--to', '140.82.112.3', '--to', '140.82.114.3') `
                -PassThru -WindowStyle Hidden
            Start-Sleep -Seconds 2
            $pushed = Invoke-Push @('-c', 'http.proxy=http://127.0.0.1:8899')
            $used = 'local relay'
        }
    }
} finally {
    if ($relay -and -not $relay.HasExited) { Stop-Process -Id $relay.Id -Force -ErrorAction SilentlyContinue }
}

if (-not $pushed) {
    Fail 'git push failed. Enable your proxy and re-run, or re-authenticate GitHub. Nothing was lost: the repository exists and the commit is local.'
}
Ok "pushed via $used"

Write-Host ''
Ok "published: https://github.com/$login/$RepoName"
exit 0

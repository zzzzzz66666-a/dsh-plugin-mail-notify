<#
.SYNOPSIS
    Install dsh-plugin-mail-notify into the DeepSeek Harness desktop profile.

.DESCRIPTION
    Wraps the package's own scripts so an assistant can drive the whole install
    with one command and read a clear pass/fail verdict at the end.

    It never sees or prints the mailbox authorization code unless you pass
    -AuthCodeFile, and even then it only pipes the file's contents into the
    package's script over stdin — the value never appears on a command line.

    Steps: (1) write the plugin row + dependency, (2) optionally store the
    authorization code, (3) run the structural verifier.

    It does NOT restart DeepSeek Harness: that would interrupt whatever session
    the user has open. The script prints the reminder instead.

.PARAMETER PackageDir
    Package root: the folder containing package.json and scripts\configure.mjs.

.PARAMETER Sender
    Mailbox that sends the notifications.

.PARAMETER Recipient
    Mailbox that receives them. Defaults to -Sender.

.PARAMETER ReplyTo
    The only address allowed to reply. Defaults to -Recipient.

.PARAMETER Prefix
    Subject tag, default [DSH]. Also the IMAP search tag; do not change it later
    without reconfiguring.

.PARAMETER AuthCodeFile
    Path to a file holding the QQ Mail authorization code on one line. When
    omitted, the script prints the command for the user to run themselves — which
    is the preferred flow, because then the secret never leaves their terminal.

.PARAMETER SkipCredential
    Write the configuration but leave the credential store untouched.

.PARAMETER DryRun
    Print what would be written; write nothing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install_plugin.ps1 `
        -PackageDir 'C:\Users\me\dsh-plugin-mail-notify' -Sender me@qq.com

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install_plugin.ps1 `
        -PackageDir 'C:\Users\me\dsh-plugin-mail-notify' -Sender me@qq.com `
        -AuthCodeFile "$env:TEMP\code.txt"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageDir,
    [Parameter(Mandatory = $true)][string]$Sender,
    [string]$Recipient,
    [string]$ReplyTo,
    [string]$Prefix,
    [string]$AuthCodeFile,
    [switch]$SkipCredential,
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

# --- prerequisites ---------------------------------------------------------

if (-not (Test-Path -LiteralPath $PackageDir)) { Fail "package directory not found: $PackageDir" }
$PackageDir = (Resolve-Path -LiteralPath $PackageDir).Path
if (-not (Test-Path -LiteralPath (Join-Path $PackageDir 'package.json'))) {
    Fail "not a package root (no package.json): $PackageDir"
}
foreach ($required in @('scripts\configure.mjs', 'scripts\verify-install.mjs', 'scripts\set-credential.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackageDir $required))) {
        Fail "package is incomplete: missing $required"
    }
}
Ok "package root: $PackageDir"

# `node` is usually not on PATH; prefer the runtime that ships with the harness.
$node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
    $found = Get-Command node -ErrorAction SilentlyContinue
    if (-not $found) { Fail "node not found. Pass the harness runtime node path, or install Node.js 20+." }
    $node = $found.Source
}
$nodeVersion = & $node -v
Ok "node $nodeVersion ($node)"

$profilePatch = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
if (-not (Test-Path -LiteralPath $profilePatch)) {
    Fail "desktop profile not found: $profilePatch`n       This plugin needs the DeepSeek Harness desktop app."
}
Ok "desktop profile found"

if (-not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'))) {
    Write-Host "note  no .credentials.yaml yet; the plugin will create the reference when the code is stored" -ForegroundColor Yellow
}

# --- step 1: configuration row + dependency --------------------------------

if (-not $Recipient) { $Recipient = $Sender }
if (-not $ReplyTo) { $ReplyTo = $Recipient }

$configureArgs = @(
    (Join-Path $PackageDir 'scripts\configure.mjs'),
    '--sender', $Sender,
    '--recipient', $Recipient,
    '--reply-to', $ReplyTo
)
if ($Prefix) { $configureArgs += @('--prefix', $Prefix) }
if ($DryRun) {
    # A real code is not needed for a dry run; this value is never written.
    $configureArgs += @('--auth-code', 'dry-run-placeholder', '--dry-run')
} else {
    $configureArgs += '--no-credential'
}

Write-Host ''
Write-Host '=== 1/3  writing the plugin row and dependency ===' -ForegroundColor Cyan
& $node @configureArgs
if ($LASTEXITCODE -ne 0) { Fail "configure.mjs exited $LASTEXITCODE" }
if ($DryRun) {
    Write-Host ''
    Write-Host 'Dry run only. Re-run without -DryRun to apply.' -ForegroundColor Yellow
    exit 0
}

# --- step 2: credential (optional) -----------------------------------------

Write-Host ''
Write-Host '=== 2/3  storing the authorization code ===' -ForegroundColor Cyan

if ($SkipCredential) {
    Write-Host 'skip  -SkipCredential was given'
} elseif ($AuthCodeFile) {
    if (-not (Test-Path -LiteralPath $AuthCodeFile)) { Fail "authorization code file not found: $AuthCodeFile" }
    $code = (Get-Content -LiteralPath $AuthCodeFile -Raw).Split("`r`n", "`n")[0].Trim()
    if (-not $code) { Fail "authorization code file is empty: $AuthCodeFile" }
    # Piped over stdin on purpose: the value never reaches a command line, a
    # process listing, or this transcript.
    $code | & $node (Join-Path $PackageDir 'scripts\set-credential.mjs') --no-check
    if ($LASTEXITCODE -ne 0) { Fail "set-credential.mjs exited $LASTEXITCODE" }
    Write-Host "note  delete $AuthCodeFile now that the code is stored" -ForegroundColor Yellow
} else {
    Write-Host 'The authorization code is a secret, so this script will not ask for it.' -ForegroundColor Yellow
    Write-Host 'Ask the user to run this in their own terminal (it checks both logins):' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "  cd `"$PackageDir`"" -ForegroundColor White
    Write-Host "  Get-Content .\code.txt | & `"$node`" .\scripts\set-credential.mjs" -ForegroundColor White
    Write-Host '  Remove-Item .\code.txt' -ForegroundColor White
}

# --- step 3: structural verification ---------------------------------------

Write-Host ''
Write-Host '=== 3/3  verifying the installation ===' -ForegroundColor Cyan
& $node (Join-Path $PackageDir 'scripts\verify-install.mjs')
$verifyExit = $LASTEXITCODE

Write-Host ''
if ($verifyExit -ne 0) {
    Write-Host 'NOT READY. Fix the FAIL lines above before restarting the harness.' -ForegroundColor Red
    Write-Host 'See skill\references\troubleshooting.md for each symptom.' -ForegroundColor Red
    exit 1
}

Write-Host 'Installation is structurally correct.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next: ask the user to FULLY quit and reopen DeepSeek Harness' -ForegroundColor Yellow
Write-Host '(closing the window is not enough), then confirm it is live with:' -ForegroundColor Yellow
Write-Host ''
Write-Host '  $r = Get-Content "$env:USERPROFILE\.dsh\mail-notify\audit.json" -Raw | ConvertFrom-Json' -ForegroundColor White
Write-Host '  $r | Where-Object { $_.action -eq "service.start" } | Select-Object -Last 1' -ForegroundColor White
Write-Host ''
Write-Host 'A result of "configured" means the plugin is running.' -ForegroundColor Green
exit 0

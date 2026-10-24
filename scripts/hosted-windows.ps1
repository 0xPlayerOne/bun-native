# Disposable hosted-runner setup only. Never changes a developer workstation.
[CmdletBinding()]
param(
    [ValidateSet('smoke', 'rpc', 'full', 'credentials', 'm4-acceptance', 'pty')][string]$Suite = 'full',
    [switch]$Worker,
    [string]$Python,
    [string]$Bun
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This script is restricted to disposable GitHub-hosted Windows runners'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Worker) {
    if ($admin) { throw 'The native qualification worker must not be an administrator' }
    foreach ($name in @('GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN')) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    $privateTemp = Join-Path $root '.bunly/hosted-tools/temp'
    New-Item -ItemType Directory -Force $privateTemp | Out-Null
    $env:TEMP = $privateTemp
    $env:TMP = $privateTemp
    $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
    $env:HOME = $env:USERPROFILE
    $env:PYTHON = $Python
    $env:BUNLY_HOSTED_BUN = $Bun
    $env:EXPECTED_TARGET = 'win32-x64'
    # The checked-out Git directory belongs to the build account, not this test user.
    $env:GIT_CONFIG_COUNT = '1'
    $env:GIT_CONFIG_KEY_0 = 'safe.directory'
    $env:GIT_CONFIG_VALUE_0 = $root.Replace('\', '/')
    if ($Suite -eq 'pty') {
        & $Bun (Join-Path $PSScriptRoot 'qualify-bun-pty.ts')
    } else {
        & $Python (Join-Path $PSScriptRoot 'hosted_cef.py') run --suite $Suite
    }
    exit $LASTEXITCODE
}
if (-not $admin) { throw 'Creating the disposable standard account requires the hosted build administrator' }
$pythonExe = (Get-Command python -ErrorAction Stop).Source
$tools = Join-Path $root '.bunly/hosted-tools'
$evidence = Join-Path $root '.bunly/hosted-evidence'
New-Item -ItemType Directory -Force $tools, $evidence | Out-Null
$bunExe = Join-Path $tools 'bun.exe'
Copy-Item (Get-Command bun -ErrorAction Stop).Source $bunExe
$name = 'bunlyq' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$password = 'Bq!' + [Guid]::NewGuid().ToString('N')
Write-Output "::add-mask::$password"
$secret = ConvertTo-SecureString $password -AsPlainText -Force
$created = $false
try {
    New-LocalUser -Name $name -Password $secret -Description 'Disposable Bunly native qualification' | Out-Null
    $created = $true
    $users = Get-LocalGroup -SID 'S-1-5-32-545'
    Add-LocalGroupMember -Group $users -Member $name
    $account = "$env:COMPUTERNAME\$name"
    # Only this job's checkout/private output receives access; no system-wide ACL changes.
    & icacls.exe $root /grant "${account}:(OI)(CI)RX" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot grant checkout read access' }
    & icacls.exe (Join-Path $root '.bunly') /grant "${account}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot grant private qualification-output access' }
    Start-Service seclogon
    $credential = [PSCredential]::new($account, $secret)
    $shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $script = $PSCommandPath
    # No password is put in a command line, file, or uploaded artifact.
    $arguments = "-NoProfile -NonInteractive -File `"$script`" -Worker -Suite $Suite -Python `"$pythonExe`" -Bun `"$bunExe`""
    $child = Start-Process -FilePath $shell -ArgumentList $arguments -Credential $credential -LoadUserProfile -WorkingDirectory $root -PassThru -Wait -RedirectStandardOutput (Join-Path $evidence ('windows-standard-' + $Suite + '.log')) -RedirectStandardError (Join-Path $evidence ('windows-standard-error-' + $Suite + '.log'))
    Get-Content (Join-Path $evidence ('windows-standard-' + $Suite + '.log')) -Tail 60
    Get-Content (Join-Path $evidence ('windows-standard-error-' + $Suite + '.log')) -Tail 40
    if ($child.ExitCode -ne 0) { throw "Standard-user qualification failed with exit $($child.ExitCode)" }
} finally {
    if ($created) { Remove-LocalUser -Name $name -ErrorAction Stop }
    $password = $null
    $credential = $null
    if ($secret) { $secret.Dispose() }
}

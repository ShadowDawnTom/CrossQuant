param(
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Setting([string]$Name, [string]$Default) {
    $Value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $Default }
    return $Value
}

function Test-OwnedBackend([string]$InstallRoot) {
    $LockPath = Join-Path $InstallRoot 'data\backend.lock'
    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) { return $null }
    try {
        $Lock = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
        $ProcessId = [int]$Lock.pid
        $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
        if ($null -eq $Process) { return $null }
        $CommandLine = [string]$Process.CommandLine
        $Versions = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'versions'))
        if ($CommandLine.IndexOf($Versions, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $ProcessId
        }
    }
    catch {
        return $null
    }
    return $null
}

if ($env:OS -ne 'Windows_NT') { throw 'This uninstaller currently supports Windows only.' }

$DefaultRoot = Join-Path $env:LOCALAPPDATA 'Gate CrossEx'
$Root = [IO.Path]::GetFullPath((Get-Setting 'GCT_INSTALL_ROOT' $DefaultRoot)).TrimEnd('\')
$Marker = Join-Path $Root '.gate-crossex-install-root'
$ExpectedMarker = 'Gate CrossEx install root v1'
$DriveRoot = [IO.Path]::GetPathRoot($Root).TrimEnd('\')
$Forbidden = @($DriveRoot, $env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') }
if ($Forbidden -contains $Root) { throw "Unsafe installation root: $Root" }
if (-not (Test-Path -LiteralPath $Marker -PathType Leaf) -or
    (Get-Content -LiteralPath $Marker -Raw).Trim() -ne $ExpectedMarker) {
    throw "Refusing to uninstall an unrecognized installation root: $Root"
}

$ConfigPath = Join-Path $Root 'config\install.json'
$Config = $null
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    $Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
}
$DefaultShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Gate CrossEx.lnk'
$TaskName = Get-Setting 'GCT_TASK_NAME' $(if ($null -ne $Config) { [string]$Config.taskName } else { 'Gate CrossEx' })
$ShortcutPath = Get-Setting 'GCT_SHORTCUT_PATH' $(if ($null -ne $Config) { [string]$Config.shortcutPath } else { $DefaultShortcut })
$SkipService = (Get-Setting 'GCT_SKIP_SERVICE' '0') -eq '1'
if ($TaskName -notmatch '^[A-Za-z0-9 ._-]{1,100}$') { throw 'Invalid scheduled task name.' }
$ShortcutOverride = [Environment]::GetEnvironmentVariable('GCT_SHORTCUT_PATH')
if ([string]::IsNullOrWhiteSpace($ShortcutOverride)) {
    $StartMenuRoot = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')).TrimEnd('\') + '\'
    $FullShortcut = [IO.Path]::GetFullPath($ShortcutPath)
    if (-not $FullShortcut.StartsWith($StartMenuRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The configured shortcut is outside the current user Start Menu.'
    }
}

if (-not $SkipService) {
    if ($null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
        Write-Host 'Stopping Gate CrossEx safely...'
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    for ($Attempt = 0; $Attempt -lt 140; $Attempt++) {
        if ($null -eq (Test-OwnedBackend $Root)) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($null -ne (Test-OwnedBackend $Root)) {
        throw 'The backend is still shutting down; no files were removed.'
    }
    if ($null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
}

if ($ShortcutPath -notlike '*.lnk') { throw "Unsafe shortcut path: $ShortcutPath" }
Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue

if ($Purge) {
    Remove-Item -LiteralPath $Root -Recurse -Force
    Write-Host 'Gate CrossEx and all local data, credentials, logs, and backups were removed.'
}
else {
    foreach ($Relative in @('current-release.txt', 'versions', 'bin')) {
        Remove-Item -LiteralPath (Join-Path $Root $Relative) -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host 'Gate CrossEx was uninstalled.'
    Write-Host "Database, credentials, logs, backups, and this uninstaller were preserved under: $Root"
    Write-Host 'Run uninstall.ps1 -Purge only if you intentionally want to delete them.'
}

param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ArchivePath = [IO.Path]::GetFullPath($ArchivePath)
$TestRoot = Join-Path $env:RUNNER_TEMP "gate-crossex-release-install-$PID"
$InstallRoot = Join-Path $TestRoot 'Application Data\Gate CrossEx'
$TaskName = "Gate CrossEx Release Test $PID"
$ShortcutPath = Join-Path $TestRoot 'Gate CrossEx.lnk'

function Get-Sha256([string]$Path) {
    $Stream = [IO.File]::OpenRead($Path)
    try {
        $Algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            $Hash = $Algorithm.ComputeHash($Stream)
            return [BitConverter]::ToString($Hash).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $Algorithm.Dispose()
        }
    }
    finally {
        $Stream.Dispose()
    }
}

try {
    $env:GCT_ARCHIVE = $ArchivePath
    $env:GCT_SHA256 = Get-Sha256 $ArchivePath
    $env:GCT_INSTALL_ROOT = $InstallRoot
    $env:GCT_TASK_NAME = $TaskName
    $env:GCT_SHORTCUT_PATH = $ShortcutPath
    $env:GCT_OPEN_BROWSER = '0'
    Remove-Item Env:GCT_SKIP_SERVICE -ErrorAction SilentlyContinue

    & (Join-Path $RepositoryRoot 'install.ps1')
    & (Join-Path $InstallRoot 'bin\gate-crossex.ps1') status
    if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) { throw 'The Start Menu shortcut fixture was not created.' }
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'data\gate-crossex.sqlite') -PathType Leaf)) {
        throw 'The packaged backend did not create its database.'
    }

    & (Join-Path $InstallRoot 'bin\gate-crossex.ps1') uninstall
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'data\gate-crossex.sqlite') -PathType Leaf)) {
        throw 'Normal uninstall did not preserve the database.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'uninstall.ps1') -PathType Leaf)) {
        throw 'Normal uninstall did not preserve the local uninstaller.'
    }

    & (Join-Path $InstallRoot 'uninstall.ps1') -Purge
    if (Test-Path -LiteralPath $InstallRoot) { throw 'Purge did not remove the marked test installation.' }
}
finally {
    if ($null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
    foreach ($Name in @(
        'GCT_ARCHIVE',
        'GCT_SHA256',
        'GCT_INSTALL_ROOT',
        'GCT_TASK_NAME',
        'GCT_SHORTCUT_PATH',
        'GCT_OPEN_BROWSER'
    )) {
        Remove-Item "Env:$Name" -ErrorAction SilentlyContinue
    }
}

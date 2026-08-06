$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root 'config\install.json'
$CurrentPath = Join-Path $Root 'current-release.txt'
$ErrorLog = Join-Path $Root 'logs\backend.err.log'
$OutputLog = Join-Path $Root 'logs\backend.out.log'

try {
    $Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $ReleaseDir = (Get-Content -LiteralPath $CurrentPath -Raw).Trim()
    $VersionsRoot = [IO.Path]::GetFullPath((Join-Path $Root 'versions'))
    $ReleaseDir = [IO.Path]::GetFullPath($ReleaseDir)
    $Prefix = $VersionsRoot.TrimEnd('\') + '\'
    if (-not $ReleaseDir.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The active release pointer is outside the installation versions directory.'
    }

    $Node = Join-Path $ReleaseDir 'runtime\node.exe'
    $Server = Join-Path $ReleaseDir 'app\apps\backend\dist\server.js'
    $App = Join-Path $ReleaseDir 'app'
    if (-not (Test-Path -LiteralPath $Node -PathType Leaf) -or
        -not (Test-Path -LiteralPath $Server -PathType Leaf)) {
        throw 'The active release is incomplete.'
    }

    $env:NODE_ENV = 'production'
    $env:GCT_DATA_DIR = Join-Path $Root 'data'
    $env:GCT_MIGRATIONS_DIR = Join-Path $App 'migrations'
    $env:GCT_FRONTEND_DIST_DIR = Join-Path $App 'apps\frontend\dist'
    $env:GCT_CREDENTIAL_ENV_PATH = Join-Path $Root 'config\credentials.env'
    $env:GCT_PORT = [string]$Config.port
    $env:GCT_FRONTEND_PORT = [string]$Config.port
    $env:GCT_FRONTEND_ORIGIN = "http://127.0.0.1:$($Config.port)"
    $env:GCT_WINDOWS_SERVICE_PARENT_PID = [string]$PID

    Push-Location $App
    try {
        & $Node $Server 1>> $OutputLog 2>> $ErrorLog
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
catch {
    $Message = "[$([DateTime]::UtcNow.ToString('o'))] $($_.Exception.Message)"
    Add-Content -LiteralPath $ErrorLog -Value $Message
    exit 1
}

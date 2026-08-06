param(
    [ValidateSet('open', 'start', 'stop', 'status', 'logs', 'uninstall')]
    [string]$Command = 'open'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root 'config\install.json'
$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$TaskName = [string]$Config.taskName
$Port = [int]$Config.port
$LocalUrl = "http://127.0.0.1:$Port"

function Test-GctHealthy {
    try {
        $Discovery = Invoke-RestMethod -Uri "$LocalUrl/api/system/discovery" -TimeoutSec 2
        return $Discovery.product -eq 'Gate CrossEx Local Trading Terminal'
    }
    catch {
        return $false
    }
}

function Start-Gct {
    $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $Task) {
        throw 'The Gate CrossEx startup task is missing. Re-run the installer.'
    }
    Start-ScheduledTask -TaskName $TaskName
    for ($Attempt = 0; $Attempt -lt 120; $Attempt++) {
        if (Test-GctHealthy) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "Gate CrossEx did not become healthy. See $Root\logs\backend.err.log"
}

switch ($Command) {
    'open' {
        Start-Gct
        Start-Process $LocalUrl
    }
    'start' {
        Start-Gct
        Write-Host "Gate CrossEx is running at $LocalUrl"
    }
    'stop' {
        if ($null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        }
    }
    'status' {
        if (Test-GctHealthy) {
            Write-Host "Gate CrossEx is running at $LocalUrl"
        }
        else {
            Write-Host 'Gate CrossEx is stopped.'
            exit 1
        }
    }
    'logs' {
        foreach ($Log in @('backend.err.log', 'backend.out.log')) {
            $Path = Join-Path $Root "logs\$Log"
            if (Test-Path -LiteralPath $Path -PathType Leaf) {
                Write-Host "==> $Path"
                Get-Content -LiteralPath $Path -Tail 200
            }
        }
    }
    'uninstall' {
        & (Join-Path $Root 'uninstall.ps1')
    }
}

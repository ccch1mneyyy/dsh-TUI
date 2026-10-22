param([Parameter(Mandatory = $true)][string]$ControlDirectory)
$ErrorActionPreference = 'Stop'
$nativeStarted = $false
# No pipeline or Read-Host: installer stdin belongs exclusively to the child.
try {
  $config = [IO.File]::ReadAllText((Join-Path $ControlDirectory 'config.json')) | ConvertFrom-Json
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-installer.cs')
  $nativeStarted = $true
  $result = [DshInstallerJob]::Run([string]$config.application, [string]$config.commandLine,
    $ControlDirectory, [uint32]$config.parentPid, [long]$config.parentNotAfterMs)
} catch {
  $result = @{ code = 127; cleanupConfirmed = (-not $nativeStarted); error = $_.Exception.Message }
}
$json = $result | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $ControlDirectory 'result.tmp'), $json, [Text.UTF8Encoding]::new($false))
[IO.File]::Move((Join-Path $ControlDirectory 'result.tmp'), (Join-Path $ControlDirectory 'result.json'))
exit 0

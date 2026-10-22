# Test-only containment. Compile the independent guard before applying limits.
param([string]$NodePath, [string]$ScriptPath, [string]$RootPath, [string]$Mode)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'harness.cs')
  exit [InstallerAcceptanceGuard]::Run($NodePath, $ScriptPath, $RootPath, $Mode)
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}

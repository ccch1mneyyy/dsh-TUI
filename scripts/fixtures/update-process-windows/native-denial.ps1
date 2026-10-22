# Supplemental native API check: compile the PRODUCTION helper before the guard
# denies further processes. This cannot pass because Add-Type was quota denied.
param([string]$NodePath, [string]$RootPath, [uint32]$GuardPid)
$ErrorActionPreference = 'Stop'
function Wait-Marker([string]$Name) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while (!(Test-Path (Join-Path $RootPath $Name))) {
    if ($clock.ElapsedMilliseconds -gt 30000) { throw "Missing guard marker: $Name" }
    Start-Sleep -Milliseconds 40
  }
}
try {
  Wait-Marker 'native-denial.go'
  Add-Type -Path (Join-Path $RootPath 'assets/windows-installer.cs')
  [IO.File]::WriteAllText((Join-Path $RootPath 'native-denial.compiled'), 'compiled')
  Wait-Marker 'native-denial.limited'
  $directory = Join-Path $RootPath 'native-denial'
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $fixtureDirectory = [IO.Directory]::GetDirectories($RootPath, 'installer path*')[0]
  $fixture = Join-Path $fixtureDirectory 'installer payload.mjs'
  $line = '"' + $NodePath + '" "' + $fixture + '" must-not-run "' + $directory + '"'
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $result = [DshInstallerJob]::Run($NodePath, $line, $directory, $GuardPid, $now)
  [Console]::WriteLine((@{ case = 'native-job-list-creation-denied'; result = $result } | ConvertTo-Json -Compress -Depth 5))
  if ($result.code -eq 0 -or !$result.cleanupConfirmed -or $result.error -notlike '*CreateProcess*') {
    throw 'Expected confirmed fail-closed CreateProcess/JOB_LIST denial after successful native compilation'
  }
  if (Test-Path (Join-Path $directory 'payload-ran')) { throw 'Denied installer executed payload' }
  if (Test-Path (Join-Path $directory 'ready')) { throw 'Denied installer advertised ownership/start' }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}

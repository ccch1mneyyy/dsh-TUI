# Run from the repository root inside PowerShell. The script starts one Node
# renderer per glyph in the current classic conhost and writes its screen
# buffer observations to ResultPath. Use -Mode raw to demonstrate the old
# one-cell model; renderer is the passing regression path.
param(
  [Parameter(Mandatory = $true)]
  [string]$ResultPath,

  [ValidateSet('raw', 'renderer')]
  [string]$Mode = 'renderer'
)

$ErrorActionPreference = 'Stop'

& chcp.com 936 | Out-Null
$raw = $Host.UI.RawUI
$width = [Console]::BufferWidth
$targetPath = Join-Path $PSScriptRoot 'repro-conhost-width-target.mjs'

$results = foreach ($codePoint in @('2192', '25c6', '25cf')) {
  foreach ($row in 2..7) {
    [Console]::SetCursorPosition(0, $row)
    [Console]::Write(' ' * ($width - 1))
  }

  [Console]::SetCursorPosition(0, 2)
  Start-Process `
    -FilePath 'node.exe' `
    -ArgumentList '--import', 'tsx/esm', $targetPath, $codePoint, $Mode `
    -NoNewWindow `
    -Wait

  $rows = foreach ($row in 2..5) {
    $rectangle = New-Object Management.Automation.Host.Rectangle `
      0, $row, ($width - 1), $row
    $cells = $raw.GetBufferContents($rectangle)
    $builder = New-Object Text.StringBuilder
    foreach ($column in 0..($width - 1)) {
      [void]$builder.Append(($cells[0,$column]).Character)
    }
    $builder.ToString().TrimEnd()
  }

  [pscustomobject]@{
    mode = $Mode
    codePoint = $codePoint
    cursorLeft = [Console]::CursorLeft
    cursorTop = [Console]::CursorTop
    rows = $rows
  }
}

$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ResultPath -Encoding UTF8

if ($Mode -eq 'renderer') {
  $failed = $results | Where-Object {
    $_.rows -contains 'FIRST' -or [array]::IndexOf([string[]]$_.rows, 'SECOND') -ne 1
  }
  if ($failed) {
    Write-Error 'classic conhost streaming frame did not settle in the expected row'
    exit 1
  }
}

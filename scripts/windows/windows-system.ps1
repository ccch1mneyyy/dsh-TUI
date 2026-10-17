param(
    [Parameter(Mandatory = $true)][ValidateSet('inspect', 'path', 'notify-environment', 'register', 'unregister', 'restore-registration')][string]$Action,
    [Parameter(Mandatory = $true)][string]$InputFile,
    [Parameter(Mandatory = $true)][string]$OutputFile
)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
$environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$registryOptions = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\dsh-tui'

# Broadcast WM_SETTINGCHANGE so Explorer and other listeners re-read the user
# environment. Add-Type resolves reference assemblies from the process working
# directory, and $PLUGINSDIR ships the NSIS System plug-in — a native System.dll
# that shadows the .NET one and aborts the compilation — so compile elsewhere.
function Send-EnvironmentNotification {
    $savedDirectory = [Environment]::CurrentDirectory
    try {
        [Environment]::CurrentDirectory = $env:SystemRoot
        if ($null -eq ('DshEnvironmentNotification' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshEnvironmentNotification {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);
}
'@
        }
        $messageResult = [IntPtr]::Zero
        [void][DshEnvironmentNotification]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [IntPtr]::Zero, 'Environment', 2, 2000, [ref]$messageResult)
        return $true
    } catch {
        Write-Warning "Unable to broadcast the environment change: $($_.Exception.Message)"
        return $false
    } finally {
        [Environment]::CurrentDirectory = $savedDirectory
    }
}

try {
    switch ($Action) {
        'inspect' {
            $userPath = [string]$environment.GetValue('Path', '', $registryOptions)
            $prefix = [IO.Path]::GetFullPath($request.prefix).TrimEnd('\')
            $hasPrefix = @($userPath -split ';' | Where-Object {
                [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\') -ieq $prefix
            }).Count -gt 0
            $nodePaths = @()
            if (Test-Path -LiteralPath (Join-Path $prefix 'node.exe')) { $nodePaths += Join-Path $prefix 'node.exe' }
            $nodePaths += @(Get-Command node.exe -All -ErrorAction SilentlyContinue | ForEach-Object Source)
            $sessionId = (Get-Process -Id $PID).SessionId
            $running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'bun.exe' OR Name = 'dsh.exe' OR Name = 'dsh-tui.exe'" | Where-Object {
                $_.SessionId -eq $sessionId -and (
                    $_.Name -in @('dsh.exe', 'dsh-tui.exe') -or
                    $_.CommandLine -match '[\\/]node_modules[\\/](@deepseek-ai[\\/]dsh[\\/]|@deepseek-harness-tui[\\/]dsh-tui[\\/])'
                )
            } | ForEach-Object { [int]$_.ProcessId })
            $dshCommand = Get-Command dsh.cmd -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
            # An empty pipeline leaves a value that ConvertTo-Json can emit as an empty
            # object instead of null; consumers must see a path string or $null.
            if ($dshCommand -isnot [string] -or [string]::IsNullOrWhiteSpace($dshCommand)) { $dshCommand = $null }
            $registration = $null
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($uninstallKey)
            if ($null -ne $key) {
                try {
                    $registration = @($key.GetValueNames() | ForEach-Object {
                        @{ name = $_; value = $key.GetValue($_, $null, $registryOptions); kind = [int]$key.GetValueKind($_) }
                    })
                } finally { $key.Dispose() }
            }
            $result = @{ path = $userPath; pathContainsPrefix = $hasPrefix; nodePaths = @($nodePaths | Select-Object -Unique); running = $running; dshPath = $dshCommand; registration = $registration }
        }
        'path' {
            $current = [string]$environment.GetValue('Path', '', $registryOptions)
            if ($current -cne $request.expected) { throw 'User PATH changed during installation. Retry after the other installer finishes.' }
            $environment.SetValue('Path', [string]$request.value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
            # The registry write already succeeded, so a failed broadcast must never
            # abort an installation that is otherwise complete.
            $result = @{ ok = $true; notified = (Send-EnvironmentNotification) }
        }
        'notify-environment' {
            $result = @{ ok = $true; notified = (Send-EnvironmentNotification) }
        }
        'register' {
            $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($uninstallKey)
            try {
                $key.SetValue('DisplayName', 'dsh-TUI')
                $key.SetValue('DisplayVersion', [string]$request.version)
                $key.SetValue('Publisher', 'dsh-TUI community')
                $key.SetValue('InstallLocation', [string]$request.metadataDir)
                $key.SetValue('UninstallString', ('"' + (Join-Path $request.metadataDir 'unins000.exe') + '"'))
                $key.SetValue('NoModify', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
                $key.SetValue('NoRepair', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
            } finally { $key.Dispose() }
            $result = @{ ok = $true }
        }
        'unregister' {
            [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($uninstallKey, $false)
            $result = @{ ok = $true }
        }
        'restore-registration' {
            [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($uninstallKey, $false)
            if ($null -ne $request.registration) {
                $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($uninstallKey)
                try {
                    foreach ($entry in $request.registration) {
                        $key.SetValue([string]$entry.name, $entry.value, [Microsoft.Win32.RegistryValueKind]$entry.kind)
                    }
                } finally { $key.Dispose() }
            }
            $result = @{ ok = $true }
        }
    }
    $result | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $OutputFile -Encoding UTF8
} finally { $environment.Dispose() }

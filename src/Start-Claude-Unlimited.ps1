param([switch]$FunctionsOnly, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath

function Get-RetryCodeBinary {
    param([string]$ExplicitPath)
    if ($ExplicitPath) { return (Get-Item -LiteralPath $ExplicitPath -ErrorAction Stop).FullName }
    $roots = @((Join-Path $env:LOCALAPPDATA 'Claude-3p\claude-code'),
               (Join-Path $env:LOCALAPPDATA 'Claude\claude-code'),
               (Join-Path $env:APPDATA 'Claude-3p\claude-code'),
               (Join-Path $env:APPDATA 'Claude\claude-code'))
    $found = @()
    foreach ($root in $roots) {
        if (Test-Path -LiteralPath $root) {
            foreach ($file in Get-ChildItem -LiteralPath $root -Filter claude.exe -File -Recurse) {
                $match = [regex]::Match($file.FullName.Substring($root.Length), '\\(\d+\.\d+\.\d+)\\')
                if ($match.Success) { $found += [pscustomobject]@{Path=$file.FullName; Version=[version]$match.Groups[1].Value; Modified=$file.LastWriteTimeUtc} }
            }
        }
    }
    if (-not $found.Count) { throw 'Desktop Code engine not found. Open the Code tab once so Claude downloads its engine, then run Install.cmd again.' }
    $active = @(Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ExecutablePath)
    $running = @($found | Where-Object { $active -contains $_.Path })
    if ($running.Count) { $found = $running }
    return ($found | Sort-Object Version,Modified -Descending | Select-Object -First 1).Path
}

function Get-RetryDesktopExecutable {
    param([string]$ExplicitPath)
    if ($ExplicitPath) { return (Get-Item -LiteralPath $ExplicitPath -ErrorAction Stop).FullName }
    if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
        $package = Get-AppxPackage -Name Claude -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($package) {
            $candidate = Join-Path $package.InstallLocation 'app\Claude.exe'
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'AnthropicClaude\Claude.exe'),
                              (Join-Path $env:LOCALAPPDATA 'Programs\Claude\Claude.exe'),
                              (Join-Path $env:LOCALAPPDATA 'Claude\Claude.exe'))) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw 'Claude desktop executable not found. Specify -DesktopExecutable when installing a custom installation.'
}

function Get-RetryPreloadPath {
    param([string]$Path)
    $resolved = (Get-Item -LiteralPath $Path -ErrorAction Stop).FullName
    if ($resolved -notmatch '\s') { return $resolved }
    if (-not ('ClaudeRetryNativePaths' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ClaudeRetryNativePaths {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetShortPathName(string path, StringBuilder result, uint capacity);
}
'@
    }
    $buffer = New-Object System.Text.StringBuilder 32768
    $size = [ClaudeRetryNativePaths]::GetShortPathName($resolved,$buffer,32768)
    $short = $buffer.ToString()
    if (-not $size -or $short -match '\s') {
        throw 'Bun cannot preload this path because it contains spaces and Windows short names are unavailable. Install to a folder without spaces using -InstallDir.'
    }
    # Bun's preload resolver needs the real filename/extension, not its 8.3 alias.
    return Join-Path (Split-Path $short -Parent) (Split-Path $resolved -Leaf)
}

function Invoke-RetryStartupProbe {
    param([string]$Binary, [string]$Root)
    $preload = Get-RetryPreloadPath (Join-Path $Root 'retry-preload.cjs')
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Binary
    $info.Arguments = '--version'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables['BUN_OPTIONS'] = '--preload=' + $preload
    $info.EnvironmentVariables['CLAUDE_UNLIMITED_RETRY_CONFIG'] = Join-Path $Root 'policy.json'
    $info.EnvironmentVariables['CLAUDE_UNLIMITED_RETRY_PROBE'] = '1'
    $info.EnvironmentVariables['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
    $info.EnvironmentVariables['DISABLE_AUTOUPDATER'] = '1'
    $info.EnvironmentVariables['DISABLE_TELEMETRY'] = '1'
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'The preload startup probe timed out.' }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        if ($process.ExitCode -ne 0 -or $stderr -notmatch 'CLAUDE_UNLIMITED_RETRY_READY') {
            $detail=if ($stderr.Length -gt 1500) { $stderr.Substring(0,1500) } else { $stderr }
            throw ('The preload startup probe failed (exit ' + $process.ExitCode + '). Installation was rolled back. '+$detail)
        }
        return $stdout.Trim()
    } finally { $process.Dispose() }
}

if ($FunctionsOnly) { return }
try {
    $root = $PSScriptRoot
    $state = Get-Content -LiteralPath (Join-Path $root 'install-state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.marker -ne 'claude-unlimited-retry-v1' -or [IO.Path]::GetFullPath($root) -ne $state.install_dir) { throw 'Invalid patch installation state.' }
    foreach ($name in @('retry-core.cjs','retry-preload.cjs','policy.json','Start-Claude-Unlimited.ps1')) {
        $expected = $state.files.PSObject.Properties[$name].Value
        if ((Get-FileHash -LiteralPath (Join-Path $root $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
            throw ('Patch file changed: ' + $name + '. Run Install.cmd again to repair it.')
        }
    }
    $binary = Get-RetryCodeBinary $state.explicit_code_binary
    if ($binary -ne $state.verified_binary -or (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $state.binary_sha256) {
        throw 'The desktop Code engine changed. Run Install.cmd to check support for the new version.'
    }
    $desktop = Get-RetryDesktopExecutable $state.explicit_desktop_executable
    if ($env:BUN_OPTIONS -match '--preload') { throw 'An existing BUN_OPTIONS preload would conflict with this patch. Use only one retry launcher.' }
    if ($CheckOnly) {
        [pscustomobject]@{valid=$true; binary=$binary; desktop=$desktop; preload=(Get-RetryPreloadPath (Join-Path $root 'retry-preload.cjs'))} | ConvertTo-Json -Compress
        return
    }
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $desktop })
    if ($running.Count) { throw 'Claude is already running. Quit it completely from the system tray, then open Claude Unlimited Retry again.' }
    $preload = Get-RetryPreloadPath (Join-Path $root 'retry-preload.cjs')
    $env:BUN_OPTIONS = ('--preload=' + $preload + ' ' + $env:BUN_OPTIONS).Trim()
    $env:CLAUDE_UNLIMITED_RETRY_CONFIG = Join-Path $root 'policy.json'
    Start-Process -FilePath $desktop -WorkingDirectory $root -WindowStyle Normal
} catch {
    if ($CheckOnly) { throw }
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'Claude Unlimited Retry')
    exit 1
}

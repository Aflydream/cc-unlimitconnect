param(
    [string]$InstallDir=(Join-Path $env:LOCALAPPDATA 'ClaudeUnlimitedReconnect'),
    [string]$CodeBinary,
    [string]$DesktopExecutable,
    [switch]$NoShortcut,
    [string]$ShortcutDirectory
)
$ErrorActionPreference='Stop'
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+[IO.Path]::PathSeparator+$env:PSModulePath
$utf8=New-Object System.Text.UTF8Encoding $false
$root=[IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$payload=@{
    'retry-core.cjs'='@@CORE_BASE64@@'
    'retry-preload.cjs'='@@PRELOAD_BASE64@@'
    'Start-Claude-Unlimited.ps1'='@@LAUNCHER_BASE64@@'
}
$launcherSource=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload['Start-Claude-Unlimited.ps1']))
. ([ScriptBlock]::Create($launcherSource)) -FunctionsOnly

function Write-ReconnectJson {
    param([string]$Path,$Value)
    [IO.File]::WriteAllText($Path,($Value | ConvertTo-Json -Depth 10),$utf8)
}

try {
    if ($env:BUN_OPTIONS -match '--preload') { throw 'Another Bun preload is already configured. Run this installer from a normal PowerShell session.' }
    $binary=Get-RetryCodeBinary $CodeBinary
    $hash=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne '5441781f2b6bbd07354b4a74560ee88c68c9bf05d6db3c7e24c452c91673dc53') {
        throw 'Unsupported desktop Code engine. This package is verified for 2.1.309 only. Nothing was installed.'
    }
    $desktop=Get-RetryDesktopExecutable $DesktopExecutable
    $statePath=Join-Path $root 'install-state.json'
    if (Test-Path -LiteralPath $statePath) {
        $old=Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($old.marker -ne 'claude-unlimited-retry-v1' -or $old.install_dir -ne $root) { throw 'This folder belongs to another installation.' }
    } elseif ((Test-Path -LiteralPath $root) -and @(Get-ChildItem -LiteralPath $root -Force).Count) {
        throw 'Choose an empty installation folder.'
    }
    [void](New-Item -ItemType Directory -Path $root -Force)
    $backup=Join-Path $root ('backups\'+(Get-Date -Format 'yyyyMMdd-HHmmssfff'))
    [void](New-Item -ItemType Directory -Path $backup -Force)
    $names=@('retry-core.cjs','retry-preload.cjs','Start-Claude-Unlimited.ps1','policy.json','install-state.json')
    $prior=@{}
    foreach ($name in $names) {
        $file=Join-Path $root $name
        $prior[$name]=Test-Path -LiteralPath $file
        if ($prior[$name]) { Copy-Item -LiteralPath $file -Destination (Join-Path $backup $name) }
    }
    $shortcutPath=$null
    $shortcutExisted=$false
    $shortcutBackup=Join-Path $backup 'shortcut-before.lnk'
    try {
        foreach ($name in $payload.Keys) {
            [IO.File]::WriteAllBytes((Join-Path $root $name),[Convert]::FromBase64String($payload[$name]))
        }
        $policy=@{max_retries='unlimited';delay_ms=3000;attempt_timeout_ms=1800000;verified_binary=$binary;
                  binary_sha256=$hash;sdk_module='B:/~BUN/root/chunk-s8355z15.js';sdk_export='a_t'}
        Write-ReconnectJson (Join-Path $root 'policy.json') $policy
        $version=Invoke-RetryStartupProbe $binary $root
        if (-not $NoShortcut) {
            if (-not $ShortcutDirectory) { $ShortcutDirectory=[Environment]::GetFolderPath('Desktop') }
            if (-not (Test-Path -LiteralPath $ShortcutDirectory)) { throw 'Shortcut folder does not exist.' }
            $shortcutPath=Join-Path $ShortcutDirectory 'Claude Unlimited Retry.lnk'
            $shortcutExisted=Test-Path -LiteralPath $shortcutPath
            if ($shortcutExisted) { Copy-Item -LiteralPath $shortcutPath -Destination $shortcutBackup }
            $shell=New-Object -ComObject WScript.Shell
            $link=$shell.CreateShortcut($shortcutPath)
            $link.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $link.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $root 'Start-Claude-Unlimited.ps1')+'"'
            $link.WorkingDirectory=$root
            $link.IconLocation=$desktop+',0'
            $link.Save()
        }
        $files=@{}
        foreach ($name in @('retry-core.cjs','retry-preload.cjs','Start-Claude-Unlimited.ps1','policy.json')) {
            $files[$name]=(Get-FileHash -LiteralPath (Join-Path $root $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        Write-ReconnectJson $statePath @{marker='claude-unlimited-retry-v1';install_dir=$root;verified_binary=$binary;
            binary_sha256=$hash;explicit_code_binary=$CodeBinary;explicit_desktop_executable=$DesktopExecutable;files=$files}
        Write-Output ('Installed for '+$version)
        Write-Output 'Only unlimited retries, fixed 3 second delay. API and proxy settings were not changed.'
        Write-Output 'Quit Claude completely from its system tray icon, then open Claude Unlimited Retry on the desktop.'
        Write-Output ('Installed files: '+$root)
    } catch {
        foreach ($name in $names) {
            $file=Join-Path $root $name
            if ($prior[$name]) { Copy-Item -LiteralPath (Join-Path $backup $name) -Destination $file -Force }
            elseif (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
        }
        if ($shortcutPath) {
            if ($shortcutExisted -and (Test-Path -LiteralPath $shortcutBackup)) { Copy-Item -LiteralPath $shortcutBackup -Destination $shortcutPath -Force }
            elseif (-not $shortcutExisted -and (Test-Path -LiteralPath $shortcutPath)) { Remove-Item -LiteralPath $shortcutPath }
        }
        throw
    }
} catch { Write-Error $_.Exception.Message -ErrorAction Continue; exit 1 }

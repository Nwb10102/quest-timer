param([switch]$Run, [switch]$Smoke)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
Push-Location $taskRoot
try {
    dotnet restore native/QuestTimer.csproj --packages .cache/nuget --locked-mode
    if ($LASTEXITCODE -ne 0) { throw 'NuGet 패키지 복원 실패' }
    dotnet build native/QuestTimer.csproj -c Release --no-restore
    if ($LASTEXITCODE -ne 0) { throw 'WebView2 빌드 실패' }
    $taskOutput = Join-Path $taskRoot 'dist-webview2/Quest Timer'
    $taskBinary = Join-Path $taskRoot 'native/bin/Release/net48'
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $taskOutput 'www') -Force | Out-Null
    # Explicit list: no Chromium, developer tools, WPF DLL, or duplicate loaders.
    @('Quest Timer.exe', 'Quest Timer.exe.config', 'Microsoft.Web.WebView2.Core.dll',
      'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'icon.ico') | ForEach-Object {
        Copy-Item -LiteralPath (Join-Path $taskBinary $_) -Destination $taskOutput -Force
    }
    @('index.html', 'styles.css', 'game.js', 'renderer.js', 'host.js') | ForEach-Object {
        Copy-Item -LiteralPath (Join-Path $taskBinary "www/$_") -Destination (Join-Path $taskOutput 'www') -Force
    }
    $taskSdk = Join-Path $taskRoot '.cache/nuget/microsoft.web.webview2/1.0.4191.47'
    Copy-Item -LiteralPath (Join-Path $taskSdk 'LICENSE.txt') -Destination (Join-Path $taskOutput 'WebView2-LICENSE.txt') -Force
    Copy-Item -LiteralPath (Join-Path $taskSdk 'NOTICE.txt') -Destination (Join-Path $taskOutput 'WebView2-NOTICE.txt') -Force
    Copy-Item -LiteralPath (Join-Path $taskRoot 'native/사용법.txt') -Destination $taskOutput -Force
    $taskVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
    $taskZip = Join-Path $taskRoot "dist-webview2/Quest Timer $taskVersion WebView2.zip"
    Compress-Archive -LiteralPath $taskOutput -DestinationPath $taskZip -CompressionLevel Optimal -Force
    $taskBytes = (Get-ChildItem -LiteralPath $taskOutput -Recurse -File | Measure-Object Length -Sum).Sum
    Write-Host ('App: {0:N2} MiB / ZIP: {1:N2} MiB' -f ($taskBytes / 1MB), ((Get-Item -LiteralPath $taskZip).Length / 1MB))
    $taskExe = Join-Path $taskOutput 'Quest Timer.exe'
    if ($Smoke) {
        $taskTestData = Join-Path ([IO.Path]::GetTempPath()) ('quest-webview-smoke-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $taskTestData | Out-Null
        Write-Host "Smoke test data: $taskTestData"
        $taskProcess = Start-Process -FilePath $taskExe -ArgumentList @('--smoke', ('--data-dir="' + $taskTestData + '"')) -WindowStyle Hidden -PassThru
        if (-not $taskProcess.WaitForExit(120000)) { $taskProcess.Kill(); throw '스모크 테스트 시간 초과' }
        if ($taskProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $taskTestData 'success.txt'))) {
            Get-Content -LiteralPath (Join-Path $taskTestData 'failure.txt') -ErrorAction SilentlyContinue
            throw 'WebView2 스모크 테스트 실패'
        }
        Get-Content -LiteralPath (Join-Path $taskTestData 'smoke.log')
    } elseif ($Run) {
        Start-Process -FilePath $taskExe -WindowStyle Normal
    }
} finally { Pop-Location }

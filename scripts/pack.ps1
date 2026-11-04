# 打包安装包：拉便携 Python → 打 payload.zip → 编译 setup.exe
# 需要 Python 3.10+ 在 PATH（或者把 portable python 放到 runtime\python.exe）

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$payload = Join-Path $dist "payload"
$runtime = Join-Path $payload "runtime"

New-Item -ItemType Directory -Force -Path $dist, $payload | Out-Null
Copy-Item (Join-Path $root "src\server.py") $payload -Force
Copy-Item (Join-Path $root "web\*") $payload -Force
Copy-Item (Join-Path $root "dist\CityIDE.exe") $payload -Force
foreach ($d in "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll", "app.ico", "README.md") {
    $src = Join-Path $root "dist\$d"
    if (-not (Test-Path $src)) { $src = Join-Path $root "src\native\$d" }
    if (Test-Path $src) { Copy-Item $src $payload -Force }
}

if (-not (Test-Path (Join-Path $runtime "python.exe"))) {
    $zip = Join-Path $dist "python-embed.zip"
    if (-not (Test-Path $zip)) {
        Write-Host "下载便携 Python…"
        Invoke-WebRequest -Uri "https://mirrors.huaweicloud.com/python/3.12.8/python-3.12.8-embed-amd64.zip" -OutFile $zip
    }
    Expand-Archive -Path $zip -DestinationPath $runtime -Force
}

$payloadZip = Join-Path $dist "payload.zip"
Remove-Item $payloadZip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $payload "*") -DestinationPath $payloadZip -CompressionLevel Optimal

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$setup = Join-Path $dist "CityMinecraft-IDE-1.0.0-Setup.exe"
& $csc /nologo /target:winexe /out:"$setup" `
    /win32icon:"$payload\app.ico" `
    /resource:"$payloadZip",payload.zip `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll `
    /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
    (Join-Path $root "src\installer\Common.cs") `
    (Join-Path $root "src\installer\SetupForm.cs") `
    (Join-Path $root "src\installer\UninstallForm.cs")

if ($LASTEXITCODE -ne 0) { throw "打包失败" }
Write-Host "已生成 $setup ($([math]::Round((Get-Item $setup).Length / 1MB, 1)) MB)" -ForegroundColor Green

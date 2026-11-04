# 编译原生外壳（CityIDE.exe）
# 需要 Windows 自带的 .NET Framework csc，不需要 VS

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$native = Join-Path $root "src\native"
$out = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "找不到 csc.exe（.NET Framework 4.x 没装？）" }

# WebView2 的托管 DLL 和加载器需要先准备好（放进 src/native 或 dist）
$dlls = @(
    "Microsoft.Web.WebView2.Core.dll",
    "Microsoft.Web.WebView2.WinForms.dll",
    "WebView2Loader.dll"
)
foreach ($d in $dlls) {
    if (-not (Test-Path (Join-Path $native $d))) {
        Write-Host "缺少 $d，请先把 WebView2 SDK 的这几个 DLL 放到 src/native" -ForegroundColor Yellow
    }
}

$exe = Join-Path $out "CityIDE.exe"
& $csc /nologo /target:winexe /out:"$exe" `
    /win32icon:"$native\app.ico" `
    /r:"$native\Microsoft.Web.WebView2.Core.dll" `
    /r:"$native\Microsoft.Web.WebView2.WinForms.dll" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll `
    /r:System.Net.dll /r:System.Net.Http.dll /r:System.Core.dll /r:System.Linq.dll `
    "$native\Program.cs"

if ($LASTEXITCODE -ne 0) { throw "编译失败" }
Write-Host "已生成 $exe" -ForegroundColor Green

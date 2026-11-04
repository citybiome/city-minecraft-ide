param(
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$Owner = "citybiome",
    [string]$Repo = "city-minecraft-ide"
)

$ErrorActionPreference = "Stop"
$Headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "city-ide-publisher"
}

$releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases" -Headers $Headers
$draft = $releases | Where-Object { $_.draft } | Select-Object -First 1
if (-not $draft) { throw "没有草稿 release" }

$body = @"
## 1.0.0

首个发布。

**功能**
- 原生窗口（WinForms + WebView2），没有浏览器痕迹
- 内置编译器：javac 编译 / 打包 jar / 运行
- 版本下载：原版、Fabric、Forge、NeoForge、Quilt、OptiFine，国内镜像优先
- 启动游戏：自动补 natives、资源索引、中文语言；启动后 15 秒自动诊断日志
- 版本隔离：按 PCL 规则识别，隔离版本用自己的 mods / saves
- 模组工坊：解析 jar、解包到工程、javap 反编译、依赖检查
- 账户：离线账户、自定义皮肤、微软正版登录
- 灵动岛：跟随游戏窗口的状态条，左日志右诊断
- 外观：主题色、背景（纯色 / 渐变 / 图片）
- 更新检查：读 GitHub release，有新版本弹窗提示

**安装**
下载下面的 `CityMinecraft-IDE-1.0.0-Setup.exe`，双击安装。不需要管理员权限，自带 Python 和 WebView2 运行时。
"@

$payload = @{ body = $body; name = "City Minecraft Java IDE v1.0.0" } | ConvertTo-Json -Depth 5
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$h = $Headers.Clone()
$h["Content-Type"] = "application/json; charset=utf-8"

$res = Invoke-RestMethod -Method Patch -Uri "https://api.github.com/repos/$Owner/$Repo/releases/$($draft.id)" -Headers $h -Body $bytes
Write-Host "已更新说明，长度 $($res.body.Length)"
Write-Host $res.body.Substring(0, [Math]::Min(200, $res.body.Length))

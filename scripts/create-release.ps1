param(
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$Owner = "citybiome",
    [string]$Repo = "city-minecraft-ide",
    [string]$Version = "1.0.1",
    [string]$File = "",
    [string]$BodyFile = "",
    [switch]$Draft
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "city-ide-release"
}

$tag = "v$Version"
$name = "City Minecraft Java IDE $tag"

$body = $null
if ($BodyFile -and (Test-Path $BodyFile)) {
    $body = [IO.File]::ReadAllText($BodyFile, [Text.Encoding]::UTF8)
}
if (-not $body) {
    $body = "## $Version`n`n- 更新内容见仓库 CHANGELOG.md"
}

Write-Host "== 创建 release $tag =="
$payload = @{
    tag_name         = $tag
    name             = $name
    body             = $body
    draft            = $Draft.IsPresent
    prerelease       = $false
    target_commitish = "main"
} | ConvertTo-Json -Depth 5

$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$h = $Headers.Clone()
$h["Content-Type"] = "application/json; charset=utf-8"

# 已存在就更新
$existing = $null
try {
    $existing = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/tags/$tag" -Headers $Headers
} catch { }

if ($existing) {
    Write-Host "  已存在，更新内容"
    $res = Invoke-RestMethod -Method Patch -Uri "https://api.github.com/repos/$Owner/$Repo/releases/$($existing.id)" -Headers $h -Body $bytes
} else {
    $res = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Owner/$Repo/releases" -Headers $h -Body $bytes
}
Write-Host "  $($res.html_url)  draft=$($res.draft)" -ForegroundColor Green

if (-not $File -or -not (Test-Path $File)) {
    Write-Host "  没有指定安装包，跳过附件"
    exit 0
}

$fileName = [IO.Path]::GetFileName($File)
Write-Host "== 上传附件 $fileName ($([math]::Round((Get-Item $File).Length/1MB,1)) MB) =="

# 同名附件先删
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/$($res.id)" -Headers $Headers
foreach ($a in $rel.assets) {
    if ($a.name -eq $fileName) {
        Write-Host "  删除同名旧附件"
        Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$Owner/$Repo/releases/assets/$($a.id)" -Headers $Headers | Out-Null
    }
}

$h2 = $Headers.Clone()
$h2["Content-Type"] = "application/octet-stream"
$uploadUrl = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($res.id)/assets?name=$([uri]::EscapeDataString($fileName))"
$asset = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $h2 -Body ([IO.File]::ReadAllBytes($File)) -TimeoutSec 900
Write-Host "  已上传：$($asset.browser_download_url)" -ForegroundColor Green

Write-Host ""
Write-Host "完成：https://github.com/$Owner/$Repo/releases/tag/$tag"

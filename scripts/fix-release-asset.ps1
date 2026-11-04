param(
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$Owner = "citybiome",
    [string]$Repo = "city-minecraft-ide",
    [string]$Tag = "v1.0.1",
    [string]$File = "",
    [switch]$DeleteDrafts
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "city-ide-release"
}

Write-Host "== 定位 release $Tag =="
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/tags/$Tag" -Headers $Headers
Write-Host "  $($rel.name)  draft=$($rel.draft)  assets=$($rel.assets.Count)"

foreach ($a in $rel.assets) {
    Write-Host "  删除旧附件 $($a.name)"
    Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$Owner/$Repo/releases/assets/$($a.id)" -Headers $Headers | Out-Null
}

if ($File -and (Test-Path $File)) {
    $name = [IO.Path]::GetFileName($File)
    Write-Host "== 上传 $name（$([math]::Round((Get-Item $File).Length/1MB,1)) MB）=="
    $h = $Headers.Clone()
    $h["Content-Type"] = "application/octet-stream"
    $url = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($rel.id)/assets?name=$([uri]::EscapeDataString($name))"
    $asset = Invoke-RestMethod -Method Post -Uri $url -Headers $h -Body ([IO.File]::ReadAllBytes($File)) -TimeoutSec 900
    Write-Host "  $($asset.browser_download_url)" -ForegroundColor Green
}

if ($DeleteDrafts) {
    Write-Host "== 清理草稿 =="
    $all = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases?per_page=100" -Headers $Headers
    foreach ($d in ($all | Where-Object { $_.draft })) {
        Write-Host "  删除草稿：$($d.name)（id=$($d.id)）"
        Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$Owner/$Repo/releases/$($d.id)" -Headers $Headers | Out-Null
    }
}

Write-Host ""
Write-Host "== 结果 =="
$latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/latest" -Headers @{ "User-Agent" = "city-ide" }
Write-Host "  latest = $($latest.tag_name)   draft=$($latest.draft)"
$latest.assets | ForEach-Object { Write-Host "  asset: $($_.name)  $([math]::Round($_.size/1MB,1)) MB" }

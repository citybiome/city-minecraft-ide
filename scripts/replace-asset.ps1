param(
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$Owner = "citybiome",
    [string]$Repo = "city-minecraft-ide",
    [string]$File = "C:\Users\Administrator\Documents\deepseek-harness\default-workspace\javaide\dist\CityMinecraft-IDE-1.0.0-Setup.exe"
)

$ErrorActionPreference = "Stop"
$Headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "city-ide-publisher"
}

Write-Host "== 找草稿 release =="
$releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases" -Headers $Headers
$draft = $releases | Where-Object { $_.draft } | Select-Object -First 1
if (-not $draft) { throw "没有草稿 release" }
Write-Host "  $($draft.name)  id=$($draft.id)  assets=$($draft.assets.Count)"

Write-Host "== 删掉旧附件 =="
foreach ($a in $draft.assets) {
    Write-Host "  删除 $($a.name)"
    Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$Owner/$Repo/releases/assets/$($a.id)" -Headers $Headers | Out-Null
}

Write-Host "== 上传新附件 =="
$bytes = [IO.File]::ReadAllBytes($File)
$name = [IO.Path]::GetFileName($File)
$h2 = $Headers.Clone()
$h2["Content-Type"] = "application/octet-stream"
$url = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($draft.id)/assets?name=$([uri]::EscapeDataString($name))"
$res = Invoke-RestMethod -Method Post -Uri $url -Headers $h2 -Body $bytes -TimeoutSec 600
Write-Host "  已上传：$($res.browser_download_url)" -ForegroundColor Green
Write-Host "  大小：$([math]::Round($res.size/1MB,1)) MB"

<#
.SYNOPSIS
    把源码发布到 GitHub：建仓库 → 传文件 → 建草稿 release（带安装包）。

.EXAMPLE
    .\publish.ps1 -Token "ghp_xxx" -Repo "yourname/city-minecraft-ide"

.EXAMPLE
    .\publish.ps1 -Token "ghp_xxx" -Repo "yourname/city-minecraft-ide" -DryRun
#>
param(
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$Branch = "main",
    [string]$Tag = "",
    [string]$Name = "",
    [string]$BodyFile = "",
    [switch]$Private,
    [switch]$SkipRelease,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot          # 仓库根目录
$ApiRoot = "https://api.github.com"
$Headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "city-ide-publisher"
}

function InvokeApi {
    param(
        [string]$Method = "GET",
        [string]$Url,
        $Body = $null,
        [string]$ContentType = "application/json"
    )
    $args = @{
        Method      = $Method
        Uri         = $Url
        Headers     = $Headers
        ErrorAction = "Stop"
    }
    if ($null -ne $Body) {
        if ($Body -is [byte[]]) {
            $args.Body = $Body
        } else {
            $args.Body = ($Body | ConvertTo-Json -Depth 12)
            $args.ContentType = $ContentType
        }
    }
    try {
        return Invoke-RestMethod @args
    } catch {
        $msg = $_.Exception.Message
        if ($_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message }
        throw "GitHub API 出错（$Method $Url）：$msg"
    }
}

Write-Host "== 1/4 检查 token ==" -ForegroundColor Cyan
$parts = $Repo.Split("/")
if ($DryRun) {
    $owner = $parts[0]
    Write-Host "  [DryRun] 跳过 token 校验，按 $owner 处理" -ForegroundColor DarkGray
} else {
    $me = InvokeApi -Url "$ApiRoot/user"
    $owner = $me.login
    Write-Host "  登录为：$owner"
}

if ($parts.Count -ne 2) { throw "-Repo 要写成 用户名/仓库名" }
$repoOwner = $parts[0]
$repoName = $parts[1]
if ($repoOwner -ne $owner) {
    Write-Host "  注意：仓库属于 $repoOwner（组织？），会用你的权限去创建" -ForegroundColor Yellow
}

Write-Host "== 2/4 确认仓库 ==" -ForegroundColor Cyan
$repoExists = $false
try {
    $r = InvokeApi -Url "$ApiRoot/repos/$repoOwner/$repoName"
    $repoExists = $true
    if ($r.default_branch) { $Branch = $r.default_branch }
    Write-Host "  已存在：$($r.html_url)（分支 $Branch）"
} catch {
    Write-Host "  仓库不存在，准备创建"
}

if (-not $repoExists) {
    if ($DryRun) {
        Write-Host "  [DryRun] 会创建仓库 $repoOwner/$repoName (private=$($Private.IsPresent))" -ForegroundColor DarkGray
    } else {
        $created = InvokeApi -Method "POST" -Url "$ApiRoot/user/repos" -Body @{
            name        = $repoName
            description = "City Minecraft Java IDE - 本地 Minecraft 模组开发 IDE"
            private     = $Private.IsPresent
            has_issues  = $true
            auto_init   = $false
        }
        Write-Host "  已创建：$($created.html_url)" -ForegroundColor Green
    }
}

Write-Host "== 3/4 上传文件 ==" -ForegroundColor Cyan
$skipDirs = @("dist", "repo", ".git", "workspace", "cache", "moddev", "__pycache__",
              ".webview2", ".webview2-island", ".chrome-profile", "node_modules")
$skipFiles = @("config.json", "server.log", "theme-bg.img", "setup.log", "*.png.tmp")

$files = Get-ChildItem -Path $Root -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($Root.Length + 1)
    $inSkip = $false
    foreach ($d in $skipDirs) {
        if ($rel -like "$d\*" -or $rel -like "$d/*") { $inSkip = $true; break }
    }
    if ($inSkip) { return $false }
    foreach ($f in $skipFiles) { if ($_.Name -like $f) { return $false } }
    if ($rel -like "*.pyc") { return $false }
    return $true
}

Write-Host "  共 $($files.Count) 个文件"

$i = 0
foreach ($f in $files) {
    $i++
    $rel = $f.FullName.Substring($Root.Length + 1).Replace("\", "/")
    $url = "$ApiRoot/repos/$repoOwner/$repoName/contents/$([uri]::EscapeUriString($rel))"

    if ($DryRun) {
        Write-Host ("  [{0}/{1}] {2}" -f $i, $files.Count, $rel) -ForegroundColor DarkGray
        continue
    }

    $sha = $null
    try {
        $existing = InvokeApi -Url "$url`?ref=$Branch"
        if ($existing -and $existing.sha) { $sha = $existing.sha }
    } catch { }

    $bytes = [IO.File]::ReadAllBytes($f.FullName)
    $content = [Convert]::ToBase64String($bytes)
    $body = @{
        message = "upload $rel"
        content = $content
        branch  = $Branch
    }
    if ($sha) { $body.sha = $sha }

    try {
        InvokeApi -Method "PUT" -Url $url -Body $body | Out-Null
        Write-Host ("  [{0}/{1}] {2}" -f $i, $files.Count, $rel) -ForegroundColor Green
    } catch {
        # 空仓库第一次提交时分支可能还不存在，去掉 branch 再来一次
        $body2 = @{ message = "upload $rel"; content = $content }
        if ($sha) { $body2.sha = $sha }
        try {
            InvokeApi -Method "PUT" -Url $url -Body $body2 | Out-Null
            Write-Host ("  [{0}/{1}] {2}（默认分支）" -f $i, $files.Count, $rel) -ForegroundColor Green
        } catch {
            Write-Host ("  [{0}/{1}] {2} 失败：{3}" -f $i, $files.Count, $rel, $_.Exception.Message) -ForegroundColor Red
        }
    }
}

if ($SkipRelease) {
    Write-Host "== 完成（跳过了 release）==" -ForegroundColor Cyan
    exit 0
}

Write-Host "== 4/4 建草稿 release ==" -ForegroundColor Cyan
if (-not $Tag) { $Tag = "v1.0.0" }
if (-not $Name) { $Name = "City Minecraft Java IDE $Tag" }

$notes = "首次发布。"
if ($BodyFile -and (Test-Path $BodyFile)) { $notes = Get-Content $BodyFile -Raw }

if ($DryRun) {
    Write-Host "  [DryRun] 会创建草稿 release：$Tag" -ForegroundColor DarkGray
    exit 0
}

$existingRelease = $null
try {
    $existingRelease = InvokeApi -Url "$ApiRoot/repos/$repoOwner/$repoName/releases/tags/$Tag"
} catch { }

if ($existingRelease) {
    Write-Host "  release $Tag 已存在：$($existingRelease.html_url)" -ForegroundColor Yellow
    $release = $existingRelease
} else {
    $release = InvokeApi -Method "POST" -Url "$ApiRoot/repos/$repoOwner/$repoName/releases" -Body @{
        tag_name         = $Tag
        name             = $Name
        body             = $notes
        draft            = $true
        prerelease       = $false
        target_commitish = $Branch
    }
    Write-Host "  已创建草稿：$($release.html_url)" -ForegroundColor Green
}

$installer = Get-ChildItem -Path (Join-Path $Root "..\dist") -Filter "*Setup.exe" -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) {
    $installer = Get-ChildItem -Path (Join-Path $Root "dist") -Filter "*Setup.exe" -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

if ($installer) {
    Write-Host "  上传安装包：$($installer.Name) ($([math]::Round($installer.Length/1MB,1)) MB)"
    $uploadUrl = "https://uploads.github.com/repos/$repoOwner/$repoName/releases/$($release.id)/assets?name=$([uri]::EscapeDataString($installer.Name))"
    try {
        $bytes = [IO.File]::ReadAllBytes($installer.FullName)
        $assetHeaders = $Headers.Clone()
        $assetHeaders["Content-Type"] = "application/octet-stream"
        $res = Invoke-RestMethod -Method "POST" -Uri $uploadUrl -Headers $assetHeaders -Body $bytes -TimeoutSec 600
        Write-Host "  附件已上传：$($res.browser_download_url)" -ForegroundColor Green
    } catch {
        Write-Host "  安装包上传失败：$($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "  没找到安装包（dist\*Setup.exe），跳过附件" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "完成。打开发布页看看草稿：" -ForegroundColor Cyan
Write-Host "  https://github.com/$repoOwner/$repoName/releases"
Write-Host "确认没问题后点 Publish release 就正式发布了。"

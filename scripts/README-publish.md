# 发布到 GitHub（一条命令）

这个脚本用 GitHub REST API 上传，**不需要安装 git**。

## 用法

1. 打开 https://github.com/settings/tokens → Generate new token
   - 类型选 **Fine-grained token**
   - Repository access: **All repositories**（或者选中要发布的仓库）
   - Permissions → Repository permissions 里勾：
     - **Contents: Read and write**
     - **Administration: Read and write**（要新建仓库才需要）
2. 复制 token，运行：

```powershell
.\scripts\publish.ps1 -Token "ghp_xxx" -Repo "你的用户名/city-minecraft-ide"
```

想先看看会上传哪些文件（不真的传）：

```powershell
.\scripts\publish.ps1 -Token "xxx" -Repo "你的用户名/city-minecraft-ide" -DryRun
```

## 它会做四件事

1. 检查 token 是谁
2. 仓库不存在就创建（默认 public，想私有加 `-Private`）
3. 把源码按目录上传（已存在则更新）
4. 建一个**草稿 release**（draft=true，只有你能看到），把安装包作为附件传上去

草稿 release 你在网页上确认没问题再点 "Publish release" 就行。

## 参数

| 参数 | 说明 |
|---|---|
| `-Token` | GitHub token（必填） |
| `-Repo` | `用户名/仓库名`（必填） |
| `-Branch` | 分支名，默认 `main` |
| `-Private` | 建私有仓库 |
| `-SkipRelease` | 只传代码，不建 release |
| `-DryRun` | 只打印计划，不执行 |

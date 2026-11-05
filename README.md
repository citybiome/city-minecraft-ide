# City Minecraft Java IDE

一个给 Minecraft 模组开发用的**本地 IDE**：原生窗口、内置编译器、下载启动一条龙。
不用装 IDEA、不用配 Gradle，装完就能写代码、编模组、开游戏。

![安装包](docs/screenshot-installer.png)

## 它是什么

- **原生桌面程序**：WinForms + WebView2 外壳，没有地址栏、没有浏览器痕迹
- **内置编译器**：直接调 JDK 的 `javac` / `java`，编译、打包、运行全在界面里
- **启动器**：下载任意 Minecraft 版本、装 Fabric / Forge / NeoForge / Quilt / OptiFine、启动、自动诊断
- **联机**：开房间自动抓局域网端口、扫描附近世界、一键直连、UPnP 公网映射；红石联机可从 Modrinth 一键装
- **Java 运行时**：下载走国内镜像（清华 TUNA / 华为云），前一个挂了自动退 Adoptium 官方
- **模组工坊**：解析 jar、解包到工程、`javap` 反编译看字节码、检查模组依赖
- **账户**：离线账户、自定义皮肤、微软正版登录
- **灵动岛**：启动游戏后在游戏窗口上方浮一条状态条，点开左边日志右边诊断
- **可换外观**：主题色、背景（纯色 / 渐变 / 图片）

## 装

下载 [Releases](../../releases) 里的 `CityMinecraft-IDE-x.y.z-Setup.exe`，双击安装，不需要管理员权限，自带 Python 和 WebView2 运行时。

## 从源码构建

```powershell
# 1. 编译外壳（需要 .NET Framework 4.x 的 csc，Windows 自带）
.\scripts\build.ps1

# 2. 打包安装包（需要 Python 3.10+，用来拉便携 Python 和打 zip）
.\scripts\pack.ps1
```

产物在 `dist\` 下。

## 目录结构

```
src/server.py          后端：HTTP 服务、版本下载、启动、诊断、编译、账户
src/native/Program.cs  原生外壳（WinForms + WebView2）
src/installer/         安装包程序（安装向导 + 卸载）
web/                   前端（原生 HTML/CSS/JS，无框架）
scripts/               构建 / 打包脚本
```

## 技术要点

- 后端只监听 `127.0.0.1:8777`，前端由外壳加载，页面里不出现 IP
- 下载优先走国内镜像（BMCLAPI），资源文件走官方 CDN，多线程 + 长连接
- 启动前自动补齐 natives、资源索引、语言文件（否则会缺 `lwjgl.dll` 或进游戏是英文）
- 版本隔离按 PCL 的规则识别（`versions/<版本>/PCL/`），隔离版本用自己的 mods/saves
- 日志诊断：启动 15 秒后读日志，匹配常见崩溃模式并给出处理建议

## 许可

MIT

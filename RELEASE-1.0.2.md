## 1.0.2

这一版主要在修「皮肤进不到游戏里」这条链路，顺带把 bbmodel 转换和代码片段面板补齐。

### 修复
- **皮肤进不了游戏**：原版客户端只认认证服务器签名的 textures 属性，本地 png 放哪都没用。现在启动器自己当认证服务器（内置 Yggdrasil + 2048 位 RSA 签名），启动时自动挂 `authlib-injector`，离线账户也能有皮肤
- **头像和游戏里不一致**：两端现在读同一张 `custom_skins/<玩家名>.png`，由启动器签名下发
- **authlib-injector 版本太旧**：1.2.5 → 1.2.8，26.x 的新 authlib 才能转换成功
- **Windows 防火墙拦截**：启动器自动给 javaw 加放行规则，不再弹「防火墙已阻止此应用」
- 启动器缺 `lwjgl.dll` 直接崩 → 启动前自动补 natives
- 进游戏是英文 → 启动前补齐资源索引（含语言文件、音效）
- 多一个黑色控制台窗口 → 改用 `javaw.exe` + `CREATE_NO_WINDOW`
- 后台被旧目录残留进程占端口导致白屏 404 → 外壳核对 `root`，不是自己目录的就接管
- 版本隔离不生效、每个版本显示同一批 mod → 按 PCL 规则识别 `versions/<版本>/PCL/`
- 灵动岛卡在「补资源」 → 补完复位进度
- 游戏窗口识别错（把标题带 Minecraft 的浏览器窗口当成游戏）→ 必须 java/javaw 进程

### 新增
- **外置登录（皮肤站）**：Yggdrasil 协议登录，皮肤站上传的皮肤/披风能进游戏
- **bbmodel 转换**：Java Block/Item、Modded Entity、OptiFine Entity、Minecraft Skin；Bedrock 格式明确拒绝。保留 display 手持/GUI/地面变换、UV 按分辨率换算、多贴图拆分、多轴旋转提示烘焙
- **F5 代码片段面板**：49 个模板（常用 / 类与对象 / 集合 / 文件网络 / Minecraft / Fabric / Forge / NeoForge / Quilt / 构建 / 调试），带搜索、缩进跟随、光标占位
- **搜索工程**：在代码页里搜项目源码，结果显示 `文件:行号`，点击跳转
- **更新检测**：启动时读 GitHub release，有新版本弹窗
- **外观设置**：主题色、背景（纯色/渐变/图片）、暗化
- **账户**：离线改名、自定义皮肤、微软正版登录、外置登录

### 安装
下载 `CityMinecraft-IDE-1.0.2-Setup.exe`，双击安装，不需要管理员权限，自带 Python 3.12 和 WebView2 运行时，配置全默认。

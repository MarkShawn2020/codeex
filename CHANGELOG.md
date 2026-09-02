# Changelog

## 0.5.0 — 2026-09-02

### 新功能

- 新增 Prompt Config 插件：在 Codex 原生的指令链上分层配置 system、user、project 三级提示词，可读写 `config.toml` 的 `developer_instructions` 以及全局和所选项目的 AGENTS 指令文件。入口位于插件管理页和模型切换器旁。
- 新增 Safe Archive 插件：归档仍被其他 Codex 客户端占用的会话时，不再直接失败，而是说明该会话正被谁占用，并可选择「稍后归档」——等活跃写入方释放线程后自动完成。对话框提供一键复制诊断信息。

### 修复

- 修复后台启动器仍在、完整 Codex 运行体已退出时，重新打开 Codeex 或执行 `npx lovstudio app codeex start` 不会恢复窗口却误报成功的问题；显式打开现在会重新拉起并激活运行体，CLI 也会等到运行体真实存活后再报告成功。
- 修复 Codeex Dev 将 Vite 配置文件的只读访问误判为源码变化、反复终止并重启运行体的问题；切换到 `codeex` 项目不再表现为闪退。
- Prompt Config 只在插件管理页和模型切换器旁提供配置入口，不再重复注入新任务页右侧的 Environment 悬浮区。
- 修复官方 Codex 更新后重新分包生产代码时，Safe Archive 因为改写点被拆分到不同 chunk 而拒绝构建、导致应用无法启动的问题；插桩现在按内容定位改写点，不再假设它们同属一个 chunk。

### 分发

- 继续支持 Apple Silicon、macOS 13 或更高版本。
- 安装 Codeex 前需要已安装并至少启动一次官方 Codex（`/Applications/ChatGPT.app`）。

### 开发

- `npx lovstudio app codeex dev` 现在会启动与正式应用完全隔离的 Codeex Dev 桌面实例，并在插件、bridge、管理界面或运行脚本变化后自动重建和重启；原来的插件中心浏览器预览迁移为 `pnpm dev:plugin-center`。

## 0.4.1 — 2026-08-25

### 修复

- 修复后台启动器在任务流式更新期间反复夺取 macOS 前台焦点的问题；状态刷新、启动准备、权限检查和自动重启现在都保持在后台。
- 修复本地开发安装同时暴露两个 Codeex 应用身份的问题，只保留一个可见的 Codeex 运行界面。
- 修复启动器被替换或异常退出后管理进程继续驻留、占用控制端口的问题；运行体现在会跟随其所属启动器退出。

### 分发

- 继续支持 Apple Silicon、macOS 13 或更高版本。
- 安装 Codeex 前需要已安装并至少启动一次官方 Codex（`/Applications/ChatGPT.app`）。

## 0.4.0 — 2026-08-24

### 新功能

- 发布可分发的 Codeex 启动器：在用户设备上从已安装的官方 Codex 创建增强运行体，不随安装包再分发官方应用二进制。
- 在完整 Codex 界面内提供 Codeex 插件页，支持原子安装与卸载 Lovinsp、Daemonize 和 Archive Sidebar。
- 增加原生“完全磁盘访问权限”引导、授权状态检测、系统设置直达入口和菜单栏入口。
- 使用稳定 Developer ID 签名，避免每次插件重建后被 macOS 识别为新的 Codeex。

### 修复

- 修复 Codeex 与官方 ChatGPT 的进程、bundle identifier 和用户数据边界，两个应用可以并存。
- 修复切换插件页时官方 Tab 内容、搜索框占位符和页面状态丢失的问题。
- 保持 `~/.codex` 中的任务、Skills、MCP 和账号配置可由 Codeex 与官方应用共同使用。

### 分发

- 支持 Apple Silicon、macOS 13 或更高版本。
- 安装 Codeex 前需要已安装并至少启动一次官方 Codex（`/Applications/ChatGPT.app`）。

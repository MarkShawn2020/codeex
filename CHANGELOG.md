# Changelog

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

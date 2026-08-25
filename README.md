# Codeex

Codeex 0.4.1 是支持本地插件的完整 Codex Desktop。打开 `/Applications/Codeex.app`
会直接进入熟悉的 Codex 界面，可正常创建任务、运行 Agent、操作代码以及使用
Skills 和 MCP；插件中心只是同一应用菜单栏中的辅助窗口，不再是必须经过的启动页。

Codeex 不覆盖、也不再分发 `/Applications/ChatGPT.app`。公开安装包只包含签名启动器、
插件和本地构建依赖；首次运行会从用户已经安装的官方 production 包，在 Application
Support 中准备增强运行体。它在产品体验上是一个应用，在更新和签名边界上则与官方
ChatGPT 相互独立。

后台启动器只负责菜单栏和运行体生命周期，不会因任务进度、状态刷新或自动重启夺取
当前应用焦点；只有用户主动选择“显示 Codeex”或打开插件中心时才会切换前台应用。

[从 codeex.lovstudio.ai 下载 Codeex](https://codeex.lovstudio.ai/) ·
[更新日志](CHANGELOG.md)

## 产品边界

Codeex 负责：

- 校验官方 Codex production 包并创建 APFS 写时复制构建输入；
- 发现 `plugins/*/plugin.json`，保存安装状态并执行插件生命周期；
- 把已安装插件注入 production renderer；
- 打开时直接显示完整 Codex，不展示单独启动器；
- 从 macOS 菜单栏打开插件中心、显示或重启 Codeex；
- 通过仅监听 `127.0.0.1`、随机令牌保护的控制接口管理插件。

| 插件 | 默认状态 | 作用 |
| --- | --- | --- |
| `lovinsp` | 已安装 | production renderer 的 click-to-code 与 bundle 源位置 |
| `daemonize` | 未安装 | 独立运行 `codex app-server daemon`，为界面重启后恢复任务提供基础 |

安装状态保存在：

```text
~/Library/Application Support/Codeex/plugins.json
```

## 安装与使用

普通用户：

1. 安装并至少启动一次官方 Codex，确认它位于 `/Applications/ChatGPT.app`；
2. 从 [codeex.lovstudio.ai](https://codeex.lovstudio.ai/) 下载 DMG，把 Codeex 拖入“应用程序”；
3. 如需跨项目、下载和附件目录工作，从 Codeex 菜单栏主动打开“完全磁盘访问权限…”并在授权后重启 Codeex。

开发安装：

```bash
pnpm install
pnpm install:app
open /Applications/Codeex.app
```

也可以运行：

```bash
npx lovstudio app codeex start
# 或在仓库内运行 pnpm start
```

启动后首先出现的是完整 Codex 主窗口。插件中心可从 Codeex 的 macOS 菜单栏图标打开。
Codeex 使用独立的 Electron profile，但继续读取 `~/.codex` 中的账号、任务、Skills、
MCP 和配置，因此同一批任务也能继续在官方 ChatGPT 中找到。

CLI 插件管理仍然可用：

```bash
pnpm plugins list
pnpm plugins install daemonize
pnpm plugins uninstall lovinsp
```

## 开发与验证

```bash
pnpm dev                 # 预览插件中心
pnpm check               # 类型、模块、manifest 与控制接口测试
pnpm build               # 构建插件中心及 production 运行资源
pnpm start:codex         # 开发时直接启动完整 Codeex 运行界面
pnpm smoke               # 隔离 profile 验证完整界面与 Lovinsp
pnpm smoke:daemonize     # 验证界面重启后 daemon 连接连续性
```

### macOS 文件夹权限

Codeex 会优先使用钥匙串中唯一的 `Developer ID Application` 身份签名。稳定的
Team ID 与 bundle ID 让 macOS 在版本重建后继续识别同一个 Codeex，避免对
Downloads、Documents、Desktop 反复弹出首次访问授权。

Codeex Tab、插件中心与菜单栏会显示“完全磁盘访问权限”入口，但后台启动过程不会
自动弹窗或切换前台应用。需要跨项目、下载、附件和受保护目录工作的用户可主动打开
“系统设置 → 隐私与安全性 → 完全磁盘访问权限”并开启 Codeex，授权后需重新启动。
macOS 不允许应用自行授予该权限，最终确认必须由用户完成。

多证书机器通过 `CODEEX_SIGN_IDENTITY` 指定证书 hash 或名称。没有 Developer
ID 时会降级为 ad-hoc 签名并明确警告；这种模式的 designated requirement 绑定
当前代码哈希，重建后无法保证复用 TCC 授权。可设置
`CODEEX_REQUIRE_STABLE_SIGNATURE=1` 禁止降级。若未启用完全磁盘访问权限，稳定
签名只能避免重复询问，首次访问每个受保护目录仍由 macOS 决定是否询问。

官方应用更新后重新构建即可；准备脚本会按版本和 `app.asar` 指纹自动重建。Codeex
使用独立 bundle ID，并优先以本机 Developer ID 做稳定签名；没有可用证书时才降级
为 ad-hoc。依赖 OpenAI Team ID / App Group 的系统级能力仍可能不可用，需要时请继续
使用未修改的官方 ChatGPT。

架构原因、备选方案和失败模式见
[ADR 0001](docs/adr/0001-single-surface-codeex-wrapper.md)。

Codex Desktop 前端源码未随应用公开，所以 Lovinsp 定位的是提取到
`.codex-upstream/app/webview/assets` 的 production bundle，而非 OpenAI 内部 TSX。

[Lovinsp 文档](https://inspector.fe-dev.cn/en)

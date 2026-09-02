# Codeex Agent Notes

## 失败模式与约定

- webview 插桩必须按内容（唯一字面量）定位 chunk，不能假设多处改写点同属一个 app-initial-* 文件：上游会在版本间重新分包（2026-09-02, 56d2c91）
- 上游 chunk 契约变更导致构建中止时，先在真实 upstream 目录上跑一遍插桩再改代码，fixture 测试通过不代表真实 bundle 命中（2026-09-02, 56d2c91）

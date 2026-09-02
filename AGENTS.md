# Codeex Agent Notes

## 失败模式与约定

- webview 插桩必须按内容（唯一字面量）定位 chunk，不能假设多处改写点同属一个 app-initial-* 文件：上游会在版本间重新分包（2026-09-02, 56d2c91）
- 上游 chunk 契约变更导致构建中止时，先在真实 upstream 目录上跑一遍插桩再改代码，fixture 测试通过不代表真实 bundle 命中（2026-09-02, 56d2c91）
- 公证不在 `build-release.mjs` 里，需手工走 notarytool，keychain profile 名为 `notary`；顺序是 app 先公证钉票、再用钉票后的 app 重建 DMG、DMG 再公证钉票（2026-09-02, d99442d）
- 钉票会改变 DMG 字节，`SHA256SUMS.txt`/`release-manifest.json`/`site/release.json`/`site/index.html` 的哈希与大小必须在钉票之后回填（2026-09-02, d99442d）
- `site/index.html` 的 release-proof 区块声称是发行回读证据，发版时必须用真实 sha256、字节数和 chunk/node 实测值覆盖，historically 曾长期滞留旧值（2026-09-02, d99442d）

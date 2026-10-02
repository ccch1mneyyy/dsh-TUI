# dsh-TUI Admission Conformance

本套件验证固定 dsh-std revision 与 TUI profile 的组合行为，不重新实现 dsh-std parser 或 negotiation。

运行：

```sh
pnpm test          # 在 dsh-TUI workspace 内（复用 workspace 安装的 @dsh-std/*）
npm run test:standalone   # 脱离 dsh-TUI workspace 时（回退到仓根 vendor/dsh-std）
```

测试优先装载当前 workspace 已安装的 `@dsh-std/*`。脱离 dsh-TUI workspace 单独运行（无 workspace 提供 `@dsh-std/*`）时，pnpm 会因 `workspace:*` peerDependencies 预检失败，请使用 `npm run test:standalone`（等价于 `node scripts/conformance.mjs --standalone`）：runner 会初始化并构建仓根 `vendor/dsh-std`，然后在 TUI Profile 目录下的 `node_modules` 建立指向构建产物的链接后运行同一组检查。`npm run test` 复用已安装或已构建的依赖，`npm run validate`（`--no-build`）只使用已经安装或构建的依赖。两种路径运行同一组检查：

- 使用 `@dsh-std/manifest` 解析并投影 Community v0.15 Manifest；
- 使用 `@dsh-std/command`、`@dsh-std/storage`、`@dsh-std/messages` 和 `@dsh-std/presentation` 注册 Community v0.15 公共 definitions；
- 将 Community v0.15 补充 definitions 与 TUI 私有 definitions 注册到同一个 `ProtocolCatalog`；
- 校验 Host Descriptor、permission policy、私有 profile digest、event envelope、ledger 和 claim；
- 验证 compatible、degraded、waiting authorization、rejected 与 unknown 的 TUI admission 投影；
- 验证 `tui.dsh/v1alpha1` 私有 requirement 能与 Host support 正常协商。

Evidence 必须区分声明、解析、协商、测试、观察与 attestation。任何层级都不得被展示为“安全插件”“无漏洞”“官方认证”或“兼容所有 DSH Host”。

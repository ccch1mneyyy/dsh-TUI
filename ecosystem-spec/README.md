# dsh-ecosystem-spec

`dsh-ecosystem-spec` 是建立在 [dsh-std](https://github.com/Yan-Zero/dsh-std) 之上的 dsh-TUI 插件准入 profile 与一致性测试库。

本仓库不另行定义 Manifest、元协议、composition、lifecycle 或 Community v0.15 领域协议。公共协议由 [`vendor/dsh-std`](vendor/dsh-std) submodule 固定；本仓库只规定：

- dsh-TUI 市场和推荐列表采用的额外准入条件；
- TUI Host Descriptor、验证声明和 effect ledger profile；
- TUI 自有协议；
- 将上述内容与 dsh-std 一起执行的 conformance fixtures。

私有协议使用普通的 `apiVersion + kind` 坐标，并注册到 dsh-std `ProtocolCatalog`。`x-ccch1mneyyy.tui/*` 只表示其兼容性由 dsh-TUI 维护，不会获得另一套发现、协商或生命周期机制。

当前规范和测试均为 Experimental，不代表 dsh 官方认证，也不构成安全隔离。

## 验证

```sh
git submodule update --init
corepack enable
pnpm test
```

`pnpm test` 会按 submodule 固定的 revision 安装并构建 dsh-std，然后运行 TUI admission suite。生成的 `lib` 只存在于 submodule 工作区，不提交到本仓库。

## 文档

| 路径 | 内容 |
|---|---|
| [`spec/community-consensus-v0.15.md`](spec/community-consensus-v0.15.md) | dsh-std 公共基线的稳定引用入口 |
| [`spec/tui-admission-v0.15.md`](spec/tui-admission-v0.15.md) | dsh-TUI 产品准入要求 |
| [`registry/registry-0.15.json`](registry/registry-0.15.json) | 本 profile 导入的 std 定义与自有定义 |
| [`protocols/profile-definitions.js`](protocols/profile-definitions.js) | 可由 dsh-std core 装载的 TUI 私有定义 |
| [`conformance/`](conformance) | fixtures、requirement matrix 与测试 runner |
| [`rfc/`](rfc) | TUI 增量协议及保留的历史 RFC 路径 |

规范优先级依次为实际执行环境与安全边界、固定的 dsh-std revision、TUI admission profile、实验提案和实现细节。

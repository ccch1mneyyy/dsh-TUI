# dsh-TUI Admission Protocol Profile

[`registry-0.15.json`](registry-0.15.json) 不是全局协议注册表。它描述本 TUI Profile（`tui-profile/`，与 dsh-TUI 代码同库、随代码修订）使用的 definition 集合：

- `imports` 引用固定 dsh-std revision 已提供的 definitions；
- `definitions` 只收录 dsh-TUI 私有 definitions。

导入条目不复制 dsh-std 的 schema 或 contract 正文。Community v0.15 的 `Command`、`LocalStorage`、`MessageObserver`、Presentation 与 Workspace 定义分别由 `@dsh-std/command`、`@dsh-std/storage`、`@dsh-std/messages`、`@dsh-std/presentation` 与 `@dsh-std/workspace` 注册。

本地 definition 的 contract profile 使用 SHA-256 固定。修改 profile 内容必须更新 digest，并按兼容性决定保留坐标或发布新 `apiVersion`。digest 只证明字节一致，不证明发布者身份。

`tui.dsh/*` 是 dsh-TUI 私有 namespace。私有 definition 与公共 definition 一样注册到 dsh-std `ProtocolCatalog`；目录收录本身不产生 live support。

权限目录仍是 TUI authorization policy 的输入。permission grant 与 protocol support 分开判断，安装 definition 不自动授权操作。

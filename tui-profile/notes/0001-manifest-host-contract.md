# 0001 — dsh-std Baseline Profile

> TUI Profile 说明（随 dsh-TUI 代码修订；编号仅作稳定锚点）。

## Baseline

dsh-TUI admission 使用 `vendor/dsh-std` 固定 revision 所定义的：

- Community v0.15 `dsh-plugin.json` 解析与投影；
- `apiVersion + kind` 元协议及 definition negotiation；
- composition、permission policy 接缝和 lifecycle scope；
- `commands.dsh/v1alpha1` `Command`；
- `storage.dsh/v1alpha1` `LocalStorage`；
- `messages.dsh/v1alpha1` `MessageObserver`。

对应规范与机器资产从 [统一指南](../docs/plugin-admission-and-development.md) 的 Community v0.15 基线进入。本 profile 不重新规定这些对象。

## TUI profile

[`registry/registry-0.15.json`](../registry/registry-0.15.json) 分为两类条目：

- `imports` 引用 dsh-std 已有定义；
- `definitions` 收录本 profile 的 TUI 私有定义，并绑定本地 contract profile digest。

Host Descriptor 只能声明上述 definition 集合中可由当前 `ProtocolCatalog` 解析的 support。Manifest requirement、Host support 和 TUI 私有协议由同一个 dsh-std evaluator 协商。

## Product decisions

dsh-TUI 额外规定 Host Descriptor、授权状态到 admission decision 的映射、artifact evidence 和市场展示。这些是 TUI product policy，不改变 dsh-std 协议语义。

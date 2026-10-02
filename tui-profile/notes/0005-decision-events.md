# 0005 — TUI Decision Events

> TUI Profile 说明（随 dsh-TUI 代码修订；编号仅作稳定锚点）。

**Coordinate:** `tui.dsh/v1alpha1` `DecisionEvents`

## Scope

该私有协议承载 dsh-TUI 的用户输入、回退、会话切换和压缩决策点。它不改变只读 observation 协议，也不把 TUI 决策接缝写成 dsh-std 的公共事件表。

协议 definition 通过 dsh-std `ProtocolCatalog` 注册。订阅归属、清理由 lifecycle activation scope 管理；跨进程使用时必须先由 connection agreement 暴露相应 support。

## Decision chain

每个 event point 必须定义 payload、合法 decision、无决定时的默认流程、权限和 deadline。一次 chain 串行处理 handler；handler 异常、非法返回或 normalize 失败被隔离并记录，随后继续。第一个合法且非 no-opinion 的 decision 生效；全链没有决定时执行原流程。

decision 应用前必须校验目标对象的运行时 identity/generation。目标已变化时不得按可复用 id 套用陈旧结果。

## Authorization

interception 默认拒绝并可撤销。当前权限为 `session.input.intercept`、`session.rewind.intercept`、`session.switch.intercept` 和 `session.compact.intercept`。撤销授权后，新的 dispatch 不再包含对应 handler；在途 decision 按 event point policy 取消或判定陈旧。

definition 位于 [`protocols/profile-definitions.js`](../protocols/profile-definitions.js)，contract profile 位于 [`registry/contracts/decision-events-v1alpha1.json`](../registry/contracts/decision-events-v1alpha1.json)。

# 0002 — Runtime Presentation Invocation

> TUI Profile 说明（随 dsh-TUI 代码修订；编号仅作稳定锚点）。

Runtime invocation 使用 `@dsh-std/presentation` 定义的 `PresentationDescriptor`、`PresentationClients` 与各项 Presentation protocol。本 profile 不定义 `PresentationSnapshot` protocol。

Host 必须从当前 active agreements 构造 invocation-scoped typed clients。Facet 不得在 activation state 中缓存 descriptor 或 client，也不得根据 local、remote、headless 或 UI 类型推断 Presentation 能力。

`text` 是 Command result 或其他领域内容，不是 Presentation protocol；device-code 是认证流程的 fallback，不是 Presentation capability。打开认证页面使用 `presentation.dsh/v1alpha1` `OpenExternal`。

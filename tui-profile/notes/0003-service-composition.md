# 0003 — Composition Baseline Reference

> TUI Profile 说明（随 dsh-TUI 代码修订；编号仅作稳定锚点）。

插件关系、facet selection、protocol preflight、provider 冲突和 activation order 采用 [`@dsh-std/composition`](../../vendor/dsh-std/docs/proposals/composition.zh.md)。本 profile 不再定义第二套 `provides` / `requires.services` 或按加载顺序选择 provider 的机制。

Community v0.15 Manifest 中出现 `provides` 或非空 `requires.services` 仍由 `@dsh-std/manifest` 拒绝。服务能力通过 facet protocol support、运行时 publication 和领域协议的 composition rule 表达。

dsh-TUI 可以提供自己的 selection policy，但 policy 只能在 dsh-std composition 暴露的选择点上决策，不能改变 protocol definition 或伪造 live support。

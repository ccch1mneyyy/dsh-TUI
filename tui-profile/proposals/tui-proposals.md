# dsh-TUI Experimental Proposals

> TUI Profile 说明（随 dsh-TUI 代码修订；编号仅作稳定锚点）。

本文记录 dsh-TUI 团队的非规范性实验方向与已知待决项，随 dsh-TUI 代码一起修订——没有
社区 RFC 轨道，也没有晋级或毕业门槛。TUI-PROP ID 是稳定引用，供链接与追溯使用；一个
方向只有在形成可由 dsh-std 装载的 definition、contract profile 和 conformance fixtures
后，才能被 admission profile 当作 protocol 使用。文中历史条目引用的 “RFC 000x” 指
[`notes/`](../notes/README.md) 下的同名说明（编号仅为稳定锚点，不代表流程阶段）。

## TUI-PROP-001 Reference Host / Conformance Host

**Status:** Experimental  
**Reason for TUI-specific scope:** TUI 希望提供第一个真实 Host conformance evidence，但不能自我认证。  
**Baseline dependency:** dsh-std Manifest、core、composition、lifecycle 与 TUI claim profile。
**Proposal identifier（尚非 protocol coordinate）:** `tui.dsh.conformance-host`
**Entry criteria:** Host Descriptor schema、测试 runner、至少一组合法/非法 fixture 可运行。  
**Exit criteria:** 两个独立 integration 和三个示例插件通过同一 headless suite，结果绑定 Host Descriptor/artifact digest。  
**Rollback plan:** 移除 TUI market 的 conformance claim 展示，保留原始测试日志，不影响插件运行。

覆盖 manifest、negotiation、lifecycle、event envelope、command registration、cleanup、ledger 和 invocation snapshot。

## TUI-PROP-002 Runtime Determinism

**Status:** Experimental  
**Reason for TUI-specific scope:** 远程工作区需要可观察、可复现的 runtime identity。  
**Community dependency:** v0.1 的 runtime generation、activation instance、artifact/claim schema。  
**Proposal identifier（尚非 protocol coordinate）:** `tui.dsh.runtime-determinism`
**Entry criteria:** 定义 Runtime ID、Generation、artifact digest、dependency lock、environment fingerprint、activation set 的数据结构。  
**Exit criteria:** 同一 generation 的重复启动产生相同 activation plan，并通过跨重启 fixture。  
**Rollback plan:** 停止生成 deterministic claim，回退到普通 Host Descriptor，不删除已有 ledger。

## TUI-PROP-003 Provenance-first UI

**Status:** Experimental  
**Reason for TUI-specific scope:** 溯源展示是 TUI 产品工作流，不是跨宿主渲染 contract。  
**Community dependency:** effect ledger、claim evidence、plugin/activation ownership。  
**Proposal identifier（尚非 protocol coordinate）:** `tui.dsh.provenance-view`
**Entry criteria:** ledger record schema 可验证，且无 secret/credential/token/正文泄露。  
**Exit criteria:** command、resource、异常和 cleanup 状态可从 UI 反查到 plugin/activation/runtime generation，并通过隐私测试。  
**Rollback plan:** 禁用 UI 查询入口，不停止 ledger 写入和清理能力。

## TUI-PROP-004 Reproducible Workspace

**Status:** Experimental  
**Reason for TUI-specific scope:** lockfile、安装复现和 workspace 迁移属于 TUI packaging/product 层。  
**Community dependency:** artifact digest、claim schema、runtime descriptor。  
**Proposal identifier（尚非 protocol coordinate）:** `tui.dsh.reproducible-workspace`
**Entry criteria:** 能计算依赖闭包并记录插件、配置、权限 grant 和产物 digest。  
**Exit criteria:** 新 runtime/container 能按 lock 复原同一 activation set，失败项有明确原因。  
**Rollback plan:** 回退到不可复现的普通安装并显式撤销 Reproducible 标记。

## TUI-PROP-005 Remote Presentation Snapshot

**Status:** Superseded

Invocation-scoped Presentation 的声明、协商、类型化调用、失效条件与安全边界由 `@dsh-std/presentation` 规定。TUI profile 不定义第二套 Snapshot protocol coordinate。

## TUI-PROP-006 Experimental UI Contract

**Status:** Superseded

Facet ownership、surface negotiation、host-rendered 与 local-module content mode、registration 和 lifecycle 由 `@dsh-std/ui` 规定。`page -> layer -> slot -> component` 属于 shell 的布局模型，不构成 TUI protocol coordinate。本 profile 不定义跨 Web、TUI 与 GUI 的通用 vnode tree。

TUI 的具体 contribution surfaces 由 RFC 0006 定义。删除本提案不会影响 Command、Presentation 或既有 TUI contribution identity。

## TUI-PROP-007 Experimental Service Composition

**Status:** Superseded

该方向已经由 dsh-std core、composition 和 lifecycle 承担。本 profile 不注册 `tui.dsh.service-composition`，也不增加第二套 service graph。TUI 的 provider selection 只能作为 composition policy 实现。

## TUI-PROP-008 Experimental Admission Profile

**Status:** Experimental  
**Reason for TUI-specific scope:** TUI 市场等级是产品 policy，不修改 dsh-std。
**Community dependency:** schemas、registry、conformance claim。  
**Proposal identifier（尚非 protocol coordinate）:** `tui.dsh.admission-profile`
**Entry criteria:** `compatibilityDecision`、`verificationLevel`、`restrictions[]` 三维状态和 claim schema 可消费。  
**Exit criteria:** 每一档都有机器可读证据、失败原因、市场展示和迁移测试，人工判断不能替代证据。  
**Rollback plan:** 降低市场展示等级并撤销无证据 claim，不删除插件 artifact 或历史证据。

## TUI-PROP-009 Lightweight UI Contributions（Host-Rendered + Scene Components）

**Status:** Superseded

本提案所称的两档 contribution 已分别对应 `@dsh-std/ui` 的 `host-rendered` 与 `local-module` content mode。公共 ownership、registration 和 cleanup 语义不再由 TUI 重复定义。

RFC 0006 保留 TUI 专属部分：`SettingsSection` descriptor、终端呈现约束、`Scene` 本地 handler ABI、全屏互斥和错误集合。其 definition、contract profiles 与 conformance fixtures 继续使用 `tui.dsh/v1alpha1` 坐标。

跨 endpoint 不传输可执行 scene handler，也不存在由本提案定义的通用 vnode fallback。远端 catalog 只能投影 RFC 0006 允许的纯数据 identity 与 metadata。

## 边界

除已经由 RFC 0006 定义的 contribution 外，上述提案在 definition、profile 和 fixtures 完成前不构成 protocol support，也不能成为 dsh-std 或其他 Host 的隐式依赖。

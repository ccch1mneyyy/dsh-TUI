# Adapter Note — dsh-tui (host) v0.15

**Status:** Current
**Spec version:** community-v0.15 + tui-admission/0.15（`registry/registry-0.15.json`）
**Host:** dsh-TUI 0.9.x（`@deepseek-harness-tui/dsh-tui`）/ Cordis 4.x profile；上游 `@deepseek-ai/*` 主校验线 `0.1.2-alpha.1`（兼容 `0.1.0-rc.6/7/8`、`0.1.1-rc.1/2`）
**仓库:** https://github.com/ccch1mneyyy/dsh-TUI（`src/dsh-adapter/`、`src/adapter/standard/`）

## 定位

本 Note 是 **dsh-tui 本体作为宿主**的 Adapter Note：它把公共 contract 坐标逐一映射到
dsh-tui 维护的 adapter 中介面（Cordis service id / 宿主 API），记录已知偏差与证据。

为什么映射表必须放在 TUI Profile 内、与准入规范同处一份文档：

- dsh-tui 的 adapter 层（`src/dsh-adapter/`）是**唯一**允许 import 官方 `@deepseek-ai/*`
  的地方（`verify:boundary` 门禁）；UI 层与插件一律只接触其中介面。
- 插件/扩展"使用 TUI 维护的 adapter、享受接口不炸"的前提，是**遵守 tui-admission v0.15**：
  接口稳定性来自 ① 上游 rc 校验线 ② patch surface 快照 ③ 契约坐标 fail-closed
  ④ 权限默认 deny——全部以本 profile `registry/` 与 `schemas/` 为准。
- 因此"用 adapter"与"遵循 spec"是同一份契约的两面；contract → 宿主机制的对照表
  随 spec 一起版本化，才能保证宿主行为可核查、可回滚。

边界（见 [`../governance/rules.md`](../governance/rules.md)）：本 Note 不改变标准语义；只约束 dsh-tui 宿主自身，其他宿主不要求遵守。

## Contract 映射

私有坐标统一为 `tui.dsh/v1alpha1`，与 dsh-tui 实际实现及本 profile
`registry/registry-0.15.json` 一致（原 D-1 已收口）。dsh-std 导入条目与 dsh-TUI 私有
definition 统一注册进 dsh-std `ProtocolCatalog`；权限与 protocol support 分开判断，
安装 definition 不自动授权操作。

| Spec 坐标 | 权限（默认） | dsh-tui adapter 落点（宿主机制） | 实现模块 |
| --- | --- | --- | --- |
| `commands.dsh/v1alpha1#Command`（import） | `commands.invoke`（allow） | `ctx.tuiPluginHost.registerCommand(pluginCtx, def)` —— 中介注册 + C-041 归属戳（per-owner deny 可执行）；**未归属**的 `ctx.get('commands').register` 是文档化 C-070 边界 | `plugin-host.ts` / `command-attribution.ts` / `command-errors.ts` |
| `storage.dsh/v1alpha1#LocalStorage`（import） | `storage.local.read` / `storage.local.write`（deny） | `ctx.tuiPluginStorage.open(pluginCtx)` → `{get,set,delete}`；命名空间由已验证 Component 身份派生（无冒充参数）；配额 256 keys / 256 KiB；值必须是精确 JSON；文件落 `~/.dsh-tui/plugin-storage/<ns>.json`（atomic write + 进程内串行链） | `plugin-storage.ts` |
| `messages.dsh/v1alpha1#MessageObserver`（import, event） | `messages.observe.read`（deny） | `ctx.tuiMessageObserver.subscribe(pluginCtx, scope, cb)`；scope=`session:<id>`，事件按 scope 隔离；投递 at-most-once、无 replay；**窄映射**见 D-2 | `message-observer.ts` |
| `presentation.dsh/v1alpha1#OpenExternal` / `UserInteraction` / `ExternalRedirect`（import） | — | 进程内 seam：`userQuestions` 服务 + `ask_user_question` 工具（questionStore）；`approval/request` 瀑布 → `ApprovalStore`（仅归属本 TUI 的 agent）；ExternalRedirect 为 TUI 侧补注册 provider 语义（见 D-3） | `plugin.ts` / `questions.ts` / `approvals.ts` / `tui-extension.ts` |
| `workspace.dsh/v1alpha1#WorkspaceProvider`（extension, dsh-std） | — | `ctx.tuiWorkspaces`（`dsh-tui-workspaces` 行）；缺失时回退本地 workspace runtime（#183） | `workspaces.ts` |
| `tui.dsh/v1alpha1#DecisionEvents`（私有 definition） | `session.input.intercept` / `session.rewind.intercept` / `session.switch.intercept` / `session.compact.intercept`（deny） | `ctx.tuiPluginHost.subscribeDecision(pluginCtx, event, listener)` —— D-7 中介决策门禁（身份/静态 requirement/scope/grant 全查）；事件名 `tui/input` `tui/rewind-prompt` `tui/rewind-done` `tui/session-switch` `tui/session-switched` `tui/compact`；无 grant 返回 no-op disposer 而非异常 | `decision-guard.ts` / `tui-extension.ts` / `component-identity.ts` |
| `tui.dsh/v1alpha1#Channel`（私有 definition） | — | Channel wire 协议：`wireRevision` 6、19 个 features（commands/credentials/diagnostics/files/models/modes/presets/presentation/provider-setup/scenes/session-history/session-input/session-lifecycle/session-state/settings/skills/subagents/trace/workspaces）；open/subscribe/invoke/close 各校验入参与快照形状 | `tui-channel.ts`（`@dsh-std/connection` defineCapabilityProtocol） |
| `tui.dsh/v1alpha1#SettingsSection`（私有 extension） | — | `ctx.tuiSettingsSections.register(...)`（/settings 屏区块） | `settings-sections.ts` |
| `tui.dsh/v1alpha1#Scene`（私有 extension） | — | `ctx.tuiScenes`（`dsh-tui-scenes` 行；全屏场景渲染） | `scenes.ts` |
| （无契约坐标的宿主 UI seam，`dsh-tui-extensions` 行） | — | `ctx.tuiDialogs` / `ctx.tuiStatus` / `ctx.tuiShortcuts` / `ctx.tuiRenderers` / `ctx.tuiCommandTrees`；软消费（`ctx.get`），缺行时降级为空 store | `dialogs.ts` / `status.ts` / `shortcuts.ts` / `renderers.ts` / `command-trees.ts` / `extensions.ts` |

跨契约的宿主机制：

- **Admission（TUI-PKG-001/002）**：`ctx.tuiPluginHost.admit(pluginCtx, source)` ——
  `@dsh-std/manifest` parse → project → vendored registry 校验 → grant 逐条评估 →
  negotiate（compatible / compatible_degraded 才放行）→ 绑定 Verified Component
  identity 到该 activation；activation 实例 id 由宿主签发。
- **Grant store**：`~/.dsh-tui/extension-grants.json`（`grants.ts` live GrantStore，
  文件变更即时生效并主动释放 grant 拥有的 effect）；`permissions-0.1.json` 是 policy
  输入，deny 默认。
- **Effect ledger（C-060）**：`ctx.tuiEffectLedger`，append-only JSONL
  `~/.dsh-tui/effect-ledger.jsonl`；每条记录携带 lifecycle triple
  （`pluginId` / `activationInstance` / `runtimeGenerationId`），写前过
  `schemas/effect-ledger-record.schema.json`（`additionalProperties: false` 结构性地
  禁止泄漏 payload），失败 fail-closed 丢弃、绝不改写已有行。
- **决策门禁（D-7）**：`installDecisionGuard` 在 plugin-host 行与 extensions 行各装一次
  （幂等），与 Cordis `ctx.on` 兼容 facade 无关——`ctx.on` 不能绕过 admission/scope/grant。

## Host Descriptor 映射（TUI-HOST-001）

`host-descriptor.ts` 懒构建 + 缓存（commands 挂载状态变化时重建）：

| Descriptor 字段 | dsh-tui 实际值 |
| --- | --- |
| `$schema` | `urn:dsh-tui:host-descriptor:0.15` |
| `hostId` / `hostVersion` | `dsh-tui` / `@deepseek-harness-tui/dsh-tui` package.json 版本（fallback `0.0.0`） |
| `facetApiVersions` | `["v1alpha1"]`（vendored registry 的 facetApiVersions 存在且形态 `vN(alpha\|beta)M` 时优先） |
| `contracts` | 从 vendored registry 解析；dsh-TUI 私有 definition 做 SHA-256 profile digest 校验（漂移即 drop，fail-closed）；support spec 过 `definition.validateSupport` |
| Command 诚实规则（C-010） | 仅当 `ctx.get('commands')` 已挂载才声明 `commands.dsh/v1alpha1#Command`；裸/嵌入上下文不协商虚假 compatible |
| `runtime` | `location: "local"`、`generationId` 每行激活一个 UUID（C-050）、`headless` 按进程 |
| `trustLevel` | `trusted-in-process`（TUI-TRUST-001：不构成 OS/进程/realm 安全边界） |
| `platform` | `process.platform` / `process.arch` / `process.version` |

构建完成后对 descriptor 再跑语义校验（`validateHost`）与 schema 校验（`check`），
失败则清空 `contracts` fail-closed。vendored registry 不可用时只广告空协议面并告警，
boot 不因漂移数据死亡。

## 上游契约映射

`contract.ts` 是官方上游的唯一校验点：

- 主校验线 `UPSTREAM_VALIDATED_VERSION = '0.1.2-alpha.1'`；兼容线
  `0.1.0-rc.6 / 0.1.0-rc.7 / 0.1.0-rc.8 / 0.1.1-rc.1 / 0.1.1-rc.2`
  （`UPSTREAM_VALIDATED_VERSIONS`）；特性门控用 `installedMeetsVersion` 跨家族比较，
  老安装优雅降级。
- peer 范围：`^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1`；blessed 包中 harness 包按完整版本号校验，
  框架包按 MAJOR 校验（`@deepseek-ai/cordis` 4、`@deepseek-ai/schemastery` 3）。
- drift → boot warning（开发可见）；CI `verify:contract` 直接失败（用户机器上炸之前先炸 CI）。
- Patch surface：`cordis.patch.yml` 干预已快照 `patch-surface.snapshot.json`
  （disables 23 行 / config overrides 6 行 / inserts 14 行；后 6 个 insert 对应官方
  web-app 的 host-plane 服务，使用 dsh-tui 作用域 id，检测到官方行时自行 disabled，
  可安全共存）；CI `verify:patch-surface` 与 `verify:web-coexistence` 分别检查快照与共存。
- 升级流程：`pnpm add` 新 rc → `build`（typecheck + 门禁）→ 契约/快照差异落入
  `src/dsh-adapter/` 内解决，业务 UI 零修改。

## 已知偏差

- **D-2 消息观察是窄映射**：只投递 `user/message → message.received`、
  `assistant/message → message.sent` 两类；streaming/chunk、`tool/*`、`turn/*`、mode
  事件一律不产生 envelope（保守起步）。`privacyClass` 恒为 `sensitive`；summary 截断
  200 格，图片引用按 192 KiB 预算解析，超限标记 `truncated`。
- **D-3 presentation 是进程内 seam 而非独立实现**：`ask_user_question` 走
  `userQuestions` 服务 + `ApprovalStore`（approval/request 瀑布）；`ExternalRedirect`
  是 TUI 侧补注册的 provider 语义 definition（`@dsh-std/presentation` 0.1.0 尚未携带
  该 kind）。
- **D-4 运行时 descriptor 与官方示例不同**：`registry/host-descriptor.tui.example.json`
  是 `runtime.location=remote` + `headless=true` + `remoteAttach` 的远程形态示例；
  真实 dsh-tui 运行时生成的是 `local` + `headless=false` 形态，且 `contracts` 受
  Command 挂载诚实规则影响。示例不是真实 descriptor 的镜像。
- **D-5 上游校验粒度**：harness 包要求 rc 号**一致**（不同 rc 混装即 drift），框架包
  只查 major——`cordis`/`schemastery` 的 minor/patch 差异不在校验面内。

## 证据

- dsh-tui 构建门禁（CI `verify:build`）：`verify:boundary`（越界 import 即失败）、
  `verify:contract`（上游 rc 线）、`verify:patch-surface`（快照对比）、`verify:manifest-deps`，
  以及 plugin 系列 `verify:plugin-spec` / `verify:plugin-grants` / `verify:plugin-storage` /
  `verify:plugin-messages` / `verify:plugin-ledger` / `verify:plugin-commands` /
  `verify:plugin-negotiation` / `verify:plugin-lifecycle`，以及扩展边界回归
  `verify:extension-events` / `verify:extension-ui` / `verify:plugin-scene-boundary`。
- 本 profile conformance：脱离 dsh-TUI workspace 单独运行 `npm run test:standalone`（固定 `vendor/dsh-std`
  submodule 初始化 + 构建 + 全套校验，含私有协议协商 fixture）；dsh-tui workspace
  内 `pnpm test` 复用 workspace 安装的 `@dsh-std/*`。
- 运行时 selfCheck：`tuiPluginHost.selfCheck()` 对 vendored registry + contract-profile
  digest 做完整性检查，违例项从 Host Descriptor fail-closed 丢弃并告警。
- dsh-tui 以固定 submodule 消费上游基线：`vendor/dsh-std`（固定 revision）。TUI Profile
  已随 dsh-tui 仓库内联（`tui-profile/`，不再是 `dsh-ecosystem-spec` submodule）；上游
  基线升级时需同步本 profile 的 registry、schemas 与 conformance。
- 关联 Note：[`dsh-tui-vscode-v0.15.md`](dsh-tui-vscode-v0.15.md)（VS Code companion
  宿主，与本 Note 的 dsh-tui 本体宿主互补）。

## 收敛计划

1. **私有命名空间已统一**：`tui.dsh/*` 已在 dsh-tui 代码、本 profile registry、
   conformance 与本文档同步（原 D-1 关闭）。
2. 消息观察事件面随 dsh-std messages 演进扩宽（有上游支撑时），privacyClass 细化
   逐步文档化（D-2）。
3. `ExternalRedirect` 上游化：等 `@dsh-std/presentation` 携带该 kind 后撤销 TUI 补注册
   （D-3）。
4. 发布运行时生成的"真实"Host Descriptor 作为 reference 资产，与官方示例并列
   （D-4）。

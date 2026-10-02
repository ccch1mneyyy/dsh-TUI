# Changelog

本文件是 **TUI Profile**（`tui-profile/`）的变更日志：条目描述本 profile 自身的规范、
资产与文档变化。profile 与 dsh-TUI 代码同处一库，随代码现状一起修订（归属、边界与修订
口径见 [`governance/rules.md`](governance/rules.md)），因此没有单独的审批或晋级流程，
登记的是 profile 的变化而不是 dsh-TUI 产品的全部变更。

## 2026-08-25（私有命名空间统一与插件文档合并）

### Changed

- dsh-tui 私有坐标统一为 `tui.dsh/v1alpha1`，Adapter Note 中 D-1 已关闭；
- 将 dsh-TUI `docs/plugins.md` / `plugins.en.md` 合并到本仓库 `docs/`，并在 README 文档地图中挂链。

## 2026-08-18（UI surface 分层）

### Changed

- RFC 0006 改为基于 `@dsh-std/ui` 的 TUI surface profile，只保留 `SettingsSection` 与 `Scene` 的 TUI 专属 descriptor、handler ABI、冲突和错误语义；
- TUI-PROP-006 与 TUI-PROP-009 标记为 Superseded；通用 contribution ownership、content mode、registration 与 lifecycle 不再由 TUI 重复定义；
- 明确 Scene 可执行 handler 不跨 endpoint，远端只投影协议允许的纯数据 identity 与 metadata。
- conformance runner 改为优先装载宿主提供的 `@dsh-std/*`；独立检出时通过 `npm run test:standalone` 回退到固定的 `vendor/dsh-std`，不再写死单一构建目录或递归执行 pnpm script。

## 2026-08-17（v0.15 对齐，社区 RFC v0.15）

### Breaking（Draft 阶段，迁移自 Community Consensus v0.1）

- **Manifest 结构升级到 v0.15**：顶层 `entry` / `apiVersion` 移除，改为 `facets.host.{entry, apiVersion}`（当前唯一注册值 `v1alpha1`）；`client` / `worker` 为保留名，出现即 `INVALID_MANIFEST`（契约归 RFC 0002）。
- **契约坐标化（元协议内核）**：`requires.capabilities.required/optional[]` 改为 `requires.contracts[]`，引用类 K8s 坐标 `apiVersion + kind`；registry 与契约 profile 增加坐标（`storage.dsh/v1alpha1`+LocalStorage、`commands.dsh/v1alpha1`+Command、`messages.dsh/v1alpha1`+MessageObserver），v0.1 平面名保留为 legacy 别名（当前用于 subscriptions 字符串形式解析）。
- **协商器改为坐标匹配**：group+kind 未知 → `INVALID_MANIFEST`（rejected）；group+kind 已知但 apiVersion 未注册 → `unknown`；决策优先级不变。
- **Host Descriptor 坐标化**：`apiVersions` 改为 `facetApiVersions`（`v1alpha1` 风格）；`contracts[]` 以坐标 + schemaHash 声明，且必须与 registry 一致（fail closed）。
- **messages.observe payload 对齐 MCP ContentBlock**：`textPreview` 移除，改为 `payload.content[]`（text / image 子集，边界待社区 §9 Q3 定案）；envelope 头字段不变。
- **版本号全线升到 0.15**：manifestVersion、eventVersion、ledgerVersion、claimVersion、specVersion `community-v0.15`、registryVersion；契约 profile 版本升到 0.15 并重新固定 schemaHash。
- 文件改名：`spec/community-consensus-v0.1.md → v0.15`、`spec/tui-admission-v0.1.md → v0.15`、`conformance/requirements-v0.1.json → v0.15`、`registry/registry-0.1.json → 0.15`、`registry/contracts/*-0.1.json → -0.15.json`。

### Added

- fixtures：`valid-plugin-object-subs`（坐标化 subscription 对象形式）、`invalid-plugin-unknown-coordinate`（未知 group）、`invalid-plugin-client-facet`（保留名拒绝）、`invalid-message-content`（ContentBlock 缺字段）；
- runner：坐标索引（byCoordinate / byName）、`resolveContractRef` / `resolveSubscription`、`validateHost`（坐标 + hash 钉死 registry）、oneOf 校验支持、`rejected` 协商断言；
- 规范文本：C-004 元协议坐标；版本模型 §10（六维独立演进）。

### 待社区定案（不影响本版实验实现）

- fallback 的承载机制（上游 v0.15 未定，本地按 TUI 收紧执行）；
- subscriptions 引用格式（上游示例为扁平字符串，本文同时接受坐标对象与 legacy 字符串）；
- ContentBlock 字段边界（§9 Q3）、privacyClass 分级（§9 Q4）；
- RFC 0004 证据等级术语（declared/resolved/decided vs 本库 Declared/Parsed/Negotiated...）待上游定案后对齐；
- 权限不支持语义（manifest 请求宿主未声明权限 → waiting_authorization 的歧义）待社区五态模型定案。

## 2026-08-17（红队验收修复，commit 29b9b72 之后）

### Fixed（红队 PASS WITH FINDINGS 的 3 个 Medium + 边界完善）

- **F1** runner `additionalProperties` 不再把 `$defs` 键当合法附加属性（对齐 draft-2020-12，未知顶层键彻底 fail-closed）；
- **F2** `facets.host.apiVersion` 必须 ∈ registry 的 `facetApiVersions`（当前 `["v1alpha1"]`）；协商新增 facet 版本交叉校验，不匹配 → `rejected`/`FACET_API_VERSION_UNAVAILABLE`；
- **F3** optional 引用缺 fallback 的拒绝提前到未注册版本分支之前（无版本例外）；
- **F5** Host Descriptor 权限必须 ∈ permissions registry，未知权限即无效；坐标不得重复；
- **F7** oneOf 改为"恰好一个匹配"（JSON Schema 语义）；profile/registry 权限一致性纳入 verifyContractProfiles；
- **F4** 新增 12 个 fixture（unknown kind、subscription→capability、重复坐标、未注册 facet 版本、worker facet、混合 ContentBlock、host 未知契约/hash 不匹配/未知权限/重复坐标/facet 版本、复合 unknown+rejected）并接入断言；协商新增 `compoundUnknown`（unknown 胜出）与 `facetMismatch` 场景；
- **F9** 文档残留：SECURITY.md、governance/rules.md、rfc/0005 版本号对齐 v0.15；
- **F10** ledger 字符串字段加长度/格式约束（pluginId/activationInstance/resource.id/errorCode/replaces）；
- **F11** `.pi-subagents/` 加入 .gitignore。

### 已知局限（文档化）

- `unknown` 触发条件 (b)（registry 版本高于协商器支持）因静态绑定不可达，已在 C-030 与 conformance README 注明；
- 权限不支持语义歧义（等待授权 vs 不支持）已在 C-030 注明。

## 2026-08-17（实验增补，issue #266）

### Added

- RFC 0005（Decision Events）：认领 `before-*` 延期主题——envelope（`expectsDecision`）、决定词汇表、链语义 D-1~D-5、D-6 陈旧决策按身份/代际丢弃（禁 id 比较）、D-7 拦截订阅显式授权默认拒绝、D-8 parked 同步性；TUI 实验能力名 `tui.dsh.decision-events`。
- TUI-PROP-009（Lightweight UI Contributions）：两档轻量 UI 契约——Track A 宿主拥有渲染、插件供消毒数据；Track B 插件组件在宿主渲染器内渲染。
- `adapters/` 目录与 Adapter Note 模板；SPEC-WRITING-RULES §2 同步分区。

### Changed

- §10 延期条目为 `before-*` 事件补充方向性约束（拦截类订阅必须显式授权、默认拒绝）并指向 RFC 0005；
- C-010 补充 trusted-in-process 宿主的 runtime generation 粒度；
- README：声明 `$id` 占位域不可解析、example Host Descriptor 为示意值。

## 2026-08-17（评审修订，issue #266）

### Changed

- **Breaking（Draft 阶段）**：optional capability 引用的 `fallback` 改为必填（C-030）。
- C-030 补全语义：`unknown` 触发条件限定为两种；明确决策优先级。
- TUI Admission §2：`Listed` 统一为 `Declared`；"TUI Verified" 获得显式定义。
- `requirements-v0.1.json` 每条增加 `evidence: automated | review` 标记。

### Added

- fixtures：`invalid-plugin-optional-no-fallback`、`invalid-plugin-provides`、`unknown-version-plugin`、`host-no-observe.example`；
- runner：`unknown` 决策分支、contract profile 十点完整性检查、`compatible_degraded` 与 `unknown` 协商断言。

## 2026-08-17

### Added

- 建立 `dsh-ecosystem-spec` 文档簇；
- 分离 Community Consensus 与 dsh-TUI Admission；
- 增加 TUI 实验性提案区、Governance / Conformance / Registry 文档；
- 增加 RFC 0000-0004 索引性规范文档；
- 增加 Manifest、Host Descriptor、event envelope、effect ledger、claim schema；
- 增加真实 registry、permission registry、contract profile、fixtures 和零依赖 conformance runner；
- 增加 `C-*` 与 `TUI-*` requirement ID、状态模型和 claim 绑定要求。

### Positioning

- 明确本仓库是社区侧、实验性规范库；不要求 dsh 官方立即采纳；
- 明确 TUI 准入规则不自动等于社区标准或官方标准；
- 明确 reference implementation != specification；
- 明确 trusted-in-process capability/permission 不是技术安全边界。

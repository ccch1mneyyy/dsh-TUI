# Changelog

本文件是 **TUI Profile**（`tui-profile/`）的变更日志：条目描述本 profile 自身的规范、
资产与文档变化。profile 与 dsh-TUI 代码同处一库，随代码现状一起修订（归属、边界与修订
口径见 [`governance/rules.md`](governance/rules.md)），因此没有单独的审批或晋级流程，
登记的是 profile 的变化而不是 dsh-TUI 产品的全部变更。

## 2026-10-12（**发布第一版 apiVersion**：`tui.dsh/v1alpha1` 公开面冻结）

> 这一段就是 roadmap §6 第 5 条的**冻结动作**（Stage C / C-2）。逐条口径见
> [`notes/0009`](notes/0009-backend-contribution.md) 的「Public surface（frozen）」；
> 这里记的是 profile 层的声明本身——**本条目即"第一版"的版本锚**。

### Frozen

- **坐标**：`tui.dsh/v1alpha1`（**保留现名 + 显式冻结声明**）。`alpha` 后缀在这个生态里不
  携带"不承诺"语义——`registry-0.15.json` 里活动的契约坐标全是 `v1alpha1`（`std` 那侧
  也是 `v1alpha1`）——所以不改名、零迁移，由本条目把"已冻结"讲清楚。
- **冻结的四条**（缺一条等于没冻）：
  1. **只增不删**、已发布字段/方法的**语义不改**（时间锚：自 B-2 / PR #1449，
     2026-10-10 合入起算；**第一版冻结在本条目**）。
  2. **破坏性变更发新坐标**（`apiVersion + kind`），不得偷改老坐标的语义。
  3. **先弃用再移除**：在一个**已发布的次版本**里先给弃用告警，之后才移除，且
     **移除条件必须可判定**（模板 = `docs/plugins.md` 的 `minimal` → `minimalUi`，
     执行体 `scripts/verify-minimal-ui-naming.ts`）。
  4. **形状由 digest + conformance + 门禁钉住**：改了 profile 正文却不换坐标 =
     `profileHash` 漂移 = 直接红。
- **纳入承诺的前端缝**：稳定候选那六条（接缝六 设置区块 / 八 全屏场景 / 十 托管对话框 /
  十一 状态行 / 十二 快捷键 / 十三 条目渲染器）。**不在冻结范围**：实验面（toast、
  侧栏 Panel）与"新能力还能不能加"这个天花板——新能力仍可加，只是加完不许删、不许改语义。
- **确认策略随冻结定稿**：`confirmation.policy` 的取值集合 = `confirm` + `trusted-source`
  （语义与四条判据见 `notes/0009`）。它是"取值只增不删"这条承诺的第一个实例。

### Added

- **`confirmation` 的第二个取值 `trusted-source`**：贡献**请求**宿主按**自己的**来源判据
  决定是否免确认，判据不成立一律 **fail closed 退回 `confirm`**——声明本身从不足以免确认。
  判据与四条边界（嫡系清单 + provenance 在线时交叉、免确认 ≠ 免记录/免展示、只覆盖该包
  本身、伪装嫡系退回确认流程）写进 `notes/0009` 的「Permissions and security」。
  conformance 增加正例 `valid-backend-contribution-trusted.json`，
  `TUI-BACKEND-001` 的 fixture 清单、参考套件（45 → **46 例**）与仓内镜像门同改；
  `confirm` 仍在取值集合内、未知取值仍被拒，两处都有断言。
- **「后端不得依赖宿主命令表」进正文**：`notes/0009` 新增一节——保留名 MUST 从**自身能力面**
  派生，宿主在合并与分发两处执法 **local names-win**，后端侧不需要 `local.has(name)`
  一类防御。执法是宿主的、不是形状规则（`validateBackendSpec()` 不校验命令名）。
- **共用平台文案收口为单一数据源**：新建 `src/backends/shared/platform-text.ts`，持有宿主与后端
  共用的那批平台文案（10 条）；宿主字典
  （`src/i18n.ts`）与两个后端的字典都从它取，副本不再各存一份。`scripts/verify-i18n.ts`
  新增**跨字典一致性**断言：任一侧重新写回一份不同的副本即红。
- **中立缝补一条边界规则**：`src/backends/shared/` 是后端栈的**地板**——不 import scoped
  （厂商）包；在 `src/` 内只 resolve 到 `src/agent/` 与自己目录；相对 import 不得逃出 `src/`。
  堵住"后端经缝间接读到宿主字典"的传递性漏洞（边界门禁只看直接 specifier）。**非 scoped 的
  运行时依赖不归这条管**（`channel-tokens.ts` 的 `yaml` 即一例），归依赖门禁。`ADAPTER.md`
  的规则表同改，唯一一条既有例外被**钉住**而不是放宽（`channel-tokens.ts` →
  `src/utils/credentials.ts`，实测只 import node 内建的路径助手）；`verify-backend-registry`
  的拷贝树注入多两条常驻 probe（58 → 60：缝读宿主字典、缝逃出 `src/`），规则因此承重。
- **`unloadExport` 与 `nativeKey` 两条的 C 半**（第三方说明 + 执行强度）：`notes/0009`
  与 `docs/plugin-admission-and-development.md` 写明池不变量由**宿主门禁**表达
  （probe 夹具的池台账，conformance fixture 层故意不承载），`nativeKey` 的三处执行体
  （`EXPECTED_NATIVE_RULES` 快照 + 拷贝树注入 + 贡献声明必拒的反例）逐条点名。

### Changed

- **`notes/0009` 的「Public surface（α）」→「Public surface（frozen）」**：四条承诺成文、
  纳入承诺的前端缝点名、已知缺口 1（版本锚）与 3（跨字典门禁）关闭。
- **`docs/plugins{,.en}.md` 的稳定性说明与后端条目对齐冻结**：「稳定候选」那一档明确
  纳入冻结承诺，其余两档仍只是成熟度参考；后端贡献族由"`alpha`，不承诺"改为"公开面已随
  第一版 apiVersion 冻结"，装链路仍未做这一点保持原样（它是 Stage C 后续 PR 的活）。

## 2026-10-12（Backend 贡献族接线 W-2：registry 条目、descriptor 发布与扩展 catalog 装配）

> 这一段只做**接线**（Stage C 的第一段）：贡献**声明**的形状与语义一字未改，
> 正式冻结仍在 Stage C 发布第一版 apiVersion 时。逐条口径见
> [`notes/0009`](notes/0009-backend-contribution.md) 的「Wired (W-2)」节。

### Added

- **`extensions` 段进入注册表读者**：`registry-0.15.json` 新增 `tui.backend` 条目
  （`authority: 'dsh-tui'`、`kind: 'extension'`、**sha256 钉住** `registry/contracts/backend-v1alpha1.json`）；
  `registryEntries()` 读 `imports + definitions + extensions`，`verifyRegistry()` /
  `verifyContractProfiles()` 对私有扩展条目做与协议定义同样的坐标、权限、十点完备与 digest 校验。
  导入型扩展条目（`authority: 'dsh-std'`，今天是 `workspace.provider`）不受"本机必须注册它的定义"
  这条约束——它指向的包不是本仓依赖，宿主既不发布也不读它。
- **`Backend` 成为宿主发布的契约坐标**：`protocols/profile-definitions.js` 新增
  `backendDefinition`（与 `DecisionEvents` 同一个 provider 形状），bundle 因此可以在
  `requires.contracts` 里引用它，宿主 descriptor 也能发布它——**且只在真探针证据上**：
  new 内核路径按 lifecycle 的 live 证据、**默认的 `legacy` 路径**按挂载拓扑里的同一个只读探针
  （`ctx.tuiPluginHost.probeBackendAdmission()`，不注册任何东西）。两条路径都发布，接线才在
  默认启动下成立。
- **说明 0009 新增「Wired (W-2)」节**：接线逐条、探针语义（只读、无副作用、不注册任何东西、
  "探针缺席即不发布"），以及**仍未做**的那一步（把已挂载 bundle 的声明接进 `registerBackend()` / picker）。

### Changed

- **状态口径**：`notes/0009` 与 `docs/plugin-admission-and-development.md`（接缝十四 +
  发布前检查清单）由「尚未接线（W-1）」改为「准入链路已接线（W-2）、装链路未做」。
- **已知缺口 5 关闭**：Backend contract profile 自本条起在 `profileHash` 校验范围内——
  "改正文不换坐标"在 `verifyRegistry()` 处必红。新增**已知缺口 6**：参考实现
  （`conformance/tests/admission-core.js`）的坐标索引尚未含 `extensions`，与仓内读者有一处
  口径差，只影响「扩展坐标作为 `requires.contracts` 引用」这一条路径（45 例套件与仓内镜像门
  对已实现用例仍逐条一致）。

## 2026-10-11（Backend 贡献族：两种后端形态、反例与公开面承诺清单）

### Added

- **Backend 贡献族的 conformance 覆盖两种后端形态**：新增 `valid-backend-contribution-cli.json`（驱动系统 CLI 的后端——**没有**安装配方、仍有 `unloadExport` 池钩子），与既有的 SDK peer 正例成对；新增三条反例（安装配方残缺、宿主未实现的 `confirmation` 策略、`grants` 形状）。既有的 `invalid-backend-unknown-field.json` 同时就是"凭空补 `nativeKey` 必须红"那条反例，现已在用例名与文档里点名。`TUI-BACKEND-001` 的 fixture 清单与 `docs/plugin-admission-and-development.md` 同步。
- **公开面承诺清单**：新增 [`notes/0009`](notes/0009-backend-contribution.md) 的「Public surface（α）」一节——承诺（导出面**只增不删，自 B-2 / PR #1449（2026-10-10 合入）起算**、能力词表真源、grants fail-closed、执行器表"加取值不算 breaking"……）、明确不承诺（registry/loader/picker、`native.*` 与 DSH specialist、`catalog` 方法签名、`lastSession` 接口、transcript 真源、`confirmation` 取值集合、文案字面量）与"破坏性变更怎么被发现"，并列出已知缺口。**正式冻结仍在 Stage C 发布第一版 apiVersion 时**（roadmap §6 第 5 条）。

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

# 0009 — Backend Contribution

> TUI Profile 说明（随 dsh-TUI 代码修订；编号仅作稳定锚点）。

**Coordinates:** `tui.dsh/v1alpha1` `Backend`

**Base protocol:** [`protocols/tui-contributions.js`](../protocols/tui-contributions.js)（definition、validator 与 handler assertion），宿主侧的分层与实现说明见 [`docs/agent-backend-design.md`](../../docs/agent-backend-design.md)。

## Scope

`Backend` 是继 `SettingsSection` 与 `Scene` 之后的第三个贡献族，与它们同处一个 manifest extension catalog：它声明**一个后端在宿主里长什么样**——身份、标签、它运行期答话的会话能力、它索要的宿主权限、它的安装面与卸载出口。声明是数据，不是权威：后端在本进程内运行，见「Grants and the trust model」。

贡献族今天的准入状态是**已接线（W-2，Stage C）**：definition、validator、handler assertion、contract profile、conformance requirement、宿主侧门禁，以及"清单 → registry → descriptor"这条链路都已就位——`Backend` 是宿主发布的契约坐标，第三方 bundle 的 `x-dsh-tui` 声明由生产准入 catalog 里的同一份扩展定义校验。仍未做的是把**已挂载 bundle 的声明接进注册表与 picker** 的那一步（装链路，见末节）。

## Declaration fields

- `id`：`^[a-z0-9][a-z0-9-]{0,31}$`（小写字母、数字与 `-`，最长 32 字符）。`dsh`、`claude`、`codex` 是宿主自己的 id（`BACKEND_RESERVED_IDS`，与注册表的 `BUILTIN_BACKEND_IDS` 双向比对）：贡献声明其中之一会在准入处被拒（`BACKEND_ID_RESERVED`）——`dsh` 的 session ref 序列化时不带前缀，插件戴这个 id 会和首方引用撞车；`claude` / `codex` 的行是宿主自己的词表。这是**词表**不是形状规则——宿主自己的 seed 合法地戴着它们，所以 `validateBackendSpec()` 放行，拒绝发生在准入处。
- `label`：`{ text }`，**只收字面量**。`label` 只允许 `text` 一个键，`{ kind: 'key' }` 作为未知字段被拒：宿主 i18n 键会让贡献借宿主的词说话。in-tree manifest 自己的 `{ kind: 'key' }` 标签由宿主在投影时展开成字面量，见下。
- `shortLabel`：非空字符串，picker 行使用。
- `product?`：可选的非空字符串，标识这个后端驱动的产品。
- `capabilities`：字符串数组，见「Capabilities and the runtime set」。
- `grants`：字符串数组，见「Grants and the trust model」。
- `install?`：`{ executor, specifier, version }`，三者都必须非空，见「Install surface」。
- `unloadExport?`：非空字符串，见「Lifecycle and failure」。
- `confirmation?`：`{ policy }`，缺省即 `confirm`（宿主始终询问用户）；`trusted-source` 请求宿主按**它自己的**来源判据决定是否免确认，见「Permissions and security」。

以下 in-tree 私有项**不进公开声明**：`inTree`、`alwaysAvailable`、`nativeKey`、`vendorPackages`、`backendExport`，以及 `label.kind === 'key'`。宿主自己的 manifest 是这份公开声明的**超集**，`src/dsh-adapter/backend-contribution.ts` 的 `backendContributionOf()` 是唯一投影方向：剥掉上述私有项、把 key 标签展开成字面量、把缺省声明投影成 `capabilities: []` / `grants: []`。投影结果必须过 `validateBackendSpec()`——manifest 长出一个 spec 表达不了的字段时，门禁在投影处变红，而不是悄悄漂移。
`backendExport` 有意留在 in-tree：它是构建期索引从模块命名空间里取导出名的机制，不是贡献字段；贡献在注册时直接交出 handler 对象，由 `assertBackendHandler()` 断言（`id`、`detect`、`open` 必在，`descriptor`/`catalog`/`launch` 出现时必须是对象）。

## Capabilities and the runtime set

`capabilities` 声明该后端的 handler 运行期真会应答的会话能力，**必须覆盖** `AgentSession.capabilities` 实际返回的键集：声明的集合不小于服务面，`open()` 不得答话集合外的能力键（`scripts/verify-backend-contribution.ts` 用 probe 后端的两条路径把这条钉住）。

词表的真源是 `src/agent/capabilities.ts` 的 `SessionCapabilities`，spec 侧只有一份副本 `src/adapter/spec/backend-capabilities.ts` 的 `BACKEND_CAPABILITY_NAMES`（分层是单向的：`src/adapter/**` 今天没有任何一处 import `src/agent/**`，所以只能另写一份），由 `scripts/verify-backend-contribution.ts` 用 TypeScript AST **双向**比对：接口加了成员而常量没跟是红，常量编出一个接口没有的名字也是红。

未知名字**降级不拒绝**：贡献可以声明这个宿主的会话模型不认识的能力，准入把它记为待决项（`missingOptional` 里的 `capability:<name>`），判定为 `compatible_degraded`，而不是拒绝这个后端。

## Grants and the trust model

`grants` 只取宿主自己的权限词表 `registry/permissions-0.1.json`（闭集，8 条）。已知名字而没人授权 → 判定 `waiting_authorization`、`reasonCode` 为 `PERMISSION_NOT_GRANTED`：条目**注册但不进 picker**（`listOfferedBackends()`）——id 存在，启动的两段解析与 session refs 都必须找得到它，但选中它等于打开一个宿主描述不了的后端。未知名字沿用同一条「降级不拒绝 + 记为待决项」（`permission:<name>`）：静默当作可用等于宣称一条没人能撤销的授权，拒绝则等于自己发明一套权限词表。

准入判定本身是纯函数 `backendAdmission(spec, host)`，返回 `BackendAdmission`，沿用插件准入的五态词汇：`compatible`、`compatible_degraded`（带 `missingOptional`）、`waiting_authorization`（带 `deniedPermissions`），以及不会成为注册表条目的 `rejected`（`BACKEND_ID_RESERVED`）与 `unknown`——后两者由调用方抛错，内建 manifest 走到那里必须是响亮的构建期错误。

contract 的 `errors` 只发布**有产出者**的码，今天正好是上面两个：`BACKEND_ID_RESERVED`（准入拒绝）与 `PERMISSION_NOT_GRANTED`（等待授权，复用插件准入的词表）。形状违规（`label` 用宿主 i18n 键、声明 `nativeKey`）由 `validateBackendSpec()` 以未知字段的 `TypeError` 拒绝，不占错误码；能力/恢复不匹配一类的码在 C 段给出真正产出点之前不发布——发布没有产出者的码，等于让第三方为一条永远走不到的失败路径写错误处理。这一对由 `scripts/verify-backend-contribution.ts` 钉住。

**这不是隔离。** 后端在宿主进程内运行，就是全信任代码；准入、grants 与 effect ledger 给的是**能力声明与可审计性**，不是沙箱。后端真正需要的宿主服务——`BackendHost` 上的 `tokenStore`、`oauthCredential`、`stderr`，以及将来的 `dataDir`——是**可选宿主能力**，走 feature-detect，不是 grants。in-tree 三个后端今天都声明 `grants: []`：现有八条权限没有一条描述后端真正需要的东西（起子进程、读自己的 prefs、联网）。

## Install surface

`install` 是 `{ executor, specifier, version }`，三个字段都必须是非空字符串，缺一个即 validation 失败。执行器是**宿主实现的表**（首版只有 `pnpm-profile-add`）：宿主不认识的执行器读作「无安装面」（`installable: false`，那一行退回检测自己的 hint），不是拒绝注册。`install` 缺省也是一等公民——用户自己装的二进制就是依赖（codex 形态），声明「装什么、哪个版本、交给宿主哪个执行器」这件事只有真的能装的后端才做。

## Resume semantics

以下四条是定案口径（roadmap §6 第 11 条），按 `MUST` / `MUST NOT` 写：

- 启动恢复**只针对所选后端**（MUST）；宿主 MUST NOT 把恢复请求交给这次启动没有选中的后端。
- 恢复目标 MUST 绑定后端身份：一个派生出来的目标只在其来源后端上可用。**后端不可用、没有上次会话、指定会话不存在**三种情况一律 MUST 明确报错并以非零退出——MUST NOT 降级成冷启动，MUST NOT 静默新建一个没人要的会话。
- 裸 `--resume` MUST 只查**该后端自己的** `lastSession`。
- MUST NOT 回落到其他后端，MUST NOT 尝试恢复替代后端的上次会话，也 MUST NOT 自动新建会话；用户去掉 `--resume` 之后才按普通启动流程处理。

`lastSession` 的接口与恢复目标的传递方式**不在本协议内**（技术定稿）：`AgentBackend.launch.sessionPrefs()` 返回的 `lastSession()`，以及宿主侧承载这个目标的 env 名，都是实现的私事；`DSH_TUI_RESUME_BACKEND` 不是允许跨后端恢复的依据。

实现说明（不进协议）：安全模式的「重试正常启动」是唯一例外——它的目标派生自 `last-run.json`（崩溃时在跑的内核可能已经不在注册表里），在那里失败会关掉用户最后的退路，因此撤销在重试路径下降级为**告警 + 冷启动**，由一次性 env `DSH_TUI_RESUME_RETRY` 标记，启动读到即从环境里删除。

## Lifecycle and failure

`unloadExport` 只用于**模块级/进程级**资源池（codex 的 app-server hub 那种跨会话复用的池）；会话级资源归 `session.dispose()`，MUST NOT 塞进 `unloadExport`。

宿主只对**真的加载过**的条目记账并调用它的 `unloadExport`：「未加载即不关池」是宿主的不变量——没加载过的后端不会被 import，也不会被关池；第二次 unload 是 no-op。注册、加载、调用或 cleanup 失败必须响亮且**归属于具体的条目**（component、facet 与 contribution identity），MUST NOT 静默吞掉，也 MUST NOT 让别的贡献或基础 TUI 跟着倒。

**这条的执行强度在宿主，不在声明里**：贡献无法用声明表达"我没被加载就别关我的池"——那是注册表的记账行为（`src/dsh-adapter/backend-registry.ts` 只对真的加载过的条目记账并解析 `unloadExport`，模块里取不到那个导出即响亮报错）。反例因此由**宿主门禁**表达而不是 conformance fixture：`scripts/fixtures/probe-backend/` 的假后端配一份**独立模块**的池台账（读计数不等于加载过后端），`scripts/verify-backend-contribution.ts` 用它钉住"未加载即不 import / 未加载即不关池 / 只关真的加载过的"三条不变量与幂等性。manifest 层没有"我还没被加载"这种可写的形状，所以 fixture 层故意不承载它。

## Permissions and security

声明里的文本按不可信输入净化：宿主剥离控制字符、按 terminal cell（不是 `string.length`）截断宽度，再让它们进 picker、launchpad 与 handoff 文案。

`confirmation.policy` 是贡献**请求**的确认策略，不是它自授的豁免；宿主只实现自己有的策略（`BACKEND_CONFIRMATION_POLICIES`）：

- `confirm`（缺省）：宿主始终询问用户。
- `trusted-source`：请求走宿主的**可信来源通道**。宿主按**自己的**判据决定，判据不成立一律 **fail closed 退回 `confirm`**——声明这个取值本身从不足以免确认。

免确认的判据与边界（宿主承诺；判定落在安装链路与启用链路上）：

1. 判据 = 宿主**随包发布的嫡系清单**（离线可判）**加** provenance 在线可得时的交叉核对，**不一致即否决**；provenance **不得单独放行**（镜像源可能根本没有 provenance，取交集会把嫡系也判回确认）。
2. **免确认 ≠ 免记录 / 免展示**：仍然记 effect ledger，仍然在 `/plugin` 里可见。
3. 免确认**只覆盖该包本身**：它拉进来的第三方依赖与构建脚本仍按上游规则要 `allowBuilds` 批准。
4. **伪装嫡系**（清单不命中 / 发布者不符 / provenance 不一致）一律 fail closed，退回确认流程。

未知取值一律拒：贡献不许给自己免确认。取值集合**只增不删**——将来加一条来源策略是加取值，不改字段、不算 breaking。

本协议不是安全边界，理由见「Grants and the trust model」。

## Command names and the host's command table

后端 MUST NOT 依赖宿主的命令表：MUST NOT 读它来决定自己注册什么名字，MUST NOT 指望宿主替它避开重名，也 MUST NOT 假定「宿主的某个命令一定存在」。这条与「池清理」「`nativeKey`」同族——都是"某个后端不得依赖宿主私有面"。

- 后端要保留的名字 MUST 从**自身能力面**派生（它自己实现的命令，加上它 manifest 里声明的 goals / channels / permissions 一类名字），不查宿主词表。
- 宿主在两处执法 **local names win**：合并后端命令列表时丢弃与本地命令同名的条目（`src/dsh-adapter/channel/core/session-controls.ts`，注释原文 *Local names win, served here or not*），分发时已知的本地命令在 Chat 层就被本地处理、根本到不了后端（`src/screens/Chat.tsx` 的 `isLocalCommandName()` / `isHiddenCommandName()` 判定）。
- 因此后端侧**不需要** `local.has(name)` 一类防御，实测那些路径不可达；唯一理论通道是**非 Chat 分发器**（parent-mediated，见 `src/adapter/ports/channel-view.ts` 的 `AgentMessageVia`）携带 `/前缀` 文本。真见到宿主命令漏进后端 `submit`，从上面两处执法点查起。

执法是**宿主的**、不是本协议的形状规则（`validateBackendSpec()` 不校验命令名）；协议侧只写"谁负责"：重名由宿主在合并与分发两处丢弃，后端不得把这件事当成自己的契约。

## Machine definitions and conformance

Definition、validator 与 handler assertion 位于 [`protocols/tui-contributions.js`](../protocols/tui-contributions.js)：`BACKEND`、`BACKEND_RESERVED_IDS`、`BACKEND_CONFIRMATION_POLICIES`、`backendExtensionDefinition`、`validateBackendSpec()`、`assertBackendHandler()`，并随 `contributionExtensionDefinitions` 一起注册。

Contract profile：[`registry/contracts/backend-v1alpha1.json`](../registry/contracts/backend-v1alpha1.json)，与 Scene / SettingsSection 同一份 12 个必需键的形状，`securityBoundary: false`，`operations` 列出 `declare`、`detect`、`open`、`catalog`、`resume`。

Conformance requirement 是 `TUI-BACKEND-001`（记在 `conformance/requirements-v0.15.json`），由**十个 fixtures**承载。三个正例各自钉一件事：`valid-backend-contribution.json`（SDK peer 形态：安装配方 + 池钩子）、`valid-backend-contribution-cli.json`（系统 CLI 形态：**没有**安装配方、仍有池钩子——"用户自己的二进制就是依赖"是一条一等公民声明，不是缺字段）与 `valid-backend-contribution-trusted.json`（第二个已实现的确认策略 `trusted-source`）。七个反例是 `invalid-backend-{unknown-field,bad-id,key-label,capability-shape,install-incomplete,confirmation-policy,grants-shape}.json`；其中 **`invalid-backend-unknown-field.json` 就是"凭空补 `nativeKey` 必须红"那条**（它的拒绝理由逐字含 `nativeKey`），名字写作 unknown field 是因为形状校验看到的就是未知字段。

`conformance/requirements-v0.15.json` 中 `TUI-BACKEND-001` 的 fixture 清单由 `scripts/verify-plugin-spec.ts` 读取：门禁要求它与仓内 Backend 用例表完全一致，且每个列出的文件都存在。只改 requirement 登记、不改仓内用例表，或删除任一列出的 fixture，都会使门禁失败。

执行体有两层：profile 套件（`conformance/tests/run.js` 的 Backend 段）是参考实现，但它**不在任何自动化里**；仓内 `scripts/verify-plugin-spec.ts` 的 Backend 段是它在 CI（`verify:build`）里的执行体，**两边期望必须同改**。清单交叉校验不读取 `run.js` 的用例表，不能自动发现两边期望的差异。宿主侧的两条不变量（"未加载即不关池"、"只关真的加载过的条目"）**不在这一层**：它们是宿主行为、无法用 manifest fixture 表达，只能由 `scripts/verify-backend-contribution.ts` 与 `scripts/verify-backend-registry.ts` 的 probe 夹具钉住。

宿主侧门禁是 `scripts/verify-backend-contribution.ts`：内建 manifest 的投影 dogfood、两份词表的单一真源、准入判定、`scripts/fixtures/probe-backend/` 这个假后端的资源不变量与安装面两态、坏声明必须红，以及末节的范围守卫。

## Public surface（frozen）：承诺什么、不承诺什么

**状态**：`tui.dsh/v1alpha1` 的**第一版公开面已冻结**（Stage C / C-2；roadmap §6 第 5 条，profile 层的完整声明见 [`CHANGELOG.md`](../CHANGELOG.md) 的冻结条目）。坐标**保留 `v1alpha1`**，冻结是一句**显式声明**而不是"名字里没有 alpha"：`alpha` 后缀在这个生态不携带"不承诺"语义（`registry-0.15.json` 里活动的契约坐标全是 `v1alpha1`），改名要付迁移成本，所以用本节与 CHANGELOG 的条目把"已冻结"说清楚。

冻结的确切内容（四条，缺一条等于没冻）：

1. **只增不删**：已发布的字段与方法的语义不改。导出面自 B-2 / PR #1449（2026-10-10 合入）起算，**第一版冻结在本节所述的这次发布**。
2. **破坏性变更发新坐标**（`apiVersion + kind`）：不得偷改老坐标的语义。
3. **先弃用再移除**：在一个**已发布的次版本**里先给弃用告警，之后才移除，且**移除条件必须可判定**——模板是 `docs/plugins.md` 的 `minimal` → `minimalUi`（那条写着"移除条件（可判定）：v0.13"，执行体是 `scripts/verify-minimal-ui-naming.ts`）。
4. **形状由 digest + conformance + 门禁钉住**：改了正文却不换坐标 = `profileHash` 漂移 = 直接红（见「破坏性变更怎么被发现」）。

**同批纳入承诺的前端缝**：稳定候选那六条（接缝六 设置区块 / 八 全屏场景 / 十 托管对话框 / 十一 状态行 / 十二 快捷键 / 十三 条目渲染器，清单见 `docs/plugins.md` 的稳定性表）。**不在冻结范围**：实验面（toast、侧栏 Panel）与「新能力还能不能加」这个天花板——新能力仍可加，只是加完不许删、不许改语义。

### 承诺（冻结范围内，可以依赖）

| # | 承诺 | 由什么钉住 |
|---|---|---|
| 1 | **公开导出面只增不删，自 B-2 起算**：`BACKEND`、`BACKEND_CAPABILITY_NAMES`、`BACKEND_RESERVED_IDS`、`validateBackendSpec`、类型 `BackendInstallRecipe` / `BackendSpec`、`backendAdmission`（+ `BackendAdmission` / `BackendAdmissionHost`）、`backendContributionOf` | 包入口 `src/dsh-adapter/index.ts` 的 Backend 段；删其中任何一个都是 breaking |
| 2 | 声明字段与语义以本文档与 definition 正文为准（`id` / `label`（**只收字面量**）/ `shortLabel` / `product?` / `capabilities` / `grants` / `install?` / `unloadExport?` / `confirmation?`） | `validateBackendSpec()`；`verify-backend-contribution.ts` 的 dogfood 段（三个内建 manifest 投影后过同一 validator） |
| 3 | 能力词表的真源是宿主的 `SessionCapabilities`，**双向**比对：发明一个名字会红，删掉一个成员也会红 | `verify-backend-contribution.ts` 的 TS AST 双向比对 |
| 4 | `grants` fail-closed：未知权限名**降级不拒绝**（记为待决项），已知权限名而没有授权 → 注册但不进 picker | `backendAdmission()` 的五态判定 + 门禁用例 |
| 5 | 安装面是**声明 + 执行器查表**：宿主不认识的执行器读作"没有安装面"（**不是**拒绝）；`install` 缺省是一等公民（系统 CLI 形态） | 注册表派生的 `installable`；probe 夹具两种形态各自的断言 |
| 6 | **加取值不算 breaking**：`confirmation` 的取值集合只增不删（今天 `confirm` 与 `trusted-source`，各自语义见「Permissions and security」）；执行器表同理（首版只有 `pnpm-profile-add`） | definition 的取值集合 + 门禁（`confirm` 必须在集合内、未知取值必须被拒，两处都断言） |

### 明确不承诺

| # | 不承诺 | 现状锚点 |
|---|---|---|
| 1 | **把 bundle 的声明接进 registry / picker 的那一步**（装链路，Stage C 的后续工作）：准入链路本身已接线 | 末节 |
| 2 | `native.*` 与 DSH 的 specialist 能力**始终留首方侧**；`nativeKey` 缺省即"不使用 native 通道"，宿主**不得凭空补规则** | `ADAPTER.md` 的派生规则 + `verify-adapter-boundary` 的 `EXPECTED_NATIVE_RULES` 快照 + 拷贝树注入（`verify-backend-registry`）；贡献声明 `nativeKey` 会被 `validateBackendSpec()` 以未知字段拒（`invalid-backend-unknown-field.json` 就是这条反例） |
| 3 | `BackendHandler.catalog` 的**方法签名**（协议侧是 `object`；`SessionCatalog` 的形状会随主线演进） | `protocols/tui-contributions.d.ts` |
| 4 | `lastSession` 的接口与恢复目标的传递方式（含 `DSH_TUI_RESUME_BACKEND` 这个 env 名）：**语义进协议，接口不进** | 「Resume semantics」节 |
| 5 | 会话记录 / transcript 的真源归属；`SessionCatalog.snapshotKey()` 只用于首屏快照，**永不作为 transcript 权威** | `src/agent/backend.ts` |
| 6 | **不会再加取值**：取值集合只增不删，来源策略演进 = 加取值；`BACKEND_CONFIRMATION_POLICIES` 这个常量今天也不在公开导出面上 | definition |
| 7 | 后端自带文案的**字面量**：与宿主共用的那批平台文案已收口为**单一数据源**、由跨字典门禁钉住（改一处不会再漏另一处）；各后端**自己**的文案字面量仍不承诺——改它不算 breaking | `src/backends/shared/platform-text.ts` + `verify-i18n` 的跨字典段；「文案与公开面」见 `docs/agent-backend-design.md` |

### 破坏性变更怎么被发现

坐标（`apiVersion + kind`）不变就不得改已承诺的语义；**门禁只覆盖各自断言的范围，并不能自动发现所有语义变更**，所以这张清单的作用是让"改哪一块会被谁拦住"可查。`verify-plugin-spec` 检查声明形状、fixture 期望与"篡改 profile 必败"；`verify-backend-contribution` 检查内建投影、词表（含 `confirmation` 取值集合"只增不删"的正反两面）、准入、probe 资源不变量与 **W-2 的接线正断言**；`verify-public-config-types` 检查消费者使用已发布类型与导出的写法；`verify-i18n` 现在还包含**跨字典一致性**（共用平台文案已收口为单一数据源）；`verify-protocol-single-source` 检查协议来源与派生常量一致性；`verify:contract` 检查 DSH 上游版本与独立入口宿主契约。

Backend contract profile 自 W-2 起**已在 `profileHash` 校验范围内**（`registry/registry-0.15.json` 的 `tui.backend` 条目 + `registry/contracts/backend-v1alpha1.json`）：仅修改 profile 正文、保持坐标不变，`verifyRegistry()` 会报 `profileHash drifted`，descriptor 也随之丢弃该契约——"改正文不换坐标"因此是红的。

### 已知缺口（诚实清单，别当成已解决）

1. ~~**"只增不删从 B-2 起算"需要一个版本锚**~~ —— **C-2 已关闭**：`CHANGELOG.md` 的**冻结条目**就是锚（日期 + 坐标 + 冻结的四条内容），"只增不删自 B-2 / PR #1449 起算、第一版冻结在该条目"因此在时间上可查。**仍未关闭的一半**：`tui-profile/package.json`（0.1.0-experimental）仍不与根包（0.14.0）版本号挂钩——profile 内容随包发布、由 digest 钉住，但不自称版本号；版本号对齐属 D 段生态治理。
2. **profile 套件不在 CI**：Backend 的 conformance 例由仓内镜像门（`scripts/verify-plugin-spec.ts`）在 `verify:build` 里代跑，**两边期望必须同改**；
3. ~~**共用平台文案的副本没有跨字典门禁**：`verify-i18n` 只查各自字典的完整性，不跨字典比字面量；~~ —— **C-2 已关闭**：与宿主共用的那批平台文案（10 条）收口为**单一数据源** `src/backends/shared/platform-text.ts`——宿主字典（`src/i18n.ts`）展开它，两个内置后端用 `pickPlatformText()` 各取自己渲染的那几条，**副本不再各存一份**；`scripts/verify-i18n.ts` 新增「跨字典一致性」段逐字比对（并断言每个后端实际携带的平台键集合与其登记清单相等），任一侧把一份不同的内联副本写回去即红。**残留**：文案的**机制**仍是两份实现（`backends/shared/localized-text.ts` 与宿主 `i18n.ts` 的 `pickText` / `substitute`），今天只保证行为一致、不共享代码。
4. **"宿主只对真的加载过的条目记账并调用 `unloadExport`"是宿主的**不变量，第三方无法用声明表达它——它由 probe 夹具与 registry 的池台账钉住，不在 conformance fixture 层。
5. ~~**Backend contract 的 digest 与坐标语义保护尚未接线**~~ —— **W-2 已关闭**：contract profile 已进 registry 的 digest 校验范围（见「破坏性变更怎么被发现」）。仍不覆盖的是**历史坐标的语义比较**（旧坐标正文是否被改过只能靠 digest，没有语义 diff）；那属于 D 段生态治理，不是本族的接入条件。
6. **profile 套件与仓内镜像在 `extensions` 段上有一处口径差（已知，未关闭）**：`conformance/tests/admission-core.js` 的坐标索引仍只由 `imports + definitions` 构成（所以它遇到 `requires.contracts` 里的扩展坐标会按"未知 kind"抛错），而生产侧 `registryEntries()` 自 W-2 起把 `extensions` 一并纳入（于是同一个请求在仓内落成 `rejected`/`REQUIRED_PROTOCOL_UNAVAILABLE`）。两者对**已实现的用例**期望一致（套件 46 例全绿、镜像门同绿），差异只在"扩展坐标作为 requires 引用"这一条路径上；要不要把参考实现也扩到 `extensions`，留到 C 段后续（`docs/plugins.md` 的兼容承诺不受影响）。

## Wired (W-2) — what stage C connected, and what is still open

**准入链路已接线。** 家族不再是"声明得出来、宿主兑现不了"：`Backend` 是宿主 published 的契约坐标，第三方 bundle 的 `x-dsh-tui` 声明由生产准入 catalog 里的同一份定义校验。逐条（前四条取代了 B 段故意留下的范围守卫，第五条是它们的前提）：

- `registry/registry-0.15.json` 的 **`extensions` 段有 `tui.backend` 条目**（`authority: 'dsh-tui'`、`kind: 'extension'`、**sha256 pin 住 `registry/contracts/backend-v1alpha1.json`**），`registryEntries()` 读 `imports + definitions + extensions`，`verifyRegistry()` / `verifyContractProfiles()` 对私有扩展条目做与协议定义同样的坐标、权限、十点完备与 digest 校验。**导入型扩展条目（`authority: 'dsh-std'`，今天是 `workspace.provider`）不受"本机必须注册它的定义"这条约束**：它指向的 `@dsh-std/workspace` 不是本仓依赖，宿主既不发布也不读它，为它 fail-closed 会把整个 descriptor 清空。
- **`Backend` 进了 `HOST_SUPPORTED_CONTRACTS`**（`src/adapter/spec/protocol-constants.ts` 的派生读面同时扩到 `extensions`），`scripts/verify-protocol-single-source.ts` 的坐标字面量表同改。
- **descriptor 真的发布它，且只在真探针证据上**：`ctx.tuiPluginHost.probeBackendAdmission()` 走一遍"构一个没人拥有的声明 → 家族 validator → 宿主准入事实"的路径（只读、无副作用、不注册任何东西），驱动的同步投影与异步 `refresh` 两条路径都要它。**默认 boot 走的是 `legacy` adapter 模式**，那条路径不跑 Kernel lifecycle、按"挂载拓扑 + 只读探针"声明契约（与 DecisionEvents 的 guard 探针同一个先例），所以同一探针也在那里被读一次——否则这条接线只在 `DSH_TUI_ADAPTER_MODE=new` 下成立，默认启动下第三方 bundle 仍会被拒。"探针缺席"或"机器答不出 `compatible`"⇒ 坐标不发布并报出丢弃原因——这正是 W-1 警告过的"**声明支持但发不出来**"的反面。实测：只做前两条而不接探针时，descriptor 为空、要求该坐标的 bundle 落 `rejected`/`REQUIRED_PROTOCOL_UNAVAILABLE`；接完探针后同一条 manifest 判 `compatible`。
- **唯一注册贡献定义的生产模块是规范准入 catalog 的装配点**（`src/adapter/standard/tui-extension.ts` 的 `buildAdmissionCatalog()` 调 `registerTuiContributionExtensions(manifests)`）——bundle 的 `x-dsh-tui` 声明因此在 `admitInternal` 的 `manifests.validate()` 里有定义可解析。
- **协议的协议面**：`Backend` 同时是宿主发布的契约坐标（`tui-profile/protocols/profile-definitions.js` 的 `backendDefinition`，与 `DecisionEvents` 同一个 provider 形状）：bundle 可以在 `requires.contracts` 里引用它。贡献**声明**的形状与语义一字未改（`tui-contributions.js` 的 `backendExtensionDefinition` 仍是唯一的书写面）。

**仍未做（装链路的活，不是本族的接入条件）**：把**已挂载 bundle** 的 `x-dsh-tui` 声明读出来接进 `registerBackend()` / picker——今天注册表只有内置种子（`backend-registry.ts` 自述 "the plugin discovery of Stage C is the intended second caller"，那个 caller 还没有）。`/plugin` 的安装链（Stage C 的后续 PR）落地时，`Backend` 的声明才是从"能被准入"变成"真的出现在 picker 里"。

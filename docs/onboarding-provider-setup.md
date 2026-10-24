# 首次引导的账号与模型接入（Onboarding v2 设计）

状态：已实现，代码在 `feat/onboarding-provider-setup` 分支（基线 `a40c305a`，未提交）。
关联：引导首版 #1255、`/provider` 向导、`dsh-auth` 订阅登录、`/settings` 凭据写入。

本文回答一个问题：**首次启动的引导应该怎样把"这台机器能用哪个模型"这件事配置好**，
而不是把用户推去导出一个环境变量。文中的每个结论都能在代码里找到落点；行号以
`a40c305a` 为准，改动后按符号名检索。

## 1. 问题

### 1.1 现状（v1）

`ONBOARDING_STEPS = ['apikey', 'look', 'model', 'keys']`（`src/components/onboardingModel.ts:14`），
第一步 `ApiKeyStep`（`src/screens/Onboarding.tsx:619`）是**只读检查页**：

- `channel.describeCredential('DEEPSEEK_API_KEY')` → 只报有没有（`:127`）；
- `channel.balanceInfo()` → 一次真实连通性检查（`:131`）；
- 缺 key 时打印两条指引（`:650-653`）：`DEEPSEEK_API_KEY=sk-…`（POSIX 形状，附一句
  PowerShell）与 `~/.deepseek/config.json { "apiKey": … }`；
- 键盘上 Enter 只等于"重新检查"（`:418-421`）。

也就是说，用户在这一页**做不了任何配置**。真正能配置的地方全在别处：

| 入口 | 能做什么 | 证据 |
| --- | --- | --- |
| `/provider` | 加/改/删 provider 路由、输入 API key、订阅 OAuth 登录（`ctx.dshAuth` 挂载时） | `src/dsh-adapter/providerWizard.ts:153`、`:205-214`、`:1010` |
| `/auth login <provider>` | 订阅账号 OAuth（含 Host 的 `deepseek-account`） | `src/dsh-adapter/oauth/index.ts:267`、`oauth/service.ts:96-140` |
| `/login` | 状态 + 指路（"使用 /provider 管理 DSH 凭据…"） | `src/screens/Chat.tsx:3842`、`src/i18n.ts:692` |
| `/settings` | 只有 **Web 搜索** 的 secret 字段可写（默认 ref 恰好也是 `DEEPSEEK_API_KEY`） | `src/dsh-adapter/channel/settings-host.ts:83-92` |

### 1.2 具体缺陷

1. **只读 vs 用户预期**：首启第一屏只报"未配置"，没有动作入口，用户会把它读成
   "这里配不了"。
2. **指引有一处是错的**：`~/.deepseek/config.json` 在 DSH 里没有读取方。DSH 2.1-rc.2
   的真实存储是 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）与环境变量；
   官方文档把"写密钥"这件事交给 Web 模型页（见上游 *配置模型* 指南）。0.1.7-rc.1 /
   0.2.0-rc.2 的 `dsh-llm-deepseek` 里同样搜不到该路径。
3. **环境变量指引只有 POSIX 形状**：Windows 上真正管用的是用户级环境变量（一键安装包
   就是这么做的，`scripts/make-installer-bundle.mjs:151-165`），而 `~` 在 cmd/PowerShell
   里并不展开。
4. **登录后的内容没有被接住**：`dsh-auth` 的目录是**凭据门控**的——
   `CredentialGatedAdapter.listModels()` 对没有凭据的 provider 直接返回 `[]`
   （`src/dsh-adapter/oauth/index.ts:139-163`）。所以"登录成功"与"模型列表里多出这些模型"
   是同一次状态变化，**可以被观测、也应该被引导接住**；v1 完全没用这条信息。
5. **默认模型没有被带出来**：登录/加 key 之后用户仍停在只读页，还要自己去第 3 步或
   `/model` 里挑默认模型。

### 1.3 不构成缺陷的部分（先排除）

- 缺 key **不会**让引导消失：DSH 的 key 是每次请求才解析（`resolveAuth`），
  模型发现把 `MISSING_CREDENTIAL` 吞成空目录，`agents.create` 不碰凭据，因此
  `channel.startupFailure`（`src/dsh-adapter/channel/core/compose.ts:944`）不会因为缺 key 触发，
  引导照常弹出（仓库自带的真机探针在隔离 HOME 下正是靠 `Esc 跳过引导` 收掉它：
  `scripts/verify-installed-startup.mjs:174-182`）。
- 门禁链上没有平台分支：`onboardingOnBoot = dshBoot && noResume && shouldOfferOnboarding()`
  （`src/dsh-adapter/plugin.ts:2370`），`shouldOfferOnboarding` 只看
  `~/.dsh-tui/onboarding.json`（`src/onboardingPrefs.ts:120`）。
- 引导仍然有存在价值：它是唯一能一次把**语言/主题 + 默认模型/强度/工作区 + 快捷键**
  对齐的地方。

## 2. 目标与非目标

**目标**

- G1 第一步从"只读检查"变成"**接入页**"：能在引导内完成订阅登录、API key 配置、
  重新检查；不再强推 `DEEPSEEK_API_KEY` 环境变量。
- G2 登录/配置成功后，**把新出现的模型接住**：没有就不问；只有一个就自动设为默认；
  有多个就问"接入哪些 / 哪个设为默认"。
- G3 让第 3 步的默认模型与接入结果一致（用户不必再挑一遍）。
- G4 指引必须真、必须跨平台（删掉 `~/.deepseek/config.json`，给出 Windows 可执行的写法）。
- G5 不新增 UI→adapter 的**值** import，不新增端口方法（复用 `providerSetup()` /
  `oauthProviderStatuses()` / `listModels()` / `switchModel()` 这些既有接缝）。

**非目标**

- N1 不重写 `/provider` 向导，也不动它的持久化语义（路由 profile + 凭据 + 回滚）。
- N2 不接管 DSH 的账号域（PKCE、回调、令牌存储仍归 Host）。
- N3 不做"引导里直接编辑 `cordis.patch.yml`"这类底层编辑。
- N4 不改 v1 的四步骨架与"Esc 跳过不记账 / 走完才记账"的记账契约
  （`src/screens/Onboarding.tsx:465-473`、`src/onboardingPrefs.ts:97-109`）。

## 3. 架构

### 3.1 分层与模块边界

沿用仓库既有规则（UI 不 import 后端；`src/dsh-adapter/` 是唯一允许 import
`@deepseek-ai/*` 的地方；UI 从 `src/dsh-adapter/` 只取类型）：

```
src/screens/Onboarding.tsx        ← 屏幕：状态机 + 渲染 + 键盘/鼠标（不碰凭据）
src/components/onboardingProviderPlan.ts   ← 纯推导：目录差分、0/1/N 决策、候选排序
src/onboardingDraft.ts            ← 模块级进度存储：问卷面板接管期间的"记忆"
src/screens/Chat.tsx              ← 接缝持有者：questionStore.ask / provider 动作回调 / 结果刷新
src/dsh-adapter/providerWizard.ts ← 既有值：runProviderWizard、runOAuthLogin（不改语义）
src/dsh-adapter/oauth/index.ts    ← 既有值：dsh-auth 服务与凭据门控目录（不改）
```

**为什么动作回调放在 Chat，而不是让 Onboarding 直接调 `runProviderWizard`**：
Chat 已经持有 `questionStore`（`Chat.tsx:3309`）与既有的两个值 import
（`Chat.tsx:47`），并已有一套"`/provider` 结束后刷新模型/提供方/补全缓存"的收尾逻辑
（`Chat.tsx:3317-3331`）。把这些放进 Chat 可以在**不新增任何边界例外**的前提下复用它们；
Onboarding 只拿两个回调 prop。

**为什么进度要落模块存储**：问卷/审批面板与整屏界面共用"打断通道"——面板挂起时
整屏被卸载、回答后**重挂**（`Chat.tsx:6283-6294`，`screenOpen` 包含 `onboardingOpen`）。
如果接入流程要用问答面板（API key 输入、OAuth 设备码/授权 URL），向导的 React 状态
会在接管期间丢失。`src/onboardingDraft.ts` 因此保存：当前步骤、焦点、动作前的目录基线、
待接入的 provider/模型、以及一句上屏提示；挂载时读取、变更时写入、完成/跳过时清空。

### 3.2 状态机（第一步）

```
            ┌─────────────┐
  挂载 ───▶ │  checking   │  describeCredential + oauthProviderStatuses + listModels/listProviders
            └──────┬──────┘
                   ▼
            ┌─────────────┐   动作行 ❯ 登录订阅账号（列 provider，已登录/未登录同列）
            │   ready     │   动作行   添加模型提供方（API key）→ /provider add 流程
            │ (动作列表)  │   动作行   重新检查 / 跳过这一步（= 下一步）
            └──┬───┬───┬──┘
               │   │   └────── 重新检查 ──────▶ checking
   登录/加 key │   │
               ▼   │
        ┌──────────┴──┐   动作在跑：`pending` 一直留着；中途重挂只恢复进度，**不结算**
        │  in-flight  │
        └──────┬──────┘
               ▼   动作结束：写 `draft.completed`（取消 / 失败也写，状态是 outcome）
        ┌─────────────┐
        │  completed  │
        └──────┬──────┘
               ▼   结算：在挂的实例做；订阅把"迟到的完成"送到它
        ┌─────────────┐
        │  adopting   │  目录差分：0 → none（只报结果）；1 → auto；N → 内联多选 + 默认单选
        └──────┬──────┘
               ▼
            ready（提示"已接入 N 个模型，默认 X"）
```

Esc 语义不变：任何时候 Esc 跳过整个引导（不记账）；接入子流程内部 Esc 由各自面板/
内联层吃掉，回到 `ready`。

### 3.3 数据流

**A. 订阅登录（OAuth）**

1. 首帧读 `channel.oauthProviderStatuses()`（未挂 `dsh-auth` 时返回 `undefined` → 动作行
   置灰并给出原因，而不是假装能点）。
2. 用户在某一行 Enter → Chat 提供的 `onProviderSignIn(provider)` →
   `runOAuthLogin(deps, oauth, provider)`（`src/dsh-adapter/providerWizard.ts:995`）→
   面板走设备码/授权 URL/浏览器（`openInBrowser`，win32 分支已处理 `&` 引号问题，
   `src/dsh-adapter/oauth/opener.ts:21-38`）。
3. 登录写入 dsh-auth 自己的凭据文件；**下一次 `listModels()` 就能看到该 provider 的模型**
   （`CredentialGatedAdapter` 每次调用都读一次凭据）。
4. 重挂后 `adopting` 阶段做差分（下面 3.4）。

**B. API key（`/provider` add 流程）**

1. 动作行 → Chat 的 `onProviderAddProvider()` → `runProviderWizard(...)`（同 `/provider`）。
2. 向导自己问 route/端点/协议/key/模型多选，并**先写凭据再写 profile，失败回滚**
   （`providerWizard.ts:380-410`）。这里的"模型多选"就是 key 路由语义下真正的"是否增加"。
3. 结束后同样进入 `adopting`：只把**新出现的**模型作为默认候选。

**C. 已有配置（env / 凭据库 / 既有路由）**

`describeCredential('DEEPSEEK_API_KEY')` 与目录快照都可能一开始就是"有"。此时第一步
只报状态 + 给动作，不进 `adopting`（没有新内容可用）。

### 3.4 0/1/N 默认决策（纯推导）

`src/components/onboardingProviderPlan.ts`：

```ts
export interface ProviderModelRef { readonly provider: string; readonly id: string; readonly name: string }

export interface AdoptionPlan {
  readonly provider: string | undefined           // 本次发生变化的 provider（未知时 undefined）
  readonly added: readonly ProviderModelRef[]     // 基线里没有、现在有的模型（保持目录顺序）
  readonly decision: 'none' | 'auto' | 'ask'      // 0 / 1 / N
  readonly defaultPick: ProviderModelRef | undefined  // N 时的预选：当前路由若在 added 里就选它，否则第一个
}

export function planModelAdoption(input: {
  readonly baseline: readonly ProviderModelRef[]
  readonly current: readonly ProviderModelRef[]
  readonly provider?: string
  readonly currentRoute?: { provider: string; id: string }
}): AdoptionPlan
```

- `added` 只收"基线没有、现在有"的模型；给了 `provider` 就只看它。这样"重新检查"、
  第二个 provider 登录、以及中途改配置都不会重复询问已经接过的模型。
- `decision` 就是用户要的三分支：**没有就不问、只有一个直接设为默认、多个才问**。
- `defaultPick` 保证 N 分支的预选是稳定的（当前路由优先），不会每次都跳到列表头。

### 3.5 "接入"到底持久化什么（诚实性决策）

这一步很容易做成假按钮（仓库明确反对：见 `onboardingModel.ts:34-37` 对键位卡的注释）。三条路径
各自的真实效果不同，UI 文案必须与之一致：

| 路径 | 持久化的东西 | 引导里的措辞 |
| --- | --- | --- |
| OAuth 登录 | provider 凭据（插件自己的存储）；模型**登录后即可用**（凭据门控目录） | "登录后这些模型已可用——选一个作为默认" |
| `/provider` key 路由 | 路由 profile（含选中的 `models`）+ 凭据 ref | "已写入 N 个模型——选一个作为默认" |
| 默认模型 | `channel.switchModel(provider, id)` → `~/.dsh-tui/model.json`（`src/dsh-adapter/channel/model-switch.ts`） | "默认模型：X" |

因此"是否增加"这个问句：
- key 路由：由 `/provider` 自己的模型多选回答（真持久化），引导不重复问；
- OAuth：**不再假装有 enable 列表**，问句改为"把 <provider> 的 N 个模型接入并选一个默认吗？"，
  N>1 时先多选（决定哪些进默认候选），再单选默认；只有一个时连问都不问，直接设为默认。

### 3.6 与第 3 步（模型/强度/工作区）的关系

- 第一步接入完成后，第 3 步的模型分组会把**本次新接入的 provider** 标记为"新"，并把
  光标预置到刚设为默认的那一项；
- 如果用户在第一步选了"跳过接入"，第 3 步保持 v1 行为（现有全量目录 + 空目录提示），
  空目录提示文案改为指向 `/provider` 与 `/auth`（而不是只指向 `/provider`）。

## 4. 失败、回滚与幂等

- **登录失败/取消**：`runOAuthLogin` 已把 `UserQuestionError` 归一成 `'cancelled'`，
  其余错误归一成 `'failed'` 并 notify（`providerWizard.ts:1056-1070`）。引导只消费结果，
  不改状态机；`adopting` 阶段看到 0 个新增就退化成 `none`。
- **凭据写入**：引导不自己写凭据；`/provider` 的回滚语义（先凭据后 profile，profile
  失败恢复旧 key，`providerWizard.ts:380-410`）原样保留。
- **重复接入**：差分基线写进 draft，重挂后仍是同一基线；同一批模型不会被问第二次。
- **动作 id（review 修正）**：`pending` 带一个单调 id。关掉引导不会取消 provider 流程——用户在
  `/setup` 里重新发起一单后，上一单的迟到回调若直接把 `completed` 写进 draft，就会顶掉新一单的
  `pending`，让引导结算"被放弃的那一单"、丢掉在跑的那一单的结果。完成态只在
  `draft.pending.id === 自己的 id` 时写（见 §7.2）。
- **结算时序（review 修正）**：`pending` 覆盖**整个动作期间**，`completed` 只在动作结束时写入；
  结算必须有 `completed`。原因是问答面板可以在两次提问之间关闭（模型探测、profile 写入都在
  提问之间），此时本屏被重挂而目录还没变——早结算会读到旧目录并把结果丢掉。跑动作的实例即使
  已被卸载也会把 `completed` 写进 draft（若引导已关闭则跳过），在挂的实例通过
  `subscribeOnboardingDraft` 收到通知后结算；三条路径（挂载、订阅、Promise 回调）加起来只结算
  一次（`completed` 在结算开始时同步清空）。
- **面板接管**：面板挂起时向导卸载。draft 的写入点必须发生在**发起动作之前**
  （基线 + 意图），否则动作回来时丢失上下文。
- **写盘失败**：`switchModel` 返回 false 时给 `onboarding-model-switch-failed` 同款提示，
  不静默。

## 5. 键盘、鼠标与 Esc

- 第一步的动作行是 `ListItem`（既有鼠标悬停/点击契约），键盘 ↑/↓ 移焦点、Enter 触发。
- 内联接入层（N 分支）是引导自己的模态层，两个键各管一件事：**`Space` = 选择**
  （模型区勾/去勾当前行；默认区把当前行标记为默认），**`Enter` = 确定**（模型区确认这批
  勾选并进默认区；默认区把标记的那一个落成默认模型）。`↑`/`↓` 只移动焦点、不改标记，
  `Tab` 换区，`Esc` 退一层（不关引导）。标记与焦点分开画（✓ = 已选中，❯ = 焦点），
  所以"Enter 落的是 ✓ 那一行"是可读的；这与既有的工作区模态层同构
  （`Onboarding.tsx:262-296`）。
- 鼠标点击与 `Space` 走**同一个**勾选函数：被点掉的若是"标记的默认"，标记同样让给还选着的
  第一个（早期版本只有键盘路径做了移交，导致默认区可能一个 ✓ 都没有）。
- 全局 Esc 仍然跳过引导；`Ctrl+C` 与 Esc 同义（`Onboarding.tsx:300-305`）。
- 底部提示行按当前子状态切换（动作列表 / 勾选 / 选默认），不写死一句话。

## 6. 门禁与契约影响

- **不改端口**：不新增 `ChannelUi` 方法 → `src/adapter/channel/ui-policy.ts`、
  `scripts/verify-adapter-ports.*`、`verify-adapter-effect-class.*` 无需改动。
- **不新增边界例外**：Onboarding 不 import `src/dsh-adapter/` 的值；Chat 的既有
  import 行（`Chat.tsx:47`）不新增符号。
- **i18n**：新增键必须 zh+en 齐全、且在 `src/` 或 `scripts/` 有字面引用
  （`scripts/verify-i18n.ts` 的死键/完整性检查）；不新增 `DYNAMIC_PREFIXES`。
- **回归**：`scripts/verify-onboarding-wizard.tsx`（组件契约）与
  `scripts/verify-launchpad-onboarding-chat.tsx`（Chat 集成：`/setup` 打开、Esc 记账、
  模型/强度/工作区选择）都必须保持绿；后者用的假 channel 没有 `oauthProviderStatuses`，
  所以新读法一律走可选链。

## 7. 测试计划

1. 新增 `scripts/verify-onboarding-provider-plan.ts`（纯，无 React）：0/1/N 三分支、
   基线差分的重复调用幂等、`defaultPick` 的当前路由优先、provider 过滤。
2. 扩展 `scripts/verify-onboarding-wizard.tsx`（假 channel + 假登录回调）：
   - 缺 key 时第一步渲染出动作行，且不再出现 `~/.deepseek/config.json`；
   - 单个新模型 → 自动 `switchModel`，无问答；
   - 三个新模型 → 内联多选出现、默认预选正确、确认后 `switchModel` 落在选中项；
   - 无新增 → 只出提示，不调 `switchModel`；
   - `onProviderSignIn` 被调用时携带正确的 provider；
   - draft：步骤/焦点在卸载-重挂后保持。
3. `node --import tsx/esm scripts/verify-i18n.ts`：新键完整性/占位符/死键。
4. `node --import tsx/esm scripts/verify-launchpad-onboarding-chat.tsx`：Chat 集成不回归。

### 7.1 实际结果（2026-10-20，同步 `origin/main` `5e0146bc` 后）

同步：上游 44 个提交（a40c305a → 5e0146bc）**没有触碰** `Onboarding.tsx` / `onboardingModel.ts` /
`providerWizard.ts` / `oauth/`，`git stash pop` 无冲突；`ProviderWizardOutcome` 联合未变。


| 门禁 | 结果 |
| --- | --- |
| `scripts/verify-onboarding-wizard.tsx` | **88/88 通过**（新增 J1–J12：动作行、兜底文案、0/1/N 三分支、Space/Enter 分工、draft 重挂、面板接管结算、标记移交） |
| `scripts/verify-onboarding-provider-plan.ts`（新增） | **21/21 通过** |
| `scripts/verify-i18n.ts` | 通过（2077 条目，无死键、占位符一致） |
| `scripts/verify-guide.mjs` | 通过（20 份手册逐字节一致） |
| `scripts/verify-adapter-boundary.ts` | 通过（未新增 UI→adapter 的值 import） |
| `tsc -p tsconfig.json --noEmit` | 改动文件零错误（仓库其余错误来自本机 node_modules 与 main 的依赖漂移） |
| `scripts/verify-launchpad-onboarding-chat.tsx` | 本轮 5/235；**稳定失败集 = Z8×2 / Z9 / Z10×2（剪贴板/图片，本机没有剪贴板工具链）**，与干净 `origin/main` 基线逐条相同。另有一对 `N4a/N4b`（启动页命令面板鼠标点击）是时序 flake：**干净基线连续两次也命中（7/235）**，与本改动无关。A/B 用 `NPM_CONFIG_REGISTRY` 指向不可达地址以消掉"有新版本"条件位 |

### 7.2 实现审查修正（自查发现并已修）

| 问题 | 现象 | 修法 |
| --- | --- | --- |
| 动作清单异步长出，焦点按下标记 | 首帧只有"重新检查/跳过"，状态读回来后"登录/加 key"插到最前 → 焦点静默从"重新检查"变成"登录"，一次回车点错 | 焦点改按**动作 id**记；首次挂载不钉行（`accessFocusId = undefined` 即第一行），只有重挂才按 draft 下标恢复 |
| 卸载的实例抢先结算 | 面板挂起 → 本屏卸载 → 在飞 Promise 解析时旧实例把 `pending` 清掉，重挂的实例再无可结算 → 登录后的模型永远不被接入 | `settlePendingAction` 先查 `aliveRef`，卸载的实例原样留下 `pending`；新增 J9 用"永不解析的登录 + 卸载 + 重挂"钉住 |
| `cancelled`/`failed` 也进结算 | 失败时反而显示"没有新增可用模型"，盖掉真正的失败原因 | 两条都只清 `pending` 并回到动作层；失败另给一句本地回声（整屏盖着时外面的通知条看不见） |
| 结算后状态不刷新 | 刚登录的账号在状态区仍显示"未登录" | 结算与落默认之后各 `setCheckNonce(+1)`，重读凭证/登录状态/连通性 |
| 迟到解析写脏 draft | 用户已退出引导，`switchModel` 才解析 → 给下一次 `/setup` 留一条过期提示 | 落地判断先看 `aliveRef`，卸载后既不写状态也不写 draft |
| Chat 的 hook 在 early-return 之后 | 面板挂起时 Chat 提前 return，三个新 `useCallback` 不执行 → 面板关闭时 hook 数量变化（React 直接报错） | 三个回调上移到 `switchModelRecorded` 之后、所有 early-return 之前 |

| 结算早于动作完成（review，Major） | 面板在两次提问之间关闭 → 本屏重挂、目录还没变 → 早结算读到旧目录；动作随后结束却无人接手 → **登录成功但模型永远不被接入** | `pending` 覆盖整个动作期间，`completed` 只在结束时写；结算必须有 `completed`；`subscribeOnboardingDraft` 把迟到的完成送到在挂实例。J9 重写成这个时序（未完成 → 不结算；完成 → 只结算一次），J11 覆盖"挂载时已完成" |
| 焦点按下标恢复（review） | `runProviderAction` 写的是行号；重挂首帧 `oauth` 还没读回，清单更短 → 行号指向另一个动作 | draft 增 `focusId`，按动作 id 恢复；id 暂时不在清单里就落在第 0 行，清单长出来再回到同一动作 |
| 鼠标勾选不移交标记（review） | 键盘 Space 有移交，鼠标 `onToggle` 没有 | 两条路径共用 `toggleAdoptSelection` |
| 英文手册漏了 `←/→` 例外（review） | 中文列了"第一步的接入子层"，英文只列了滑块与钻入的模型列表 | 同步 `docs/interaction.en.md` 并重建 `guide/` |

| 两单交错顶掉 pending（review，Minor） | 关引导 → 重新 `/setup` 发起新动作 → 上一单迟到回调把新 pending 写成自己的完成态 | `OnboardingPendingAction` 增单调 `id`；完成态只在 id 相同时写；J12 覆盖"关闭→新单→旧单迟到→新单仍正常结算" |
## 8. 兼容与迁移

- **`ONBOARDING_VERSION` 不 bump**：按 `src/onboardingPrefs.ts:34-39` 的规则，
  只有**新增步骤**才 bump；本次是同一批步骤内的能力升级（第 1 步换语义、第 3 步预置），
  不打算让所有老安装再看一遍引导。若后续把"账号与模型接入"拆成独立第 5 步，再 bump。
- **DSH 版本线**：`describeCredential` / `providerSetup()` / `oauthProviderStatuses()` 都是
  既有的可选接缝（缺失即降级），因此 0.1.x 老宿主上第一步退化成"状态 + 环境变量指引"，
  不会崩。
- **没有 `dsh-auth` 的宿主**：登录动作行置灰并说明原因；`/provider` key 路径仍可用。

## 9. Windows 专项修复（与 1.2 对应）

1. 删除 `~/.deepseek/config.json` 那条指引；
2. 兜底指引给出平台正确的写法：PowerShell 用户级持久化（`[Environment]::SetEnvironmentVariable(...,'User')`，
   与一键安装包同一口径）、cmd 的 `setx`、以及 `$DSH_HOME\.credentials.yaml` 的真实位置；
3. 首选路径不再是环境变量，而是引导内的登录/加 key；环境变量降级为"你也可以这样做"。

## 10. 开放问题

- Q1（**已调研，结论：可做，但留作后续小 PR**）是否要在接入层提供"DeepSeek 官方 API key"
  快捷项？
  - **规范路径**：浏览器/桌面模型页写 key 走 Remote `credentials` 命名空间
    （`credentials.set(ref, value)` → `ctx.credentials.set`，见
    `@deepseek-ai/dsh-api-settings-controller` 的 `credentials.set` 处理）；TUI 的 `/provider`
    走的是同一条 `providerSetup().writeCredential(ref, value)`。
  - **没有所有者限制**：`isReservedCredentialRef` 只拦**插件注册的 settings section** 与
    `/settings` 的通用 secret 写（`settings-host.ts:213`），`/provider` 的写路径不经过它。
    所以 `writeCredential('DEEPSEEK_API_KEY', key)` 在架构上是合法的。
  - **没有 schema 可依**：DSH 的 `apiKeyEnv` 字段只声明 `role: 'credential-ref'`（一个名字），
    Web 模型页的密钥输入框是它自己硬编码的，setting 描述里没有"secret 字段"可让 TUI 通用渲染——
    所以这一项在 TUI 也得硬编码一行。
  - **为什么不在本 PR**：它是共享 ref 的写入（所有引用 `DEEPSEEK_API_KEY` 的路由一起换 key），
    需要一次"影响面确认"交互，属于独立话题；本 PR 先把"接入主干 + 文案纠错"落地。
- Q2 默认强度（effort）是否也跟随接入结果给建议值？现设计不动。
- Q3 多 provider 同时接入时，是否要一次问"默认 provider"再问"默认模型"？
  现设计按 provider 顺序逐个接入，每次最多问一组。

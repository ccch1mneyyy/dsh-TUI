# 首次引导的账号与模型接入（Onboarding v2 设计）

关联：#1646（本设计）、引导首版 #1255、`/provider` 向导、`dsh-auth` 订阅登录、`/settings` 凭据写入。

本文回答一个问题：**首次启动的引导应该怎样把"这台机器能用哪个模型"这件事配置好**，
而不是把用户推去导出一个环境变量。文中的落点一律写模块与符号名，按名检索。

## 1. 问题

### 1.1 v1 的第一步

`ONBOARDING_STEPS` 的第一步原是 `apikey`，渲染为 `ApiKeyStep`（`src/screens/Onboarding.tsx`），
是**只读检查页**：

- `channel.describeCredential('DEEPSEEK_API_KEY')` → 只报有没有；
- `channel.balanceInfo()` → 一次真实连通性检查；
- 缺 key 时打印两条指引：`DEEPSEEK_API_KEY=sk-…`（POSIX 形状，附一句 PowerShell）与
  `~/.deepseek/config.json { "apiKey": … }`；
- 键盘上 Enter 只等于"重新检查"。

也就是说，用户在这一页**做不了任何配置**。真正能配置的地方全在别处：

| 入口 | 能做什么 | 落点 |
| --- | --- | --- |
| `/provider` | 加/改/删 provider 路由、输入 API key、订阅 OAuth 登录（`ctx.dshAuth` 挂载时） | `src/dsh-adapter/providerWizard.ts` 的 `runProviderWizard`、`runOAuthWizard` |
| `/auth login <provider>` | 订阅账号 OAuth（含 Host 的 `deepseek-account`） | `src/dsh-adapter/oauth/` |
| `/login` | 状态 + 指路（"使用 /provider 管理 DSH 凭据…"） | `Chat.tsx` 的 `login` 命令 |
| `/settings` | 只有 **Web 搜索** 的 secret 字段可写（默认 ref 恰好也是 `DEEPSEEK_API_KEY`） | `src/dsh-adapter/channel/settings-host.ts` |

### 1.2 具体缺陷

1. **只读 vs 用户预期**：首启第一屏只报"未配置"，没有动作入口，用户会把它读成
   "这里配不了"。
2. **指引有一处是错的**：`~/.deepseek/config.json` 在 DSH 里没有读取方。DSH 的真实存储是
   `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）与环境变量；官方文档把
   "写密钥"这件事交给 Web 模型页。`dsh-llm-deepseek` 里同样搜不到该路径。
3. **环境变量指引只有 POSIX 形状**：Windows 上真正管用的是用户级环境变量（一键安装包
   就是这么做的，见 `scripts/make-installer-bundle.mjs`），而 `~` 在 cmd/PowerShell 里并不展开。
4. **登录后的内容没有被接住**：`dsh-auth` 的目录是**凭据门控**的——
   `CredentialGatedAdapter.listModels()` 对没有凭据的 provider 直接返回 `[]`
   （`src/dsh-adapter/oauth/index.ts`）。所以"登录成功"与"模型列表里多出这些模型"
   是同一次状态变化，**可以被观测、也应该被引导接住**；v1 完全没用这条信息。
5. **默认模型没有被带出来**：登录/加 key 之后用户仍停在只读页，还要自己去第 3 步或
   `/model` 里挑默认模型。

### 1.3 不构成缺陷的部分（先排除）

- 缺 key **不会**让引导消失：DSH 的 key 是每次请求才解析（`resolveAuth`），
  模型发现把 `MISSING_CREDENTIAL` 吞成空目录，`agents.create` 不碰凭据，因此
  `channel.startupFailure` 不会因为缺 key 触发，引导照常弹出（仓库自带的真机探针
  `scripts/verify-installed-startup.mjs` 在隔离 HOME 下正是靠 `Esc 跳过引导` 收掉它）。
- 门禁链上没有平台分支：`onboardingOnBoot = dshBoot && noResume && shouldOfferOnboarding()`
  （`src/dsh-adapter/plugin.ts`），`shouldOfferOnboarding` 只看 `~/.dsh-tui/onboarding.json`
  （`src/onboardingPrefs.ts`）。
- 引导仍然有存在价值：它是唯一能一次把**语言/主题 + 默认模型/强度/工作区 + 快捷键**
  对齐的地方。

## 2. 目标与非目标

**目标**

- G1 第一步从"只读检查"变成"**接入页**"：能在引导内完成订阅登录、API key 配置、
  重新检查；不再强推 `DEEPSEEK_API_KEY` 环境变量。
- G2 订阅登录成功后，**把新出现的模型接住**：没有就不问；只有一个就自动设为默认；
  有多个就在这些新模型里选一个作为默认（它们登录后已经全部可用，见 3.5）。加 key 的启用与切换由 `/provider` 向导自己问
  （多个模型时逐个列出、由用户选，或保持当前模型），引导只报结果（见 3.5）。
- G3 让第 3 步的默认模型与接入结果一致（用户不必再挑一遍）。
- G4 指引必须真、必须跨平台（删掉 `~/.deepseek/config.json`，给出 Windows 可执行的写法）。
- G5 不新增 UI→adapter 的**值** import，不新增端口方法（复用 `providerSetup()` /
  `oauthProviderStatuses()` / `listModels()` / `switchModel()` / `notifications` 这些既有接缝）。

**非目标**

- N1 不重写 `/provider` 向导，也不动它的持久化语义（路由 profile + 凭据 + 回滚）。
- N2 不接管 DSH 的账号域（PKCE、回调、令牌存储仍归 Host）。
- N3 不做"引导里直接编辑 `cordis.patch.yml`"这类底层编辑。
- N4 不改 v1 的四步骨架与"Esc 跳过不记账 / 走完才记账"的记账契约
  （`Onboarding` 的 `finish`、`src/onboardingPrefs.ts`）。

## 3. 架构

### 3.1 分层与模块边界

沿用仓库既有规则（UI 不 import 后端；`src/dsh-adapter/` 是唯一允许 import
`@deepseek-ai/*` 的地方；UI 从 `src/dsh-adapter/` 只取类型）：

```
src/screens/Onboarding.tsx        ← 屏幕：状态机 + 渲染 + 键盘/鼠标（不碰凭据）
src/components/onboardingProviderPlan.ts   ← 纯推导：目录差分、0/1/N 决策、候选排序
src/onboardingDraft.ts            ← 模块级进度存储：问卷面板接管期间的"记忆"
src/screens/Chat.tsx              ← 接缝持有者：questionStore.ask / provider 动作回调 / 结果刷新
src/dsh-adapter/providerWizard.ts ← 既有值：runProviderWizard、runOAuthLogin
src/dsh-adapter/oauth/index.ts    ← 既有值：dsh-auth 服务与凭据门控目录（不改）
```

**为什么动作回调放在 Chat，而不是让 Onboarding 直接调 `runProviderWizard`**：
Chat 已经持有 `questionStore` 与 `providerWizard.js` 的既有值 import，也已有一套
"`/provider` 结束后刷新模型/提供方/补全缓存"的收尾逻辑。把这些放进 Chat 可以在
**不新增任何边界例外**的前提下复用它们；`/provider` 命令与引导的"添加模型提供方"
共用同一个 `runProviderSetup`（同一份 deps、同一个目录收尾），Onboarding 只拿两个回调 prop。

**为什么进度要落模块存储**：问卷/审批面板与整屏界面共用"打断通道"——面板挂起时
整屏被卸载、回答后**重挂**（Chat 的 `interruptPanel && screenOpen` 分支，`screenOpen`
包含 `onboardingOpen`）。接入流程要用问答面板（API key 输入、OAuth 设备码/授权 URL），
向导的 React 状态会在接管期间丢失。`src/onboardingDraft.ts` 因此保存：当前步骤、焦点
（行号与动作 id）、动作前的目录基线、在飞的动作、动作的完成态、以及一句上屏提示；
挂载时读取、变更时写入、完成/跳过时清空。它只在进程内，不序列化。

### 3.2 状态机（第一步）

```
            ┌─────────────┐
  挂载 ───▶ │  checking   │  describeCredential + oauthProviderStatuses + listModels/listProviders
            └──────┬──────┘
                   ▼
            ┌─────────────┐   动作行 ❯ 登录订阅账号（列 provider，已登录/未登录同列）
            │   ready     │   动作行   添加模型提供方（API key）→ /provider 向导
            │ (动作列表)  │   动作行   重新检查 / 跳过这一步（= 下一步）
            └──┬───┬───┬──┘
               │   │   └────── 重新检查 ──────▶ checking
   登录/加 key │   │
               ▼   │
        ┌──────────┴──┐   动作在跑：`pending` 一直留着；中途重挂只恢复进度，**不结算**；
        │  in-flight  │   登录 / 加 key 两行不接、显示"配置进行中"（一次只跑一单）
        └──────┬──────┘
               ▼   动作结束：写 `draft.completed`（added / changed / cancelled / failed，
        ┌─────────────┐   并带上流程在这期间发出的最新一条通知）
        │  completed  │
        └──────┬──────┘
               ▼   结算：在挂的实例做；订阅把"迟到的完成"送到它
        ┌─────────────┐
        │  adopting   │  目录差分：0 → none（只报结果）；1 → auto；N → 内联选默认（单选 + 保持当前模型）；加 key → 只报结果
        └──────┬──────┘
               ▼
            ready（提示一句结果："已接入 X，默认模型设为 Y" 等）
```

Esc 语义不变：任何时候 Esc 跳过整个引导（不记账）；接入子流程内部 Esc 由各自面板/
内联层吃掉，回到 `ready`。

### 3.3 数据流

**A. 订阅登录（OAuth）**

1. 首帧读 `channel.oauthProviderStatuses()`。未挂 `dsh-auth`（返回 `undefined` 或空）时
   **不画**登录行，而不是假装能点；同理没有 `providerSetup()` 时不画"添加模型提供方"。
   登录行的可见性与执行走同一个接缝：Chat 执行登录取的是 `providerSetup()?.oauth`，所以只有它
   在时才画登录行——"有 dsh-auth、没有 `/provider` 宿主服务"的组合不出现点了就报未挂载的死入口，
   兜底文案也只说"当前组合里订阅登录不可用"，不断言是哪个插件没挂。登录状态在重新检查、打开
   选账号层、以及 `oauth` 接缝晚于首帧出现时都会重读，晚到的组合不必等用户点"重新检查"。
2. 用户在某一行 Enter → Chat 提供的 `onProviderSignIn(provider)` →
   `runOAuthLogin(deps, oauth, provider)` → 面板走设备码/授权 URL/浏览器
   （`src/dsh-adapter/oauth/opener.ts` 的 `openInBrowser`，win32 分支已处理 `&` 引号问题）。
   已登录的账号会问"重新登录 / 登出 / 取消"。
3. 登录写入 dsh-auth 自己的凭据文件；**下一次 `listModels()` 就能看到该 provider 的模型**
   （`CredentialGatedAdapter` 每次调用都读一次凭据）。
4. 结算阶段做差分（下面 3.4）。

**B. API key（`/provider` 向导）**

1. 动作行 → Chat 的 `runProviderSetup()` → `runProviderWizard(...)`（与 `/provider` 同一条）。
2. 向导自己问 route/端点/协议/key/模型多选，并**先写凭据再写 profile，失败回滚**。
   这里的"模型多选"就是 key 路由语义下真正的"是否增加"。
3. 写入后向导问"要切换到新 provider 的哪个模型？"：本次启用的模型逐个列出，最后一项是
   "保持当前模型"（描述里写出当前模型）。多个模型时由用户明确选默认，而不是固定取第一个。
   不勾模型、启用整份内置目录时不问，改为提示用 `/model` 切换。
4. 回到引导只报结果（新增几个模型、当前默认是谁）：启用哪些、切不切过去，向导已经问过并落了盘，
   引导不再进 `adopting`，也不改默认（见 3.5）。

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

这一步很容易做成假按钮（仓库明确反对：见 `onboardingModel.ts` 对键位卡的注释）。三条路径
各自的真实效果不同，UI 文案必须与之一致：

| 路径 | 持久化的东西 | 引导里的措辞 |
| --- | --- | --- |
| OAuth 登录 | provider 凭据（插件自己的存储）；模型**登录后即可用**（凭据门控目录） | 1 个："已接入 X，默认模型设为 Y"；多个：选默认层"X 接入 N 个可用模型"，选中后同一句 |
| `/provider` key 路由 | 路由 profile（含选中的 `models`）+ 凭据 ref；切换题选中的模型 | "已接入 X 的 N 个模型；默认模型：Y" |
| 默认模型 | `channel.switchModel(provider, id)` → `~/.dsh-tui/model.json`（`src/dsh-adapter/channel/model-switch.ts`） | "默认模型：Y" |

因此"是否增加"这个问句：
- key 路由：由 `/provider` 自己的模型多选与切换题回答（真持久化），引导不重复问；
- OAuth：**不假装有 enable 列表**。登录后这些模型已经全部可用，`/model` 与第 3 步读的都是全量
  目录，没有任何地方保存"接入哪几个"——多选只会让用户以为做了筛选。所以 N>1 时只问"哪个当
  默认"（单选，末尾一行"保持当前模型"）；只有一个时连问都不问，直接设为默认。

第一步的凭证行与余额检查只针对 DeepSeek 官方 API（`balanceInfo` 只认 `DEEPSEEK_API_KEY`）。
已经有别的接入——已登录的订阅账号，或 `/provider` 配好且 key 真的在的路由——时，缺 DeepSeek
key 不画成失败：凭证行改成"未配置 DEEPSEEK_API_KEY（只有 DeepSeek 官方 API 需要）"，余额检查
改成"已跳过 DeepSeek 余额检查；已接入：…"，手工设置的兜底文案也一并收起。刚登录或刚配好的人
不该看到"没有可用的凭证"。

登出、改路由、删路由也会从这两个动作里跑出来（登录行选已登录账号、`/provider` 选"编辑"）。
它们本意不是新增，结算时报流程自己的那一句（"已退出…"、"已删除…"），不说"没有新增可用模型"。

### 3.6 与第 3 步（模型/强度/工作区）的关系

- 结算会让第 3 步重读模型与提供方（`catalogNonce`），默认模型由 `switchModel` 落盘，
  所以第 3 步看到的当前模型就是第一步定下的那个，不需要再挑一遍。
- 第 3 步本身不变：同一份全量目录，空目录时提示用 `/provider` 配置。

## 4. 失败、回滚与幂等

- **失败原因要看得见**：两条流程只经 `channel.notify` 报原因（写入失败、登录失败、
  路由 id 非法、OAuth 未挂载……），而整屏引导盖住了通知条。跑动作的实例在 `start()` 前
  记下最后一条通知的 id，结束后把它之后最新的那一条写进 `completed.notice`；结算时
  失败显示"这次配置没有完成：<原因>"，没有新通知才用通用文案。开跑前就在的旧通知不算。
  提示行带语气：成功用 success、取消与"没有新增"用 warning、失败用 error；语气与文字一起存进
  draft，重挂后不会变回成功色。
- **登录失败/取消**：`runOAuthLogin` 已把 `UserQuestionError` 归一成 `'cancelled'`，
  其余错误归一成 `'failed'` 并 notify。取消/失败不读目录，只回到动作层。
- **凭据写入**：引导不自己写凭据；`/provider` 的回滚语义（先凭据后 profile，profile
  失败恢复旧 key）原样保留。
- **重复接入**：差分基线写进 draft，重挂后仍是同一基线；同一批模型不会被问第二次。
- **动作归属**：`runProviderAction` 在读基线（`await channel.listModels()`）**之前**登记归属，
  `finish()`、卸载、发起新一单都会作废它；目录回来先验归属，作废了就不写 draft、也不 `start()`
  ——否则迟到的读取会复活已清空的 draft，并替一个已经离开的用户跑完登录。
- **动作 id**：`pending` 带一个单调 id。关掉引导不会取消 provider 流程——用户在 `/setup`
  里重新发起一单后，上一单的迟到回调若直接写 `completed`，就会顶掉新一单的 `pending`。
  完成态只在 `draft.pending.id === 自己的 id` 时写。
- **结算时序**：`pending` 覆盖**整个动作期间**，`completed` 只在动作结束时写入；
  结算必须有 `completed`。问答面板可以在两次提问之间关闭（模型探测、profile 写入都在
  提问之间），此时本屏被重挂而目录还没变——早结算会读到旧目录并把结果丢掉。跑动作的实例即使
  已被卸载也会把 `completed` 写进 draft（若引导已关闭则跳过），在挂的实例通过
  `subscribeOnboardingDraft` 收到通知后结算；已卸载的实例不结算。三条路径（挂载、订阅、
  Promise 回调）加起来只结算一次（`completed` 在结算开始时同步清空）。
- **结算后刷新**：结算与落默认之后都重读凭证/登录状态/连通性，刚登录的账号不会仍显示"未登录"；
  `switchModel` 迟到解析时若引导已关，既不改状态也不给下一次 `/setup` 留提示。
- **写盘失败**：`switchModel` 返回 false 时给 `onboarding-model-switch-failed` 同款提示，
  不静默。

## 5. 键盘、鼠标与 Esc

- 第一步的动作行是 `ListItem`（既有鼠标悬停/点击契约），键盘 ↑/↓ 移焦点、Enter 触发。
  动作清单是异步长出来的（先有"重新检查/跳过"，状态读回后才有"登录/加 key"），所以焦点
  按**动作 id** 记与恢复，不按下标。
- 内联选默认层（N 分支）是引导自己的模态层，只有单选：`↑`/`↓` 移动，`Enter` 把焦点那一行
  落成默认模型；末尾一行"保持当前模型"（附当前模型名）不动默认，`Esc` 与它同义（退一层，
  不关引导）。焦点先落在预选上（当前路由在新增里就是它，否则第一个新增模型）。这与 `/provider`
  切换题的"切换到 X / 保持当前模型"同形，与既有的工作区模态层同构。
- 列表按 `listWindow` 窗口化：模型可能几十个，焦点行必须始终在视口内，否则 Enter 就成了盲操作；
  "保持当前模型"固定在窗口之外。
- 鼠标点击与 Enter 是同一个落点（`applyAdoption`）：点模型行设为默认，点"保持当前模型"不动默认。
- 全局 Esc 仍然跳过引导；`Ctrl+C` 与 Esc 同义。
- 底部提示行按当前子状态切换（动作列表 / 选账号 / 选默认），不写死一句话。

## 6. 门禁与契约影响

- **不改端口**：不新增 `ChannelUi` 方法 → `src/adapter/channel/ui-policy.ts`、
  `scripts/verify-adapter-ports.*`、`verify-adapter-effect-class.*` 无需改动。
- **不新增边界例外**：Onboarding 对 `src/dsh-adapter/` 只有 `import type`；Chat 的
  `providerWizard.js` import 行只多了 `type ProviderWizardOutcome`。`ProviderWizardDeps`
  多一个可选的 `currentModel`（切换题的"保持当前模型"用它写出当前模型）。
- **i18n**：新增键必须 zh+en 齐全、且在 `src/` 或 `scripts/` 有字面引用
  （`scripts/verify-i18n.ts` 的死键/完整性检查）；不新增 `DYNAMIC_PREFIXES`。
- **回归**：见第 7 节；`scripts/verify-launchpad-onboarding-chat.tsx` 用的假 channel 没有
  `oauthProviderStatuses`，所以对可选接缝的新读法一律走可选链。

## 7. 测试

1. `scripts/verify-onboarding-provider-plan.ts`（纯，无 React）：0/1/N 三分支、
   基线差分的重复调用幂等、`defaultPick` 的当前路由优先、provider 过滤。
2. `scripts/verify-onboarding-wizard.tsx`（真 Ink + headless xterm，假 channel + 假动作回调）：
   - 动作行按接缝出现，兜底文案不再有 `~/.deepseek/config.json`；
   - 0/1/N 三分支；N 分支只有单选、不报"已接入 N 个"，"保持当前模型"不调 `switchModel`，
     鼠标与键盘同一个落点（J4/J8/J10）；
   - draft：卸载-重挂后保持步骤与焦点，面板接管期间不早结算，迟到的完成只结算一次，
     两单交错时旧单不顶掉新单；
   - 加 key 只报结果，不推翻向导里的选择（J13）；
   - 失败原因与登出/删除结果在引导里可见（J14/J15）；
   - 关屏后迟到的目录读取不启动登录、不写回 draft，两单的目录都卡住时旧单作废（J16/J17）；
   - 80×24 下 30 个新模型，选默认层的焦点行与"保持当前模型"都在视口内（J18）；
   - 已登录订阅账号或配好 key 路由时，缺 DeepSeek key 不报"没有可用的凭证"（J19/J20）；
   - 登录行与执行同一接缝、晚到的 dsh-auth 不需要重新检查（J21）；
   - 失败/取消/成功三种提示三种语气，draft 里也一样（J22）；
   - 一单在跑时登录 / 加 key 不能再发起第二单，重挂后也一样，结束后第一单的结果照常结算（J23）。
3. `scripts/verify-provider-wizard.mjs`：切换题列出全部启用模型并以"保持当前模型"收尾，
   选中第二个时切到第二个（3b）。
4. `scripts/verify-i18n.ts`、`scripts/verify-launchpad-onboarding-chat.tsx`（Chat 集成：
   `/setup` 打开、Esc 记账、模型/强度/工作区选择）。

`verify-i18n` 在 `verify:build` 门禁链里，其余脚本登记在 `scripts/run-ci-group.mjs`。

## 8. 兼容与迁移

- **`ONBOARDING_VERSION` 不 bump**：按 `src/onboardingPrefs.ts` 的规则，只有**新增步骤**
  才 bump；本次是同一批步骤内的能力升级（第 1 步换语义），不打算让所有老安装再看一遍引导。
  若后续把"账号与模型接入"拆成独立第 5 步，再 bump。
- **DSH 版本线**：`describeCredential` / `providerSetup()` / `oauthProviderStatuses()` 都是
  既有的可选接缝（缺失即降级），因此 0.1.x 老宿主上第一步退化成"状态 + 环境变量指引"，
  不会崩。
- **没有 `dsh-auth` 的宿主**：不画登录动作行；`/provider` key 路径仍可用。

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
    `/settings` 的通用 secret 写（`settings-host.ts`），`/provider` 的写路径不经过它。
    所以 `writeCredential('DEEPSEEK_API_KEY', key)` 在架构上是合法的。
  - **没有 schema 可依**：DSH 的 `apiKeyEnv` 字段只声明 `role: 'credential-ref'`（一个名字），
    Web 模型页的密钥输入框是它自己硬编码的，setting 描述里没有"secret 字段"可让 TUI 通用渲染——
    所以这一项在 TUI 也得硬编码一行。
  - **为什么不在本 PR**：它是共享 ref 的写入（所有引用 `DEEPSEEK_API_KEY` 的路由一起换 key），
    需要一次"影响面确认"交互，属于独立话题；本 PR 先把"接入主干 + 文案纠错"落地。
- Q2 默认强度（effort）是否也跟随接入结果给建议值？现设计不动。
- Q3 多 provider 同时接入时，是否要一次问"默认 provider"再问"默认模型"？
  现设计按 provider 顺序逐个接入，每次最多问一组。

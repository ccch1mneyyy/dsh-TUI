# Codex 原生后端施工日志

> 分支 `feat/codex-native`（worktree `/home/coder/dsh-tui-codex`，基于 `main` f6d61438 + 方案提交 483a550b）。
> 方案：[codex-backend-design.md](codex-backend-design.md)（下称"方案"）。实施：Opus 5.5（单代理，不派子代理）。
> 规则：每个 checkpoint 一个提交；只暂存显式路径；不 push、不开 PR；实测与方案冲突时以实测为准，
> 在本文记录并修订方案（方案内标"C0 已验证"）。

## 协议

1. 每期开工前读方案对应章节与本文；施工按方案 §11 的分期与 §13 的实施协议。
2. 每个 checkpoint：改动 → 自跑本期门禁 → 提交 → 在本文追加条目（做了什么、门禁命令与通过数、
   偏离与理由、遗留）。
3. 实测只经 `scripts/lib/codex-cheap-only.mjs`（临时 `CODEX_HOME`、中转 provider 走 `-c`、
   `gpt-5.6-terra` + `low`）；每期记录实测回合数。
4. 架构偏离（§3 决策、§6 中立层形状）先在"决策记录"写明理由再做。

## 决策记录

| # | 决策 | 理由 |
| --- | --- | --- |
| C0-D1 | 生成类型原样入库，但用 `package.json` `files` 的 `!lib/types/backends/codex/protocol/generated` 排除出 npm 包；`verify:package` 断言不在包内 | 875 个纯类型文件编译后 2625 个文件 / 11 MB（`.js` 为空模块），占包文件数近一半；运行时只经 `protocol/index.ts` 的常量表，`export type` 不产生运行时 import |
| C0-D2 | 中转 provider 在实测与探针里一律经 `codex app-server -c model_providers.relay.*` 注入，不写进任何文件 | 维护者"凭据不写文件"的规则；V10 证实 `-c` 整表注入可用 |
| C0-D3 | `MIN_CODEX_VERSION = 0.144.0`（而非退路 0.160.0） | V16：0.144.0 的生成协议包含本后端用到的全部方法/通知/服务端请求/item 类型，握手、`thread/start`、`model/list` 实测可用；验证线以外的版本照常 drift 提示 |
| C0-D4 | 命令审批的选项按服务端给的 `availableDecisions` 生成（缺省时按官方 TUI 的默认集：accept、execpolicy、cancel） | 实测与官方 TUI 源码（`approval_overlay.rs` `exec_options`）：服务端常常不提供 `decline`/`acceptForSession`；按方案固定四项会给出服务端拒收的决定 |
| C0-D5 | 中断时丢弃未被采纳的 steer：`cancel('interrupt')` 回执 `confirmed`；`cancel('user')` 由会话把这些 steer 重新排进客户端 followup 队列 | V6：`turn/interrupt` 清空回合的待采纳输入（`clear_pending`），历史里也没有；`user` 取消的语义是"排队的输入下回合照跑" |
| R-D1 | 中立事件 `assistant.message` 新增可选 `usageOnly?: true`：投影器只记账（tokens、费用分桶、`lastUsage`、回合账本，按 seq 去重），不建行、不改既有行；`/trace` 源跳过 | 评审 #2：Codex 在回复落定后才报用量，原先用空 `blocks` 的非 canonical 消息承载，会改写上一行的时间/图片并在 `/trace` 留空消息。按"空且非 canonical"启发式判断会误伤 DSH 旧式空消息，故用显式标志（§6 形状的增量改动，DSH 不产生该标志，行为不变） |

## 分期日志

### C0 — 契约、脚手架与事实复核

**提交**

- `c874e8a3` 协议同步脚本 `scripts/codex-protocol-sync.mjs`（临时 `CODEX_HOME` 下跑
  `codex app-server generate-ts --experimental`），生成类型入库
  `src/backends/codex/protocol/generated/`（codex-cli 0.160.1，875 文件），`contract.ts`
  （验证线、`MIN_CODEX_VERSION`、`PROTOCOL_VERSION`/`PROTOCOL_DIGEST`、版本比较与 drift）、
  `protocol/index.ts`（用到的类型 + `CLIENT`/`NOTIFY`/`SERVER_REQUEST`/`OPT_OUT_NOTIFICATIONS`
  常量表，`satisfies` 生成联合）、`narrow.ts`；`verify:codex-contract` 进 `verify:build`
  （摘要、常量表 ⊂ 生成联合、后端源码里协议形状的字面量全在生成联合里、`package.json` 无
  `@openai/codex*`、版本策略），变异自测：改生成文件/摘要/字面量 `'thread/strat'` 均失败。
- `4244fd20` N1：`src/backends/shared/{atomic-file,channel-tokens}.ts`（`ChannelTokenStore`，
  Claude 旧名作 `@deprecated` 别名保留一期）；边界门禁：后端可 import `shared/`，`shared/` 不得
  import scoped 包、具体后端与 `dsh-adapter/`，新增 `native.codex`（只在 `backends/codex/`）；
  `ADAPTER.md` 规则表三行。fixtures 搬运 + `scripts/lib/codex-fixture-sanitize.mjs`（`--write`
  脱敏 / `--check` 门禁：凭据形状、白名单外 URL 主机、临时与 home 路径、installationId）；
  假 app-server `scripts/lib/codex-fake-app-server.ts` + 自测；成本守卫
  `scripts/lib/codex-cheap-only.mjs`；探针 `scripts/probes/codex-{probe-lib,record,c0-verify}.mjs`；
  `rpc/transport.ts`（假 app-server 实现它的接口）。
- 本 checkpoint：V1–V17 探针与结论、两份新录制 fixture、方案修订、本文。

**门禁**

- `verify-codex-contract` 15/15；`verify-codex-fake-app-server` 22/22；
  `codex-fixture-sanitize --check` 9 个文件 OK（中转站主机名与密钥出现次数：0）。
- N1 纯移动：全部 `verify-claude-*`（22 个，除 live/headless）+ `verify-backend-channel` +
  `verify-agent-domain` 全绿；`verify:boundary`、`verify-source-hygiene`、`verify-i18n`、
  `verify-terminal-size-source`、`tsc -p tsconfig.typecheck.json` 通过；变异：`shared/` import
  claude 或厂商包、codex import claude、`native.codex` 越界均被拦。

**实测**：3 个回合（live-a 2 个：文件新建+删除+env；ephemeral fork 内 1 个；live-b 1 个被中断的回合）。

**V1–V17 结论**（探针：`scripts/probes/codex-c0-verify.mjs offline|live-a|live-b`）

| # | 结论 | 处理 |
| --- | --- | --- |
| V1 | stdin EOF 后约 70 ms 以 code 0 退出 | `close()` 先 EOF，2 s 后才 SIGTERM（保留升级） |
| V2 | Codex 给 shell 注入：`CODEX_THREAD_ID`、`CODEX_SESSION_ID`、`CODEX_VERSION`、`CODEX_CI`（unified exec）；按策略还有 `CODEX_SANDBOX`、`CODEX_SANDBOX_NETWORK_DISABLED`、`CODEX_PERMISSION_PROFILE`、`CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS`、`CODEX_NETWORK_PROXY_*`；npm 启动器给自己的进程设 `CODEX_MANAGED_BY_*`/`CODEX_MANAGED_PACKAGE_ROOT`；`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 会改 originator | 子进程环境删除以上（保留 `CODEX_HOME`、`CODEX_API_KEY`、`CODEX_SQLITE_HOME`、证书等用户配置） |
| V3 | `thread/start` 带不带 `serviceName` 都是 `source:"vscode"`；官方 `codex resume` 选择器默认 `sourceKinds:[cli, vscode]` 并按"默认 provider"与 cwd 过滤——dsh-tui 建的 thread **会被列出**（provider 与用户默认相同时；不同 provider 的需在选择器里切"全部 provider"） | open 不需要额外参数；恢复提示同时给 `codex resume <id>` |
| V4 | `thread/resume.initialTurnsPage` 接受 `itemsView`；缺省 `summary` 会省略工具 item，`itemsView:'full'` 返回全量 | resume 一次请求带 `initialTurnsPage:{limit, sortDirection:'desc', itemsView:'full'}`，不再另发 `thread/turns/list` |
| V5 | 对运行中的 thread 再次 `thread/resume`（rejoin）会**重发**挂起的服务端请求，**同一个 request id** | hub/会话按 (代数, id) 去重：重发的请求不再弹第二个面板 |
| V6 | `turn/steer` 被受理（返回 turnId）后若在被采纳前 `turn/interrupt`，该输入被丢弃：不出现 `userMessage`、不进历史、中断后也不自动开回合（源码 `abort_all_tasks → clear_pending`） | 回执一律 `confirmed`；`user` 取消把未采纳的 steer 重新排进客户端队列（C0-D5） |
| V7 | `item/tool/requestUserInput` 的错误应答与 `{answers:{}}` 等价（服务端都提交空答案）；官方 TUI 的 Esc 是中断回合 | 取消 = 应答 `{answers:{}}` + `turn/interrupt` |
| V8 | 官方预设三档：`read-only`「Read Only」(on-request + `:read-only`)、`auto`「Default」(on-request + `:workspace`)、`full-access`「Full Access」(never + `:danger-full-access`)（`utils/approval-presets`） | 方案 §5.9 四档（含 plan）不变，`auto` 的标签按官方叫"默认/Default" |
| V9 | `config/read` 路径：`config.model_provider`、`config.model_providers.<id>.{base_url,env_key,wire_api,requires_openai_auth}`、`config.openai_base_url`、`config.chatgpt_base_url`；自定义 provider 下 `account/read` 为 `requiresOpenaiAuth:false`，外部令牌登录被接受但**不生效**（无账户、无刷新请求） | 路由判定按这些键写（C2），仍作纵深防御保留 |
| V10 | `-c model_provider=… -c model_providers.<id>.{name,base_url,env_key,wire_api}=…` 整表注入可用：`config/read` 可见、真实回合经该 provider 跑通 | 渠道（C2）按方案走 `-c`；实测脚本同法（C0-D2） |
| V11 | `thread/settings/update` 在空闲 thread 上可改 model/effort/approvalPolicy/sandbox：应答 `{}`、发 `thread/settings/updated{threadSettings}`，resume 读回新值（持久化） | C2 的 models/effort/modes 空闲时立即生效 |
| V12 | `thread/fork{ephemeral:true}` 得到 `ephemeral:true`、`path:null` 的 thread，可跑回合且带原上下文；不进 `thread/list`、不写 rollout 文件 | `/btw` 可按方案声明（C4） |
| V13 | `fileChange` 删除的 `diff` 是**被删文件的原文**（新建亦为原文，更新为无文件头 hunk）；`imageGeneration` 字段：`status`、`revisedPrompt`、`result`（图片数据）、`savedPath?`、`failure` | diff 卡：delete → `{oldText: diff, newText:''}`；图片生成按 `savedPath` 优先（C4） |
| V14 | 后台终端 = unified exec 中超过 yield 仍存活的进程（模型自行决定，最多 64 个），跨回合存活直到退出或 `terminate`/`clean`；回合后**没有**生命周期通知，只能轮询 `thread/backgroundTerminals/list`（官方 TUI 只在切工作树时检查） | 不在 C1–C3 声明 `tasks`；C4 评估轮询方案 |
| V15 | 另一进程已加载该 thread 时，`thread/resume` 失败：JSON-RPC `-32600`，message `thread <id> already has an active writer` | 映射为本地化错误"该会话正被另一个 Codex 进程使用" |
| V16 | 0.144.0（本机 PATH 上的旧版）生成协议覆盖本后端全部名字（只缺 `thread/revert`，本后端不用），握手 + `thread/start` + `model/list` 实测可用，未知的 optOut 名不报错 | `MIN_CODEX_VERSION = 0.144.0`（C0-D3） |
| V17 | `account/login/start{chatgptAuthTokens}` 不同步校验（~30 ms 返回 `{type}`），但随即用令牌做工作区路由发现：假令牌 → 401 → 服务端立刻发 `account/chatgptAuthTokens/refresh{reason:'unauthorized'}`，并发 `account/login/completed{success:false, error}`；不写 `auth.json` | C2：以 `login/completed{success:false}` 判定失败并降级到用户自己的凭据（只停止注入，不调 `account/logout`——那会动用户的登录） |

**其他 C0 观察**

- `thread/resume{cwd}` 覆盖生效（应答 `cwd` 为覆盖值）：恢复时沿用 thread 自己的 cwd，C3 可提供"在当前目录继续"。
- `thread/fork` 有 `beforeTurnId`（排除该回合及之后）：rewind 不必先找"上一个回合"（C3）。
- `turn/completed` 的 turn 是 `itemsView:'summary'`，只含最终回复；live 翻译不能依赖它。
- 打开 thread 后服务端会主动发 `mcpServer/startupStatus/updated`（内置 `codex_apps`）与 `thread/goal/cleared`。
- 新录制 fixture：`c0-files-delete-fork`（commentary、命令、新建+删除、ephemeral fork 回合）、
  `c0-approval-redeliver-interrupt`（审批、rejoin 重发、steer 后中断）。

**遗留到 C1**：rpc/client、hub、binary/detect、backend、session、translator、presentation、N7。

### C1 — 核心会话

**提交**

- `acfc2327` 运行时：`rpc/{client,hub,binary}.ts`、`detect.ts`、`backend.ts`、`modes.ts`、`prefs.ts`、
  `session/{session,state,input,approvals,history}.ts`、`translate/{items,live,replay,presentation,commands,notices,usage,events}.ts`；
  N7（`KERNEL_IDS`/`KERNEL_INFO`（含 `installable`）/`kernelDisplayName`、`BACKEND_LOADERS.codex`、
  `BackendDetection.loginInSession` 与目录的 `noteKey`、`plugin.ts` 的 `KernelBackendId`、Config 注释、
  launcher 的 `--backend` 与帮助）；`displayPath` 移到 `src/backends/shared/`；i18n 全部 `codex-*` 键（zh/en）；
  README 双语一节、`docs/configuration*` 的 `backend` 行。
- `a091db6a` `verify-codex-{rpc,hub,translate,live-replay,input}` + goldens；修复：被中断的回复保留已流出的正文。
- `dc90d603` `verify-codex-{approvals,chat}`、`verify-kernel-catalog`；审批选项全部带官方文案；
  `verify-launchpad` K1 改为三内核。全部登记 `channel-ui` 组。
- `d1f8a23e` `scripts/verify-codex-live.ts`（不进 CI）。

**实测**：3 个回合（文本、命令审批、文件改动），`verify-codex-live` 12/12 通过。C0+C1 合计 6 个回合。

**偏离方案之处（均已在代码注释写明）**

1. 用户行正文 = 第一个 text 输入（用户键入的内容），其余 text（`@` 展开、选区）只进 `blocks`；方案 §7.4
   写的是全部 text 以换行连接——那样回放会把文件内容显示成气泡。用户行 `id` = `clientId`（无则 item id），
   `anchor` = item id，live 与回放一致。
2. 回合在第一个 item 到达时打开（空回合在 `turn/completed` 时开合），不在 `turn/started` 时：live 与回放
   同一规则、origin 由第一个 item 推断（§7.5 原写 `turn/started` → `turn.start`）。
3. 用量：共享投影器只从 `assistant.message.usage` 记账（`context.usage` 被忽略），而 Codex 的
   `thread/tokenUsage/updated` 在回复结算之后才到。做法：有打开的回复就并入它的结算；否则发一条
   无块、非 canonical 的"仅用量" `assistant.message`（当前 step），不改任何行。历史不含用量，
   所以回合汇总行是 live 独有（live≡replay 登记差异）。
4. 审批选项按 `availableDecisions`（C0-D4），所有选项带官方文案（含"是，执行"与两种"否"）；
   文件改动的无理由拒绝 = `decline`（D10），文案"否，不应用这些改动，继续"（官方只有 cancel）。
5. MCP elicitation 在 N2（C2）之前以 `cancel` 应答并提示；`collabAgentToolCall` 在 C4 之前是普通卡片，
   `subAgentActivity` 走 `custom`（插件渲染接缝，默认不显示）；图片在 C3 之前拒收（明确报错）。
6. 中断无应答的强制收敛窗口 15 s（方案 `now` 写 ≤10 s，Claude 为 30 s）。
7. `thread/start` 没有 effort 参数：记住的 effort 经 `config.model_reasoning_effort` 传入。
8. C1 的检测不设 `loginInSession`（`/login` 在 C2）；中立层的字段与目录规则已就位并有回归。
9. 实测脚本自己用 backend 同样的设置加中转 `-c` 参数建 hub（`codexBackend.open` 在 C2 渠道之前没有
   provider 接缝），其后全部走后端自己的代码。
10. 目录（catalog）是 C3：C1 下 `--resume <id>` 可用，会话浏览器列表暂无 Codex 会话。

**门禁**（最终代码 `f747a827`）

- `pnpm install --frozen-lockfile`；`pnpm build`：compile + `verify:build` 90/90（含 `verify:codex-contract`
  15、`verify:boundary`、`verify:agent-domain`、`verify:claude-contract`、`verify:i18n` 2009 条）；
  `pnpm verify:package`（3015 文件）；`pnpm smoke`。
- `run-ci-group.mjs`（`DSH_TUI_LANG=zh`、`--jobs 4`，无一条靠串行重跑放行）：render-scroll 79/79、
  input-terminal 31/31、session-workspace 57/57、channel-ui 156/156（含 `verify-projection-golden`、
  `verify-dsh-translate`、全部 `verify-claude-*` 与新的 `verify-codex-*`）、flaky-observation 2/2。
- 新回归：`verify-codex-rpc` 30、`-hub` 37、`-translate` 117、`-live-replay` 23、`-input` 37、
  `-approvals` 45、`-chat` 52（80/40 列 × inline/fullscreen）、`-fake-app-server` 22、
  `verify-kernel-catalog` 10、`codex-fixture-sanitize --check` 21 个文件。
- 实测：`verify-codex-live` 12/12（3 回合）。
- 时序 flake（单独重跑通过，均与本分支改动无关的 DSH 面）：同机另一工作树在跑 CI 组时（负载 24/16 核），
  `verify:build` 里先后出现 `verify:adapter-descriptor`（C0）、`verify:btw`、`verify:rewind-edit`
  的单次失败，各自单独重跑 3/3 或 2/2 通过；`verify-compaction-progress` scene1（已知 flake）单独重跑
  1/3 通过、在最终一轮组跑中通过；`verify-session-browser`（已知）单独重跑通过。第一轮组跑未设
  `DSH_TUI_LANG=zh` 时 `verify-splash-eggs` 因语言失败，固定语言后通过。

**留给监督者**

- 共享投影器的中断行写死"接下来想让 DeepSeek 做什么？/ What should DeepSeek do instead?"（`interrupted-ask-next`），
  Claude 与 Codex 后端都显示 DeepSeek——是否改成按后端名插值（中立层改动，不在本期范围）。
- C0 补录（§10.2：错误/重试、MCP、web search、图片、elicitation、goal、review、后台终端）未做：它们服务
  C2–C4 的翻译测试，C1 的对应映射用合成通知覆盖。建议各期按需录制（预算内），还是现在一次补齐？
- `MIN_CODEX_VERSION = 0.144.0`（C0-D3）比方案退路宽；如要保守可改回 0.160.0。

## 评审修复（C0+C1，618abd1f 的评审）

已修（各带回归，抽查 #1/#2 在修复前的源码上确实失败）：#1 强制收敛后迟到的 item/delta/完成被丢弃
（`closedTurns`，`verify-codex-input`）；#2 用量报告不可见（R-D1，`verify-codex-translate`）；#3 `now` 先于
被中断丢弃的 steer（`verify-codex-input`）；#4 子 thread（`subAgentActivity.agentThreadId`、collab
`receiverThreadIds`）路由到父会话，审批带 `agentId`（`verify-codex-approvals`）；#5 审批命令只做无损
解包，否则显示原始命令（不再用 commandActions 片段）；#6 `writeStdin`、`networkApprovalContext`、
`additionalPermissions`、非会话 cwd 写进审批描述；#8 Windows npm shim 解析到原生 `codex.exe`
（`resolveNpmShim`，`verify-codex-rpc`）；#9 版本过旧单独的原因并带升级提示（`verify-kernel-catalog`）；
#10 录制脚本的控制台输出与未捕获错误经 `safe()` 脱敏。小项：fixture 检查器识别实时 key 字面值并清洗
`config/read` 层哈希（已重洗 `c0-files-delete-fork`）；`cli_auth_credentials_store = "auto"` 无
auth.json 判 `unknown`；重连 `thread/resume` 带与 open 相同的模式/模型覆盖；拒绝回退记为 `rejected`；
`turn/interrupt` 失败清 `cancelCause`；`bash -lc`、`-NoLogo`、带引号的 pwsh 路径可解包。
goldens 变化：两张卡片标题从错误的引号剥离改为正确脚本（`c0-files-delete-fork`、`s4-plan-question`）。

未修（留给后续）：#7 渠道 base URL 校验（拒绝含 userinfo、查询串、疑似 key 的路径段；凭据只经
`env_key`/`env_http_headers`；文档注明主机名在进程列表可见）——随 C2 的 `channels.ts` 一起做；共享 hub
的 debug/stderr/bubblewrap 只通知首个打开者（应扇出到所有会话）；`closeAllCodexHubs` 未接入退出漏斗。

门禁：`pnpm build` 除 `verify:transcript-images`、`verify:image-preview` 外全过——二者断言英文文案，
本机 `~/.dsh-tui/lang.json` 被设为 zh（非本分支所为），用干净 HOME 单跑均通过。

## Neutral layer N2–N6

分支 `feat/codex-neutral`（基于 483a550b），实现 [codex-backend-design.md](codex-backend-design.md)
§6 的 N2–N6：后端中立、DSH 与 Claude 行为不变（下列门禁证明）。每项一个提交，便于并入
`feat/codex-native`。Codex 后端本身、`src/backends/shared/`（N1）与内核注册（N7）不在此分支。

### 交付形状（给 Codex 后端的接法）

| # | 提交 | 形状与用法 |
| --- | --- | --- |
| N2 | `7c5f70ec` | `src/channel/elicitation.ts`（输入为 MCP 形状 `ElicitationRequestView {serverName, displayName?, title?, message?, requestedSchema?, url?}`，无厂商类型）：`createElicitationForm(req)` → `{questions, answer(answers)}`，`answer` 返回 `accept{content}` / `decline` / `reask{questions}`（只重问无效字段，标签在首问时固定）；`createElicitationUrlAsk(req)` → `{questions, accepted(answers)}`，无 URL 时为 `undefined`；`elicitationNotices.{urlOpen,urlComplete,urlMissing,unsupported}`；底层 `formFields`/`parseFieldText`/`fieldQuestion`/`fieldValue`/`serverHeader`。Claude 的 `dialogs.ts` 只保留挂起/撤回接线。i18n 键 `claude-elicit-*` 改名为中立的 `elicit-*`（文案不变；`verify-claude-dialogs` 只跟随键名）。Codex：`mcpServer/elicitation/request` 经此转 `question.request`，按 `accept/decline/cancel` 应答。 |
| N3 | `7496e290` | `QuestionItemView.secret?: true`：交互桥带入 store；问卷面板输入行按码点画 `•`（选项行打字、括号粘贴、CJK、光标编辑），提交原文；答卷记录对 `secret` 问题显示 `••••`（选项与文本都掩）。记录从问卷型 `tool.call` 参数里的问题对象读 `secret: true`；Codex 若为 `requestUserInput`（不入历史，F23）合成记录，参数问题对象带 `secret: true`，且事件里最好不放明文答案（投影会掩码，但 `/trace` 能看到原始事件）。 |
| N4 | `459aaa82` | 新事件 `{type:'tool.output'; callId; text; time; parentCallId?}`（追加片段）。投影器在运行中的工具行上维护 `liveOutput`（最后 200 行 / 16 KiB，按 UTF-16 码元计）与 `liveOutputDropped`（从头部丢掉的整行数）；`tool.result` 到达即删除这两个键（从未输出的卡片形状不变，DSH 黄金基线不动）；未知/已落定/被窗口折叠/子代理 lane/问卷型调用一律忽略。运行中的卡片在 Running 行下渲染最新 5 行（全屏 8 行，展开时为整条保留尾部），dim，有更早的行时首行 `… N 行省略`；ANSI/OSC 剥离、`\r` 进度取最后状态、制表符转空格、按显示单元截断成一行。实时行不受 3 行折叠与平滑揭示影响。DSH/Claude 翻译器声明“可选未用”（`verify:agent-domain` 断言）；轨迹折叠直接消费不出行。后端应以 `wake:'frame'` 发出、每个 call ≤10 Hz。 |
| N5 | `55b0c119` | `ToolFileDiff` = `{path, oldText, newText}` \| `{path, patch, change?, movePath?}`。patch 分支（`src/components/diffPatch.ts`）用 `JsDiff.parsePatch`（缺文件头时补 `--- a/<path>`/`+++ b/<path>`）；hunk 计数与头不符时 jsdiff 会抛错，退回宽松逐行解析；`add`/`delete` 的原文内容（无 `@@`）当作整段新增/删除；完全读不出的保留原样行。unified 卡：单文件首行 `(+N -M)` 统计行，多文件为可点击路径行（移动 `a → b`、新文件/已删除标签）加统计；每行带真实行号（删除行用旧号，其余用新号），hunk 间 `⋯`。双栏视图逐栏显示各自行号。Codex：`update` → `{path, patch, change:'update', movePath?}`。 |
| N6 | `e4a95ae3` | `ChannelGoal.budget?: {tokensUsed, tokenBudget: number\|null, timeUsedSeconds}`：目标面板、页脚芯片（`12.3k/50k`）与状态行目标段显示 `已用 12.3k / 50k tokens · 4m`（en `Used 12.3k / 50k tokens · 4m`）替代轮次。新能力 `goals?: {set(objective, {tokenBudget?}), pause(), resume(), clear()}`；声明它的会话获得随行命令 `/goal`（`BACKEND_GOAL_COMMAND`，同 `/permission`、`/channel`）与核心宿主 `backendGoals()`；语法见 `src/channel/goal-command.ts`（`/goal`、`/goal <目标>`、`--budget 50k`/`--tokens=1.5m`、`edit`、整句 `pause`/`resume`/`clear`）。DSH 的 `/goal` 仍是 `dsh-command-goal` 注册表行（先判定，路由不变）。 |

### 偏离 §6 形状之处（均为超集或细化）

- N2：除纯函数外还导出表单/URL 流程对象（`createElicitationForm`、`createElicitationUrlAsk`），
  让两个后端的挂起逻辑只剩接线；i18n 键改名为中立前缀。
- N4：16 KiB 以 UTF-16 码元计（不是 UTF-8 字节）；展开（Ctrl+O/点击）时显示整条保留尾部；任何
  有输出的运行中卡片都显示实时行（双栏 diff 除外），不限终端卡；`MessageList` 增加 `fullscreen`
  属性并把实时行数计入行高签名（尾部填满窗口后签名饱和，不再触发重测）。
- N5：单文件 patch 也显示 `(+N -M)`（独立统计行，路径已在卡片标题里）；增加宽松解析与原文
  add/delete 的兜底。
- N6：`ChannelCapabilities` 新增 `goals` 标志、`ChannelUi` 新增 `backendGoals()` 宿主（与
  `backendModes`/`backendMcp` 同型）；语法增加 `--budget`/`--tokens` 与 `edit`。**唯一的用户可见
  变化**：Claude 会话输入 `/goal` 现在提示“在 Claude 内核下不可用”且不发给 CLI（原先作为文本
  透传）；`docs/claude-backend{,.en}.md` 已同步。§5.15 写的“需 N5 的预算字段 / goals 能力（N5）”
  实为 N6。

### 渲染与性能

- `scripts/perf-tool-live-output.tsx`（不进 CI）：全屏 100×40，200 行历史 + 50 张已落定工具卡，
  一张运行中终端卡以 10 Hz 收 60 片输出。帧耗时 p50 0.91→1.00 ms（对照组为只走 1 s 耗时 tick），
  每帧 yoga 测量调用 +11%；每片帧耗时前 10 片 ≈4.7 ms、后 10 片 ≈3.5–5.6 ms（噪声内持平，不随
  累计输出增长）。只有运行中那张卡的 memo 属性变化，其余行不重渲。尾部追加 20k 次共 ≈107 ms
  （≈5 µs/次）。
- N5 旧分支：在 N4 提交与 N5 提交上各截取 72 帧（40/80/120 列 × unified/split/auto × 折叠/展开，
  含多文件、CJK、超长行），逐字节相同。

### 门禁（HEAD `e4a95ae3`）

- `pnpm build`：编译 + `verify:build` 89/89；`pnpm verify:package`（2952 文件、30 个入口目标）与
  `pnpm smoke` 通过。
- `scripts/run-ci-group.mjs` 全部组（本地 `--jobs 4`，并行红的条目由运行器串行复跑）：
  render-scroll 81/81、input-terminal 31/31、session-workspace 57/57、channel-ui 149/149、
  flaky-observation 2/2。首轮未设 `DSH_TUI_LANG=zh`（CI 测试 job 会设）时，
  `verify-splash-eggs`、`verify-activity-store` 因一次性 HOME 回落英文而失败，带 CI 环境重跑通过；
  `verify-guide` 抓到 `guide/` 副本未同步（已 `node scripts/build-guide.mjs` 并入 N6）。
  串行复跑转绿的 CPU 争用条目：`verify-unseen-report-once`（基线 483a550b 同样在 8 路并发下 8/8
  失败、串行 5/5 通过）、`verify-smooth-reveal`、`repro-idle-oscillation`、
  `verify-scroll-jumps-narrow`、`verify-todo-side-panel`、`verify-docked-queue`、
  `verify-jobs-side-panel`、`verify-trajectory-source-states`；已知时序 flake
  `verify-compaction-progress` scene6 单独重跑通过。
- `verify:projection-golden`（5 个黄金基线、83 行，fixture 未改动）、`verify-dsh-translate`
  （168 live / 162 replay）、`verify:agent-domain`（18）、`verify:claude-contract`（16）、
  全部 22 个 `verify-claude-*`（假 SDK）通过。
- 新增聚焦回归：`verify-elicitation` 41、`verify-question-secret` 19（channel-ui）、
  `verify-tool-live-output` 68、`verify-diff-patch` 49（render-scroll）、`verify-goal-budget` 39
  （channel-ui）。未做真实终端手动演练（无交互 TTY）；inline/fullscreen 与 80/40 列由无头
  Chat 场景覆盖。

  Chat 场景覆盖。

## 方案评审（交接前，HEAD `93457fb7` 之后）

监督方按"原生体验第一、复用、低维护"复审了技术方案，修订已就地写进 `codex-backend-design.md`
（标注 **评审修订**），未改代码。会影响后续实现的决定：

| # | 决策 | 理由 |
| --- | --- | --- |
| DR-1 | **N8 取代 R-D1**：用量改走独立的只记账事件 `usage`（N8a），并让投影器把 `context.usage` 当作后端占用读数、优先于计费样本（N8b）。C2 第一项把 `assistant.message.usageOnly` 迁过去 | 领域事件是所有后端共用的契约；"一条不是消息的消息"迫使每个 `assistant.message` 消费者特判。三个翻译器都不发 `context.usage`，N8b 对 DSH/Claude 零影响 |
| DR-2 | N9：可选 `init` 能力；`/init` 不做后端命令 | 本地 `/init` 名字优先，后端命令永远到不了；Claude 也能借此恢复 `/init` |
| DR-3 | Shift+Tab 只切换 Plan（`cycle() = [当前权限档, 'plan']`），权限档走 `/permission` | 官方 `cycle_collaboration_mode` 语义；权限档与协作模式是两个正交维度 |
| DR-4 | 上下文占用按官方公式：`last.totalTokens`，百分比扣 12000 基线 | 与官方 TUI 同时显示同一数字（`codex-rs/tui/src/token_usage.rs`） |
| DR-5 | 默认设置优先级：dsh-tui prefs > 用户 `config.toml` > 内置默认（权限档 `auto`） | 不覆盖用户配置 |
| DR-6 | hub 路由兜底：未知 thread 经 `thread/read` 查父链归到根会话，查询期间缓冲（含服务端请求） | 不依赖 `subAgentActivity` 先到；多层子代理 |
| DR-7 | 事件流不变量检查器跑全部后端 fixture | 抓"幽灵回合"一类顺序缺陷 |
| DR-8 | rewind 坚持 `thread/fork{lastTurnId}` | `beforeTurnId` 只在实验类型里（0.144.0/0.160.1 稳定类型都没有） |
| DR-9 | 渠道 URL 校验；评估 `thread/start.config` 承载 provider | `-c` 参数在进程列表可见 |

## 本机续作 C2-C4（2026-10-07）

基线 `02141231`，独立工作树 `D:/code/projects/.worktrees/dsh-tui-codex-native`，分支仍为
`feat/codex-native`。本轮未 commit、push 或开 PR；共享主仓 main 和原有私有技能文件未修改。
维护者明确要求扩大并行与 xhigh 后，5 个独立工作树子代理分域实施和审查，没有子代理再派代理。

### 功能实现

- C2：N8 独立 usage 事件替代 usageOnly，复用记账和 seq 去重，不建行、不改行、不进入 trace/导出；
  占用优先级为 DSH projection > backend context.usage > billing sample。N9 init 接 Codex 官方
  提示词和 Claude 原生 /init，DSH 模板仍由扩展拥有。全部 fixture 事件流不变量已接入 CI。
- hub 诊断广播、晚 attach 快照和 bubblewrap 汇总；退出漏斗关闭已加载 pool，DSH-only 不因此加载
  Codex。未知 child 经 thread/read 父链路由，审批随通知缓冲。Windows npm shim 直达真实 exe。
- 100ms 命令输出合帧、真实 patch 行号、secret/自动问卷、共用 MCP form/URL elicitation、计划评审
  三分支。修复表单重问后 serverRequest/resolved 不结算面板，以及普通模型/effort 改动误重写
  collaboration instructions、pending 重复覆盖、旧 server 拒收 Plan 字段污染下一回合。
- models/effort、正交 Plan/权限、compact/context/account/MCP、review/diff/plan/usage/skills、
  /init 全接通。Shift+Tab 只开关 Plan，full-access 只经显式选择。12k context 公式采用原生 last。
- auth：第一方路由、JWT 声明、CAS/8s AbortSignal、三种 /login、URL 保存/启动双校验、令牌独立
  存储。外部 AuthBridge 已加载后失败不假称 native 恢复；启动已观测失败才切不同指纹的干净 hub。
  /logout 只清 dsh-auth 存储，不调用原生 account/logout，已缓存托管令牌正常重启后停止使用。
- C3：原生目录最多 500 项、跨 provider/项目、摘要预览、改名/归档文案；初始 full20 回合、同步
  older/record 与一页预取。summary 不抹完整工具内容，history 有界；fork/rewind 仅用稳定
  lastTurnId，原始首回合建空 thread，文件回退明确拒绝，未就绪前页不误判首回合。颜色最多200项。
- 图片：20MiB/张、20张/条、50MiB/条、2048边/2048²，发送 data URL，live/replay 同源惰性 facade；
  缺文件占位，MCP、view/generation 图片也接入。传输96Mi码元容纳合法base64消息，完整行超限也拦。
- 独立审查 R1 已修：临时断线保留原工具卡、attempt 和正文，不虚构执行失败；恢复按 item 阶段补缺，
  已显示行和用量不重复。full20 页沿原生 cursor 回补到已知边界，最多50页/1000回合；active先恢复
  输入turn再放队列。超预算/cursor循环明确警告只读，不假报成功。48项有坏基线反证。
- C4：子代理 lane、父链验权、按需历史/opaque sourceCursor、interrupt、父模型send_input转达；
  请求 model/prompt/nickname 同卡更新，不宣称实际执行模型。父子同callId输出按lane分开并100ms合帧。
- 后台终端仅inventory非空时2s轮询，UTF-8尾部64KiB、100ms输出合帧；原生terminate确认才停止，
  自然消失注明退出状态未知，不编造exitCode。目标预算/状态、hook通知/hookPrompt、活动自述、
  30s等待/120s提示、btw/recap只读ephemeral已接。独立审查 R2 owner dispose/reset旁问泄漏、
  迟到fork/start清理，以及MCP/webSearch被误报模型stalled均修复并有75项回归。
- 主题仅CODEX/Codex标题；原配色、宠物、字体尺寸与布局不变。中断文案按后端和当前语言呈现，
  DSH行结构/文案逐字节不变。双语用户说明、README、架构/贡献说明和20篇guide已同步。

### 验证账本

- 冻结源码 `DSH_TUI_VERIFY_JOBS=4 pnpm build`：编译和90/90构建门禁通过；boundary、i18n、
  manifest/协议、DSH/Claude契约、固定窗和全部渲染门禁通过。
- 最终 `run-ci-group channel-ui --jobs 4`：177/177全通过，包含全部DSH/Claude/Codex回归。
  初轮175项里whale-girl首帧观察并行红、串行绿；最终冻结轮不靠复跑放行。
- input-terminal 31/31；render-scroll 初轮80/81，K3通用too-old判定误伤Claude，限制为Codex后
  verify-launchpad 314/314 单独通过，其余80项已通过。
- session-workspace 53/57；4项在shared main既有源码/产物与隔离HOME下复现完全相同失败：
  handoff-atomic Windows/POSIX信号假设；update-extract python3 exit9009；update-checksum Linux
  tar夹具与Windows zip/exe资产错配；standalone-cache-guard POSIX chmod/stat假设。3 owner源、
  2产物hash相同，4 probes相对基线无diff，未扩scope修改更新器。
- Codex聚焦：rpc47、hub55、translate157、live/replay43、input41、approvals52、chat52、auth92、
  live-guard17（不收费）、controls97、plans25、advanced30、catalog/history27、lifecycle47、
  images21、subagents23、child-output9、side-query75、reconnect48、chat-controls108。
- 事件不变量86条流/2272事件及变异反证通过；DSH5份黄金基线/83行未改。
- verify:package 3080文件/30入口目标；pnpm smoke、20篇guide同步验证通过。本地tarball仅在.local，
  未发布。正式profile组合dump-config通过，使用独立DSH_HOME和工作树Junction，不迁用户主profile。
- 官方Windows Codex0.160.1包经官方SHA256校验，verify-codex-offline 9项通过：隔离HOME握手、
  创建、目录、原始context0、权限/Plan、改名、ephemeralfork、full页恢复。无turn/start、不收费。
  本轮真实模型回合0，真实ChatGPT/设备码/API-key和物理终端仍未测。
- 独立perf-tool-live-output：200对话行+50工具卡，全屏100x40/10Hz/60片。无输出p50/p95
  0.37/0.55ms；实时0.38/0.74ms、max1.86ms；前10片均值1.67ms/后10片1.14ms，成本不随累计
  输出上升。此为本机无头renderer探针，不替代真实终端基准。

### 偏离和未测边界

- provider保留已证实-c；thread/start.config可临时覆写，但跨进程provider定义恢复/官方互通无凭据
  实测证明，未贸然换路径。argv主机名可见的限制已写文档。
- 临时connectionLost不虚构interrupted比原设计更保真，旧input回归改为真实full-items恢复快照。
  sourceCursor是必要的小中立增量，不伪造Codex总记录数，旧数字页后端缺省不变。
- 本机CODEX_TEST_BASE_URL/CODEX_TEST_API_KEY未设置，没有可交互TTY。真实OAuth originator、device
  flow、API-key持久化、带凭据文本/视觉/子代理/终端/goal/旁问回合未执行。正式live走backend.open，
  缺凭据明确skipped，不当作live通过；成本/隔离入口17项守卫通过。
- tarball独立profile安装因registry TLS/metadata fetch反覆失败取消，不绕过TLS、不改全局环境。
  离线独立profile解析使用已有本机依赖；用户正在运行的TUI未终止、重启或换轨。
  真实入口无TTY探针只完成配置解析，交互启动未验证；本轮启动的诊断进程已停止，不算TTY通过。
- 施工期间profile帮助命令意外初始化空codex-native-check；核空依赖/绝对路径/无链接后已删除，
  没有读取或改动个人凭据。构建在Windows Node24.13遗留的本轮preset探针目录已按绝对路径清理。

## dst 验收部署与授权上传（2026-10-07）

维护者后续授权构建、让 dst 直接使用并上传分支，验证后再合并。

- pnpm build 编译和90项构建门禁再次通过。dst profile 包 Junction 改指 Codex 工作树，
  sync-profile --check 对比5501文件零差异；dst --backend codex --dump-config 通过。
- 本机委托启动器增加本地已校验0.160.1 binary回落，显式CODEX_EXECUTABLE优先；默认内核记忆改为
  codex。启动器、原链接目标和原内核记忆备份仅在.local，不进入Git。
- 当前TUI不重启、不终止。新终端运行dst即可验收，或显式dst --backend codex。
- 上传仅推feat/codex-native，不推main、不发npm、不打tag、不开PR、不合并。
- 核心完成不代表全部原生字段消费。尚缺serviceTier/输入模态、终端PID/CPU/RSS/cwd详情、MCP详细
  清单/认证、instructionSources、独立推理tokens/支出状态、命名权限档、归档浏览/取消归档。
  真实凭据和交互TTY仍需维护者验收。

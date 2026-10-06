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

**门禁**（见下方门禁记录）

**留给监督者**

- 共享投影器的中断行写死"接下来想让 DeepSeek 做什么？/ What should DeepSeek do instead?"（`interrupted-ask-next`），
  Claude 与 Codex 后端都显示 DeepSeek——是否改成按后端名插值（中立层改动，不在本期范围）。
- `verify:build` 在另一个工作树同时跑 CI 组时（负载 24/16 核）出现过两个不同的时序失败
  （`verify:btw`、`verify:rewind-edit`、C0 时 `verify:adapter-descriptor`），单独重跑均 3/3 通过。

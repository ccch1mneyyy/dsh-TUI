# 会话持久化与上下文

本文覆盖三块：resume 契约与多会话管理（resume.txt、/resume 选择器、MRU）、
会话持久化后端（JSONL/SQLite 文档冲突）、已加载上下文与 teardown 分流
（issue #12）。行号均以审计基线 b2f4087 为准。

## resume 契约

契约总述（`src/sessionHistory.ts:1-9`）：TUI 把选中的会话 id 写入
`~/.dsh-cc/resume.txt`，launcher 以 `DSH_CC_RESUME_SESSION` 环境变量回喂；
**会话记录本体在 DSH 持久化后端（dsh-session-persistence-jsonl），resume.txt
只跨进程携带 id**。

```text
退出（onUserExit，src/plugin.ts:199）与 /resume 选择（src/channel.ts:1449）时
  writeResumeTarget(sessionId) 写 ~/.dsh-cc/resume.txt（src/sessionHistory.ts:36-39，
  原样写入无换行）
  /new 时 clearResumeTarget() 写空串清空 marker（src/channel.ts:1568；
  src/sessionHistory.ts:42-48）
  -> Windows：dsh-cc.cmd --resume 读 %USERPROFILE%\.dsh-cc\resume.txt，
     set /p 注入 DSH_CC_RESUME_SESSION（dsh-cc.cmd:29-32），其余参数透传
     @dsh --profile cc-tui（:40）
  -> cordis.yml:27 与 cordis.patch.yml:203：cc-tui 行
     sessionId: !!js process.env.DSH_CC_RESUME_SESSION ?? undefined
  -> src/plugin.ts:131-138：apply 把 config.sessionId 传给 resolveAgent
  -> src/plugin.ts:365-398：ctx.agents.resume（preset 取目标日志、路由只允许完整
     钉覆盖，见 [model-route.md](model-route.md)）；artifact 缺失或后端未挂载
     降级为新建会话
```

退出提示的 resume 命令（src/plugin.ts:477-489）：win32 为 `dsh-cc --resume <id>`，
其他平台为 `DSH_CC_RESUME_SESSION=<id> dsh --profile <p>`；包本身不提供
dsh-cc bin。

## /resume 选择器与 MRU

```text
/resume -> channel.listSessions()（src/channel.ts:1854-1918）：
  sessionPersistence.list() 取全部头
  -> 按 cwd 精确隔离（"Claude Code 的项目维度"：只列本会话目录启动的会话）
  -> readLastUsed() 取 last-used.json 做 MRU 排序（updatedAt 回退 createdAt；
     "DSH session headers carry only createdAt"，故需自维护）
  -> 前 20 条 load 全文取首个 user/message 作标题；无 user/message 的
     launch artifact 从选择器剔除
  -> 排除当前会话（agents.resume 拒绝 live session）；空则通知
     resume-none-in-cwd
  -> 回车 -> channel.resumeTo(session.id)（src/screens/Chat.tsx:954-965，成功 notify
     'Session resumed'）
  -> resumeTo（src/channel.ts:1349-1455）：拒绝 working 中 -> composePreset
     (resolvePersistedPreset) 按目标日志组合 -> agents.resume ->
     coalesceReplayEvents 重放 -> writeResumeTarget(sessionId)（刷新
     resume.txt）-> touchSession(sessionId)（更新 MRU）
```

touchSession 触发点（全部改变活跃会话的路径，channel.ts 注释 "The current
session is being used — move it to the MRU front (/resume sorts by
last-used)"）：submit(1151)、steer(1160)、interruptAndDeliver 重排队(1206)、
rewindTo fork(1344)、resumeTo(1451)、newSession(1570)、switchModel fork(1674)。
实现（src/sessionHistory.ts:91-99）：readLastUsed() 合并后写回
`{…lastUsed, [sessionId]: Date.now()}` 到 ~/.dsh-cc/last-used.json，
best-effort 永不抛。

## 会话持久化后端与 JSONL/SQLite 文档冲突

### 配置侧（当前代码实况，均 explicit evidence）

- `cordis.patch.yml:143-149`：profile 组合只有一条 session-persistence-jsonl
  覆盖行——"Sessions live in the shared JSONL store (~/.dsh/sessions) — the
  same backend dsh web writes — so /resume here and the web session list see
  each other (#24)"；root 默认 `dshHomePath('sessions')`，注释称该行来自
  dsh-base 层、本 override 只在设 DSH_CC_SESSION_ROOT 时改 root（测试隔离）。
  **整份 patch 无 SQLite 行、无"禁用 JSONL"行**。
- `cordis.yml:158-164`：裸组合同样挂 `@deepseek-ai/dsh-session-persistence-jsonl`，
  root 默认 `(USERPROFILE ?? HOME)/.dsh-cc/sessions`（:164）。
- `scripts/migrate-sessions-to-jsonl.mts:1-16`：一次性迁移（#24），把
  "retired cc-tui SQLite store"（~/.dsh-cc/sessions.sqlite）复制进共享 JSONL
  库（默认 $DSH_HOME/sessions ?? ~/.dsh/sessions），源文件不动、幂等可重跑。
- 提交 43f271f（#37/#24）：patch 层此前自插 sqlite 并禁用 base JSONL，本次
  "删掉禁用行和 sqlite 插入行，让 base 层的 session-persistence-jsonl 生效"；
  9017204 确认 bundle 层从 dsh-base 继承该行。
- `package.json:92-93`：jsonl 与 sqlite 两个后端依赖都在 devDependencies
  （sqlite 仅为迁移脚本服务）。
- `scripts/run.ts:196` 注释残留 "inserts cc-tui front door + SQLite"（与
  patch 实际内容不符的陈旧注释）。

### 文档侧（旧表述）

| 文档 | 声称 |
| --- | --- |
| `docs/configuration.md:154-162` | Profile 使用本包的 SQLite `sessions` 行，并禁用 base 的 JSONL 持久化（避免双写入所有者）；默认文件为 ~/.dsh-cc/sessions.sqlite；裸 cordis.yml 用 JSONL 默认 ~/.dsh-cc/sessions/；两种启动方式不要混用同一数据目录 |
| `docs/configuration.md:139` | DSH_CC_SESSION_ROOT 在 profile 安装时是 SQLite 数据库路径，裸 cordis.yml 时是 JSONL 根目录 |
| `docs/architecture.md:77,85-86` | 持久化表列 ~/.dsh-cc/sessions.sqlite 为 profile patch 默认；DSH_CC_SESSION_ROOT 改写 SQLite 路径 |
| `docs/getting-started.md:71` | patch 覆盖或插入"SQLite 会话持久化" |

### 判定与未决点

以当前配置为准：**两处组合（cordis.yml 与 cordis.patch.yml）都是 JSONL，
SQLite 声称标为「文档冲突/待确认」**。文档描述的是 43f271f（#37）之前的
状态。无法仅凭本仓库确证的点：

- dsh-base 层最终组合中是否存在 SQLite 行（base 层内容在 node_modules，
  未安装不可读；patch 语义是整行覆盖，覆盖后是否双重挂载取决于 dsh Loader
  的规则）。
- DSH_CC_SESSION_ROOT 的文档语义（SQLite 路径）与两处实现（JSONL root 覆盖）
  直接冲突——实现侧一致性明确。

## 输入命令历史

`src/history.ts` 管理的是**输入命令历史**（与会话历史无关）：
`~/.dsh-cc/history.jsonl`，每行一个 {text, ts} JSON（:6-14）；appendHistory
追加、去重相邻重复项（CC 行为：重复提交只推进时间戳）、slice(-200) 截断
（HISTORY_LIMIT=200，:45-68）；loadHistory 返回倒序（最新在前，:70-85）供
Ctrl+R 搜索框（见 [input-commands.md](input-commands.md#ctrlr-历史搜索)）；
historyEntryId 用 sha1(text) 前 12 位做 React key。写入点全部在 PromptInput
五条发送路径（submit/steer/queue/interrupt/slash，:238/263/281/327/351）。

## 已加载上下文

### 快照组装

LoadedContext 快照含五组（src/channel.ts:226-244 注释 "Snapshot of everything a
fresh conversation for the current agent will load"）：有序系统提示词分段
sections、动态上下文 contexts、工作区指令文件 files（AGENTS.md 家族）、技能
skills、工具 tools。`Channel.loadedContext` "computed at boot and on every
agent swap"（src/channel.ts:320-327），快照未组装好时为 undefined，面板保持隐藏。

```text
refreshLoadedContext（src/channel.ts:2165-2218）：
  systemPrompt.assemble(assembleContextFor(target)) 产出 sections/contexts/tools
    （src/channel.ts:2175）；每个 section 经 renderPrompt 严格插值渲染并 "keeping non-empty
    results"（src/channel.ts:2180-2192）
  -> 动态上下文来自 renderContextSections(assembly)（src/channel.ts:2189-2192，上游
     dsh-system-prompt 组装产物，非 TUI 直接查工具注册表）
  -> files 来自 @deepseek-ai/dsh-agent-instructions 的
     discoverBaselineInstructionFiles({cwd})，只取 displayPath（src/channel.ts:2194-2196）
  -> skills 经 serviceForAgent(ctx, target, 'skills') 按 agent 作用域链读取
     （preset 层注册的技能也能解析，src/channel.ts:2201-2210）
  -> 竞态防护：每个异步来源完成后检查 if (target !== agent) return，为旧
     agent 计算的快照被丢弃（src/channel.ts:2176,2195,2206,2212-2215）；总失败仅
     logger.warn，面板不显示坏快照
```

触发点：createChannel 末尾（src/channel.ts:2244）+ rewindTo(1342) / resumeTo(1447) /
newSession(1567) / switchModel(1672) 四个 agent 交换路径。

### 启动面板与 `/context`

- 启动面板仅在 `channel.rows.length === 0 && channel.loadedContext !==
  undefined` 时显示；默认折叠为一行摘要，Ctrl+P 展开/收起分组明细，
  首条转录行接管后整个面板消失。
- `/context` 每次执行都通过 `channel.pushLocal` 向当前转录输出一次本地报告；它不切换
  常驻状态，也不进入模型上下文或会话事件。Ctrl+T 始终只打开会话轨迹，Ctrl+P 只在
  启动面板在屏时生效。
- 单条文本上限 800 字符（src/utils/loaded-context.ts:5，CONTEXT_ENTRY_MAX_CHARS）；
  truncateContextText 只保留头部并追加截断标记，注释明确 "model-visible
  text is the source of truth"，本地报告只约束自身渲染，模型实际收到的内容不受影响；
  工具描述单独按 160 字符截断。
- summarizeLoadedContext 只把非空组拼接为一行摘要，全部为空时返回 '' 使
  面板整体隐藏（src/utils/loaded-context.ts:26-34）。

### 上下文传给 agent 的路径

deliverUserText（src/channel.ts:927-961）：sendChain FIFO → expandMentions 展开
@ 引用为附件块 → createUserMessage({content: blocks, source: {kind:'user'}})
（typed text 恒为第一块）→ agent.followup(message)（followup）或
agent.steer(message)（steer）。TUI 与 dsh-mcp-client 之间没有直接消息通道
（src/channel.ts:1988-2018：MCP 工具以 `mcp__<server>__<tool>` 公开名出现在工具运行时，
/mcp 状态按 server 分组列出）——上下文经 agent 组装，面板只是只读快照。

### 上下文低量警告

每会话一次（contextWarned 闩），剩余 < 20_000 tokens 时通知 "Context low
(X% remaining) · Run /clear or start a new session"（src/channel.ts:788-789,
884-899，CONTEXT_WARNING_BUFFER_TOKENS = 20_000）。

## teardown 与退出分流（issue #12）

根因（提交 3f0aa69）：DSH launcher 启动后必有一次整树 recompose，插件上下文
的 ctx.effect 清理触发 instance.unmount() → waitUntilExit() 结算 →
handleExit → disposeRootAndExit(ctx, 0)，进程 exit 0——"闪退回 bash"。

| 路径 | 行为 | 位置 |
| --- | --- | --- |
| cordis 上下文 teardown（launcher recompose） | `ctx.effect(() => () => { funnel.markTeardown(); instance?.unmount() })`——只卸载 UI 不退出进程，recompose 后 loader 重跑 apply/render 重挂 TUI；不写 resume marker、不 disposeRootAndExit | src/plugin.ts:320-323 |
| 用户退出（/exit、双击 Ctrl+C/Ctrl+D） | onUserExit（src/plugin.ts:193-263）：writeResumeTarget(channel.agentId) 写 resume.txt → instance?.unmount()（恢复终端光标/raw 模式/鼠标追踪 + 换行避免提示符重叠）→ 出错 disposeRootAndExit(ctx,1) + stderr "cc-tui crashed"；正常打印 resume 提示后 disposeRootAndExit(ctx,0) | src/plugin.ts:172-180 注释 "Teardown only unmounts the UI; user exit runs the full leave sequence"、"the two must not share a fate (issue #12)" |

createExitFunnel 实现（src/plugin.ts:450-467）：teardown 标志使 handleExit 早退，
exited 闩保证 onUserExit 只跑一次；"Exported for scripts/verify-teardown-exit.tsx"。
disposeRootAndThen（src/plugin.ts:497-510）：ctx.root.fiber.dispose() 整树回收，5 秒兜底
定时器（unref）保证退出码不卡死。

Ctrl+C/Ctrl+D 语义（src/screens/Chat.tsx:1178-1192）：工作中→channel.cancel()；空闲且
有文本→仅清空输入并撤销退出臂；空输入→requestExit()（双按 3 秒窗口，
:221-245 "first press arms an exit, second press exits"）；Ctrl+D 不论输入
直接走双按退出。Ink 以 exitOnCtrlC: false 启动（src/plugin.ts:303）——Ctrl+C
完全由 TUI 自处理（Windows ConPTY 下 Ctrl+C 以 stdin 数据到达，无 SIGINT）。
/exit 本地命令直接调 onExit()（src/screens/Chat.tsx:519-521）。

回归：scripts/verify-teardown-exit.tsx 4 条断言（teardown 不触发 onUserExit、
teardown 吞错误路径、普通 handleExit 恰好一次、handleExit(error) 转发错误），
挂 CI（.github/workflows/ci.yml:40-41）。

## 冲突

| 项 | 两侧 |
| --- | --- |
| JSONL vs SQLite 会话后端 | 见上文「会话持久化后端与 JSONL/SQLite 文档冲突」——配置侧全为 JSONL，文档侧全为 SQLite 声称，以配置为准标为「文档冲突/待确认」 |
| 注入上下文展示口径 | docs/architecture.md:107 与 README.md:186 称"注入到 system prompt 的插件上下文不会在 UI 中单独列出"；src/components/LoadedContextPanel.tsx:82-88 实际渲染 context.contexts 为独立 Group（"运行时上下文"）——精确事实：面板有空转录时展示运行时上下文组，但转录内注入消息仍不显示 |
| /doctor 存储路径不符 | src/channel.ts:2118-2119 检查 ~/.dsh-cc/sessions；实际 JSONL 根为 dshHomePath('sessions')（~/.dsh/sessions，cordis.patch.yml:149） |
| index.ts 注释过时 | src/index.ts:2-3,84 注释声称实现位于 ./plugin.tsx；仓库无此文件，实现实际在 src/plugin.ts（React.createElement，纯 TS） |
| resume 读写 API 未形成内部回路 | Channel.setResumeTarget（src/channel.ts:421-423,1919-1921）与 readResumeTarget（src/sessionHistory.ts:54-61）在仓库内无生产调用者——回路由 dsh-cc.cmd 直接读文件完成 |

## 未验证事项

- profile 最终组合中是否存在 SQLite 行（dsh-base 层在 node_modules，无法读取
  核验）；"禁用 base 的 JSONL 持久化"的最终组合效果取决于 dsh Loader 覆盖
  规则。
- dsh-session-persistence-jsonl 的物理编码细节（zstd、packed chunk runs 等，
  仅能从 migrate 脚本注释间接得知）。
- LoadedContextPanel 的 tools 组是否包含 MCP 工具（mcp__server__tool）——取
  决于上游 dsh-agent/dsh-system-prompt 组装。
- teardown 时 MCP 子进程/其他服务的回收方式（teardown 路径只 markTeardown+
  unmount，子进程生命周期归上游服务）。
- waitUntilExit 结算的精确 microtask 时序。
- ~/.pi/agent/working-activity.json 的实际格式与 pi 扩展行为（activityPrefs.ts
  注释称 mirroring 其 frames key，pi 扩展不在本仓库）。

相关文档：[lifecycle.md](lifecycle.md)（退出漏斗）、
[model-route.md](model-route.md)（resume 路由跟随）、
[input-commands.md](input-commands.md)（/resume、/new 命令）、
[unknowns.md](unknowns.md)（未验证清单）。

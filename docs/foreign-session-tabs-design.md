# dsh-tui 会话屏「外部来源」标签页 + 迁移源重构：详细设计

- 日期：2026-09-26
- 状态：已实现，合为一个 PR（ccch1mneyyy/dsh-TUI#1066）。评审后按维护者要求收窄了浏览层：去掉 catalog 与快照、Channel API 由 5 个方法收为 3 个、外部格式知识只留在 migrate 内部、打开 `/resume` 不再做外部 IO（§2、§5、§8.4，见 §12）。实现中的其余偏离已写回 §2–§8
- 范围：`src/dsh-adapter/migrate/`（四个源的解析重构）、会话屏（`/resume` / `/agentview` / `/home`）新增外部来源标签页
- 参考：dsh-chat-import（DSH 插件，同样做外部会话导入）的格式处理。本文只借鉴规则，**不依赖**该插件——用户不一定装了它

---

## 0. 目标与非目标

### 目标
1. **会话屏右上角加来源标签页**：固定第一个是 `DSH`，其后是本机**确实有数据**的外部来源，按各来源最近消息时间降序排列。
2. **浏览外部会话**：切到某个来源后，左栏按工作目录分组，右栏列出会话，交互与 DSH 会话列表一致（鼠标、键盘、搜索）。
3. **选中即开始**：选中外部会话时，导入这一个会话，然后直接跳转进去继续对话。
4. **重构四个源**（claude-code / codex / zcode / grok-build）：参考 dsh-chat-import 的格式处理精度，全部在 TUI 内实现。**`/migrate` 和标签页两个入口统一使用新解析**，工具调用照常迁移（理由见 §1）。

### 非目标
- **OMP**：本期不动。解析逻辑保持现状，只做让它接入 sessionize v2 的机械适配（§4.3），也不在标签页里出现。导入结果唯一的变化来自 sessionize v2 对所有源统一补的空 system head（§6）。
- 双向同步、增量续写，以及行级状态（「已导入」「源有更新」）。
- 改动 `/migrate` 的交互（选择器、确认层、子进程编排）和 `dsh-tui migrate` CLI 的参数与输出格式。两者只会被动受益于解析质量的提升。
- 为导入会话提供「重新导入 / 刷新」的入口。

### 已接受的限制
同一个外部会话导入后，如果在源 agent 里继续聊了，之后再点它，打开的仍是**首次导入时的快照**。这是确定性 id 去重的必然结果，本期不处理。

---

## 1. 为什么迁移工具调用

`docs/migrate.md` 现在的契约是「不迁移工具调用流量」，理由是「源格式不可忠实回放」。这个前提对 claude-code、codex、grok-build 都不成立：三者都完整记录了调用 id、工具名、参数和结果，而且可以按 id 配对。dsh-chat-import 早已在宿主上把这些导入为可以继续对话的会话。

维护者本机实测（2026-09，Grok 共 6 个会话）：源里有 473 个 `tool_calls`，每一个都能按 `tool_call_id` 找到对应的 `tool_result` 行。

不迁工具调用的代价，恰好落在本功能的核心场景上：用户选中会话是为了**接着做事**。如果模型看不到之前读过哪些文件、改过什么、命令输出了什么，续聊时就只能重新摸索。

所以本期统一迁移工具调用。唯一的底线是 **wire 合法**：每个 tool_call 都要有对应的 tool 消息。找不到结果的调用补一个空结果，找不到调用的结果丢弃并计数（§4.1）。zcode 是否记录了工具调用，取决于 v2 JSON 的实际形态（§4.3）。

两个入口共用同一个确定性 id，因此只要走同一套解析，不管从哪个入口导入，同一个会话的内容都完全一致。

---

## 2. 总体分层

```
UI 层（screens/、components/，不得 import @deepseek-ai/*）
  SessionSupervisor ── SourceTabs（新）
        ├─ tab = dsh     → 现有 DSH 双栏（原样不动）
        └─ tab = <agent> → ForeignSessionPanes（新）← useForeignSessions（新）
                                    │
channel（adapter/ports/channel-ui.ts；dsh-adapter/channel.ts 只做转发）
  listForeignSources()                       哪些来源有会话（存在性探测）
  listForeignSessions(agent, onRow)          进入标签时列出，逐条回报
  importForeignSession(agent, key)           选中即导入；key 不透明
                                    │
dsh-adapter/migrate/
  browse.ts（新）       存在性探测 + 列出（进程内指纹复用，不落盘）+ 导入入口；行映射在此完成
  import-one.ts（新）   单会话导入，经宿主 sessionPersistence 写入
  sessionize.ts（扩展） 支持工具调用 / 压缩检查点 / 中断 / 标题
  parse/（新）          纯函数：jsonl、注入识别、包装剥离、标题归一、工具配对
  adapters/<id>.ts      每源：scan()（摘要）+ load(ref)（全量）；discover()/count() 保持兼容
```

**关键原则**
- **DSH 标签页的代码路径不动**。外部来源用独立的面板组件、行组件和 hook，只复用设计原语（工作区行、搜索框、提示行）。DSH 会话屏回归多、边界复杂（occupancy、fork 祖先、新建卡片、pin），不值得冒风险去泛化它。
- **解析与 IO 分离**：`parse/` 和每个源的 `*.parse.ts` 是纯函数（输入原始文本，输出中间模型），fixtures 直接喂字符串测试。IO（readdir、stat、有界读头）只存在于 adapter 和 browse 中。
- **外部格式知识只在 migrate 内**：UI 拿到的行只有 `{agentId, key, title, cwd, updatedAt}`，`key` 只回传给导入，不解释；路径、指纹、源 id 都不出 migrate。
- **标签页导入走宿主的持久化服务**（`ctx.get('sessionPersistence')`），不像 `importSessions` 那样另起 Context 挂一份 `JsonlSessionPersistence`。原因有三：
  1. 保证与宿主配置的 root / 后端一致（profile、`DSH_HOME`）；
  2. 同一进程内只有一个写者；
  3. 会话列表的 revision 索引能立即看到新会话。

  CLI 没有宿主，继续使用 `importSessions`，保持现状。

---

## 3. 适配器接口（重构后）

```ts
/** 外部会话的轻量摘要：只读文件头和 stat 就能得到。 */
interface ForeignSessionSummary {
  readonly agentId: string
  /** 源侧稳定 id，必须与现有 discover() 的 sourceId 完全一致（见下）。 */
  readonly sessionKey: string
  /** 定位全量内容的不透明引用（文件路径 / 会话目录）。 */
  readonly ref: string
  readonly title: string          // 已归一化；可能是首问兜底
  readonly cwd: string            // 空串 = 未知
  readonly lastMessageAt: number  // 用于排序
  readonly createdAt: number
}

interface MigrationAdapter {
  readonly id: string
  readonly label: string
  roots(): readonly string[]
  /** 新：按名字遍历的描述（深度、文件名匹配、跳过目录），scan()、count() 与来源探测共用。 */
  readonly walk?: WalkSpec
  /** 新：异步、可中止、逐条回调的摘要扫描；cached 返回 summary / null（已知不是会话）/ undefined（未知，需读取）。
   *  返回每个候选的 { ref, fp, summary | null }，否定结果也进缓存。可选：OMP 本期不实现。 */
  scan?(opts?: { signal?: AbortSignal, cached?(ref: string, fp: Fingerprint): ForeignSessionSummary | null | undefined,
                 onEntry?(s: ForeignSessionSummary): void }): Promise<readonly ScanEntry[]>
  /** 新：全量解析单个会话；LoadSkip = missing / too-large / not-a-session。可选：OMP 本期不实现。 */
  load?(ref: string): Promise<MigrationSession | LoadSkip>
  /** 保留（/migrate、CLI 在用）：四个源由 scan + load 组合实现，语义不变。 */
  discover(): MigrationDiscovery
  count?(): number
}
```

标签页只展示实现了 `scan` 和 `load` 的来源，本期就是这四个。

**硬约束：`sessionKey` 必须与现有 `discover()` 的 `sourceId` 完全一致。** 会话 id 的算法是 `migrationUuid('<agentId>:<sourceId>')`，只有 `sessionKey` 不变，标签页导入和 `/migrate` 导入才会落在同一个 id 上，互相识别为「已存在」。各源现在的取法如下，保持不变：

| 源 | sessionKey 取法 |
|---|---|
| claude-code | 文件名去掉 `.jsonl` |
| codex | 文件名中的 uuid（兜底用文件名） |
| zcode | `meta.taskId`（文件为 `<taskId>.json`） |
| grok-build | `summary.json` 的 `info.id` |

在 verify 脚本里加一条断言：对同一个 fixture，`scan()` 得到的 `sessionKey` 必须等于 `discover()` 得到的 `sourceId`。

---

## 4. 解析精度重构

§4.3 中标注「实测」的规则，都在维护者本机的真实数据上核实过（2026-09）。

### 4.1 共享纯函数（`migrate/parse/`）
- `jsonl.ts`：逐行解析，合法的 `null` 或标量行跳过，同时计数坏行；不能静默丢弃。
- `injection.ts`：
  - **注入前缀表**（行首匹配，大小写不敏感）：`<environment_context>`、`<system-reminder>`、`<user_instructions>`、`<local-command-caveat>`、`<local-command-stdout>`、`<command-name>`、`<permissions>`、`<user_info>`、`# AGENTS.md instructions`、`# Context from my IDE setup:`。
  - **包装剥离**：`<user_query>…</user_query>`、`<pasted_content …>`（开标签可能没有对应的闭标签）、`The user interrupted the previous turn:` 和 `The user sent a message while you were working:`（只保留其中 `<user_query>` 的正文）。
  - 快速路径：文本不含 `<` 时直接跳过正则（沿用现有 claude adapter 对 ReDoS 的防护思路）。
- `title.ts`：`normalizeTitle`，折叠空白，超过 80 字符截断并加 `…`。
- `tools.ts`：`callId → step` 映射；孤儿结果丢弃并计数；同一步内的结果按 call 顺序排序；没有结果的 call 补一个空结果（保证 wire 合法：每个 tool_call 都闭合）。

### 4.2 中间模型（取代现在「按 role 排成一列」的 `MigrationTurn[]`）

```ts
interface MigrationSession {
  sourceId: string; cwd: string; title?: string; titleExplicit: boolean
  startedAt: number
  turns: ImportTurn[]
  stats: { badLines: number; droppedToolResults: number; filtered: number; meta: number }
}
interface ImportTurn {
  prompt: string                              // 空串 = 压缩边界轮（检查点即是 user 侧）
  compaction?: { summary: string; model?: string }
  steps: ImportStep[]
  aborted?: boolean
}
interface ImportStep {
  inputs: string[]                            // 轮中途进入这一步的 user 消息（isMeta、子代理报告）
  blocks: ({ type: 'text'; text: string } | { type: 'reasoning'; text: string }
         | { type: 'tool-call'; id: string; name: string; arguments: string })[]
  results: { callId: string; text: string; isError: boolean }[]   // 图片已换占位、超长已截断
  model?: string
}
```

实现说明：结果只保留文本（图片在解析阶段换成 `[image]`），sessionize 再包成 `ContentBlock[]`；`inputs` 是实现中新增的字段，用来承载模型在轮中途看到的机器上下文，取代「并入 step 之后的上下文」的原设想（§4.3）。

CLI 的 dry-run 只用到了 `session.turns.length`（显示为「N messages」），改为调用 `messageCount(session)` 辅助函数，输出语义保持一致。

### 4.3 各源规则

**claude-code**
- **一次响应合并为一步**：Claude Code 把一次模型响应按内容块拆成多行、共用 `message.id`，中间还可能插入工具结果行（实测 57,475 行 assistant 对应 27,151 次响应）。同一轮内按 `message.id` 合并回一步。
- `isMeta:true` 的 user 消息**不开新轮**，也不参与标题。实测之后 110 条紧跟模型回复、5 条是工具结果（skill 正文、`[Image: …]`、`Continue from where you left off.` 等），另有 61 条是本地命令的 caveat，之后没有模型回复。处理方式：作为**下一步的 `inputs`** 写入（上游允许 user/message 出现在轮内任意位置，wire 上是 tool 消息之后、下一个 assistant 之前的 user 消息，合法），计入 `stats.meta`；注入形态的 caveat 丢弃。
- **命令回显**：`<command-name>` / `<command-message>` 还原成 `/name args` 提问；模型没有回复的命令轮（`/model`、`/clear` 等本地命令）不导入；`<local-command-stdout>` 等注入不开轮。
- `tool_use` / `tool_result` 按 id 配对。结果总是在后面才到，要挂回 call 所在的 step，不能挂到最近一步。
- **ghost retry 去重**：同一 call id 在相邻步骤里原样重发，且前一步没有结果时，删掉前一步。
- `isCompactSummary` 转为压缩检查点。旧格式 2.0.x 的 `type:'summary'` 是写在文件头的一行叶子标题，前面没有可折叠的内容，**只当标题**，不转检查点（当检查点会退化成把标题作为第一条 user 消息注入）。
- 标题优先级：`custom-title` **后到者胜** > 旧格式 `summary` > `ai-title` **取首个** > 首个真实提问。
- 排除 `subagents/` 下的文件，以及文件名与记录中 `sessionId` 不一致的辅助 transcript。
- thinking 块照旧保留；每步记录 `message.model`。

**codex**
- user 块过滤掉 `<` 开头的块，以及 `# AGENTS.md instructions` 块。后者实测 13 个会话的首条消息就是它，而现有实现对 user 块一律不过滤。
- 读取 `function_call` / `custom_tool_call` 及对应的 `*_output`。输出有三种形态：纯字符串、`{"output": …}` JSON 字符串（取内层）、`input_text` / `input_image` 块数组（实测 968/1045 条，是最常见的形态）。`custom_tool_call` 的 input 是自由格式（patch、JS 片段），包成 `{"input": …}` 保证参数是 JSON。
- **步边界**：一次模型调用返回 reasoning、消息和调用，之后 harness 追加工具输出，所以出现输出之后的下一个模型产物开启新步。
- `reasoning.summary[].text` 是明文，作为所属模型调用的 reasoning 块（`encrypted_content` 不碰）。这一条修正了现有文档中「reasoning 加密不可读」的说法。
- `agent_message`（子代理回传给本线程的报告，实测 38 条）作为下一次模型调用的 `inputs`。
- `compacted.payload.message` 转为检查点。`turn_aborted` 标记当前轮为 aborted。
- 每个 `turn_context.model` 更新「当前模型」，写入其后的步骤。
- 排除子代理 rollout：`thread_source='subagent'` 或 `source.subagent`。**只看首个 `session_meta`**：派生或 fork 的线程会在自己的 meta 之后重复父会话的 meta（连同继承的历史），cwd 同样只取首个。

**grok-build**（实测行型如下）

| 行 | 处理 |
|---|---|
| `system` | 跳过 |
| `user` + `synthetic_reason`（`system_reminder` / `compaction_meta`） | 不开轮；`compaction_meta` 中以「This session is being continued…」开头的转为检查点 |
| `user`，内容以 `<user_info>` 开头（没有 synthetic_reason） | 注入，跳过 |
| `user`，`<user_query>` 包装 / 中断包装 / 插话包装 | 剥掉包装后开轮；带 `prior_turn_interrupt` 的，把上一轮标为 aborted |
| `reasoning` | `summary[].text` 缓冲，前置到下一个 assistant |
| `assistant`：`content` 字符串 + 顶层 `tool_calls[{id,name,arguments}]` + `model_id` | 一行对应一步；text 块加 tool-call 块；model 取 `model_id` |
| `tool_result`：`tool_call_id`、`content` 字符串、可选 `images` | 按 id 挂回对应 step；每张图片换成 `[image]` 占位 |
| `backend_tool_call` | 计数，不映射 |

同时保留现有的 v0（`role` 形态）兼容和 `GROK_HOME` 支持。实测 `summary.json` 没有 `generated_title`，只有 `session_summary`。

**zcode**：只支持原维护者的存储 `~/.zcode/v2/sessions/<dir>/<taskId>.json`（`{ meta, messages }`），不读 `~/.zcode/cli/db/db.sqlite`，不引入 `node:sqlite`。
- 本期保证：沿用现有字段映射，接入 §4.1 的注入过滤和标题归一，并产出 §4.2 的中间模型。
- 待定：维护者本机没有这个格式的样本。实现者需要先拿到一个真实样本（向原维护者要，或自行安装 zcode 生成），确认 `messages` 里有没有工具调用和 reasoning 字段：有就按 §4.1 映射，没有就维持纯文本。fixtures 按确认后的字段合成。

**omp**：本期不动。只把现有 adapter 产出的 role 列表机械转换成 `ImportTurn[]`（user 开轮，其后的 assistant 各占一步），好让 sessionize v2 只需维护一种输入。除 §6 统一补的空 system head 外，导入结果与现在逐事件一致，`verify-migrate` 中现有的 omp 断言原样通过。

### 4.4 体量保护
- 单个工具结果文本上限 64KB，超出部分截断，末尾加 `…[truncated N bytes]`。图片一律用占位符，不把 base64 写进日志。
- 超过 64MB 的源文件：摘要里照常列出，选中时给出明确的报错提示，不能静默消失。

---

## 5. 摘要扫描与复用（browse）

### 5.1 各源的摘要取法（只读头或尾，不整读）

| 源 | 标题 | cwd | lastMessageAt | 需在摘要阶段过滤的会话 |
|---|---|---|---|---|
| claude-code | 与 §4.3 的优先级相同（`custom-title` 需读尾部约 64KB） | 行上的 `cwd` 字段 | 文件 mtime | `subagents/` 下的文件、辅助 transcript、只有注入没有真实提问的会话 |
| codex | 首个真实提问 | `session_meta.cwd` | 文件 mtime | 子代理 rollout |
| zcode | `meta.title` | `meta.workspacePath` | 文件 mtime | — |
| grok-build | `generated_title` > `session_summary` > 首个 `<user_query>` 正文 | `info.cwd` | max(summary、chat_history 的 mtime) | 没有真实提问的会话 |

实现：摘要直接由 PR1 的同一个解析函数在文件头上得出，因此过滤规则与全量导入一致，`sessionKey` 恒等于 `sourceId`。头窗口逐级扩大（先 32KB，取不到提问再读 256KB），窗口按字节截断并丢掉残行；claude-code 在文件大于头窗口时再读 64KB 尾窗口取最后一次 `/rename`；zcode 是 JSON 文档没有可用的头部，变化的文件整读（体量小）。

### 5.2 复用与代价
- **指纹**：`{ mtimeMs, size }`（grok 用两个文件的复合指纹）。指纹不变就直接复用摘要，不再读文件。
- **不落盘**：复用只在进程内（随 channel 释放），不写任何快照或缓存文件。评审前的版本把摘要快照持久化到 `~/.dsh-tui/foreign-catalog.v1.json` 并在首帧同步读取，已按维护者要求去掉（§12）。
- **并发**：每个候选的 stat 与头读取在 16 并发的池里执行，结果无序到达，列表在 migrate 内排序。
- **不阻塞渲染**：全部使用 `fs/promises`，遍历每处理 N 个条目主动让出一次（`setImmediate`）。现有 adapter 用的同步 fs 只保留在 `discover()` 兼容路径里。
- **generation 保护**：同一来源先发起的慢列出晚于后发起的快列出完成时，不覆盖新结果。
- **实测**（合成 1 万个 Claude 会话，Windows）：打开会话屏 2ms（事件循环 0 停顿）；首次进入该来源 1.1s，再次进入 0.18s；最长停顿 1ms。评审前的实现：每次打开约 0.5s 全量 stat + 23ms 首帧同步读 + 5MB 快照重写；首次进入 2.3s，再次 0.43s，最长停顿 16ms。本机真实数据（`scripts/probe-foreign-browse.mjs`，114 个会话）：探测 2ms，列出 8–62ms，单会话导入 14–208ms（大会话的 sessionize 在导入时同步执行，一次性代价）。

### 5.3 标签页来源探测
- 会话屏打开时执行，是打开 `/resume` 唯一的外部 IO：每个来源按 `walk` 描述异步遍历，**找到第一个候选即停**，不 stat、不计数（`browse.listSources`）。
- 有候选的来源才出 tab，按注册顺序排列，DSH 固定在第一个。按最近活动排序需要每次打开都 stat 全部会话，与"打开不做外部 IO"冲突，已放弃（§12）。

---

## 6. sessionize v2

仍然使用官方的 `Session.create` + `append`，信封字段（seq、time、id）由上游生成。事件序列：

```
[compaction/start → compaction/summary → user/message(检查点) → compaction/end]   ← 仅当该轮带 compaction，位于 turn/start 之前
turn/start
  per step:
    step/start
    system/message { content: [] }    （仅会话首步：空 system head）
    user/message                      （仅首步，prompt 非空时）
    user/message × inputs             （轮中途的机器上下文）
    assistant/message { content: blocks（含 tool-call 块）, stream: [], source: { provider:'migrated:<agent>', model } }
    tool/call × n
    tool/result × n                   （与 call 一一对应，缺的补空；sourceEventSeqs 引用对应 tool/call）
    step/end
turn/end { reason: aborted ? { kind:'aborted', reason:{ kind:'legacy' } } : { kind:'completed' } }
session/title                          （仅显式标题，末尾写入）
```

- **与 live loop 同序**：提问是首步的 user 消息（原设计写在 step/start 之前）。没有步的轮直接在轮内写提问；没有步的首轮补一个只装 head 与提问的步。
- **空 system head**（实现中新增）：live loop 把 surface 第 0 节点留给系统提示词，续聊时用 replace 写入。导入日志此前没有 head，续聊时提示词只能追加在导入历史之后，而 pi-ai 适配器只提取「首条 system」，提示词会被当作一条 user 消息发出。空 head 不投影为消息，重读导入会话的内容不变。
- **检查点形态以 v4 上游为准**：dsh-chat-import 的写法基于旧格式，v4 下字段已变。检查点 user/message 的 `source` 为 `{ kind:'compact-checkpoint', compactionId }`，`surfaceOp` 为 `{ op:'replace', startSeq, endSeq }`，替换 head 之后的全部 surface 节点，`sourceEventSeqs` 等于 `shadowedSeqs`；事务 `turn: null`（独立事务）。@deepseek-ai/dsh-compaction 不是本包依赖，事件按其契约结构化书写，由 `Session.append` 在运行时校验。边界之前没有可折叠节点时不发事务，摘要落为该轮开头的一条 user 消息；会话停在压缩点、之后既无提问也无回复时不产生空轮。
- **验收底线**：导入的会话用 `resumeTo` 打开后，再发一轮新消息，生成的 wire 消息序列要合法（每个 tool_call 都有对应的 tool 消息，中间不插 assistant）。

---

## 7. 单会话导入与跳转

```
点击 / Enter 外部会话行
  → channel.importForeignSession(agentId, ref)
      1. id = foreignSessionId(agentId, sessionKey)（与 /migrate 同算法）
      2. 已存在（persistence.stat，旧后端回退 list）→ { kind:'ready', created:false }
      3. 行上的 cwd 不存在 → { kind:'cwd-missing' }
      4. adapter.load(ref)（跳过原因 → { kind:'failed' }）→ 再查一次加载后的 cwd
      5. 源在列出后换了身份时，id 按加载内容重算并再查一次是否已存在
      6. sessionize（内存中）→ create → append → flush → close；写入失败时尽力删除半截日志 → { kind:'failed', reason:'write-failed' }
      7. { kind:'ready', created:true }
  → onOpenSession(id)   （复用现有的 channel.resumeTo 路径：切换工作区、关闭会话屏、重绘）
```

- **cwd 预检**：导入前检查 `cwd` 是否存在。不存在时在底部状态行提示「工作目录不存在：<path>」，不导入。
- **防重入**：同一个 ref 正在导入时，再次请求并入进行中的那一次（返回同一个 Promise），不会写两次。状态行显示「正在导入 <标题>…」。
- **失败面最小化**：先在内存里完成解析和 sessionize，全部成功后才开始写盘，把失败面压缩到 IO 本身，避免留下半截日志、而下次点击又被当作「已存在」直接打开。失败时留在会话屏，状态行显示原因。
- **耗时**：大会话的解析可能达到秒级。本期使用异步分片并在状态行显示进度，暂不引入 worker_threads。
- **导入后的标题**：显式标题写 `session/title` 事件；首问兜底的不写，让 DSH 自己回退到首条 user 文本。

---

## 8. UI 设计

### 8.1 标题栏与标签条

```
 ▣ 会话管理  本终端托管多个会话 · 切换不中断                 DSH │ Claude Code  Codex  Grok Build
                                                              ━━━
```

- 当前 tab 用 `remember` 色加粗的**反色块**（实现选定：下划线要多占一行，而标题栏只有一行）；其他 tab 用 dim。鼠标悬停时去掉 dim。
- 没有任何外部来源（或宿主没有该 facade）时不画标签条，DSH 页面与之前完全一致。
- **宽度降级**（按显示单元宽度计算，使用仓库自带的宽度辅助函数）：
  1. 放不下时先隐藏副标题；
  2. 还放不下，从末尾把 tab 折叠成 `+N`；
  3. 点击 `+N` 弹出下拉列表，复用现有工作区菜单的绝对定位 Box；
  4. 当前 tab 永远不折叠。
- tab 点击时要 `stopImmediatePropagation`（根 Box 的 onClick 会关菜单）。

### 8.2 键盘
- **Tab / Shift+Tab**：下一个 / 上一个来源。
- 这会占用现在「Shift+Tab 在左栏打开工作区菜单」的路由。Enter 在左栏本来就能打开同一个菜单（见 `SessionSupervisor.tsx` 中 `isPlainReturn` 的 rail 分支），所以这条路由是冗余的，可以让出来。需要同步更新 `home-hint-*` 提示文案。

### 8.3 外部来源 tab 的双栏
- **左栏**：按外部会话的 `cwd` 分组（使用 `normalizeWorkspaceCwd`）。路径与 DSH 已登记的工作区相同时，显示已登记的标题，否则显示 basename。按组内最新会话降序排列，显示会话数；目录已不存在的组标出（复用工作区行的缺失标记）。cwd 未知的会话归入「未知目录」组。默认选中终端当前目录所在的组，没有则选最新的组。**不提供**右键菜单、重命名、移除；左栏 `Enter` 进入右栏。
- **右栏**：
  - 标题行为「`<来源> · <工作区> 的会话`  共 N」；
  - 搜索框按标题和 cwd 过滤；
  - **没有新建会话卡片**，光标空间从 0 开始（不要照搬 DSH 列表中 `sessionIndex - 1` 的偏移）；
  - 行上显示标题、相对时间和工作目录，**不显示**任何导入状态；
  - Enter、单击、双击都执行「导入并打开」。
- **底部提示**：`←/→ 切换栏位 · Enter 导入并打开 · Tab 切换来源 · Esc 返回`。在外部 tab 下，Ctrl+N、Ctrl+X、pin 都不生效，Ctrl+L 改为「重扫该来源」。
- **状态行**：沿用现有的 notice 行，显示导入进度和错误。

### 8.4 状态
- 会话屏的挂载状态中新增 `tab: 'dsh' | <agentId>`，每次打开默认为 `dsh`。
- 进入外部 tab 时列出该来源（逐条结果按 100ms 批量合并进列表）；`Ctrl+L` 重新列出。
- 不保留跨 tab 的状态：视图（选中的工作区、光标、栏位）只属于当前 tab，切换即重置；再次进入重新列出，靠 migrate 的进程内复用保持便宜。搜索词在切换 tab 时清空。
- 导入可能要几秒：落地时会话屏已关闭则不打开（用户已经离开）；提示只报给发起导入的 tab。
- 光标模型沿用 DSH 列表的规则：**只存 id 这一个事实，index 由 id 推导**。

### 8.5 行组件
`SessionListRow` 接收的是 DSH 的 `SessionSummary`（带 kind、title 对象、live 等字段），不能把外部摘要伪造成 `SessionSummary`。外部行 `ForeignSessionRow` 自成一体，外观与 DSH 行一致（两行、`❯`、绿色选中、蓝色悬停）。评审前曾从 `SessionListRow` 抽出共用的展示内核；为了不改动 DSH 行、降低对核心 UI 的侵入，已撤回，重复的只有外框与光标几行。

---

## 9. 文件清单

| 路径 | 变更 |
|---|---|
| `src/dsh-adapter/migrate/parse/{jsonl,injection,title,tools}.ts` | 新增 |
| `src/dsh-adapter/migrate/adapters/{claude-code,codex,zcode,grok-build}.parse.ts` | 新增，每源的纯解析 |
| `src/dsh-adapter/migrate/adapters/{claude-code,codex,zcode,grok-build}.ts` | 重构：scan/load，discover/count 保持兼容 |
| `src/dsh-adapter/migrate/adapters/omp.ts` | 仅做输出到 `ImportTurn[]` 的机械转换 |
| `src/dsh-adapter/migrate/types.ts` | 新增 §3、§4.2 的类型 |
| `src/dsh-adapter/migrate/sessionize.ts` | v2 |
| `src/dsh-adapter/migrate/browse.ts`、`import-one.ts` | 新增 |
| `src/adapter/ports/channel-ui.ts`、`channel-session.ts`、`src/dsh-adapter/channel.ts` | 新增 3 个方法与行类型；channel 只转发 |
| `src/components/sessions/SourceTabs.tsx`、`ForeignSessionRow.tsx` | 新增 |
| `src/screens/sessionSupervisor/useForeignSessions.ts`、`ForeignSessionPanes.tsx` | 新增 |
| `src/screens/SessionSupervisor.tsx` | 标题栏接入 tab，按 tab 切换双栏，调整 Tab 键路由 |
| `src/i18n.ts` | 新增文案（中英） |
| `docs/migrate.md` / `.en.md` | 契约变化：迁移工具调用、压缩检查点、Codex reasoning 摘要可读、注入过滤 |
| `docs/interaction.md`、`docs/user-guide.md`（及 `.en`）、`README.md`、`README_ZH.md` | 标签页与快捷键 |
| `scripts/verify-migrate-parse.mjs`、`scripts/run-ci-group.mjs` | 新增回归并登记 |

`/migrate` 相关的 `Chat.tsx`、`MigratePicker.tsx`、`picker.ts` **不改**，`cli.ts` 只把 `turns.length` 换成 `messageCount()`。

---

## 10. 验证

1. **`verify-migrate-parse.mjs`（新增）**：用合成 fixtures 覆盖 §4.3 的每条规则，逐源断言轮数、步数、tool call 与 result 的配对、检查点、标题。fixtures 全部合成，不提交真实数据。
2. **`verify-migrate.mjs`（扩展）**：
   - omp 的现有断言原样通过；
   - 其余三源中与旧契约冲突的断言（例如「不含工具调用」）按新契约更新，并在 commit 中逐条说明；
   - 新增「scan 得到的 sessionKey 等于 discover 得到的 sourceId」。
3. **resume 回归**：一个带工具调用和检查点的导入会话，经 `resumeTo` 打开后发起一轮新对话，断言序列化后的 wire 消息合法。
4. **`verify-session-supervisor.tsx`（扩展）**：
   - tab 条的渲染和宽度降级（宽、窄、极窄）；
   - 点击 tab 切换、Tab / Shift+Tab 循环切换；
   - 外部列表的分组、搜索、光标；
   - Enter 触发导入，随后以确定性 id 调用 `onOpenSession`；
   - 第二次选中同一会话时不再导入，直接打开；
   - cwd 缺失时显示提示；
   - DSH tab 的既有断言全部不变。
5. **性能探针**（`scripts/probe-foreign-browse.mjs`）：在本机真实数据上测打开会话屏的探测、进入来源的首次与再次列出、单会话导入，并报告事件循环最长停顿，数字写进 PR 描述。
6. **本地真实数据抽查**（不入库）：Grok 源 473 个 tool_calls 应全部导入且都有结果，不出现以 `<system-reminder>` 或 `<user_info>` 开头的轮；Claude 的 isMeta 不产生假轮；Codex 不出现 AGENTS.md 假轮。
7. **手动走查**：inline 与 fullscreen 两种模式、窄终端、鼠标关闭（SSH）的情形。

---

## 11. 实施切分与提交粒度

**提交粒度**：细粒度，一个 commit 只做一件可独立验证的事，例如一条共享解析规则、一个源的某类行型、一处 UI 行为。每个 commit 都要带上对应的回归断言，并且能单独通过构建。

1. **PR1：解析层 + sessionize v2**（合并后 `/migrate` 立即受益）
   - 共享 `parse/` 的各个模块，每个模块一个 commit；
   - 中间模型、sessionize v2、omp 机械适配；
   - claude-code 和 codex 按规则逐条提交（工具配对、isMeta、检查点、注入过滤、按步 model……）；
   - grok-build 按行型逐条提交；zcode 在确认样本后提交；
   - 最后更新 `docs/migrate.md` 双语契约。
2. **PR2：摘要扫描与导入**：四个源的 `scan()`（每源一个 commit）、browse、`import-one`、channel 方法、性能探针。
3. **PR3：UI**：SourceTabs、ForeignSessionPanes、键盘路由、i18n、文档，以及 supervisor 回归。

实际按维护者要求合为一个 PR，三段作为提交分组保留。

## 12. 评审后的收窄

维护者对 #1066 的反馈：`/resume` 的性能影响为灾难级；并希望尽可能少改 Channel API、尽可能少占长期状态（原为 catalog + 快照 + 缓存 + UI 记忆）、尽可能把外部格式知识控制在 migrate 内部。对应改动：

| 方面 | 评审前 | 现在 |
|---|---|---|
| 打开 `/resume` | 首帧同步读整份快照；后台串行 stat 四个来源的全部文件；重写整份快照 | 每个来源走到第一个候选即停，不读内容、不写任何东西 |
| Channel API | 5 个方法（两对同步读 / 异步刷新 + 导入） | 3 个异步方法，形状同现有 `listSessions(onEnriched)` |
| 长期状态 | `~/.dsh-tui/foreign-catalog.v1.json`；UI 按 tab 记住工作区与光标、跨 tab 缓存行 | 无文件；migrate 内进程级指纹复用；UI 只有当前 tab 的视图 |
| 外部格式知识 | 行上带 `ref`、`sessionKey`；catalog 在 migrate，facade 在 channel/ | 行只有不透明 `key`；探测、列出、映射、导入入口都在 `migrate/browse.ts` |
| 来源排序 | 按最新 mtime | 按注册顺序 |
| 扫描 | 逐个串行 | 16 并发池 |
| DSH 会话行 | 抽出共用展示内核，改动 `SessionListRow` | 不改动；外部行自成一体 |

评审同时指出的正确性问题一并修正：codex 以 `<` 开头的真实提问被当注入丢弃（收紧为前缀表）；导入落地时会话屏已关闭仍强行打开；导入提示串到其他 tab；压缩检查点缺少原生 /compact 的前言与 `<compacted-summary>` 包装；`/migrate` CLI 的会话根不认 `DSH_TUI_SESSION_ROOT`；同一会话身份的并发导入按 ref 去重会并发写同一 id。


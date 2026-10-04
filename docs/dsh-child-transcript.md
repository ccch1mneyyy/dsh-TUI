# DSH 子会话转录页（dsh-child-transcript）

> 实现：`src/dsh-adapter/channel/subagent-transcript.ts`。本文说明这个数据源的契约，
> 以及新后端接入子代理转录页时要满足的条件（界面不需要改）。

## 目标与边界

DSH 是 `SubagentControl.history` → `SubagentTranscriptPage` 契约的第二个实现
（第一个是 Claude 后端读子代理转录文件）。界面、页签、分页、去重与 live 尾部合并
都复用共享件（`SubagentDetailScene` / `AgentTranscriptScene` /
`src/components/messages/subagentTranscript.ts`），没有按后端分支的代码。

数据通道（回归脚本会检查）：

| 路径 | 用法 |
|---|---|
| `ctx.sessionPersistence.open(id, 'read')` + `SessionHandle.read(offset, length)` | 唯一数据通道（公开只读 range API，可与 writer 并存） |
| `subagents.listChildren(parentId)` | 验权/目录源：只有本 parent 目录内的 direct child 才会被打开 |
| `ctx.sessions.flush(childSession)` | 活跃 child 的读前持久化屏障（可选、best-effort） |
| `Session` snapshot-events API（上游已 deprecated） | 禁止新增调用 |
| 原始 JSONL / sessionLog 自制 reader | 不用（那是 session-tree 的专用 bounded reader） |
| `ctx.agents.get(childId)` | 只用于核对活跃身份/flush；不 load/resume Agent |

## 读取形状

一次 `history(agentId, window?)` 调用：

1. **固定绑定**：捕获 binding（session 对象 + generation）；每个 `await` 之后复查，
   parent 已切换即丢弃结果（拒绝，UI 显示 unavailable）。
2. **验权**：`listChildren(parentId)` 名册必须包含目标 id，否则返回 `null`
   （不存在此 child）；界面传来的 id 不会被直接打开。one-shot 与 continuable
   子会话都可读。
3. **持久化屏障**：child 的 exact Session 还在 agents registry 时，先
   `ctx.sessions.flush(session)`（不等待 whenIdle、不创建/恢复 Agent）；flush
   失败只降级为「已落盘前缀 + live tail」，不阻塞。
4. **open + 校验**：`open(childId, 'read')`；校验 stored id、格式版本
   （`SESSION_FORMAT_VERSION`）、parent lineage（header 声明的 `parentSession`
   若与本 parent 不符 → fail closed）、seeded child 的精确
   `inheritedEventCount`（缺失 → fail closed，绝不假设为 0）。
5. **总长**：`stat().eventCount` 可用时采用（并用一次单事件探测验证新鲜度：
   stat 之后又落盘的事件不能藏住最新页）；不可用（当前 pinned JSONL 后端即如此）
   时用有界的单事件探测（指数 + 二分，每次 `read(offset, 1)`，最多 48 次、
   跨度上限 2^24）找日志末端，不整本读取后再切片，也不直接读文件。
6. **窗口**：child 自己的历史是 `[cut, total)`（fork 继承前缀永不翻页）。首页 =
   最后 `min(400, own)` 条 source 事件（与 Claude 的 400 message 页、共享
   `TRANSCRIPT_OLDER_CHUNK` 同宽）；older 请求按
   `[cut + skip - count, cut + skip)` 取。`skippedFromStart` / `hasOlder` 均以
   own 事件计。窗口 cursor 是 **source record**（SessionEvent），与
   SessionLogOffset 同一零基语义，不与 event seq 混用（seq 即位置，anchor 是
   `String(seq)`）。
7. **翻译**：每次调用新建一个一次性 DSH 翻译器（不影响 live 翻译器的状态）；只保留
   `assistant.message` / `tool.call` / `tool.result` 三种事件，并把
   `parentCallId` 设为子会话 id；不经过 Channel 与投影器，不影响 todo/job/goal 状态。
8. **身份**：`uuids` 填 DSH 真实存在的 durable message id（`user/message` 的
   `data.id`、`assistant/message` 的 `data.message.id`），缺失不伪造；
   tool `callId` 原样保留。`parentAgentId` = 验证过的 parent session id
   （名册与存储血缘都核对过）。
9. **收尾**：每条路径都在 `finally` 里关闭一次；读取或校验失败一律拒绝（界面显示
   unavailable，不把失败显示成空历史）。

## 降级矩阵

| 情形 | 行为 |
|---|---|
| 无 sessionPersistence（组合未装载） | 无 `history` 方法 → 转录页签不渲染（共享 UI 规则） |
| continuation service 缺失 / persistence 调用时消失 | 拒绝 → unavailable |
| child 未物化 / 格式版本未知 / torn tail / corrupt（日志短于 cut） | 拒绝 → unavailable |
| flush 失败 | 已落盘前缀 + live tail（partial，如实） |
| 探测预算耗尽（>2^24 事件） | 拒绝 → unavailable（不做无界扫描） |
| catalog miss / 非 direct child | `null`（无此 child） |

## 新后端接入清单

1. 实现同一个 `subagentControl.history(agentId, window?) →
   SubagentTranscriptPage | null`；不支持时不提供该方法（页签自动不渲染）。
2. 数据源必须公开、只读、可取消、有界；以 parent-owned 名册校验 id；提供
   newest 页与 older cursor（cursor 语义 = source record，两端一致）。
3. 把原始记录翻成共享的 `AgentEvent`（assistant.message / tool.call /
   tool.result），设置子代理的 `parentCallId` 与稳定的 anchor/time；不经主 Channel
   投影器，不影响 todo/job/goal 状态。
4. 给出真实的消息 id、seq anchor 与 tool callId；没有 UUID 就不编造；跨页切开的块用
   可合并的 anchor（同 anchor 的 text/thinking 由共享的 `prependOlderLeaves` 拼接）。
5. 对接共享 `foldTranscriptLeaves` / `uniqueRenderKeys` /
   `prependOlderLeaves` / `mergeLiveWindow`，并覆盖 overlap、重复、乱序与
   缺口测试（合并逻辑只在共享 helper 里改，两个后端一起测）。
6. 用 fixture 覆盖：验权、继承前缀、读取预算（5 万条以上的日志不做无界读取）、取消、
   绑定切换、只关闭一次、坏数据 → unavailable。

## 回归

`scripts/verify-dsh-child-transcript.ts`（`run-ci-group.mjs` 的 channel-ui 组）：翻译
fixture、验权与拒绝路径、窗口与继承前缀、5 万条日志的读取预算、绑定切换与降级、
共享去重与 live 合并、真实 channel 上的能力点亮，以及源码检查（不用已弃用的
snapshot API、不自己读日志文件）。

## 已知限制

- 当前钉住的 JSONL 持久化后端 `stat()` 不含 `eventCount`，日志末端靠上面的有界探测
  找到。探测次数很少（最多 48 次单事件读取），但宿主实现的每次 `read` 都会重读整份
  日志。如果大日志出现明显延迟，需要上游 sessionPersistence 提供廉价的 eventCount 或
  定位到末尾的 API，这里只需替换「总长发现」一步。
- 页界切开的 tool call/result：result 落在 newer 页时其 call 在 older 页，
  fold 按共享规则丢弃孤儿 result（与 Claude 同语义）；活跃 child 由
  `mergeLiveWindow` 按 callId 补齐状态。
- 不支持嵌套子会话：`listChildren` 只核对直接子会话。

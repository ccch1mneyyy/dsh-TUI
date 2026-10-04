# DSH 子会话转录页（dsh-child-transcript）

> 状态：已实现（`src/dsh-adapter/channel/subagent-transcript.ts`）。本文件是
> 该数据源的契约说明，以及「新后端接入转录页」的 checklist（UI 零工作）。

## 目标与边界

DSH 成为既有 `SubagentControl.history` → `SubagentTranscriptPage` 合同的第二个
实现者（第一个是 Claude 的 on-disk child lane）。UI、页签、分页、去重、live-tail
合成**全部复用现有共享件**（`SubagentDetailScene` / `AgentTranscriptScene` /
`src/components/messages/subagentTranscript.ts`），零 backend-specific 分支。

数据路裁定（与设计一致，违反即回归脚本红）：

| 路径 | 裁定 |
|---|---|
| `ctx.sessionPersistence.open(id, 'read')` + `SessionHandle.read(offset, length)` | 唯一数据通道（公开只读 range API，可与 writer 并存） |
| `subagents.listChildren(parentId)` | 验权/目录源：只有本 parent 目录内的 direct child 才会被打开 |
| `ctx.sessions.flush(childSession)` | 活跃 child 的读前持久化屏障（可选、best-effort） |
| `Session` snapshot-events API（上游已 deprecated） | 禁止新增调用 |
| 原始 JSONL / sessionLog 自制 reader | 不用（那是 session-tree 的专用 bounded reader） |
| `ctx.agents.get(childId)` | 只用于核对活跃身份/flush；不 load/resume Agent |

## 读取形状

一次 `history(agentId, window?)` 调用：

1. **栅栏捕获**：捕获 binding（session 对象 + generation）；每个 `await` 之后复查，
   parent 已切换即丢弃结果（拒绝，UI 显示 unavailable）。
2. **验权**：`listChildren(parentId)` 名册必须包含目标 id，否则返回 `null`
   （不存在此 child）；UI 给的任意 id 绝不会被直接打开。one-shot / continuable
   都可读（mode 不是 history 门槛）。
3. **持久化屏障**：child 的 exact Session 还在 agents registry 时，先
   `ctx.sessions.flush(session)`（不等待 whenIdle、不创建/恢复 Agent）；flush
   失败只降级为「已落盘前缀 + live tail」，不阻塞。
4. **open + 校验**：`open(childId, 'read')`；校验 stored id、格式版本
   （`SESSION_FORMAT_VERSION`）、parent lineage（header 声明的 `parentSession`
   若与本 parent 不符 → fail closed）、seeded child 的精确
   `inheritedEventCount`（缺失 → fail closed，绝不假设为 0）。
5. **总长**：`stat().eventCount` 可用时采用（并用一次单事件探测验证新鲜度：
   stat 之后又落盘的事件不能藏住最新页）；不可用（当前 pinned JSONL 后端即如此）
   时用**有界单事件探尾**（指数 + 二分，每次 `read(offset, 1)`，探测次数硬上限
   48、span 上限 2^24）找日志末端——绝不无界读取整本后 slice，也绝不私读文件。
6. **窗口**：child 自己的历史是 `[cut, total)`（fork 继承前缀永不翻页）。首页 =
   最后 `min(400, own)` 条 source 事件（与 Claude 的 400 message 页、共享
   `TRANSCRIPT_OLDER_CHUNK` 同宽）；older 请求按
   `[cut + skip - count, cut + skip)` 取。`skippedFromStart` / `hasOlder` 均以
   own 事件计。窗口 cursor 是 **source record**（SessionEvent），与
   SessionLogOffset 同一零基语义，不与 event seq 混用（seq 即位置，anchor 是
   `String(seq)`）。
7. **翻译**：每次调用新建一次性 DSH translator（不碰 live translator 的 frame
   fence / open-call ledger）；只有 `assistant.message` / `tool.call` /
   `tool.result` 三种 leaf 事件存活，逐条强制 `parentCallId = childSessionId`；
   不经 createChannel/projector，todo/job/goal 状态零副作用。
8. **身份**：`uuids` 填 DSH 真实存在的 durable message id（`user/message` 的
   `data.id`、`assistant/message` 的 `data.message.id`），缺失不伪造；
   tool `callId` 原样保留。`parentAgentId` = 验证过的 parent session id
   （名册 + 存储 lineage 双重核验的事实）。
9. **收尾**：每条路径 `finally close` 恰一次；任何读/校验失败都拒绝（UI 显示
   unavailable，绝不把失败伪装成空历史）。

## 降级矩阵

| 情形 | 行为 |
|---|---|
| 无 sessionPersistence（组合未装载） | 无 `history` 方法 → 转录页签不渲染（共享 UI 规则） |
| continuation service 缺失 / persistence 调用时消失 | 拒绝 → unavailable |
| child 未物化 / 格式版本未知 / torn tail / corrupt（日志短于 cut） | 拒绝 → unavailable |
| flush 失败 | 已落盘前缀 + live tail（partial，如实） |
| 探尾预算耗尽（>2^24 事件） | 拒绝 → unavailable（诚实，不无界扫描） |
| catalog miss / 非 direct child | `null`（无此 child） |

## 新后端接入 checklist（UI 零工作）

1. 实现同一个 `subagentControl.history(agentId, window?) →
   SubagentTranscriptPage | null`；缺能力时**不提供方法**（页签自动不渲染）。
2. 数据源必须公开、只读、可取消、有界；以 parent-owned 名册校验 id；提供
   newest 页与 older cursor（cursor 语义 = source record，两端一致）。
3. 把原始记录翻成共享 `AgentEvent` leaf 词汇（assistant.message /
   tool.call / tool.result），强制 child lane 的 `parentCallId`、稳定
   anchor/time；不经主 Channel projector，无 todo/job/goal 副作用。
4. 给出真实 source message id、event seq anchor 与 tool callId；缺 UUID 不造
   UUID；跨页切块用可合并 anchor（同 anchor 的 text/thinking 由共享
   `prependOlderLeaves` 缝合，无需后端处理）。
5. 对接共享 `foldTranscriptLeaves` / `uniqueRenderKeys` /
   `prependOlderLeaves` / `mergeLiveWindow`，并覆盖 overlap、重复、乱序与
   缺口测试（merge 逻辑只改共享 helper 一处，双后端共测）。
6. Fixture 证明完整性、预算与错误降级：验权、seeded cut、读预算（50k+ 日志
   禁无界读）、取消、generation 切换、close 恰一次、坏数据 → unavailable。

## 回归

`scripts/verify-dsh-child-transcript.ts`（登记在 `run-ci-group.mjs` 的
channel-ui 组）：T 翻译 fixtures / O 验权与 fail-closed / W 窗口与 cut /
B 50k+ 预算 / G 栅栏与降级 / D 共享去重与 live 合并 / C 真实 channel 能力点亮 /
S 源卫生（禁 deprecated snapshot、禁 raw reader）。

## 已知边界（后续批次）

- pinned JSONL 后端 `stat()` 不含 `eventCount`，末端靠有界探尾发现；探尾
  探测本身便宜（≤48 次单事件读），但宿主实现每次 `read` 会物理重读整份日志
  ——若实际出现大日志延迟，向 sessionPersistence 提公开的 cheap tail-seek /
  eventCount API（上游子批），本适配层只需替换「总长发现」一步。
- 页界切开的 tool call/result：result 落在 newer 页时其 call 在 older 页，
  fold 按共享规则丢弃孤儿 result（与 Claude 同语义）；活跃 child 由
  `mergeLiveWindow` 按 callId 补齐状态。
- 本轮未做 nested child（目录父关系递归）；`listChildren` 只验 direct child。

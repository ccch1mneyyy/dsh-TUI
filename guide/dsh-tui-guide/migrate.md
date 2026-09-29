# 会话迁移：从其他编程代理导入对话

[文档索引](README.md) · [English](migrate.en.md)

把 Claude Code、Codex、OMP、zcode、Grok Build 的本地对话历史导入 DSH
会话库。迁移后 `/resume` 按原工作目录浏览并恢复这些对话——换代理不丢
历史上下文。

```sh
dsh-tui migrate                # 列出各源可扫描的会话文件数（不写入）
dsh-tui migrate claude-code    # 导入 Claude Code 的全部对话
dsh-tui migrate codex --dry-run  # 只预览将落盘的内容，不写入
```

TUI 内等效入口：`/migrate`。裸 `/migrate` 弹出**多选源选择器**——每行一个代理
（勾选框 + 可扫描文件数 + 「X 分钟前刚活动过」标记，最近活跃排最前）：
空格勾选/取消、`a` 全选/全不选、Enter 进入**二次确认层**（逐行列出将导入
的源与数量，注明「已存在的自动跳过，可重复执行」；Enter 导入 / `d` 干跑
预览 / Esc 返回选择）、Esc 关闭。`/migrate <agent>` 同样经过确认层（单源）；
`/migrate <agent> --dry-run` 因不写盘直接预览。完成通知带逐源真实计数
（「导入 X · 已存在 Y」）。CLI 形态保持直达（脚本场景）。导入在
子进程中运行，界面不会卡顿；结果经通知流汇报，输出汇入 `/migrate`
本地行。两个入口走同一套导入逻辑与同一套幂等规则。

## 支持的源

| 源 | 本地存储 | 说明 |
| --- | --- | --- |
| `claude-code` | `~/.claude/projects/` | 同一次响应拆成的多行（共用 `message.id`）合并为一步；thinking、工具调用与结果、压缩摘要、`/rename` 与生成标题都迁移；`isMeta` 上下文并入下一步；`subagents/` 与辅助 transcript 不成会话 |
| `codex` | `~/.codex/sessions/` | 工具调用与三种输出形态、reasoning 摘要（明文部分）、`compacted` 摘要、中断轮、子代理报告都迁移；模型按 `turn_context` 逐步记录；注入块与子代理 rollout 不迁移 |
| `omp` | `~/.omp/agent/sessions/` | 与 DSH 同源的近直接映射（文本与思考过程） |
| `zcode` | `~/.zcode/v2/sessions/` | 单 JSON 对象格式；只映射 user/assistant 文本，`meta.title` 作为标题 |
| `grok-build` | `~/.grok/sessions/`（可用 `GROK_HOME` 重定位） | reasoning 行附着到其后的 assistant 步；工具调用与结果（图片换占位）、压缩摘要、中断轮、`session_summary` 标题都迁移；`<user_query>` 等包装只留正文；合成注入行与 `<user_info>` 不迁移 |

## 行为契约

- **只读源**：迁移只读取源代理的本地存储，绝不修改；产物经官方
  `JsonlSessionPersistence` 写入 `$DSH_HOME/sessions`——导入的会话是
  一等公民（可打开、可续聊、可 rewind）。
- **幂等**：同一源对话命中同一确定性 UUID（v5）。重复导入跳过已存在
  项，不堆叠重复、不重写已有日志。两个入口（CLI 与 TUI）对同一源数据
  生成完全相同的会话 id。
- **结构保留**：按轮次还原，一步对应源里的一次模型调用：思考过程、正文、
  工具调用及其结果都在所属的步里，导入的会话可以直接接着做事。
- **工具调用 wire 合法**：结果按调用 id 挂回发起调用的那一步（不挂最近一步），
  同一步内按调用顺序排列；没有结果的调用补空结果，找不到调用的结果丢弃并
  计数，跨步复用的调用 id 改名。续聊时每个 tool_call 都紧跟它的 tool 消息。
  单条结果上限 64KB（超出截断并注明），图片一律换成 `[image]` 占位。
- **压缩检查点**：源里的上下文压缩边界写为与 `/compact` 同形的原生压缩事务。
  原始事件仍在日志里，模型只看到「摘要 + 之后的对话」，与源代理压缩后实际
  使用的上下文一致。
- **注入过滤**：harness 写进 user 角色的机器文本（环境块、AGENTS.md 说明、
  system-reminder、本地命令回显等）不开轮、不当标题；`<user_query>` 与粘贴
  信封等包装只保留正文。轮中途模型可见的机器上下文（Claude 的 `isMeta`、
  Codex 的子代理报告）作为下一步的输入保留。
- **标题**：源自带的标题（`/rename`、生成标题、`session_summary`、
  `meta.title`）写为 `session/title`；没有时以首个真实提问兜底，但不写入
  日志，由 DSH 按首条 user 文本自行回退。标题统一折叠空白、截断到 80 字符。
- **续聊就绪**：导入日志与原生会话一样，在首步预留空的 system head；续聊时
  系统提示词替换进这个位置，而不是追加在导入历史之后。
- **不迁移的内容**：逐条消息的原始时间戳（事件时间取导入时刻，会话起始
  时间保留源记录）；Codex reasoning 的加密部分；Grok 的提供方侧工具
  （`backend_tool_call`）。
- **健壮性**：单条坏行、合法 JSON `null`（整行或子对象）、超 64MB 的
  文件均安全跳过；单个会话失败不中断整批，失败清单随退出码 1 汇报。

## 实测参考（真实数据，供量级预期）

| 操作 | 规模 | 耗时 |
| --- | --- | --- |
| 列出五源计数 | ~3000 个文件 | 0.7 秒（名字匹配，零解析） |
| 导入 zcode | 60 会话 | 2.3 秒 |
| 导入 claude-code | 163 会话（含大量 thinking） | 39 秒 |
| 导入 codex + omp | 728 + 1366 会话 | 约 2.5 分钟 |
| 重复导入（幂等） | 任意 | < 1 秒，全部 already present |

导入后用 `/resume` 浏览：会话按原工作目录分目录存放（目录名按官方
编码规则生成），标题、起始时间可读；含思考过程的会话在 TUI 中以
推理块呈现，可折叠查看。

## 会话管理界面的来源标签

不想整批导入时，在会话管理界面（`/resume`、`/home`、`/agentview`）里按来源浏览：
标题栏右侧为每个有会话的源显示一个标签，选中一条会话即**只导入这一条**并直接打开。

- 解析与 `/migrate` 完全相同，会话 id 同样按源会话确定性生成：两个入口导入同一条会话得到同一个 DSH 会话，已导入的直接打开。
- 打开会话管理界面只探测各来源是否有会话（每个来源找到第一个候选即停）；列表在点进标签时才读取，来自摘要扫描（只读文件头/尾）。同一次运行里没有变化的会话不重读；不写任何缓存文件。
- 会话原工作目录已不存在时不导入，界面给出提示；这时仍可用 `/migrate` 整批导入。
- 标签页不改变 `/migrate` 与 `dsh-tui migrate` 的行为。

## 智能迁移提示

TUI 启动约 12 秒后做一次后台检测：任一源在最近 20 分钟内有文件写入
（以各源会话文件的最新修改时间为信号）时，弹出一次通知「刚刚从xx过来？
/migrate 来快速迁移」。检测在后台运行（亚秒级），每会话只提示一次；
`grok-build` 数据缺失时静默跳过。提示显示期间按 Enter（输入框为空时）
直达选择器并自动勾选该源，其他按键照常。

## 故障排查

- **`unknown agent`**：源名以 `dsh-tui migrate` 无参输出的名单为准。
- **`needs the profile's compiled copy`**：profile 内编译产物缺失或过旧，
  先运行 `dsh-tui update`。
- **导入数低于扫描计数**：扫描计数是候选文件数（按文件名匹配），
  导入会过滤解析失败与空对话，略低属正常。
- **全新 `DSH_HOME` 首跑报 installation rejected**：profile 自举撞上
  npm 上陈旧的 tarball 版本，升级 dsh 后自愈；或先用已有 profile。
- **一个会话都没找到**：确认源代理的数据目录存在于当前用户家目录；
  `grok-build` 用 `GROK_HOME` 重定位时需在环境变量中设置。

## 设计取舍（维护者与贡献者参考）

- 解析与 IO 分离：`adapters/<源>.parse.ts` 是纯函数（原始文本 → 轮模型），
  共享规则在 `parse/`（jsonl 坏行计数、注入识别与包装剥离、标题归一、
  工具调用配对）；adapter 只做文件发现。OMP 仍产出角色列表，经
  `fromRoleTurns` 机械折成轮。
- grok 的 `synthetic_reason` 过滤：只迁缺省与显式 `human` 的用户行；
  `compaction_meta` 中的摘要行转为压缩检查点。
- Claude 旧格式（2.0.x）的 `summary` 记录是写在文件头的一行叶子标题，
  按标题处理，不当作压缩边界。
- Codex 的 `custom_tool_call` 输入是自由格式（patch、JS 片段），迁移时包成
  `{"input": …}`，保证调用参数是 JSON。
- zcode：没有带工具调用或 reasoning 的样本，只映射文本角色，不猜测字段。
- 时间戳边界：grok 行内无逐条时间，会话起始时间取 `summary.json`。
- 术语：迁移（migrate）指本功能；与「从 dsh-cc-tui 更名迁移」
  （见[安装与快速开始](getting-started.md)）无关。

实现与验证细节见 `src/dsh-adapter/migrate/`、
`scripts/verify-migrate-parse.mjs`（逐源解析规则，合成 fixture）、
`scripts/verify-migrate.mjs`（事件合成与官方读取链往返，含 wire 合法性与
压缩检查点）与
`scripts/verify-migrate-command.tsx`（挂真实 Chat 的 `/migrate` 交互回归）。

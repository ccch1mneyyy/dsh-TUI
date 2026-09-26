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

TUI 内等效入口：`/migrate`（或 `/migrate <agent> [--dry-run]`）。导入在
子进程中运行，界面不会卡顿；结果经通知流汇报，输出汇入 `/migrate`
本地行。两个入口走同一套导入逻辑与同一套幂等规则。

## 支持的源

| 源 | 本地存储 | 说明 |
| --- | --- | --- |
| `claude-code` | `~/.claude/projects/` | 思考过程（thinking 块）按轮保留 |
| `codex` | `~/.codex/sessions/` | 模型名从 `turn_context` 前向提取；reasoning 加密不可读，不迁移 |
| `omp` | `~/.omp/agent/sessions/` | 与 DSH 同源的近直接映射 |
| `zcode` | `~/.zcode/v2/sessions/` | 单 JSON 对象格式，role/时间戳/工作目录齐备 |
| `grok-build` | `~/.grok/sessions/`（可用 `GROK_HOME` 重定位） | reasoning 兄弟行附着到其后首个 assistant 轮；`synthetic_reason` 合成注入行（system_reminder 等）不迁移 |

## 行为契约

- **只读源**：迁移只读取源代理的本地存储，绝不修改；产物经官方
  `JsonlSessionPersistence` 写入 `$DSH_HOME/sessions`——导入的会话是
  一等公民（可打开、可续聊、可 rewind）。
- **幂等**：同一源对话命中同一确定性 UUID（v5）。重复导入跳过已存在
  项，不堆叠重复、不重写已有日志。两个入口（CLI 与 TUI）对同一源数据
  生成完全相同的会话 id。
- **结构保留**：用户/助手消息与思考过程按轮次还原；一轮内的多条助手
  消息各占独立 step。
- **不迁移的内容**：工具调用流量（源格式不可忠实回放——迁移契约是
  「重读对话」而非「续跑任务」）；逐条消息的原始时间戳（事件时间取
  导入时刻，会话起始时间保留源记录）。
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

- 标题（title）不进产物：五源管线现状，`sessionize` 不消费标题字段。
- grok 的 `synthetic_reason` 过滤：只迁缺省与显式 `human` 的用户行。
- 时间戳边界：grok 行内无逐条时间，turn 继承 `summary.json` 的时钟。
- 术语：迁移（migrate）指本功能；与「从 dsh-cc-tui 更名迁移」
  （见[安装与快速开始](getting-started.md)）无关。

实现与验证细节见 `src/dsh-adapter/migrate/` 与
`scripts/verify-migrate.mjs`（29 项回归，全程跑官方读取链）。

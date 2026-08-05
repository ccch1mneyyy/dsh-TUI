# dsh-cc-tui — Claude Code 风格的全屏交互终端

> DeepSeek Harness 的官方 cordis 插件：像素鲸鱼顶栏、双流光大字、思考流式展开、
> 双击 Esc 时间回溯、蓝白上下文进度条 + 实时 TPS 仪表。零核心改动，纯插件挂载。

![类型](https://img.shields.io/badge/type-cordis%20plugin-blue) ![内测](https://img.shields.io/badge/status-内测-yellow)

## 为什么值得装

- **颜值即生产力**：顶栏是半块像素渲染的 DeepSeek 鲸鱼（24×18 真彩色精灵），
  旁边 `DEEPSEEK HARNESS` 是自绘 5 行块状大字——品牌蓝→冰蓝横向渐变，白色流光
  窗口循环扫过；`探索未至之境！` 欢迎语带冰蓝流光。窄终端（<64 列）自动收起鲸鱼。
- **一眼看穿模型状态**：底部状态栏三行——第一行独享蓝白**上下文分段进度条**
  （系统/提示词/助手/思考/工具五段着色，右侧实时读数 `ctx 17k/1.0M 1.7% 983k`）；
  第二行 `模型 · 实时 TPS（流式 gauge / 历史 sparkline）· 思考深度 · 缓存命中率(一位小数) · 进出 tokens`，
  右侧 `git 分支 · 工作目录 · 会话标题`；第三行模式提示。
- **实时工作状态行**（working-activity 集成）：第三行左侧常驻模型的实时动态——
  等待/思考的俏皮文案（`嗯…让我捋捋`、深夜档、30s/1m/5m 分档）、真正在跑的工具
  （`改改 src/channel.ts · 12s`）、`⏵` 模型自述、回合收尾统计
  （`搞定 ✓ · 4 工具 · 想3s 干2s`），配 28 种动画指示器（默认 Claude 官方帧序列）、
  白色流光扫过文案、上下文占用 ≥80% 亮黄 / ≥95% 亮红预警
  （`⚠ 上下文85% · …`）。数据来自 dsh-working-activity 插件的 log-only
  `activity/status` 事件——与 Web UI 共享同一数据源，cc-tui 只做渲染。
  开关：`activity: false`；指示器：`activityFrames: moon`（或 `comet`/`dots`/`random`）。
- **思考过程流式可见**：thinking 块边生成边展开，回合结束自动折叠成
  `∴ Thinking · 12s`，Ctrl+O 随时展开全文。
- **双击 Esc 时间回溯（rewind）**：把对话回滚到任意一条历史消息，DSH 会话
  fork 后原样重放，消息自动回到输入框可编辑重发。
- **完整 Claude Code 交互细节**：灰色气泡用户消息、`●` 助手正文 + Markdown
  表格/代码高亮、工具调用卡片（运行中闪烁绿点/时长）、`❯` 命令提示、
  `?` 快捷键菜单、`/` 全文搜索、Ctrl+R 历史搜索、`@` 文件补全、Shift+Enter
  多行输入、滚动时置顶的「当前提示词」栏与「↓ N 新消息」药丸。
- **DSH 官方机制优先**：不走任何黑魔法——消息来自会话日志事件流，
  fork/resume/compact 全走官方服务（agents/sessions/sessionPersistence/compact），
  注入上下文与事件订阅均通过 cordis 生命周期管理，插件卸载即完全还原。
- **working-activity 生态**：工作状态行消费
  [dsh-working-activity](https://github.com/dsh-external/dsh-working-activity)
  发布的 `activity/status` 事件（组织内插件，与 Web UI 同一数据源）。
  安装 cc-tui 时请一并挂载该插件（见下方 cordis.yml 示例），
  `activity/status` 为 log-only 事件，不进入模型上下文。

## 安装（组织内 · 私有仓库）

前置：DSH 源码快照（`~/.dsh/source/current`）+ 组织读权限。

```sh
# 1. 克隆（私有仓库，仅 dsh-external 组织成员可读）
git clone https://github.com/dsh-external/dsh-cc-tui.git
cd dsh-cc-tui

# 2. 一键装入 DSH 依赖链 + 生成完整可跑配置树
sh install.sh --full

# 3. 重启 dsh 后启动
dsh --config ~/.dsh-cc/cordis.yml
# Windows 也可以直接用仓库里的 dsh-cc.cmd（支持 --resume 恢复上次会话）
```

已有自己配置树的用户：`sh install.sh` 后把输出里的最小片段合入你的 cordis.yml 即可。

> 构建产物 `lib/` 已入库，**安装无需构建**。开发者想改源码：`npm install`
> 后 `sh scripts/build.sh`（自动定位 DSH 快照并链接依赖，tsc 6 编译）。

## 配置（cordis.yml）

```yaml
- id: cc-tui
  name: '@dsh-external/dsh-cc-tui'
  config:
    provider: deepseek-official   # LLM 路由
    model: deepseek-v4-flash      # 模型
    effort: max                   # 顶栏/状态栏启动显示的思考深度
    activity: true                # 工作状态行开关（默认开）
    activityFrames: claude        # 指示器预设：claude/moon/comet/dots/…/random
    cwd: !!js process.cwd()       # 工作目录
    fullscreen: true              # 备用屏幕全屏模式
    sessionId: !!js process.env.DSH_CC_RESUME_SESSION ?? undefined  # --resume

# 实时工作状态行数据源（组织内插件，与 Web UI 共享）
- id: working-activity
  name: '@deepseek-ai/dsh-working-activity'
  config:
    publishIntervalMs: 500        # 状态快照发布间隔（越小越跟手）
```

依赖官方插件（完整示例见仓库 `cordis.yml`）：llm-deepseek（thinking 开启）、
agent-spine、bash-local、fs-local、session-persistence-jsonl（rewind/resume
的数据底座）、compact-basic（`/compact`）、dsh-working-activity（工作状态行）。

## 快捷键

| 键 | 功能 |
|---|---|
| `Enter` | 发送（`Shift+Enter` 换行） |
| `Ctrl+C` | 中断当前回合；空闲时连按两次退出 |
| `Esc` | 空闲双击清空输入；**输入为空时双击 = 时间回溯** |
| `Ctrl+O` | 展开/收起详情（思考全文、工具参数与输出） |
| `Ctrl+R` | 历史消息搜索 |
| `/` | 会话内全文搜索（`n`/`N` 跳转） |
| `Tab` | 命令 / `@` 文件补全 |
| `?` | 快捷键菜单 |
| `Shift+↑` | 消息选择模式（Enter 展开单条） |
| `/model` `/thinking` `/tokens` `/compact` `/resume` `/clear` `/exit` | 本地命令 |

## 技术要点

- **事件驱动渲染**：`session/event` 事件流 → 增量差分渲染，滚动状态独立维护，
  内容再长也不卡顿。
- **上下文进度条**：参考 pi-nano-context 算法（最大余数法分段着色 + 右侧多级
  缩略读数），颜色沿用 DeepSeek 蓝白体系。
- **TPS 仪表**：参考 pi-tps-meter——流式 1/8 格 gauge、历史 min-max sparkline、
  速度语义色（≥50 绿 / ≥20 黄 / <20 红）。
- **回滚语义**：fork 边界取消息所属 turn 的起点（DSH 事件序
  turn/start → user/message → turn/end），中断回合先等落盘再 fork，
  会话 id 唯一性由官方 SessionStore 保证。

## 已知限制

- 注入上下文（plugin source 内容）未做独立展示，随系统提示词并入进度条统计。
- `/model` 切换需重启 dsh 生效（模型由 cordis.yml 路由决定）。
- 退出时以进程退出收尾，不等待 agent 异步落盘（持久化由 persistence 插件兜底）。
- TUI 的 stderr 不进入伪终端回显（调试看 stdout 或日志文件）。

## 版权与合规

- 界面语言与交互细节**致敬** Claude Code 的设计（非官方关联）。
- BSD-3-Clause，仅限 dsh-external 组织内测使用，禁止对外分发。

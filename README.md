# dsh-cc-tui — Claude Code 风格的全屏交互终端

> DeepSeek Harness 的 cordis 插件：像素鲸鱼顶栏、双流光大字、实时工作状态行、
> 思考流式展开、双击 Esc 时间回溯、蓝白上下文进度条 + TPS 仪表。
> 零核心改动，纯插件挂载。

![类型](https://img.shields.io/badge/type-cordis%20plugin-blue) ![内测](https://img.shields.io/badge/status-内测-yellow)

## 界面预览

![首屏：像素鲸鱼顶栏](screenshots/splash.png)

![工作状态行](screenshots/working-line.png)

![状态栏](screenshots/status-bar.png)

> 截图放 `screenshots/` 目录，文件名与上面一致即可自动显示；建议 Windows
> Terminal 全屏后截图（`Win+Shift+S`），窗口建议 ≥110 列。

## 为什么值得装

- **颜值即生产力**：顶栏是半块像素渲染的 DeepSeek 鲸鱼（40×25 手绘精灵，
  深蓝描边 + 品牌蓝身 + 冰蓝肚皮 + 白嘴），**启动播放手绘动画**（眨眼 →
  喷水花绽放 → 摆尾），随后定格静态不再重绘；旁边 `DEEPSEEK HARNESS` 是
  自绘 5 行块状大字——品牌蓝→冰蓝横向渐变，白色流光窗口循环扫过；
  `探索未至之境！` 欢迎语带冰蓝流光。窄终端（<64 列）自动收起鲸鱼。
- **实时工作状态行**（替代 CC 随机动词 spinner）：工作时输入框上方常驻模型的
  实时动态——俏皮思考文案（`嗯…让我捋捋`、深夜档、30s/1m/5m 分档轮换）、真正在跑
  的工具（`改改 src/channel.ts · 12s`）、`⏵` 模型自述，配 28 种动画指示器
  （默认 Claude 官方帧序列）、白色流光扫过文案、上下文占用 ≥80% 亮黄 / ≥95% 亮红
  预警（`⚠ 上下文85% · …`），行尾保留 `↓ N tokens` 计数。回合结束自动变成
  `搞定 ✓ · N 工具 · 想Xs 干Ys` 收尾统计。
- **一眼看穿模型状态**：底部状态栏——蓝白**上下文分段进度条**（系统/提示词/
  助手/思考/工具五段着色 + 实时读数 `ctx 17k/1.0M 1.7% 983k`）、
  `模型 · 实时 TPS（流式 gauge / 历史 sparkline）· 思考深度 · 缓存命中率(一位小数) · 进出 tokens`、
  右侧 `git 分支 · 工作目录 · 会话标题`。
- **思考过程流式可见**：thinking 块边生成边展开，回合结束自动折叠成
  `∴ Thinking · 12s`，Ctrl+O 随时展开全文。
- **双击 Esc 时间回溯（rewind）**：把对话回滚到任意一条历史消息，DSH 会话
  fork 后原样重放，消息自动回到输入框可编辑重发。
- **完整 Claude Code 交互细节**：`/` 命令菜单（竖排、Enter 执行选中项、Tab 补全）、
  灰色气泡用户消息、`●` 助手正文 + Markdown 表格/代码高亮、工具调用卡片、
  `?` 快捷键菜单、`/` 全文搜索、Ctrl+R 历史搜索、`@` 文件补全、Shift+Enter
  多行输入、滚动时置顶的「当前提示词」栏与「↓ N 新消息」药丸。
- **DSH 官方机制优先**：消息来自会话日志事件流，fork/resume/compact 全走官方
  服务（agents/sessions/sessionPersistence/compact），插件卸载即完全还原。

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
agent-spine、bash-local、fs-local、fs-policy、tool-fs（文件读写）、tool-todo、
subagent（spawn/fork 子代理）、plan-mode（计划模式，`/plan` + 计划审批）、
**commands（DSH 命令注册表）+ command-goal（`/goal`）**、
session-persistence-jsonl（rewind/resume 的数据底座）、compact-basic
（`/compact`）、dsh-working-activity（工作状态行）。

> 配置注意：`plan-mode` 的 `section` 为必填（空值会导致整树加载失败）；
> `subagent` 核心服务必须先于 `subagent-spawn`/`subagent-fork` 挂载；
> `/plan`、`/goal` 需要挂 `@deepseek-ai/dsh-commands`（命令注册表），
> `/goal` 还需 agent-spine 开 `goals: {}`（持久化目标域服务）。

## 快捷键

| 键 | 功能 |
|---|---|
| `Enter` | 发送（`Shift+Enter` 换行）；命令菜单打开时执行选中项 |
| `Ctrl+C` | 中断当前回合；空闲时连按两次退出 |
| `Esc` | 关闭命令/文件菜单；空闲双击清空输入；**空输入双击 = 时间回溯** |
| `Ctrl+O` | 展开/收起详情（思考全文、工具参数与输出） |
| `Ctrl+R` | 历史消息搜索 |
| `/` | 会话内全文搜索（`n`/`N` 跳转） |
| `Tab` | 命令 / `@` 文件补全 |
| `?` | 快捷键菜单 |
| `Shift+↑` | 消息选择模式（Enter 展开单条） |
| `/model` `/thinking` `/tokens` `/compact` `/resume` `/clear` `/exit` | 本地命令 |
| `/plan` `/goal` | DSH 命令注册表命令（随插件自动并入 `/` 菜单） |

> `/` 菜单 = 本地命令 + 注册表命令的并集（注册表描述来自插件本身）；
> `/plan [off|消息]` 切换计划模式，`/goal [create/edit/pause/resume/clear 目标]`
> 管理持久化目标。

## 技术要点

- **事件驱动渲染**：`session/event` 事件流 → 增量差分渲染，滚动状态独立维护。
- **上下文进度条**：参考 pi-nano-context 算法（最大余数法分段着色 + 右侧多级
  缩略读数），DeepSeek 蓝白配色。
- **TPS 仪表**：参考 pi-tps-meter——流式 1/8 格 gauge、历史 min-max sparkline、
  速度语义色（≥50 绿 / ≥20 黄 / <20 红）。
- **working-activity 生态**：工作状态行消费
  [dsh-working-activity](https://github.com/dsh-external/dsh-working-activity)
  的 log-only `activity/status` 事件（与 Web UI 同一数据源，cc-tui 只做渲染）；
  `⏵` 自述行自动从聊天正文剥离。
- **会话恢复**：`/resume` 列表标题 = 会话第一条 user 消息（最新 20 个会话），
  8 行滚动窗口；Enter **立即切换**到该会话并回放历史；`--resume` 启动同链路。
- **回滚语义**：fork 边界取消息所属 turn 的起点（DSH 事件序
  turn/start → user/message → turn/end），中断回合先等落盘再 fork。

## 已知限制

- 注入上下文（plugin source 内容）未做独立展示，随系统提示词并入进度条统计。
- `/model` 切换需重启 dsh 生效（模型由 cordis.yml 路由决定）。
- 退出时以进程退出收尾，不等待 agent 异步落盘（持久化由 persistence 插件兜底）。
- DSH 的 `/permission`（沙箱模式切换）未适配：需要 approval 服务 + 审批 UI，
  当前 TUI 不消费审批流，刻意不挂。

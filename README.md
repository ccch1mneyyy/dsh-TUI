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
> `/goal` 还需 agent-spine 开 `goals: {}`（持久化目标域服务）；
> `/agents` 需要 `@deepseek-ai/dsh-session-query`（子代理谱系查询）。

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
| `Ctrl+V` | 粘贴：文本直接插入光标处；**Explorer 复制的文件/图片 → 插入文件路径** |
| `?` | 快捷键菜单 |
| `Shift+↑` | 消息选择模式（Enter 展开单条） |

**问卷（模型发起 `ask_user_question` 时）**

| 键 | 功能 |
|---|---|
| `↑/↓` | 选择选项 |
| `Space` | 多选题勾选/取消 |
| `Tab` | 切到自定义回答（不选选项直接打字） |
| `Enter` | 提交当前选择 |
| `Esc` | 中断提问（模型收到 ASK_ABORTED，可继续对话） |

**本地命令（CC 指令全集复刻，均走 DSH 官方链路）**

| 分组 | 命令 |
|---|---|
| 会话 | `/new` 新会话 · `/resume` 恢复 · `/clear` 清屏 · `/compact` 压缩 · `/export` 导出 Markdown |
| 状态 | `/status` 会话信息 · `/cost` token 用量 · `/doctor` 环境自检 · `/config` 配置来源 · `/init` 创建 AGENTS.md |
| 模型 | `/model` 选择器 · `/thinking` 思考显示 · `/tokens` token 明细 |
| 账号/策略 | `/login` 凭证状态 · `/logout` 登出说明 · `/permissions` 权限说明 · `/add-dir` 文件策略范围 · `/hooks` · `/mcp` · `/memory` |
| 技能 | `/audit` 代码审计 · `/bug` bug 报告 · `/review` 代码评审 · `/practice` 编程练习 · `/pr_comments` PR 评论 · `/release-notes` 发布说明 · `/vuln-check` 漏洞检查 |
| 其它 | `/agents` 子代理列表 · `/vim` · `/terminal-setup` · `/connect` · `/help` · `/exit` |
| 注册表 | `/plan` `/goal`（DSH 命令注册表插件，随插件自动并入 `/` 菜单） |

> `/` 菜单 = 本地命令 + 注册表命令的并集（注册表描述来自插件本身）；
> `/plan [off|消息]` 切换计划模式，`/goal [create/edit/pause/resume/clear 目标]`
> 管理持久化目标。
> 技能命令通过 DSH 技能系统驱动：`install.sh` 会把对应的 SKILL.md 装进
> `~/.dsh/skills`，命令只是把激活提示发给模型（模型用技能目录/加载工具取用）。

## 技术要点

- **Gentle Mist Blue 配色**：雾蓝只承担品牌、焦点、交互与高亮，正文保持
  中性灰。启动时查询终端背景色（OSC 11）自动选色：浅色终端用严格的
  Gentle Mist Blue 色卡（墨色 `#343945` 正文 + 暖米白家族），深色终端用
  雾蓝适配版（暖灰白 `#E8E6E0` 正文 + 柔雾蓝 accent）；终端不响应时回退
  深色。`CC_TUI_THEME=light|dark|dark-ansi` 可钉死配色并跳过检测。
- **事件驱动渲染**：`session/event` 事件流 → 增量差分渲染，滚动状态独立维护。
- **布局级虚拟化**：布局引擎是纯 JS 移植版 Yoga，每次提交都会全树重排——
  长会话的每帧成本随记录线性增长（越用越卡的根因）。消息列表按可视窗口
  挂载：屏幕外的行渲染为"量高占位符"（高度来自上一帧 Yoga 实测），其
  子树完全不参与布局，单帧成本从 O(全会话) 降到 O(可视窗口)；滚动几何
  （总高度/底部跟随/滚动条）、搜索跳转（未挂载行先强制挂载再寻址）保持
  不变。
- **上下文进度条**：参考 pi-nano-context 算法（最大余数法分段着色 + 右侧多级
  缩略读数），DeepSeek 蓝白配色。
- **TPS 仪表**：参考 pi-tps-meter——流式 1/8 格 gauge、历史 min-max sparkline、
  速度语义色（≥50 绿 / ≥20 黄 / <20 红）。
- **working-activity 生态**：工作状态行消费
  [dsh-working-activity](https://github.com/dsh-external/dsh-working-activity)
  的 log-only `activity/status` 事件（与 Web UI 同一数据源，cc-tui 只做渲染）；
  `⏵` 自述行自动从聊天正文剥离。
- **会话恢复**：`/resume` 列表标题 = 会话第一条 user 消息（最新 20 个会话），
  8 行滚动窗口；**按最近使用排序**（发消息/恢复/切换都会把该会话提到最前，
  记录在 `~/.dsh-cc/last-used.json`，缺失时退回按创建时间）；Enter **立即切换**
  到该会话并回放历史；`--resume` 启动同链路。
- **回滚语义**：fork 边界取消息所属 turn 的起点（DSH 事件序
  turn/start → user/message → turn/end），中断回合先等落盘再 fork。
- **终端粘贴**：raw 模式下 Ctrl+V 由应用接管——PowerShell `Get-Clipboard`
  读剪贴板：Explorer 复制的文件/图片返回 FileDropList → 插入文件路径（含空格
  自动加引号）；纯文本按原文插入光标处（含换行，不会误提交）。终端原生粘贴
  （Ctrl+Shift+V / 右键）走 bracketed paste，同样插入而非提交。

- **问卷（ask_user_question）**：DSH user-interaction 生态的 TUI 适配——模型
  调用 `ask_user_question` 时不再以工具卡片出现，而是弹出雾蓝风格问卷面板
  （每题一屏：进度头 `第 x/N 题`、题头徽标、选项 + 描述、多选勾选、Tab 自定义
  回答），按键流转走官方 dsh-tui 同款语义（↑/↓ 选择、Space 多选、Enter 提交、
  Esc 中断 → `ASK_ABORTED`）。问答结束后把 Q&A 摘要折叠进会话记录；批内多题
  与子代理并发提问按 FIFO 排队逐题呈现。服务行由 dsh-base 提供，插件在裸装
  时自建服务并注册 provider、挂载模型侧工具。

## 已知限制

- 注入上下文（plugin source 内容）未做独立展示，随系统提示词并入进度条统计。
- `/model` 实时切换走"会话 fork 续聊"（DSH 无原位换模型 API）：历史原样保留，
  新会话路由到新模型，旧会话仍留在 `/resume` 列表里。
- `Ctrl+V` 读剪贴板依赖 PowerShell `Get-Clipboard`：剪贴板被其他进程
  （如 Explorer）短暂锁定时自动重试，持续锁定时静默放弃（显示"剪贴板为空"提示）。
- 退出时以进程退出收尾，不等待 agent 异步落盘（持久化由 persistence 插件兜底）。
- DSH 的 `/permission`（沙箱模式切换）未适配：需要 approval 服务 + 审批 UI，
  当前 TUI 不消费审批流，刻意不挂（`/permissions` 仅说明现状）。
- `/vim` `/connect` `/hooks` `/mcp` `/memory` 为 CC 同名占位：对应能力在 DSH
  侧无等价机制或未在本 leaf 挂载，命令会给出明确说明而非静默。

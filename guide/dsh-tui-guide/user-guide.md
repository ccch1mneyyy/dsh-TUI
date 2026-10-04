# dsh-TUI 使用说明

[文档索引](README.md) · [English](user-guide.en.md)

> 面向日常用户的操作手册：启动、键位、命令、会话工作流、界面指标与常用技巧。

## 目录

- [1. 快速上手](#1-快速上手)
- [2. 快捷键速查](#2-快捷键速查)
- [3. 命令全集](#3-命令全集)
- [4. 会话工作流](#4-会话工作流)
- [5. 界面与状态栏](#5-界面与状态栏)
- [6. 模型 / 预设 / 主题 / 语言](#6-模型--预设--主题--语言)
- [7. 常用技巧](#7-常用技巧)

## 1. 快速上手

### 1.1 安装与启动

```sh
# 全局安装 CLI + 本插件（插件自带 dsh-tui 直达命令）
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui

# 启动（首次运行自动初始化 dsh-tui profile，需 pnpm）
dsh-tui
```

- `dsh-tui --resume`：恢复上次会话；Windows 可用仓库里的 `dsh-tui.cmd`（等价）。
- `dsh-tui safe`：安全模式——只读查看环境、列出 profile 插件并给出修复建议，还能创建干净的救援 profile（见 §5.5）。
- `dsh --profile dsh-tui`：与 `dsh-tui` 等价的手工启动方式（`/update` 仅此方式可用）。
- `deepseek-official` 路由需要 `DEEPSEEK_API_KEY`；DSH 0.2.0-rc.1+ 可用标准 profile 的 `deepseek-account` 浏览器授权路由。其他支持的订阅模型可用内置 OAuth 登录。环境自检用 `/doctor`。
- 主验证 dsh 引擎版本 `0.2.0-rc.2`；兼容列表以 `ADAPTER.md` 为准，列表之外的版本在 logo 页提示版本漂移与对齐命令。
- 如果 logo 页出现 ⚠ 版本漂移警告，按提示执行 `npm i -g @deepseek-ai/dsh@<版本>` 对齐 dsh 引擎。

### 1.2 首次启动你会看到

1. **首次引导**（在"还没完成过引导"时出现：首次安装，或引导本身升级过版本）：四步向导 ——
   **API Key 与连通性 → 语言与主题 → 模型与工作区 → 快捷键与招式**。
   `←/→` 换步骤、`Tab` 在两组面板间切、`↑/↓` 移动选择、`Enter` 执行这一步、`Esc` 跳过；
   **跳过不记账**（下次启动还会问），最后一步要在**键位卡**上按 `Enter` 才算"完成"并写入记账文件
   （焦点落在命令卡上时 `Enter` 是"试一下"）。之后随时可用 `/setup` 重跑。
2. **落地页**（**普通启动**的第一屏：没带 `--resume`、没指定工作区、也没带首句提示词；
   `DSH_TUI_NO_LAUNCHPAD=1` 可整体跳过）：像素鲸鱼顶栏（`✦ dsh-TUI` 版本号、
   `DEEPSEEK / HARNESS` 大字、当前模型与 effort、工作目录，及一行**启动提示**；
   这一屏的头部**直接定格**——开场动画留给进入对话后的转录区顶部），
   下面是一个**真输入框**（第一句话在这里打，**回车直接发送**）与框下一行**参数行**
   （模型 · 思考深度 · 模式 · 权限——四段都可点，点开对话页同款选择器就地换值），
   隔一行留白再一行**快捷入口**（第七版四格：`继续「…」`（快捷键 `Alt+R`，没有可继续会话时整格不画）·
   `会话与工作区`（历史会话与工作区本就是 `/home` 同一个界面，合并成一个入口）· `设置` ·
   **条件位**——有后台任务在跑显 `后台任务`、检测到新版本显 `有新版本`、用量到档且没 star 过显
   `投喂一颗 Star`，都不成立兜底 `帮助`）。
   入口与参数段用 `↑/↓` 或 `Tab` 移焦点、`Enter` 激活，也可以直接点；终端变矮时按"整块撤"的顺序降级
   （快捷入口 → 提示行 → 只留输入框），变窄时按 5.1 的阶梯降级。
   从这一屏打开的整屏界面（会话与工作区 / 设置 / 后台任务 / 引导向导）都**盖在落地页之上**，
   `Esc` 退出即回到落地页（草稿、参数、焦点原样保留）；**离开落地页进对话页的唯一方式是
   回车提交一条非命令消息**。
   dsh 引擎版本不在验证范围时会出现 **⚠ 版本漂移警告** 及对齐命令。
3. **底部状态栏**：工作状态行、上下文进度条、TPS 仪表与各类实时指标（见
   [5. 界面与状态栏](#5-界面与状态栏)）。
4. **启动提示行**：Logo 下方固定一行 `提示：<随机小技巧> · /tips 更多技巧`，每次启动随机换一条；
   `/tips` 打开完整技巧面板（`↑/↓` 滚动、`Esc` 关闭）。
5. **第一次普通启动**（没带 `--resume`、没指定工作区、也没带首条提示词）在落地页之后进入
   **会话管理界面**先挑工作区，离开后 `~/.dsh-tui/home.json` 记下"已看过"，以后启动直接进对话；
   界面随时可用 `/resume`、`/home`、`/agentview`、`/bg` 或输入框行首 `⌸` 打开。
6. 输入 `/` 看命令菜单，按 `?` 看快捷键帮助。

### 1.3 核心心智模型

- 命令都可用 **Tab 补全**（带参数时先输入 `/命令 ` 再 Tab）。
- 非命令输入就是普通对话；**未知命令会作为普通消息发给模型**。

## 2. 快捷键速查

> 表内 `Ctrl` 在 macOS 上大多可换 `⌘`（`⌘V` `⌘O` `⌘R` `⌘T` `⌘L` `⌘Enter`）；
> `Ctrl+C`/`Ctrl+D` 不变。
> `⌘` 需扩展键盘协议（见 §5.4），Terminal.app 用 Ctrl。

### 2.1 发送与投递（模型工作时的三种语义）

| 键 | 功能 |
|---|---|
| `Enter` | 空闲=发送；**模型工作时=steer**（注入下一步边界，不中断）；菜单打开=确认选中项 |
| `Tab` | 补全 `/` 命令或 `@` 文件；**模型工作时=follow-up**（排入当前回合之后） |
| `Ctrl+Enter`（⌘Enter） | 打断当前回合并立即发送输入 |
| `Shift+Enter` / `Ctrl+J` | 换行（`Option+Enter` 是 mac Terminal.app 的兜底） |
| `Alt+Up` | 把最后一条未处理消息取回输入框编辑（不中断回合） |
| `Esc`（工作 + 有 pending） | 中断回合并立即重投 pending 消息 |
| 工作中的 `/btw …` | Enter 直接执行（侧问永不打断主回合） |

### 2.2 中断 / 退出 / 系统

| 键 | 功能 |
|---|---|
| `Ctrl+C` | 工作中=中断；中断未收敛时再按=强制退出；空闲有输入=清空输入；空闲空输入=双击退出（3s 窗口） |
| `Ctrl+D` | 工作中=中断（中断未收敛时再按=强制退出）；空闲时双击退出 |
| `Ctrl+L`（⌘L） | 清屏并强制重绘 |
| `Ctrl+O`（⌘O） | 展开/收起详情（思考全文、工具参数与输出） |
| `Ctrl+E` | 输入框=光标到行尾；转录中=展开/折叠隐藏的旧消息 |
| `Ctrl+P` | 切换启动时 loaded-context 面板（面板在屏时有效） |
| `?` | 输入框为空时打开快捷键/命令帮助菜单 |

### 2.3 搜索

| 键 | 功能 |
|---|---|
| `Ctrl+R`（⌘R） | 历史消息搜索（只搜当前项目）；重复按或 `↓` 到下一匹配；`Enter` 回填输入框 |
| `/`（转录态） | 会话全文搜索；`n` / `N` 跳转（仅 Ctrl+O 展开态） |

### 2.4 输入编辑

| 键 | 功能 |
|---|---|
| `←` / `→` | 按字符移动光标（有选区时坍缩到选区对应边缘） |
| `Ctrl+←` / `Ctrl+→`（⌘←/→） | 按词跳转 |
| `Home` / `End`，`Ctrl+E` | 逻辑行首 / 行尾（`Ctrl+A` 已改用于子代理面板，见 §2.7） |
| `Ctrl+U` / `Ctrl+K` | 删除光标前（至行首）/ 光标后（至行尾） |
| `Ctrl+W` | 删除前一个单词 |
| `Ctrl+Z` | 撤销草稿上一步「词级」编辑（含光标与图片）；只作用于草稿，提交或用历史召回（`Ctrl+R`/`↑`）后不再可撤销，与 `Esc Esc` 的会话/消息回溯无关；可经 `/settings` 重映射 |
| `Backspace` / `Delete` | 删前一 / 后一字符；**有选区时删除整个选区** |
| `↑` / `↓` | 多行时行间移动；单行时浏览输入历史（按项目隔离，每个项目最近 200 条，跨重启保留；升级前的旧历史各项目都可见） |
| `Ctrl+V`（⌘V）/ `Alt+V` | 粘贴：文本 / 文件路径（图片自动 `@` 引用）/ 剪贴板位图（`[Image #N]` 附件）；终端拦截 `Ctrl+V` 时用 `Alt+V` |
| `Ctrl+G` | 用 `$VISUAL`/`$EDITOR` 外部编辑器编辑输入（`:cq` 保留原稿；未设置变量时提示配置） |
| `Ctrl+Shift+E`（⌘⇧E） | 展开**全屏草稿编辑器**（也可点输入行尾 `⛶`）：带行号、高亮当前行，`Enter` 换行、`Ctrl+Enter` 发送、`Esc` 收起（草稿还在）；`/settings → 全屏草稿编辑` 可关 |
| 超长草稿自动折叠 | 粘贴 **≥6 行或 ≥600 字**的块折成 `▸ N 行・M 字` 小条：点小条或 `▾` 切换折叠；`Enter` 提交的始终是全文 |
| `/vim` | **vim 编辑模式开关**（会话级、不持久化）：开启后输入框显示 `INSERT` 徽标，`Esc` 切 `NORMAL`，`i/I/a/A/o/O` 回 INSERT。NORMAL 键位见下 |
| 打字 | **有选区时替换整个选区**（和标准编辑器一致），光标落在插入文本之后 |
| 右键 / `Ctrl+Shift+V` | 终端原生粘贴（含换行原样插入） |
| `Esc`（输入框） | 一层层关：帮助 → **图片预览** → 命令菜单 → 文件菜单（只关当前 `@` token）→ **有选区就先清选区（文字不动）** → 中断重投 → 有输入清空 → 双击=时间回溯 |
| 双击 `Esc`（空输入） | **时间回溯 rewind**（3s 窗口内按两次） |

**vim NORMAL 键位**：移动 `h/l` `j/k` `0/^/$` `w/b`；
删除 `x/X` `dd`/`d$`/`d0`/`d^`/`dw`；`u` 撤销、`Enter` 发送。
未识别键忽略，`Esc` 无操作，清空用 `Ctrl+C`/`dd`。

### 2.5 导航 / 模式

| 键 | 功能 |
|---|---|
| `Shift+Tab` | 循环会话模式（默认 → plan 计划 → full 完全访问）；挂载了第三方权限预设时，它们按 registry 顺序排在循环末尾 |
| `Shift+↑` | 消息选择模式（`↑/↓` 移动，`Enter` 展开单条，`Esc` 退出） |
| `Ctrl+T`（⌘T） | 打开轨迹场景（同 `/trace`） |
| `Alt+R` | 落地页上**继续最近一条会话**（同入口行的「继续「…」」；仅启动页生效，无可继续会话时无动作）。键位可在 `/settings` 改 |
| `Alt+S` | 一键 star（同 `/star`；开屏那句求 star 标语整行也可点）。键位可在 `/settings` 改；成功后会演一小段「鲸鱼娘接住星星」的庆祝。想随时看这段庆祝：`DSH_TUI_STAR_MODAL=1 dsh-tui`；想随时看开屏那句求 star 标语：`DSH_TUI_STAR_LINE=1 dsh-tui`（都是预览用环境变量，不动账本） |

### 2.6 鼠标（fullscreen 全屏模式；拖拽/双击/三击即选即复制）

| 操作 | 功能 |
|---|---|
| 左键拖拽 | 选文本，**松开即复制**（OSC 52 + 系统剪贴板工具兜底），自动取消选区 |
| 双击 / 三击 | 选词 / 选行，即选即复制 |
| 滚轮 | 滚动消息列表（±3 行/格）；**有文本选区时随内容平移选区** |
| 输入框内 | 拖拽 / Shift+click / 双击建立选区；`Backspace`/`Delete` 删选区、打字替换、`←/→` 坍缩、`Esc` 仅清选区、`Ctrl+C` 复制选区 |
| `Esc` | 取消选区（不复制） |
| 单击 | 消息行=展开/收起 · 超链接=打开浏览器 · 「加载更早消息」/StickyHeader/「↓ N new」=加载/跳转 |
| 悬停截断内容 | 停留约 600ms 浮层显示完整内容；拖选文本期间浮层不出现 |
| 键盘扩展选区 | 有选区时 `Shift+←/→/↑/↓/Home/End` 扩展/收缩（跨行环绕） |

### 2.7 各场景键位

**问卷（模型 ask_user_question）**

- `↑/↓` 选、`Space` 多选、`Tab` 切自定义回答、`Enter` 提交；`←/→` 换题（不提交，草稿保留）；`Ctrl+V` 粘贴、`Ctrl+K` 折叠。
- `Esc` 第 2 题起返回、第 1 题取消整批；`Ctrl+C` 任意题取消。输入行里 `←/→` 先移动光标，到行首/行尾才换题。

**计划评审（plan review）**

- `↑/↓` 移动、`1`/`2` 快选；直接打字 = 填反馈（`Ctrl+V` 粘贴、`Enter` 提交）；`Esc` 打断；**批准必须不带反馈**。

**工具审批（approval）**

- `↑/↓` 移动、`1` 允许（仅本次）、`2` 拒绝、`Enter` 提交；`Esc`/`Ctrl+C` 拒绝。

**会话管理界面**（`/resume`、`/home`、`/agentview`、`/bg`、输入框行首 `⌸`，同一个界面）

- 布局：左栏工作区、右栏会话；≥84 列两栏并排，更窄收起工作区栏。
- 换栏 `←/→`；移动 `↑/↓`/`PgUp`/`PgDn`；**直接打字 = 实时筛选**（按标题/目录/分支/模型）。
- 进入 `Enter`（第 0 行 = 在该工作区新建会话）；新建 `Ctrl+Enter`/`Ctrl+N`；停止后台会话 `Ctrl+X`。
- `Ctrl+L` 重读 · 工作区栏 `Enter` 打开操作菜单 · `Esc` 关提示→清空筛选→离开。
- 来源标签：本机的 Claude Code / Codex / Grok Build / zcode 有会话时，标题栏右侧出现对应标签，`Tab`/`Shift+Tab` 或点击切换；
  外部标签里 `Enter`/单击 = 只导入这一条并直接打开（导入过的直接打开），工作目录已不存在时只提示不导入，`Ctrl+L` 重扫该来源。
- 鼠标：点击会话行=进入、点 `★`/`☆` 切固定、右键工作区行出菜单。
- 输入框空着按 `←`（或 `/bg`）= 转后台并打开本界面，会话继续跑。

切换会话只是**停放**——正在跑的回合继续跑；被其他终端占用的会话标红写 `占用 pid <pid>`、点不动，对方退出后恢复。
固定项存到 `~/.dsh-tui/session-pins.json`。
工作区菜单四项：编辑 / 在此新建 / 重命名 / 从列表移除（**只删登记**，目录与会话日志都保留）。
移除后，仍有历史会话的目录会以「仅历史」行留在侧栏；栏头分别统计已登记工作区与历史目录，移除成功也会显示提示。
「仅历史」行的菜单只有编辑与在此新建；重命名、移除只适用于已登记工作区。

**大图预览**（点输入框里的 `[Image #N]` 或转录缩略图打开）

- `←/→` 上/下一张；底部按钮缩放：`适应`/`100%`/`200%`/`400%`/`800%`；拖动、滚轮平移。
- `Esc`/`Ctrl+C`/`Enter` 或点卡片外关闭；底部「打开原图」用系统看图程序打开。

**IDE 选区**（VS Code companion 扩展 `dsh-tui-vscode`，需 ≥ 0.7.0）

- 编辑器选中代码 → 输入框下方**实时**出现 `⧉ N lines selected` 徽标，提交时选中行**自动附加**进上下文。
- 转录里有「⧉ Selected N lines from <相对路径>」指示行（附加编辑器里的文本，未保存也带上）。
- 没装/没连 IDE 时自动跳过、不影响其他功能（详见 [vscode.md](vscode.md)）。

**历史搜索（Ctrl+R）**
只列出当前项目（会话工作目录）的输入，外加升级前未分项目的旧历史。
`↑/↓` 选择 · 重复 `Ctrl+R` 或 `↓` 下一项 · `Enter` 回填 · `Esc`/`Ctrl+C`/`Ctrl+D` 取消

**轨迹场景（Ctrl+T / /trace）**
- `↑/↓`/`PgUp`/`PgDn` 移动 · `←/→`（或 `h`）切换时间线/热点 · `g`/`G` 顶/底 · `q`/`Esc` 退出
- `[`/`]` 跳失败点 · `{`/`}` 跳轮次 · `m` 循环投影 · `Enter` 展开详情（`j`/`k` 翻页）· 热点 `t` 排序
- `/` 查询行（前缀 `tool:` `kind:` `turn:` `err:` `run:` `>10s` `tok>1k`）

**/settings 设置面板**
`↑/↓` 移动 · `Enter` 展开/切换/编辑 · `←/→` 在**有选项的字段**上循环切换（布尔项仍只响应 `Enter`）·
改动自动保存，`Esc` 退出

**/btw 侧问面板**
`↑/↓` 滚动 · `Space`/`Enter`/`Esc` 关闭 · `c` 复制答案 · 等待中 `Esc` 取消

**/effort 滑杆**
`←/→` 实时调整（Esc 不还原）· `Enter`/`Esc` 完成

**@ 文件补全**
`@` 在消息任意位置触发 · `↑/↓` 移动 · `Tab`/`Enter` 接受 · 目录可继续深入 ·
`Esc` 只关当前 token 菜单
- **两种查询**：路径形输入（`@src/` `@./` `@~/` `@D:\`）只列该目录；
  普通片段**模糊匹配**（`@ink` 命中 `src/ink/Box.js`）。
- 图片路径自动变 `[Image #N]` 附件。

**子代理面板（Ctrl+A）**
`↑/↓` 浏览 · `Enter` 查看详情 · `Esc` 关闭；详情页 `←/→` 翻页，运行中 `X` 中断；子代理以卡片行实时展示。面板镜像本会话派出的全部子代理——`subagent`/`send_message` 运行、可续子代理的重派（每轮新任务重置该行）、workflow/ralph 成员——并在恢复会话时从日志重新折叠持久发现事实，重启不再清空面板。无实时计时的历史行以 `⚪` 状态展示，不伪造时长。

**双击 Esc 时间回溯（rewind）**
列表 `↑/↓` + `Enter` 进入确认 · 确认页 `Enter` 回退 / `Esc` 返回 · 插件决策等待中只响应 `Esc`

### 2.8 侧栏（Side panel）

`Ctrl+B`（可在 `/settings` → `Shortcuts` 重映射）在聊天右侧展开一条侧栏：顶部胶囊标签栏、
中间活动面板、底部按键提示行，与聊天之间隔一列中缝。

- **三种形态**：**分栏**（split，聊天约 68% + 侧栏，`+`/`-` 每次调 4 列）、**收起**（collapsed，
  布局与以前逐字节相同）、**缩放**（zoom，面板占满，聊天列保留最小宽度）。
- **分栏条件**：fullscreen 且内容区 ≥93 列（默认页边距下约合终端 97 列）；窄屏、inline 模式、
  展开全屏草稿编辑器时自动回退——`/jobs` 等命令仍走整屏面板，`Ctrl+B` 与 `/panel` 则不分栏。
- **焦点模型**：同一时刻只有一处键盘焦点，焦点在右栏时面板边框与中缝一起提亮。`Ctrl+B` 三态：
  未开 → 打开并聚焦右栏；已开但焦点在聊天 → 聚焦右栏；焦点已在右栏 → 关闭并回聊天。
- **右栏按键**：`Esc` 一步回到输入框（不关面板）· `←`/`→` 或 `[`/`]` 切换面板 · `1`-`9` 直达第 N 个 ·
  `z` 或 `Alt+Z` 缩放 · `+`/`-` 调宽（`+` 加宽面板，步长 4 列） · `↑`/`↓`/`PgUp`/`PgDn` 交给活动面板（jobs 用它选择与滚动）；
  面板没吃下的键不会再落到聊天，但 `Ctrl+C`/`Ctrl+D`/`Ctrl+L` 等 Ctrl 组合照旧作用于聊天。
- **鼠标**：点聊天栏把焦点给聊天，点右栏把焦点给面板；点标签栏上的标签直接切到那个面板（悬停会高亮），
  点右端的 `⤢` 把当前面板放大成整屏；右栏不参与拖拽选字。
- **面板**：`todo`（Goals/Todos，分栏时从输入框上方迁到这里）、`jobs`（后台任务，点转录里的任务卡
  会直接定位到该任务）、`agents`（子代理 Dashboard 与详情：Enter 进详情、Esc 逐级返回）、`companion`
   （宠物，默认不启用——在 `sidePanel.panels` 加入 `companion` 开启：跟随会话状态换心情动画，点击
   比爱心、Enter 戳一戳；皮肤 `dsh-tui.companion.skin` 可选 deepy（默认，非官方粉丝作品 deepy
   小鲸鱼）或 whale）、`info`（信息栏：模型 / 思考深度 / 工作模式 / 权限 / 上下文占用 / 缓存命中 /
  Token / TPS / 消耗 / 工作目录 / 会话标题与 ID）、`trajectory`（会话轨迹：唤醒带 + 账本 + 检视器，
  ↑/↓ 选择、Enter 展开、Tab 切热点视图；←/→ 恒归侧栏切面板，Tab 才是切视图）、`workspace`
  （工作目录/工作区总览，Enter 打开整屏工作区主页）。
- **宠物（companion）细节**：宠物锚在面板**底部**，上方是状态区（心情 · 子代理/会话计数 · 当前动作）。
  互动：点它左半/右半会被戳（poke-left/right）、短窗口连点三次是挠痒（tickle）、**按住拖动它就跟着
  指针在整个面板里走（松手弹回底部）**、鼠标悬停它会看向指针；Enter 也算戳一戳。后台任务完成、已打断
  这类提示会由它头顶的对话气泡说出——此时输入框上方**不再重复弹**同一条（宠物面板不是活动面板时
  toast 照旧；错误类通知永远走 toast）。情绪带防抖平滑：快速的工具调用不会让动画来回闪烁（离开工作
  状态约 1.5s 才切换；审批/出错仍立即抢占）。子代理/会话数会切换配乐/指挥/施工等群像动画。面板窄到
  连紧凑形态都放不下时它会「躲起来」，只留一行 `好挤呀！{{name}}暂时躲起来了~`。
  皮肤 `dsh-tui.companion.skin` 三选一：`deepy`（默认，非官方粉丝作品小鲸鱼）、`whaleGirl`（鲸娘
  表情包，22 个动画，被戳/被挠/被拎起来都有对应反应，独有「冒爱心」「举大拇指」）、`whale`（开屏
  同款像素鲸）。**鲸娘在有图像协议（kitty/sixel）的终端里按原帧数 240px 像素级渲染**（267 帧全保留、
  透明悬浮、按需解码），无图像协议自动回退字符画版。

| 子命令 | 作用 |
|---|---|
| `/panel` | 打开面板选择器（↑↓ 选择、Enter 打开并聚焦） |
| `/panel toggle` | 真开 / 真关（关闭时焦点回聊天） |
| `/panel focus` | 打开并聚焦右栏 |
| `/panel zoom` | 打开并缩放当前面板 |
| `/panel <id>` | 打开指定面板：`todo` / `info` / `trajectory` / `jobs` / `agents` / `workspace` / `companion`（补全列出已启用的 id） |

- 原本只能整屏的视图现在也能进侧栏：分屏开着且对应面板已启用时，`Ctrl+T` / `/trace` 打开轨迹面板、
  `/home` 打开工作区面板；面板栏右端的 `⤢` 再把它们放回整屏（`⤢` 是鼠标入口，键盘等价物就是各自的
  整屏快捷键：`Ctrl+T` 轨迹、`Ctrl+A` 子代理、`/jobs` 任务、`/home` 工作区主页）。
- 设置：`/settings` → `侧栏` 分组，或 `dsh-tui.sidePanel.{splitEnabled,open,ratio,panels}`
  （见[配置参考](configuration.md#tui-配置)）。
- **tmux 用户注意**：`Ctrl+B` 是 tmux 的默认前缀键，会被 tmux 截走、送不到 TUI——到
  `/settings` → `Shortcuts` 把 `sidePanel` 换成别的组合（例如 `alt+b`）。

## 3. 命令全集

命令菜单 = 内置命令（58 条，含别名） + DSH 注册表命令（`/plan` `/goal` 等） + 技能目录
（仅补全，`/help` 菜单隐藏）。`/lang` 可切换中英文界面与命令描述。

### 3.1 会话

| 命令 | 参数 | 作用 |
|---|---|---|
| `/new` | 无 | 新开会话（无二次确认；旧会话可 `/resume` 恢复） |
| `/resume` | 无 | 打开**会话管理界面**（工作区栏 + 会话栏、实时筛选、固定常用、跨工作区）：切换会话只是**停放**，正在跑的回合不中断 |
| `/home` / `/agentview` / `/bg` | 无 | 同一个会话管理界面（`/home`=工作区视角 · `/agentview`=托管会话状态 · `/bg`=转后台并打开，别名 `/background`） |
| `/tree` | 无 | 会话分叉树：悬停预览、点击回退 / 分叉 / 切换分支 |
| `/fork` | 无 | 把当前会话复制成可恢复的副本（原会话不受影响） |
| `/restart` | 无 | 重启进程并恢复本会话（回合运行中会被拒绝，先 `Ctrl+C`） |
| `/kernel` | 无 | 内核选择器：在 DSH 与实验性的 Claude 后端之间切换，记住选择并重启进入新会话（回合运行中会被拒绝）；见 [Claude 后端](claude-backend.md) |
| `/rename` | `<新名称>` | 重命名当前会话（无参时显示当前标题与用法） |
| `/recap` | 无 | 最近活动摘要（一行）+ 建议标题；面板内 `a` 键或点击一键应用标题。设置 `dsh-tui.recapOnOpen`（默认开）开启时，打开/恢复会话自动在底部显示一条分隔线 + `回顾：` 摘要行，悬停可查看操作、点击展开，发送新消息后自动消失 |
| `/workspace` | `resume` / `rename <名称>` / `open <路径或URI>` | 管理工作区；`open` 支持绝对路径、file URI、插件 scheme |
| `/clear` | 无 | 清空当前会话视图（重置展开/选择状态） |
| `/compact` | 无 | 压缩会话历史（无可压缩内容时会提示） |
| `/export` | 无 | 导出会话为 Markdown 到工作目录 |
| `/btw` | `<问题>` | 侧问：单轮、无工具、不打断主回合、不写历史 |
| `/trace` | 无 | 打开轨迹场景（同 `Ctrl+T`） |
| `/rewind` | 无 | 回退选择器（同空输入双击 Esc 的时间回溯） |
| `/exit`（别名 `/quit` `/q`） | 无 | 退出 dsh-tui |

### 3.2 状态与诊断

| 命令 | 参数 | 作用 |
|---|---|---|
| `/context` | 无 | 已加载上下文明细（指令/运行时上下文/技能/工具等） |
| `/status` | 无 | 模型+effort、工作/空闲、会话 id、目录+git 分支、token、缓存命中率、上下文百分比、会话标题 |
| `/cost` | 无 | token 用量 + 缓存命中率 + 本会话估算（并入子代理）与「主会话/子代理」拆解；非官方/未收录模型只显示 token 并标注未计价（**估算是参考，以平台账单为准**） |
| `/balance` | 无 | DeepSeek 官方账户余额（免费只读接口）：摘要行 + hover 明细（同款本会话估算拆解：主会话/子代理/未计价），点击刷新、`×` 关闭 |
| `/config` | 无 | 配置来源：`cordis.patch.yml` 路径、启动方式、模型路由 |
| `/doctor` | 无 | 环境自检 |
| `/migrate` | `[agent] [--dry-run]` | 从其他编程代理（claude-code/codex/omp/zcode/grok-build）导入对话历史，子进程运行不卡界面，详见[会话迁移](migrate.md) |
| `/init` | 无 | 在工作目录创建 `AGENTS.md`（created / exists / failed 三态提示） |
| `/agents` | 无 | 本会话子代理列表 |
| `/jobs` | 无 | 后台任务面板：状态/运行时长/退出码实时跟踪，`↑/↓` 选择、`k` 停止；面板打开时 `Esc` **只关面板**不打断回合（想中断先关面板再 `Ctrl+C`） |
| `/settings` | 无 | 打开插件设置编辑器（命名空间读取/编辑） |
| `/setup` | 无 | 重跑首次引导向导（API Key / 语言主题 / 模型工作区 / 快捷键），与首次启动是同一个界面 |
| `/help` | 无 | 快捷键 + 命令帮助菜单（`?` 入口） |

### 3.3 模型 / 显示

| 命令 | 参数 | 作用 |
|---|---|---|
| `/channel` | 无 | 中转渠道档案（仅 Claude 后端），见 [交互与命令](interaction.md#渠道档案channel仅-claude) |
| `/model` | 无 | 模型选择器；**切换 = fork 会话续聊**（历史保留、仅换路由；还没有人说过话的会话不记分支，保留首个 prompt 的自动标题），选择持久化到 `~/.dsh-tui/model.json` |
| `/effort` | `status` / `<id>` | 推理强度：无参滑杆（`←/→` 实时调整）；`status` 当前档位；`<id>` 直接设定。持久化 `~/.dsh-tui/effort.json`；新会话起始档看 /settings 的 `effortDefault`（§5.3） |
| `/thinking` | 无 | 扩展思考显示开关（流式时思考逐条展开） |
| `/tokens` | 无 | 分三段报数，不再并列两个不同量：**本次请求**上传量（input + 缓存读 + 缓存写，harness 的四个桶互斥）、**会话累计**（未缓存输入 / 输出 / 缓存读 / 缓存写）、**上下文占用** |
| `/activity` | `frames <名>` / `status` | 工作状态行动画：无参选择器浏览，`frames <名>` 直接设置（含 `random`），默认 `moon8`。持久化 `~/.dsh-tui/working-activity.json` |
| `/preset` | `<id>` / `status` | Agent 预设切换：`standard` / `ptc`（旧 0.1.1 名 `code`）/ `minimal` / `cordis` / **梁神模式 `liangshen`**；**已开始的会话不可切换**。持久化 `~/.dsh-tui/agent-preset.json` |
| `/theme` | `<名字>` / `status` | 主题：无参选择器；`<名字>` 直接切换；`status` 当前主题（auto 时附 OSC 11 解析结果）。持久化 `~/.dsh-tui/theme.json` |
| `/color` | 无参 / `<名>` / `status` / `reset` | 会话强调色：无参打开调色板（`↑/↓` 选、`Enter` 应用）；`<名>` 直设；`reset` 恢复默认。颜色 `red/orange/yellow/green/blue/purple/pink/cyan`，按会话保存 |
| `/lang` | `en` / `zh` / `status` | 界面语言热切换。优先级：`DSH_TUI_LANG` > profile 配置（旧版 settings.yaml 用户层 > cordis.yml）> 持久化 |
| `/vim` | 无 | **vim 编辑模式开关**（见 §2.4）：输入框切到 vim 键位编辑，会话级、不持久化 |
| `/panel` | `toggle` / `focus` / `zoom` / `<面板 id>` | 侧栏面板：开关 / 聚焦 / 缩放 / 切换；三态与子命令见 §2.8 |

### 3.4 账号 / 策略 / 扩展

| 命令 | 参数 | 作用 |
|---|---|---|
| `/provider` | 无 | 交互式管理模型提供方（添加 / 编辑 / 删除；标准 profile 的账号登录含 DSH 0.2.0-rc.1+ 的 DeepSeek，以及 ChatGPT/Codex / Claude / Grok；宿主 pi-ai 支持时还有 OpenAI 直连 / Meta Muse） |
| `/auth` | `status` / `login [provider]` / `logout <provider>` | 查看账号状态、登录或登出（DeepSeek 用 `deepseek-account`；pi-ai 订阅用 `openai-codex` / `anthropic` / `xai`，较新 pi-ai 另有 `openai` / `meta`） |
| `/login` | 无 | 凭证状态（来源、存储可写性、base URL；OAuth 模块挂载时另列账号状态） |
| `/logout` | 无 | 登出说明（env 来源需删环境变量并重启） |
| `/permission` | 无 / `<preset>` / `status` | 查看/切换权限预设与策略（无参打开选择器） |
| `/add-dir` | 无 | 文件策略范围说明（以工作目录为根） |
| `/hooks` | 无 | 占位：DSH hooks 未在组合中挂载时给出说明 |
| `/mcp` | 无 | MCP 连接状态（工具按 `mcp__服务器__工具` 分组）；未配置时给出 `cordis.patch.yml` 插入示例 |
| `/skills` | 无 | 技能目录选择器（名称+来源+简述），Enter 将可直调技能以 `/name ` 填回输入行 |
| `/plugins` | `check <dsh-plugin.json 路径>` | 插件诊断：信任横幅 + host 描述符 + 授权矩阵 + 台账；`check` 校验清单文件并给兼容状态 |
| `/update` | 无 | 更新 TUI 并自动重启恢复会话（仅 `dsh --profile` 启动可用；回合运行中会拒绝） |
| `/terminal-setup` | 无 | 终端配置建议（Windows Terminal ≥110 列、粘贴键位） |

### 3.5 技能

dsh-TUI 不预装通用技能；`/skills` 浏览 DSH 发现的技能，可直调技能以 `/name` 加入命令菜单（详见 §4.8）。

### 3.6 占位命令

`/connect`：占位——DSH 暂无远程连接机制。

### 3.7 注册表命令（来自 DSH 生态，随组合动态并入 `/` 菜单）

| 命令 | 作用 |
|---|---|
| `/plan` | `[off\|message]` 计划模式；`/plan off` 退出 |
| `/goal` | 设置/查看会话目标 |
| `/feedback` | 提交使用反馈 |
| `/permission` | 查看/切换 DSH `permissionPresets` registry 的预设（第三方预设按 registry 顺序显示） |

> 这些命令由 DSH 命令注册表实现，本仓库只做菜单并入、补全与分发。

## 4. 会话工作流

### 4.1 会话生命周期

| 操作 | 命令/键 | 要点 |
|---|---|---|
| 新建 | `/new` | 无二次确认——旧会话已持久化，随时可 `/resume` 找回；顺带清空 resume 标记 |
| 恢复 | `/resume`（同 `/home` `/agentview` `/bg` 与输入框行首 `⌸`） | 三合一**会话管理界面**：`←/→` 切栏、打字筛选、`Enter` 进入、`Ctrl+N` 新建、`Ctrl+X` 停后台会话、行内 ★/☆ 固定。切换只是**停放**，回合继续跑；被其他终端占用的会话标红进不去（详见 §2.7） |
| 重命名 | `/rename <标题>` | 立即改名并持久化（写入 session/title 事件，会话管理界面里能读回） |
| 压缩 | `/compact` | 手动触发 compaction；**回合运行中拒绝**；minimal preset 下不可用；压缩点以 Divider 摘要行呈现 |
| 导出 | `/export` | 从完整 session log 导出 Markdown（含 thinking 与工具调用分节），文件 `dsh-tui-export-<时间戳>.md` 落在当前会话 cwd |
| 清屏 | `/clear` | 只清视图，不动会话日志 |
| 停止 | 会话管理界面 `Ctrl+X` | 停止光标所在的**后台**会话；当前终端正在用的会话停不了（想退出整个 TUI 用 `/exit` 或双击 `Ctrl+C`） |
| 退出 | `/exit`（或 `/quit` `/q`） | 空闲 `Ctrl+C` 双击或 `Ctrl+D` 双击也可退出；工作中中断迟迟不收敛时再按 `Ctrl+C`/`Ctrl+D` 强制退出 |

命令行恢复：`dsh-tui --resume`（最近会话）/ `dsh-tui --resume <id>`（指定会话）。
`-c` / `--continue` 等价。

### 4.2 时间回溯 rewind（双击 Esc）

**空输入时连按两次 `Esc`**（或 `/rewind`），进入回退选择器：

1. 选择器列出**你自己的消息**（最新在前），`↑/↓` + `Enter` 选中。
2. 若模型正在工作：先取消回合并等落定（最长 30s）。
3. 边界取该消息所属回合**开始之前**；**不能回退到第一条消息**。
4. 系统 fork 新会话并回放历史到回退点，**原消息放回输入框**供修改重发。
5. 回退分支留在 `/resume` 列表里，继续用当前模型路由 + 会话自己的 preset。

### 4.3 消息投递语义（模型工作中）

键位见 §2.1：
- `Enter` = **steer**（注入下一步边界，不中断）
- `Tab` = **follow-up**（排到回合后）
- `Ctrl+Enter` = **interrupt**（打断并发送）
- `Alt+Up` 取回最后一条未处理消息
- `↑` 召回到的消息若仍排在队列里，会一并把那条排队项撤回（同 `Alt+Up`，避免同一条发两遍）；已被本轮取走时只提示、不撤回
- `Esc`（有 pending）中断并重投
- `/btw …` 侧问永不打断主回合

### 4.4 侧问 /btw

`/btw <问题>`：复用当前上下文做**无工具、单轮**回答，**不写历史、不计 token**，主回合照常。
面板 `↑/↓` 滚动 · `c` 复制 · `Esc` 关闭。

### 4.5 轨迹场景（Ctrl+T / /trace）

整屏查看会话全程时间线（不污染 scrollback）；键位见 §2.7。

### 4.6 模型切换与预设

- `/model`：选择器。**切换 = fork 会话续聊**（历史保留、仅换路由，旧会话留在 `/resume`）；
  持久化 `~/.dsh-tui/model.json`。
- 回合运行中切换会被拒绝。
- `/preset` 可选：`standard`（默认全功能）、`ptc`、`minimal`（内核「极简模式」：只暴露一个持久 shell 工具，无 compaction、无计划模式；也因此没有压缩、工具结果不剪枝——长会话可能撞上下文上限，`/compact` 与问卷不可用，Help 与 `/` 补全会标注，进入该预设时提示一次）、
  `cordis`、`liangshen`（梁神模式）。
  **已产生对话的会话不能切换**（blank-only）：选择只保存为下次 `/new` 的默认。
  这里的 preset 是**内核 Agent 预设**，决定模型能用哪些工具；界面上的 `/settings → 极简界面`（Minimal UI）与它无关。
- 会话模式用 `Shift+Tab` 循环：default（workspace-write + 审批）→ plan（read-only）→
  full（danger-full-access）。
- 第三方权限预设按 registry 顺序排在末尾。
- **批准计划或 `/plan off` 之后，沙箱与审批策略回到进入计划模式之前的状态**。

### 4.7 问卷与审批

键位见 §2.7。要点：
- 问卷**最后一行是自由输入行**（直接打字连同选项标签一起提交）。
- 计划评审**批准必须无反馈文本**。
- 审批与问卷同时挂起时**审批优先**；后台会话发起的审批会标注 `来自后台会话 <会话 id 前 8 位>`。

### 4.8 技能 / 注册表 / Goals-Todos

- `/skills` 浏览技能目录，可直调技能以 `/name` 加入命令菜单（dsh-TUI 不自带通用技能）。
- `/plan` `/goal` `/feedback` `/permission` 来自 DSH 注册表，随组合并入 `/` 菜单。
- **Goals/Todos 面板自动出现**：模型写入 goal/todo 时在输入框上方实时渲染（🎯 目标 + phase 徽章 + 树形 todo），
  无需操作；分栏开启时它迁到右栏的 `todo` 面板（见 §2.8）。

### 4.9 MCP / Workspace / 其他

- `/mcp`：按服务器分组列出 `mcp__服务器__工具`；未配置时给出 `cordis.patch.yml` 插入示例。
- `/workspace`：`resume` / `rename <名>` / `open <路径|file:// URI>`（打开并新建会话）。
- `dsh-tui <路径>` 同样接受工作区目标。
- `/doctor` 自检：Node/平台、API key、模型路由、cwd、上下文窗口、会话存储、插件宿主。
- `/provider` 交互向导管理模型提供方：添加 / 编辑 / 删除。
  - 标准 profile 的内置 OAuth 模块提供 **订阅账号登录**（ChatGPT/Codex / Claude / Grok；较新 pi-ai 另有 OpenAI 直连 / Meta Muse，免 API key）；也可用 `/auth login <provider>`，`/auth logout <provider>` 删除保存的 OAuth 凭据。
  - DSH 0.2.0-rc.1+ 的 DeepSeek 账号经宿主浏览器授权：`/auth login deepseek-account`，随后用 `/model` 选独立的 `deepseek-account` 路由；`/auth logout deepseek-account` 由宿主退登。它不修改 `deepseek-official` 的 API key。
- 非环境变量 API key 写入 `~/.dsh/.credentials.yaml`（0600），界面只显示 `••••••`；pi-ai 订阅 OAuth 凭据另存于 `$DSH_HOME/dsh-auth/credentials.json`（未设置 DSH_HOME 时为 `~/.dsh/dsh-auth/credentials.json`）。DeepSeek 账号授权记录由宿主凭据服务持有，不写入此 OAuth 文件。
  - 自定义端点需填路由名、API key、baseURL 与协议（`openai-completions` / `openai-responses` /
  `anthropic-messages`）。
- 添加/编辑后运行 `/model` 切换到新路由。
- `/init` 创建 AGENTS.md；`/agents` 子代理列表；`/login` `/logout` 凭证管理。
- `/permission` `/add-dir` 权限说明；`/hooks` `/vim` `/connect` 为占位。

## 5. 界面与状态栏

空会话顶部是鲸鱼 Logo 区（随对话滚动消失）：

- **开场动画**（约 3.4 秒，每次启动三选一，`/deepseek` 彩蛋重掷）：经典 / 爱心 / 睡觉。
- **欢迎期闲置动画**（`whaleIdle`，默认开）：摆鱼鳍、眨眼、拍尾巴，空闲 10 秒入睡冒 Z；**点击冒爱心唤醒**。
- **女仆娘立绘**（`whaleGirl`，默认关）：把标题的像素鲸鱼换成作者绘制的女仆娘——**最优先**走终端图像协议（Kitty/Sixel）的真图渲染；终端不支持（如内联模式）时回落到字符画版女仆娘。**点她一下**会换成「高兴鲸娘」几秒再自动回安静版；开始第一个任务后定格、不再响应点击。
- 开始第一个 agent 任务后定格为静态帧（`/new` 重新进入欢迎期）。
- 鲸鱼右侧文字列：`✦ dsh-TUI v版本号` → 块体大字 `DEEPSEEK / HARNESS`（加粗字形，两行等宽、中间空一行）→
  当前模型 + effort → 工作目录 → 启动提示行。
- 大字字面按**本地日期**轮换（8 款：加粗 / 方角实心 / 半立体 / 宽体 / 点阵灰度 / 镂空模板 / 细笔 / 方板）：
  同一天内恒定、隔天换一款，与启动时刻无关。想固定看某一款，就在 `/settings → 开屏大字字体`
  （`splashFont`）选它——选具体某款即 pin 住，选回 `按天轮换`（默认）恢复轮换；改完立即生效。
- 版本不在验证范围时多出 **⚠ 版本漂移警告**（附对齐命令）。
- 鲸鱼下方居中欢迎语：`探索未至之境！`
- 终端变窄按**内容区列数**逐档降级：**≥ 97 列**鲸鱼 + 大字；**55–96 列**只留大字（先撤鲸鱼）；
  **40–54 列**只留鲸鱼；**< 40 列**退成一行 `DeepSeek Harness` 纯文字。门槛随字面宽度浮动
  （97 列是 6 列字身那几款的数；最宽的 `wide` 要 113 列，5 列的 `classic`/`slab` 96 列就够）。
- 像素鲸鱼原图与闲置行为移植自 [dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale)（作者
  [@lhh010](https://github.com/lhh010)），特此致谢。

**超长单行折叠**（默认开）

- **单行超过 1000 字符**的文本折叠为 `… 已折叠 N 字符（点击或 ctrl+o 展开）` 标记。
- 展开：**鼠标点这一行**（工具卡点卡面）再点收起；键盘用 `Ctrl+O`。
- 思考（thinking）行不折叠。

### 5.2 底部状态栏（输入框下方三行）

**Row 1 — 上下文分段进度条**（`/settings → statusBar.contextBar`，默认开）

- 按内容类型分段着色（system / prompt / assistant / thinking / tools）。
- 分段 token 数是**本地估算**（CJK/全角按 ~1.4 字符/token、ASCII 按 ~4 字符/token、其它脚本按 ~2），
  只描述这条由什么构成，**不参与占用总量**——占用以 ctx 字段/读数为准（见下）。
- 条上唯一文字是最右缘读数 `13k/64k 19.5%`（窄屏只显示 `19.5%`）。
- 读数按占用率变色：<80% 灰蓝，**≥80% 琥珀、≥95% 红**。
- 悬停整条弹出图例：色块 + 名称 + token 数（窄屏自动改用短名）。

**Row 2 — 状态字段行**（每个字段独立开关，见 `/settings`）
- 左组：模型 → TPS → thinking → mode → ctx（**上下文占用** `19.5% (13k/64k)`：与分段条、工作线压力前缀、`/tokens`、`/status` 和上下文告警**同读一个值**，来源是 harness 自带的 `contextPressure` 投影——`projectedTokens ?? pressureTokens`，即「下一次请求」的占用，压缩与被拒请求都会立刻反映，不再等一次成功请求；投影缺席的裸 `cordis.yml` 组合回退到上次请求的计费用量）→ cache 缓存命中率 → tokens（`1.2k→340` 输入→输出）→
  cost（`≈¥0.05 谷`，**本会话估算**：包含子代理用量，按各自模型 × 峰值/空闲 × 缓存分项计价；
  hover 拆「主会话 ¥ / 子代理 ¥ / 未计价 N tok」；非官方/未收录模型只显示 token 并标注未计价；
  **估算是参考，以平台账单为准**）
- 右组：git 分支 → 工作目录（紧凑模式仅 basename）→ 会话标题 → 短会话 ID（`#` + 前 8 位，方便 `--resume` 定位）
- `statusBar.compact` 时左右合并为单行。
- 默认开：compact、model、thinking、cwd、contextUsage、cache、cost、goal、contextBar。
- 默认关：tokens、tps、gitBranch、sessionTitle、sessionId、mode、activity、trajectory。

**Row 3 — 提示 / 工作活动 + 迷你轨迹条**
- 空闲显示 `? for shortcuts`、运行中 `esc to interrupt`、选择中 `esc to return to input`。
- 空闲还显示 working-activity 动画帧（`statusBar.activity` 开），上下文 ≥80% 琥珀、≥95% 红（与 ctx 字段同一占用读数）。
- 右侧**迷你轨迹条 MiniWake**（`statusBar.trajectory`，默认关）：会话投影为密度字形，颜色区分通道，失败列染红；
  窄屏降格/隐藏。

**TPS 仪表**（`statusBar.tps`，默认关）：流式中显示实时 gauge + `N tps`，回合后显示 sparkline；
速度 **≥50 绿 / ≥20 黄 / <20 红**。

### 5.3 /settings 设置编辑器

`/settings` 打开插件设置编辑器；**改动自动保存**，`Esc` 直接退出。
dsh-tui 自身区块在 0.1.7 写入当前 profile 的 `cordis.patch.yml`，旧版写入 settings.yaml 用户层。多数设置实时生效；全屏和图片预览开关需 `/restart`。
下表为常用项，完整列表见 /settings 屏。多数主题（**外观与布局** / **开屏与吉祥物** / **对话与输入** / **图表与图片**）的字段直接平铺在根页的小标题下，改起来不用进出子页；只有真正成块的域——**公式设置** / **底栏设置** / **侧栏** / **快捷键**——保留子页，根页一行入口点进去：

| 字段 | 说明 |
|---|---|
| lang | 界面语言 zh/en（DSH_TUI_LANG 钉死时不可改） |
| fullscreen | 全屏模式（默认开）；保存后用 `/restart` 生效 |
| minimal | 极简界面 Minimal UI（默认关）：隐藏开屏头部、emoji 状态符与装饰性配色，底栏只留模型与目录；代码高亮与工具配色保留。**这是界面开关**，对模型能力没有任何影响——别和 `/preset` 的内核「极简模式」预设搞混 |
| terminalImages | 终端图片预览（默认开，需终端支持）；保存后用 `/restart` 生效。关闭后只显示文字信息并跳过预览解码，不影响向模型发送图片 |
| imageBacking | 图片底色（默认 `transparent`，与上一条同在**图表与图片**主题下）：聊天照片/插图背后垫什么。透明：只画图片自己的像素，抗锯齿边缘和透明圆角透出终端底色或壁纸；终端底色：先合成到终端背景色，柔和边缘更平滑。立即生效 |
| codeFrameStyle | 代码框样式（默认 `light`）：`light` 左侧开放栏杆；`full` 带连续右边框和底边的封闭边框。终端太窄时显示纯代码围栏。立即生效 |
| whale | 开屏头部像素鲸鱼娘（默认开）；每次启动随机三选一开场动画（经典/爱心/睡觉），`/deepseek` 彩蛋重掷 |
| whaleIdle | 鲸鱼娘欢迎期闲置动画（默认开）：定格后摆鱼鳍/拍尾巴/眨眼，空闲 10 秒入睡冒 Z；点击冒爱心。开始第一个任务后定格 |
| splashFont | 开屏大字字体：按天轮换（默认，随本地日期换款）/ 加粗 / 方角实心 / 半立体 / 宽体 / 点阵灰度 / 镂空模板 / 细笔 / 方板。选某一款即固定那一款，选回「按天轮换」恢复。立即生效 |
| whaleGirl | 女仆娘立绘（默认关）：标题像素鲸鱼换成作者绘制的女仆娘**真图**（Kitty/Sixel 图像协议）；不支持时回落像素鲸鱼 |
| diffLayout | Edit/Write diff 布局：auto（≥110 列双栏）/ split / unified |
| thinkingFold | 思考块：preview（流式 2-3 行预览 + 落定折叠）/ full（展开到轮末） |
| btw.contextBudget | `/btw` 追问携带的最近问答总字符预算（默认 24000，范围 1000-200000）；超出时从最旧的整组开始裁剪。立即生效 |
| btw.contextTurns | `/btw` 追问显式携带的最近完成问答组数（默认 4，范围 1-8）；窗口外的问答不进入请求，线程与面板仍保留全文。立即生效 |
| jobGroupFold | 连续的后台任务卡：auto（默认，≥2 张成组；整组落定且 ≥3 张时折叠成汇总行）/ always（≥2 张立即折叠，含在跑的任务）/ never（从不自动折叠，每张卡都留着）。组头一行汇总状态与合计时长，点组头或 Ctrl+O 展开 |
| effortDefault | 默认推理强度：auto / off / low / high / max。新会话的起始档位（细节见下） |
| smoothStreaming | 流式平滑输出（默认开）：回复/思考/工具卡正文按 ~30fps 匀速揭示；回放/历史完整直出 |
| toolBackground | 工具卡背景强调：none / subtle / strong |
| turnUsageRow | 回合用量行（默认关闭）：在每回合末显示 token、缓存、耗时与重试摘要；`/tokens`、`/status` 和底栏 token 悬停不受此开关影响 |
| mermaidDiagrams | Mermaid 图表（默认开）：回复中的 ```` ```mermaid ```` 代码块画成字符图，流式期间逐步成形；比终端宽或类型不支持的图保留源码并注明所需列数。立即生效 |
| mathRendering | LaTeX 公式（默认 `auto`，在 `/settings` 的**公式设置**子页里）：回复中的 `$…$`、`\(…\)` 行内公式，`$$…$$`、`\[…\]` 与单独成行的 `\begin{align}` 等显示环境块级公式的显示方式。`auto` 用当前最好的渲染方式（目前是 Unicode 文本，块级公式里的分数与上下限竖排），`image` 在支持图形的终端里用 MathJax 把公式排版成图片——Kitty 图形协议（Kitty、Ghostty、WezTerm、iTerm2 等）或 Sixel（Windows Terminal 1.22+、xterm、foot、WezTerm）（颜色跟随主题文字色；块级公式最多 16 行，行内公式在能压成一行且不糊时也显示为一行高的图片；流式中的公式、暗色的思考区、不支持图形的终端、压成一行太小以及任何渲染失败都退回 Unicode），`unicode` 固定用 Unicode 文本，`source` 保留原始 TeX。不支持、仍在流式输出或比终端宽的公式保留源码（过宽的块级公式先退成单行）。价格（`$5`）、shell 变量（`$HOME`）与代码里的 `$` 不受影响。旧的 `latexMath: false` 仍等同 `source`。**点击公式图片**打开预览卡：按 2 倍单元格尺寸重排，可 100%–800% 缩放、拖拽平移，`Esc` 或点击卡片外关闭，标题即该公式的 TeX。Sixel 下公式**不带衬底**（只画笔画），终端底色或壁纸会透出来。标题立绘这类自带透明留白的插图同样不带衬底（`whaleGirl` 的真图就是这个行为）；照片、截图与卡片内的图像仍合成到底色上，因为 Sixel 表达不了软 alpha。立即生效 |
| mathImageScale | 公式图片大小（默认 `auto`，与上一条同在**公式设置**子页）：配合 LaTeX 公式的「图片」使用——`auto` 与正文同尺寸，`large` / `xlarge` 把**块级**公式排得更大；终端图片是按设备像素 1:1 画的，所以"更大"就等于"每个笔画更多像素"，是唯一的清晰度杠杆。行内公式不受影响（只能占一行）。立即生效 |
| scrollGutter | 转录边栏：timeline（轮次时间线，默认）/ scrollbar（比例滚动条）/ hidden。立即生效 |
| pageMargin | 页边距：整屏相对终端四边向里缩。预设 none / slim / normal（默认）/ roomy，或自定义 `NxM`（细节见下）。立即生效 |
| foldTerminalCommand | 折叠终端命令（默认关）：终端卡（Bash/PowerShell）多行命令折成首行 + 计数；`Ctrl+O` 或点击卡片展开 |
| expandEditor | 全屏草稿编辑（默认开）：输入行尾 `⛶` 或 `Ctrl+Shift+E` 展开成整屏编辑器；`Ctrl+Enter` 发送、`Esc` 收起（草稿还在）；关掉后入口不显示 |
| statusBar.* | 上表全部状态栏开关（compact/model/thinking/cwd/contextUsage/cache/tokens/cost/tps/gitBranch/sessionTitle/sessionId/mode/contextBar/activity/trajectory；statusBar.sessionId 是底栏显示开关，与 cordis 的启动 sessionId 无关） |

**effortDefault**：模型没有该档时自动就近降级并弹提示；优先级 settings 用户层 > cordis `effort` >
上次 `/effort`（effort.json）> 模型默认。

**scrollGutter**：scrollbar 轨道可直接拖；`Shift`/`Alt`/`Ctrl`+拖动仍是文字选择。

**pageMargin**：自定义 `NxM` = 左右 `N` 列、上下 `M` 行（上限 8x4）；只填 `N` 则上下 1 行。

未声明 TUI 区块的命名空间以只读形式列出，需手工编辑 profile 配置（旧版为 `~/.dsh/settings.yaml`）。
以下设置**不在 /settings 内**，改 `$DSH_HOME/profiles/dsh-tui/cordis.patch.yml`：
provider / model / cwd / preset / workspace / sessionId / modes，
以及启动级 `effort` 键。

### 5.4 终端要求

- 必须交互 TTY；推荐 Windows Terminal（≥110 列、等宽、TrueColor）。
- macOS 的 ⌘ 修饰键需要扩展键盘协议（iTerm2 / kitty / WezTerm / ghostty / tmux）。
- Terminal.app 用 Ctrl。
- VS Code：装 companion 扩展 `dsh-tui-vscode`（拿到 **IDE 选区通道**，需 ≥ 0.7.0）。
- 或直接在集成终端运行 `dsh-tui`。
- **图片**：缩略图与大图预览需要 Kitty graphics 或 Sixel（自动探测，Kitty 优先）。
  - `DSH_TUI_IMAGE_PROTOCOL=auto|kitty|sixel|none` 覆盖协议。
- `DSH_TUI_DISABLE_TERMINAL_IMAGES=1` 强制关闭。
  - tmux/screen、非 TTY、无障碍模式下只显示文字，不影响把图片发给模型。
- **粘贴剪贴板图片（Ctrl+V / Alt+V）**：Linux 需要 `wl-paste`（wl-clipboard）、`xclip` 或 `xsel` 之一。
  - WSL：WSLg 把 Windows 位图暴露为 `image/bmp`，dsh-tui 会转成 PNG 再附加。
  - 上面的工具读不到时，回退到 `powershell.exe`（需要 Windows interop）读取 Windows 剪贴板，
    支持截图、资源管理器复制的文件与文本。
- 环境自检：`/doctor`。

### 5.5 安全模式与救援 profile（`dsh-tui safe`）

dsh 意外退出时，安全模式给出**只读**的环境诊断、profile 插件清单和修复指引。

- **两个入口**：手动跑 `dsh-tui safe`；或 dsh 非零退出后按屏幕提示进入（非交互环境只打一行提示）。
- **只读范围**：诊断/清单/指引都不改状态。
- 例外：重试正常启动、创建/复用空白救援 profile（只写 `$DSH_HOME/profiles/dsh-tui-safe/`）。
- **救援 profile 先要证明干净**（无第三方插件、无 `cordis.patch.yml` 条目），证不出就拒绝并打印处理方法。
- **非交互**：`dsh-tui safe --rescue` 只报告结论（就绪退出 0，被拒绝退出 1）。
- **修复命令要自己执行**（安全模式只列出）：
  - `dsh plugin --profile dsh-tui remove <第三方插件>` 移除可疑插件。
  - `dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@<版本>` 重装对齐。
  - `dsh-tui doctor` 环境诊断。

## 6. 模型 / 预设 / 主题 / 语言

| 项 | 命令 | 说明 |
|---|---|---|
| 模型 | `/model` | 选择器；**切换 = fork 会话续聊**（历史保留、仅换路由）；持久化 `~/.dsh-tui/model.json`，重启与 `/new` 沿用。从没选过的话，用内置默认模型（当前为 `deepseek-flash`） |
| 推理强度 | `/effort` | 滑杆（←/→ 实时）或 `/effort <id>`；`/effort status` 看当前；新会话默认档在 /settings → 默认推理强度 |
| Agent 预设 | `/preset` | `standard` / `ptc`（旧 0.1.1 名 `code`）/ `minimal` / `cordis` / **梁神模式 `liangshen`**；**已开始会话不可切换** |
| 主题 | `/theme` | `auto`（OSC 11 跟随终端背景）/ `light` / `dark` / `dark-ansi`；`/theme <名>` 直接切；`/theme status` 看解析结果 |
| 自定义主题 | 手动 | `~/.dsh-tui/themes/<名>.json`，`{base, colors}` 格式，选中即热切换；命名为 `auto` 会被内置遮蔽 |
| 语言 | `/lang` | `en` / `zh` 热切换；优先级 `DSH_TUI_LANG` > profile 配置（旧版 settings.yaml 用户层 > cordis.yml）> 持久化 |
| 状态行动画 | `/activity` | 选择器或 `/activity frames <名>`；默认 `moon8`，`random` 随机 |

**主题优先级**：`DSH_TUI_THEME` > `~/.dsh-tui/theme.json` > OSC 11 终端背景检测 > dark 回退。

**~/.dsh-tui/ 偏好文件**（均 best-effort，坏文件回退默认）：

- `theme.json`、`model.json`、`agent-preset.json`、`effort.json`、`working-activity.json`、`lang.json`、
  `trajectory.json`、`resume.txt` / `last-used.json`、`themes/<名>.json`

**常用环境变量**：

- `DSH_TUI_LANG`、`DSH_TUI_THEME`、`DSH_TUI_PRESET`、`DSH_TUI_PERSONA`
- `DSH_TUI_DISABLE_MOUSE`、`DSH_TUI_DISABLE_TERMINAL_IMAGES`、`DSH_TUI_IMAGE_PROTOCOL`、
  `DSH_TUI_ACCESSIBILITY`（无障碍：关动画/图形预览）
- `DSH_TUI_RESUME_SESSION`、`DSH_TUI_WORKSPACE_TARGET`、`DSH_TUI_SESSION_ROOT`、`DSH_TUI_DEBUG`、
  `DSH_TUI_RENDER_LOG`（帧取证）
- `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`VISUAL`/`EDITOR`（`Ctrl+G` 外部编辑器）、
  `DSH_PERMISSION_MODE`

## 7. 常用技巧

**上手**

1. `?` 看快捷键、`/` 看命令，两者都支持 Tab 补全。
2. 不确定环境对不对？先 `/doctor`；想看会话全貌用 `/status`。
3. 中英界面 `/lang en|zh`，即时生效并持久化。

**效率**

4. 模型工作中三种投递：`Enter` 注入下一步、`Tab` 排队、`Ctrl+Enter` 打断并发送。
5. `Alt+Up` 取回最后一条未处理消息改完重发，不用重打。
6. 想快速问又不打断主回合、不留历史：`/btw <问题>`。
7. 打错了想重来：**空输入双击 `Esc` 时间回溯**（或 `/rewind`），改完重发。
8. `@` 在消息任意位置补全文件，`@src/a.ts#L12-14` 精确引用行区间。
9. `Ctrl+A` 子代理面板：`Enter` 看详情、`X` 中断运行中的子代理。
10. `Ctrl+O` 展开/收起详情；`Ctrl+T` 看轨迹（`[`/`]` 跳失败点、`/` 字段查询）。

**排障**

11. 上下文压力 ≥80% 变琥珀、≥95% 转红——该 `/compact` 了（minimal 预设不可用）。
12. 会话管理界面（`/resume`、`/home`、`/agentview`、`/bg` 或输入框行首 `⌸`）：
    打字筛选、`★` 固定、`Ctrl+X` 停后台会话；切换只是**停放**。
13. 回合运行中 `/compact`、`/model`、`/restart` 会被拒绝——先 `Ctrl+C` 或等回合结束。
14. `/model` 切换 = fork 续聊（历史保留），持久化后重启与 `/new` 沿用。

**问手册**

15. 不确定某个功能怎么用，**直接问会话里的 AI**：这份手册随包发布，回答会给出处；
    想明确指定走手册，可以打 `/dsh-tui-guide <问题>`。手册正文只在被问到时才读进
    上下文，平时不占额度。（绕过 `dst`/`dsh-tui` 启动器、直接跑
    `dsh --profile dsh-tui` 时不带手册。）

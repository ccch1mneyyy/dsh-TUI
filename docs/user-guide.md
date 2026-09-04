# dsh-TUI 使用说明

> 面向日常用户的操作手册：启动、键位、命令、会话工作流、界面指标与常用技巧。
> 本文基于当前仓库代码与文档整理；配置行为最终以 `package.json`、`cordis.patch.yml`
> 和实际 DSH 组合为准。
>
> 英文版待补充（见 [docs/README.md](README.md) 约定）。

## 目录

- [1. 快速上手](#1-快速上手)
- [2. 快捷键速查](#2-快捷键速查)
- [3. 命令全集](#3-命令全集)
- [4. 会话工作流](#4-会话工作流)
- [5. 界面与状态栏](#5-界面与状态栏)
- [6. 模型 / 预设 / 主题 / 语言](#6-模型--预设--主题--语言)
- [7. 常用技巧](#7-常用技巧)

---

## 1. 快速上手

### 1.1 安装与启动

```sh
# 全局安装 CLI + 本插件（插件自带 dsh-tui 直达命令）
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui

# 启动（首次运行自动初始化 dsh-tui profile，需 pnpm）
dsh-tui
```

- `dsh-tui --resume`：恢复上次会话；Windows 可用仓库里的 `dsh-tui.cmd`（等价）。
- `dsh --profile dsh-tui`：与 `dsh-tui` 等价的手工启动方式（`/update` 仅此方式可用）。
- 运行模型需要 `DEEPSEEK_API_KEY`；环境自检用 `/doctor`。
- 已验证的 dsh 引擎版本：`0.1.2-rc.1`，以及 `0.1.2-alpha.3/4/5`、
  `0.1.0-rc.6/7/8`、`0.1.1-rc.1/2` 兼容线。
  更老或更新的版本仍可启动，但 logo 页会提示版本漂移并给出对齐命令。

### 1.2 首次启动你会看到

1. **像素鲸鱼顶栏**（约 3.4 秒开场动画：眨眼 → 喷水 → 摇尾，之后定格）：旁边是
   `✦ dsh-TUI` 版本号、`DEEPSEEK / HARNESS` 大字、当前模型与 effort、工作目录，
   以及一行**启动提示**（`/model` 切换模型 · `/help` 查看命令 · `Tab` 自动补全）。
   终端宽度 < 64 列时鲸鱼隐藏、仅保留文字列。
   若 dsh 引擎版本不在验证范围内，提示行下方会出现一行 **⚠ 版本漂移警告**
   （更新/更旧/混装/异常四形态），附对齐命令（`npm i -g @deepseek-ai/dsh@<版本>`）。
2. **底部状态栏**：工作状态行、上下文进度条、TPS 仪表与各类实时指标（见
   [5. 界面与状态栏](#5-界面与状态栏)）。
3. 输入 `/` 看命令菜单，按 `?` 看快捷键帮助。

### 1.3 核心心智模型

- TUI 只负责交互与呈现；**会话日志是对话真源**，模型调用、工具执行、fork/resume、
  压缩与持久化由 DSH 服务负责（`/status` 可看会话信息）。
- 几乎所有命令都可以**用 Tab 补全**；命令带参数时先输入 `/命令 `（带空格）再 Tab。
- 输入任意非命令内容就是普通对话；**未知命令会作为普通消息发给模型**（如
  `/permission` 未挂载的组合里）。

---

## 2. 快捷键速查

> 表内 `Ctrl` 在 macOS 上大多可换 `⌘`（`⌘V` `⌘O` `⌘R` `⌘T` `⌘L` `⌘Enter` 等）；
> `Ctrl+C` / `Ctrl+D` 保持 Ctrl 不变。`⌘` 需要扩展键盘协议（iTerm2 / kitty /
> WezTerm / ghostty / tmux），macOS Terminal.app 请用 Ctrl。

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
| `Ctrl+R`（⌘R） | 历史消息搜索；重复按或 `↓` 到下一匹配；`Enter` 回填输入框 |
| `/`（转录态） | 会话全文搜索；`n` / `N` 跳转（仅 Ctrl+O 展开态） |

### 2.4 输入编辑

| 键 | 功能 |
|---|---|
| `←` / `→` | 按字符移动光标（有选区时坍缩到选区对应边缘） |
| `Ctrl+←` / `Ctrl+→`（⌘←/→） | 按词跳转 |
| `Home` / `End`，`Ctrl+E` | 逻辑行首 / 行尾（`Ctrl+A` 已改用于子代理面板，见 §2.7） |
| `Ctrl+U` / `Ctrl+K` | 删除光标前（至行首）/ 光标后（至行尾） |
| `Ctrl+W` | 删除前一个单词 |
| `Backspace` / `Delete` | 删前一 / 后一字符；**有选区时删除整个选区** |
| `↑` / `↓` | 多行时行间移动；单行时浏览输入历史（50 条） |
| `Ctrl+V`（⌘V）/ `Alt+V` | 粘贴：文本 / 文件路径（图片自动 `@` 引用）/ 剪贴板位图（`[Image #N]` 附件）；终端拦截 `Ctrl+V` 时用 `Alt+V` |
| `Ctrl+G` | 用 `$VISUAL`/`$EDITOR` 外部编辑器编辑输入（`:cq` 保留原稿；未设置变量时提示配置） |
| `/vim` | **vim 编辑模式开关**（会话级、不持久化）：开启后输入框显示 `INSERT` 徽标，`Esc` 切 `NORMAL`，`i/I/a/A/o/O` 回 INSERT。NORMAL 下：`h/l` 左右、`j/k` 上下行、`0/^/$` 行首/首个非空/行尾、`w/b` 词间移动、`x/X` 删字符、`d` 待第二键（`dd` 删整行含换行 / `d$` 删至行尾 / `d0`、`d^` 删至行首 / `dw` 删至词尾）、`u` 撤销、`/` 打开命令菜单、`?` 空输入开帮助、`Enter` 发送照常；未识别键忽略（不插入）。normal 下 `Esc` 无操作，清空用 `Ctrl+C` 或 `dd` |
| 打字 | **有选区时替换整个选区**（标准编辑器语义），光标落在插入文本之后 |
| 右键 / `Ctrl+Shift+V` | 终端原生粘贴（含换行原样插入） |
| `Esc`（输入框） | 层级：关帮助 → 关命令菜单 → 关文件菜单（仅当前 `@` token）→ **有选区仅清选区（文本不动）** → 中断重投 → 有输入清空 → 双击=时间回溯 |
| 双击 `Esc`（空输入） | **时间回溯 rewind**（3s 窗口内按两次） |

### 2.5 导航 / 模式

| 键 | 功能 |
|---|---|
| `Shift+Tab` | 循环会话模式（默认 → plan 计划 → full 完全访问） |
| `Shift+↑` | 消息选择模式（`↑/↓` 移动，`Enter` 展开单条，`Esc` 退出） |
| `Ctrl+T`（⌘T） | 打开轨迹场景（同 `/trace`） |

### 2.6 鼠标（fullscreen 全屏模式；拖拽/双击/三击即选即复制）

| 操作 | 功能 |
|---|---|
| 左键拖拽 | 选文本，**松开即复制**（OSC 52 + wl-copy/xclip/xsel 兜底），自动取消选区 |
| 双击 / 三击 | 选词 / 选行，即选即复制 |
| **输入框内拖拽** | 建立输入框选区并高亮渲染（caret 跟随拖拽末端）；`Backspace`/`Delete` 删选区、打字替换选区、`←/→` 坍缩到对应边缘、`Esc` 仅清选区；拖拽只映射可见行（不做边缘自动滚动）；折叠块存在时选区钳制在 head 或 tail 一侧、不跨 chip 行 |
| **输入框 Shift+click** | 从选区头（无选区时为光标）扩展到点击处 |
| **输入框双击** | 选词（组件内自检测，500ms / 1 格；路径与标点连串整选） |
| **输入框 `Ctrl+C`（有选区）** | 复制选区到剪贴板（OSC 52 + 原生工具兜底）并保留选区继续编辑 |
| 滚轮 | 滚动消息列表（±3 行/格）；**有文本选区时随内容平移选区**（双向，两端越出视口自动取消选区） |
| `Esc` | 取消选区（不复制） |
| 单击消息行 | 展开/收起该行 |
| 单击「加载更早消息」/「ctrl+e 显示前 N 条」 | 加载更早消息 / 展开全部 |
| 单击 StickyHeader / 「↓ N new messages」 | 跳回固定消息处 / 滚动到底部 |
| 单击超链接 | 打开浏览器 |
| 悬停截断内容 | 在工具卡标题、换行的用户消息或会话标题上停留约 600ms，浮层显示完整内容；移开或终端 resize 后立即关闭 |
| 键盘扩展选区 | 有选区时 `Shift+←/→/↑/↓/Home/End` 扩展/收缩（跨行环绕） |

### 2.7 各场景键位

**问卷（模型 ask_user_question）**
`↑/↓` 选择 · `Space` 多选勾选 · `Tab` 切自定义回答 · `Enter` 提交 · 第 2 题起 `Esc` 返回上一题 · 第 1 题 `Esc` 或任意题 `Ctrl+C` 取消整批提问

**计划评审（plan review）**
`↑/↓` 移动 · `1`/`2` 数字快选（反馈为空时）· 打字=反馈 · `Enter` 提交 · `Esc` 打断评审
（批准行带反馈会报错——批准必须无反馈）

**工具审批（approval）**
`↑/↓` 移动 · `1` 允许（仅本次）/ `2` 拒绝 · `Enter` 提交 · `Esc`/`Ctrl+C` 拒绝

**/resume 工作目录 / 会话浏览器**
顶部始终显示当前工作目录；`←` 或点击目录行进入目录选择，`↑/↓` 选择、`Enter/→` 查看该目录会话；≥120 列时目录栏常驻。
会话层：打字=实时搜索 · `↑/↓` 与 `PgUp/PgDn` 移动 · `Enter` 恢复 · `Tab` 预览开关 · `⌘A` 当前/全部目录快切 ·
`Ctrl+B` 本分支 · `Ctrl+S` 折叠子 agent 运行 · `Ctrl+P` 固定/取消固定（也可点击 ★/☆）· `Ctrl+R` 重命名 · `Ctrl+D` 删除 · `Ctrl+X` 清空壳；
**右键点击会话行弹出操作菜单**（打开 / 固定或取消固定 / 重命名 / 删除，`↑/↓` 选择 · `Enter` 执行 · `Esc` 或点击别处关闭）；固定项持久化到 `~/.dsh-tui/session-pins.json`，展开的子 agent 运行也可独立置顶；
`Esc` 依次清空搜索、关闭预览、退出，目录层 `Esc` 返回会话层

**历史搜索（Ctrl+R）**
`↑/↓` 选择 · 重复 `Ctrl+R` 或 `↓` 下一项 · `Enter` 回填 · `Esc`/`Ctrl+C`/`Ctrl+D` 取消

**轨迹场景（Ctrl+T / /trace）**
`↑/↓` 与 `PgUp/PgDn` 移动 · `←/→`（或 `h`）切换 timeline/hotspot · `[`/`]` 跳上/下一个失败点 ·
`{`/`}` 跳上一轮/下一轮 · `/` 查询行（`tool:` `kind:` `turn:` `err:` `run:` `>10s` `tok>1k` 前缀）·
`m` 循环投影模式 · `g`/`G` 顶/底 · `Enter` 展开详情 · `j`/`k` 详情翻页 · hotspot 视图 `t` 排序 ·
`q`/`Esc` 退出（Esc 三层：收详情→清查询→关闭）

**/settings 设置面板**
`↑/↓` 移动 · `Enter` 展开/切换/编辑 · 改动自动保存，`Esc` 直接退出

**/btw 侧问面板**
`↑/↓` 滚动 · `Space`/`Enter`/`Esc` 关闭 · `c` 复制答案 · 等待中 `Esc` 取消

**/effort 滑杆**
`←/→` 实时调整（Esc 不还原）· `Enter`/`Esc` 完成

**@ 文件补全**
`@` 在消息任意位置触发 · `↑/↓` 移动 · `Tab`/`Enter` 接受 · 目录可继续深入 ·
`Esc` 只关当前 token 菜单
- **两种查询模式**：路径形输入（`@src/` `@./` `@~/` `@D:\`，含任意路径分隔符）只列该目录；
  普通片段走**模糊子序列匹配**（前缀/边界加权，`@ink` 也能命中 `src/ink/Box.js`）。
- 文件与目录**双预算各 100**；接受按条目类型判定（文件=插入引用、目录=继续深入）。
- 粘贴/输入图片路径自动变 `[Image #N]` 附件。

**子代理面板（Ctrl+A）**
`↑/↓` 浏览 · `Enter` 查看详情 · `Esc` 关闭；详情页 `←/→` 翻页（概览 / 输出流 / 工具与 token），
运行中可按 `X` 中断 · `Esc` 返回。聊天流里子代理以卡片行实时展示（运行中三行瀑布，
落定后折叠为标题行；对应的 Task 工具卡被抑制）。

**双击 Esc 时间回溯（rewind）**
列表 `↑/↓` + `Enter` 进入确认 · 确认页 `Enter` 回退 / `Esc` 返回 · 插件决策等待中只响应 `Esc`

---

## 3. 命令全集

命令菜单 = 内置命令（50 条） + DSH 注册表命令（`/plan` `/goal` 等） + 技能目录
（仅补全，`/help` 菜单隐藏）。`/lang` 可切换中英文界面与命令描述。

### 3.1 会话

| 命令 | 参数 | 作用 |
|---|---|---|
| `/new` | 无 | 新开会话（无二次确认；旧会话可 `/resume` 恢复） |
| `/resume` | 无 | 打开会话浏览器（搜索、预览、跨项目、折叠子 agent 运行、固定常用会话） |
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
| `/cost` | 无 | token 用量 + 缓存命中率（DSH 不提供费用计量） |
| `/balance` | 无 | DeepSeek 官方账户余额（免费只读接口）：摘要行 + hover 明细（各币种赠送/充值拆分、当前计费时段与单价、本会话 token 与花费估算），点击刷新、`×` 关闭。密钥经 DSH 凭据解析（`DEEPSEEK_API_KEY`，环境变量兜底），仅在请求头中使用 |
| `/config` | 无 | 配置来源：`cordis.patch.yml` 路径、启动方式、模型路由 |
| `/doctor` | 无 | 环境自检 |
| `/init` | 无 | 在工作目录创建 `AGENTS.md`（created / exists / failed 三态提示） |
| `/agents` | 无 | 本会话子代理列表 |
| `/jobs` | 无 | 本会话后台任务面板（`run_in_background` 启动的命令）：状态/运行时长/退出码实时跟踪，`↑/↓` 选择、`k` 停止选中任务；转录流内嵌任务卡（有输出时显示最多三行瀑布、无输出时仅头行，点击进面板），状态栏有运行数角标，任务落定弹 toast。输出来自 agent `job_output` 读取的镜像，非实时 tail |
| `/settings` | 无 | 打开插件设置编辑器（命名空间读取/编辑） |
| `/help` | 无 | 快捷键 + 命令帮助菜单（`?` 同款） |

### 3.3 模型 / 显示

| 命令 | 参数 | 作用 |
|---|---|---|
| `/model` | 无 | 模型选择器；**切换 = fork 会话续聊**（历史保留、仅换路由），选择持久化到 `~/.dsh-tui/model.json` |
| `/effort` | `status` / `<id>` | 推理强度：无参滑杆（←/→ 实时调整）；`status` 当前档位；`<id>` 直接设定。持久化 `~/.dsh-tui/effort.json` |
| `/thinking` | 无 | 扩展思考显示开关（流式时思考逐条展开） |
| `/tokens` | 无 | token 用量 + 上下文百分比 |
| `/activity` | `frames <名>` / `status` | 工作状态行动画：无参选择器；`frames` 列全部预设；`frames <名>` 直接设置。帧名 30 个（`random` 随机 + `claude/star2/sand/triangle/box/box2/corners/point/layer/flip/aesthetic/hamburger/moon/moon8/comet/breathe/dots/arrow/spark/bar/braille/arc/circle/grow/noise/bounce/rainbow/dqpb/toggle`，默认 `moon8`）。持久化 `~/.dsh-tui/working-activity.json` |
| `/preset` | `<id>` / `status` | Agent 预设切换：官方 `standard` / `ptc`（0.1.2；旧 0.1.1 名为 `code`）/ `minimal` / `cordis` + TUI 打包**梁神模式 `liangshen`** + 用户自定义；`ptc` / `code` 可跨版本兼容解析；**已开始的会话不可切换**（blank-only 锁定）。持久化 `~/.dsh-tui/agent-preset.json` |
| `/theme` | `<名字>` / `status` | 主题：无参选择器；`<名字>` 直接切换；`status` 当前主题（auto 时附 OSC 11 解析结果）。持久化 `~/.dsh-tui/theme.json` |
| `/color` | 无参 / `<名>` / `status` / `reset` | 会话强调色：**无参打开调色板选择器**（8 色 + 色点预览，`↑/↓` 选择、`Enter` 应用）；`<名>` 直接设置；`status` 当前；`reset` 恢复主题默认。输入框边框 + 会话名标签变色（标签显示在输入框顶边框**右上角**，**默认关闭**，`/settings` 的「会话名标签」可开启；`red/orange/yellow/green/blue/purple/pink/cyan`）。按会话经 `session/color` 事件保存，resume/rewind 后仍在 |
| `/lang` | `en` / `zh` / `status` | 界面语言热切换。优先级：`DSH_TUI_LANG` > settings.yaml > cordis.yml > 持久化 |
| `/vim` | 无 | **vim 编辑模式开关**（见 §2.4）：输入框切到 vim 键位编辑，会话级、不持久化 |

### 3.4 账号 / 策略 / 扩展

| 命令 | 参数 | 作用 |
|---|---|---|
| `/provider` | 无 | 交互式管理模型提供方向导（添加 / 编辑 / 删除；捆绑 dsh-auth 挂载时添加分支多出**订阅 OAuth 登录**——ChatGPT / Claude / Grok 免 API key 登录 / 登出；编辑单项只原地修补该字段、其余配置原样保留；持久化 profile，API key 非环境变量来源时才写入密钥库） |
| `/login` | 无 | 凭证状态（来源、存储可写性、base URL） |
| `/logout` | 无 | 登出说明（env 来源需删环境变量并重启） |
| `/permission` | 无 / `<preset>` / `status` | 查看当前权限预设与策略说明；无参时打开由 DSH `permissionPresets` registry 提供的选择器，参数通过官方命令切换。服务缺失时使用 legacy 三项名册，挂载但损坏时 unavailable；外部命令未注册时沿用默认命令/model dispatch |
| `/add-dir` | 无 | 文件策略范围说明（以工作目录为根） |
| `/hooks` | 无 | 占位：DSH hooks 未在组合中挂载时给出说明 |
| `/mcp` | 无 | MCP 连接状态（工具按 `mcp__服务器__工具` 分组）；未配置时给出 `cordis.patch.yml` 插入示例 |
| `/skills` | 无 | 技能目录选择器（名称+来源+简述），Enter 将可直调技能以 `/name ` 填回输入行 |
| `/plugins` | `check <dsh-plugin.json 路径>` | 插件诊断：信任横幅 + host 描述符 + 授权矩阵 + 台账；`check` 校验清单文件并给兼容状态 |
| `/update` | 无 | 更新 TUI 并自动重启恢复会话（仅 `dsh --profile` 启动可用；回合运行中会拒绝） |
| `/terminal-setup` | 无 | 终端配置建议（Windows Terminal ≥110 列、粘贴键位） |

### 3.5 技能

dsh-TUI 不预装通用技能。`/skills` 浏览 DSH 从当前 profile、用户与项目发现的
技能；可直调技能以 `/name` 加入命令菜单，参数原样随行（详见 §4.8）。

### 3.6 占位命令

| 命令 | 说明 |
|---|---|
| `/connect` | 占位：DSH 暂无远程连接机制 |

### 3.7 注册表命令（来自 DSH 生态，随组合动态并入 `/` 菜单）

| 命令 | 作用 |
|---|---|
| `/plan` | `[off\|message]` 计划模式；`/plan off` 退出 |
| `/goal` | 设置/查看会话目标 |
| `/feedback` | 提交使用反馈 |
| `/permission` | 查看/切换 DSH `permissionPresets` registry 的预设；第三方预设按 registry 顺序显示，`custom` 只作为当前态，不是选择目标；服务缺失时使用 legacy 三项名册，服务已挂载但损坏时标记 unavailable；外部命令未注册时沿用默认命令/model dispatch |

> 这些命令的行为由 DSH 命令注册表实现，本仓库只做菜单并入、补全与分发；
> 未知命令会作为普通消息发给模型。

---

## 4. 会话工作流

### 4.1 会话生命周期

| 操作 | 命令/键 | 要点 |
|---|---|---|
| 新建 | `/new` | 无二次确认——旧会话已持久化，随时可 `/resume` 找回；顺带清空 resume 标记 |
| 恢复 | `/resume` | 全屏工作目录 / 会话浏览器：顶部目录范围可点击，`←` 进入目录选择、`Enter/→` 查看；宽屏目录栏常驻；打字搜索当前层，`Enter` 恢复、`Tab` 预览、`⌘A` 当前/全部目录快切、`Ctrl+B` 本分支、`Ctrl+S` 子 agent、`Ctrl+R` 重命名、`Ctrl+P` 固定/取消固定、`Ctrl+D` 删除、`Ctrl+X` 清理空壳；右键会话行弹出打开/固定/重命名/删除菜单。固定会话组成「已固定」分组置顶显示（组内按最近活动排序），行内 ★/☆ 或 `Ctrl+P` 切换，持久化到 `~/.dsh-tui/session-pins.json`；删除会话自动清 pin，已不存在会话的 pin 记录惰性忽略。长前置上下文的旧会话会渐进恢复真实标题，不再固定显示目录名 |
| 重命名 | `/rename <标题>` | 立即改名并持久化（写入 session/title 事件，浏览器可读回） |
| 压缩 | `/compact` | 手动触发 DSH compaction；**回合运行中拒绝**；minimal preset 下不可用；压缩点以 Divider 摘要行呈现。压缩进行中切换会话（`/model`、`/resume`、`/rewind`、`/fork`、`/new`）会**先取消压缩再快照**——后台不再有静默提交的压缩；摘要默认用当前路由模型（换模型后即用新模型压缩）。"压缩已生效但落盘失败"会明确提示，不再误报为压缩失败 |
| 导出 | `/export` | 从完整 session log 导出 Markdown（含 thinking 与工具调用分节），文件 `dsh-tui-export-<时间戳>.md` 落在当前会话 cwd |
| 清屏 | `/clear` | 只清视图，不动会话日志 |
| 删除 | `/resume` 里 `Ctrl+D` | 删除日志目录与 MRU 条目（有确认） |
| 退出 | `/exit`（或 `/quit` `/q`） | 空闲 `Ctrl+C` 双击或 `Ctrl+D` 双击也可退出；工作中中断迟迟不收敛时再按 `Ctrl+C`/`Ctrl+D` 强制退出 |

命令行恢复：`dsh-tui --resume`（最近会话）/ `dsh-tui --resume <id>`（指定会话）；`-c` / `--continue` 等价。

### 4.2 时间回溯 rewind（双击 Esc）

**空输入时连按两次 `Esc`**（或 `/rewind`），进入回退选择器：

1. 选择器列出**你自己的消息**（最新在前，侧问行除外），`↑/↓` + `Enter` 选中。
2. 若模型正在工作：先取消回合并等落定（最长 30s）。
3. 边界取该消息所属回合**开始之前**；**不能回退到第一条消息**。
4. 系统 fork 新会话并回放历史到回退点（token/进度归零），**原消息放回输入框**供修改重发。
5. 回退后的分支**不算子 agent**（无 origin 标记），留在 `/resume` 列表里；继续用当前模型路由 + 会话自己的 preset。

> 有内容时双击 Esc 是清空输入；`Esc` 在输入框的完整层级：
> 关帮助 → 关命令菜单 → 关文件菜单 →（工作+pending）中断重投 → 有输入清空 → 空输入双击=rewind。

### 4.3 消息投递语义（模型工作中）

- `Enter` = **steer**：注入当前回合的下一步边界，不中断。
- `Tab` = **follow-up**：排进当前回合之后处理。
- `Ctrl+Enter` = **interrupt**：打断并立即发送。
- `Alt+Up` = 取回最后一条未处理消息到输入框（不中断）。
- `Esc`（有 pending）= 中断并立即重投 pending。
- `/btw …` 工作中 Enter 直接执行——侧问永不打断主回合。

### 4.4 侧问 /btw

`/btw <问题>`：复用当前会话完整上下文做**无工具、单轮**回答。
**不写会话历史、不计 token**，关闭面板即消失；主回合照常进行。
面板：`↑/↓` 滚动 · `Space`/`Enter`/`Esc` 关闭 · `c` 复制答案 · 等待中 `Esc` 取消。
再次触发会中止上一个侧问。

### 4.5 轨迹场景（Ctrl+T / /trace）

整屏场景（不污染 scrollback），查看会话全程的时间线：

- `←/→`（或 `h`）切换 时间线 / 热点；`↑/↓` 与 `PgUp/PgDn` 移动；`g`/`G` 首尾；`Enter` 展开详情（`j`/`k` 滚动）。
- `[`/`]` 跳上/下一个失败点；`{`/`}` 跳上一轮/下一轮；`m` 循环投影模式（等分/墙钟/压缩空闲）。
- `/` 打开**字段查询**：`tool:web_search` `kind:retry` `turn:9` `err:` `run:` `>10s` `tok>1k`，多条 AND，命中列原位高亮。
- 热点视图：`↑/↓` 选行，`t` 循环排序（耗时/次数/token），`Enter` 跳回时间线定位。
- `q`/`Esc` 退出（Esc 三层：收详情 → 清查询 → 关闭）。
- 首次使用前状态栏迷你轨迹条旁有 `ctrl+t` 提示，打开过即永久退休；
  未读失败只标注在**最新一条**失败工具行上。

### 4.6 模型切换与预设

- `/model`：选择器，**切换 = fork 会话续聊**（历史保留、只换 provider/model 路由，preset 不变）；旧会话留在 `/resume`；选择持久化 `~/.dsh-tui/model.json`。运行时切换被拒绝。
- `/preset`：`standard`（默认全功能）/ `ptc`（PTC）/ `minimal`（仅 bash+编辑器，无 compaction）/ `cordis`（创造模式）/ `liangshen`（梁神模式：首轮最小双工具，首次工具调用后开放全目录）。0.1.2 名册会把旧版 `code` 作为 `ptc` 的兼容别名；旧 0.1.1 名册仍使用 `code` 真名。
  **已产生对话的会话不可切换**（blank-only：选择只保存为下次 `/new` 的默认）。
- 会话模式 `Shift+Tab` 循环三档：default（workspace-write + 审批）→ plan（read-only）→ full（danger-full-access）。

### 4.7 问卷与审批

**问卷（模型 ask_user_question）**：面板独占键盘；`↑/↓` 选选项、`Space` 多选、
`Enter` 提交。**最后一行是自由输入行**——在选项行直接打字 = 附加该选项标签 + 自定义文本一起提交；
`Tab` 直达输入行。第 2 题起按 `Esc` 返回上一题并保留草稿；第 1 题按 `Esc`，或任意题按 `Ctrl+C`，取消整批提问（模型收到 ASK_CANCELLED）。
计划评审卡片：`1`/`2` 数字快选；**批准必须无反馈文本**（带反馈视为"继续规划"）。

**工具审批**：命令申请权限提升时弹出审批条（工具名 + 完整命令 + 原因）。
`↑/↓` 选择 · `1` 允许（仅本次）/ `2` 拒绝 · `Enter` 提交 · `Esc`/`Ctrl+C` 拒绝。
审批与问卷同时挂起时**审批优先**；协议只有"允许一次/拒绝"，无"总是允许"。

### 4.8 技能 / 注册表 / Goals-Todos

- `/skills` 浏览 DSH 发现的技能目录；可直调技能以 `/name` 加入命令菜单并由 host
  加载正文，参数原样随行。dsh-TUI 不自带通用技能。
- `/plan` `/goal` `/feedback` `/permission`：来自 DSH 命令注册表，随组合并入 `/` 菜单。
- **Goals/Todos 面板自动出现**：模型写入 goal/todo 时在输入框上方实时渲染（🎯 目标 + phase 徽章 +
  树形 todo 最多 8 行），无需任何操作；agent 空闲时自动隐藏已完成项。

### 4.9 MCP / Workspace / 其他

- `/mcp`：按服务器分组列出 `mcp__服务器__工具`；未配置时给出 `cordis.patch.yml` 插入示例。
- `/workspace`：`resume` / `rename <名>` / `open <路径|file:// URI>`（打开并新建会话）；
  `dsh-tui <路径>` 启动器同样接受工作区目标。相对路径由当前工作区插件解析。
- `/doctor` 自检：Node/平台、API key、模型路由、cwd、上下文窗口、会话存储、插件宿主。
- `/provider` 交互向导管理模型提供方（添加 / 编辑 / 删除；捆绑 dsh-auth 挂载时添加分支提供**订阅账号登录（OAuth）**——选择 ChatGPT / Claude / Grok 等订阅账号走浏览器 / 设备码流程登录，免 API key，已登录可重新登录或登出，与 `/auth status|login|logout` 同源，未挂载时无此选项；编辑菜单可选 API Key、模型列表或删除该 provider，自定义端点额外提供 Base URL 与 wire protocol——这两项仅自定义端点可编辑；任一编辑项只原地修补所选字段，profile 其余配置原样保留；仅用户配置层写入的 provider 可编辑/删除；非环境变量来源的密钥写入 `~/.dsh/.credentials.yaml` 0600，界面只显示 `••••••`；环境变量提供的密钥既不写入也不删除，与其他 provider 共用的密钥在删除时也保留）。
- `/init` 创建 AGENTS.md；`/agents` 子代理列表；`/login` `/logout` 凭证管理；
  `/permission` `/add-dir` 权限说明；`/hooks` `/vim` `/connect` 为占位（DSH 无对应机制，给明确说明）。

---

## 5. 界面与状态栏

空会话顶部是鲸鱼 Logo 区（随对话滚动消失）：

- **开场动画**（约 3.4 秒，只播一次）：眨眼 → 喷水花 ×6 → 摇尾，之后定格为静态鲸鱼。
- 鲸鱼右侧文字列：`✦ dsh-TUI v版本号` → 5 行块体大字 `DEEPSEEK / HARNESS`（品牌蓝渐变）
  → 当前模型 + effort → 工作目录 → **启动提示行**（`/model` 切换模型 · `/help` 查看命令 · `Tab` 自动补全）。
  若 dsh 引擎版本不在验证范围内，提示行下方会多出一行 **⚠ 版本漂移警告**
  （更新/更旧/混装/异常四形态，附 `npm i -g @deepseek-ai/dsh@<版本>` 对齐命令）。
- 鲸鱼下方居中的欢迎语：`探索未至之境！`（Explore the uncharted!）。
- 终端宽度 **< 64 列时隐藏鲸鱼**，仅保留文字列。

### 5.2 底部状态栏（输入框下方三行）

**Row 1 — 上下文分段进度条**（`/settings → statusBar.contextBar`，默认关）
按内容类型分段着色：system 深蓝 / prompt 藏青 / assistant 靛蓝 / thinking 品牌蓝 / tools 浅蓝，
右缘读数如 `ctx 12.3k/1.0M 1.2% 988.9k`（窄屏自动缩短）。

**Row 2 — 状态字段行**（每个字段独立开关，见 `/settings`）
- 左组：模型 → TPS → thinking 推理等级 → mode 会话模式 → ctx 上下文占用 → cache 缓存命中率 → tokens（`1.2k→340` 输入→输出）→ cost 本会话花费估算（`≈¥0.05 谷`：`≈¥` + 当前计费时段短标记 峰/谷；仅 DeepSeek 官方 provider 且模型有已知单价时显示；hover 查看高峰/空闲拆分与输入/输出/缓存明细）。估算按每次请求的发生时刻分高峰/空闲桶、各按官方对应单价计（高峰期 = 梁文峰，低谷期 = 梁文谷），跨时段会话不会被整段按当前时段计价；估算非账单，以 DeepSeek 平台为准
- 右组：git 分支 → 工作目录（紧凑模式仅 basename）→ 会话标题 → 短会话 ID（`#` + 前 8 位，与日志文件名对应，方便 `--resume` 定位）
- `statusBar.compact` 时左右合并为单行。
- 默认开：compact / model / thinking / cwd / contextUsage / cache / cost；默认关：tokens / tps / gitBranch / sessionTitle / sessionId / mode / contextBar / activity / trajectory。

**Row 3 — 提示 / 工作活动 + 迷你轨迹条**
- 空闲显示 `? for shortcuts`，回合运行中显示 `esc to interrupt`，消息选择中显示 `esc to return to input`。
- 空闲时（`statusBar.activity` 开）显示 **working-activity 工作摘要**：动画帧字符 + 冰蓝扫光；
  上下文压力 ≥80% 显示琥珀 `⚠ 上下文 N%`、≥95% 转红；回合运行中替换经典 spinner（带 token 方向后缀）。
- 右侧**迷你轨迹条 MiniWake**（`statusBar.trajectory`，默认关）：整个会话投影为十几个密度字形，
  `▁▂▃▄▅▆▇█`，颜色区分输入/工具/模型通道，失败列染红抬升；≥120 列 16 格 / ≥100 列 12 格 / ≥84 列 8 格 / 更窄不显示。
  首次使用前条旁有 `ctrl+t` 提示，打开过轨迹后永久退休。

**TPS 仪表**（`statusBar.tps`，默认关）
流式中显示 1/8 格实时 gauge + `N tps`；回合结束后显示最近 12 样本 min-max sparkline。
速度语义色：**≥50 绿 / ≥20 黄 / <20 红**。

### 5.3 /settings 设置编辑器

`/settings` 打开插件设置编辑器；**改动自动保存**，`Esc` 直接退出。
dsh-tui 自身区块（写入 settings.yaml 用户层，实时生效）共 21 个字段：

| 字段 | 说明 |
|---|---|
| lang | 界面语言 zh/en（DSH_TUI_LANG 钉死时不可改） |
| whale | 开屏头部像素鲸鱼娘（默认开）；每次启动随机三选一开屏动画：经典组合开场（眨眼+喷水+摆尾）/ 爱心 / 睡觉，`/deepseek` 彩蛋每次重掷 |
| diffLayout | Edit/Write diff 布局：auto（≥110 列双栏）/ split / unified |
| thinkingFold | 思考块：preview（流式 2-3 行预览 + 落定折叠）/ full（展开到轮末） |
| smoothStreaming | 流式平滑输出（默认开）：实时回复/展开思考/工具卡正文按 ~30fps 匀速揭示，突发送达不再跳变，一次性到达的非流式回复也平滑打出；回放/历史始终完整直出 |
| toolBackground | 工具卡背景强调：none / subtle / strong |
| statusBar.* | 上表全部状态栏开关（compact/model/thinking/cwd/contextUsage/cache/tokens/cost/tps/gitBranch/sessionTitle/sessionId/mode/contextBar/activity/trajectory；statusBar.sessionId 是底栏显示开关，与 cordis 的启动 sessionId 无关） |

未声明 TUI 区块的命名空间以只读形式列出，需手工编辑 `~/.dsh/settings.yaml`。
provider / model / cwd / effort / fullscreen / preset / workspace / sessionId / modes
**不在 /settings 内**，要改 `$DSH_HOME/profiles/dsh-tui/cordis.patch.yml`。

### 5.4 终端要求

- 必须交互 TTY；推荐 Windows Terminal（≥110 列、等宽、TrueColor）。
- macOS 的 ⌘ 修饰键需要扩展键盘协议（iTerm2 / kitty / WezTerm / ghostty / tmux）；Terminal.app 请用 Ctrl。
- VS Code：可用 companion 扩展 `dsh-tui-vscode`（Marketplace 已上架，真实集成终端承载），或集成终端直接 `dsh-tui`。
- 环境自检：`/doctor`。

---

## 6. 模型 / 预设 / 主题 / 语言

| 项 | 命令 | 说明 |
|---|---|---|
| 模型 | `/model` | 选择器；**切换 = fork 会话续聊**（历史保留、仅换路由）；持久化 `~/.dsh-tui/model.json`，重启与 `/new` 沿用 |
| 推理强度 | `/effort` | 滑杆（←/→ 实时）或 `/effort <id>`；`/effort status` 看当前 |
| Agent 预设 | `/preset` | `standard` / `ptc`（0.1.2；旧 0.1.1 名为 `code`）/ `minimal` / `cordis` + **梁神模式 `liangshen`**；**已开始会话不可切换**（blank-only） |
| 主题 | `/theme` | `auto`（OSC 11 跟随终端背景）/ `light` / `dark` / `dark-ansi`；`/theme <名>` 直接切；`/theme status` 看解析结果 |
| 自定义主题 | 手动 | `~/.dsh-tui/themes/<名>.json`，`{base, colors}` 格式，选中即热切换；命名为 `auto` 会被内置遮蔽 |
| 语言 | `/lang` | `en` / `zh` 热切换；优先级 `DSH_TUI_LANG` > settings.yaml > cordis.yml > 持久化 |
| 状态行动画 | `/activity` | 选择器或 `/activity frames <名>`；帧名 30 个（默认 `moon8`，`random` 随机） |

**主题优先级**：`DSH_TUI_THEME` > `~/.dsh-tui/theme.json` > OSC 11 终端背景检测 > dark 回退。

**~/.dsh-tui/ 偏好文件**（均 best-effort，坏文件回退默认）：`theme.json`、`model.json`、
`agent-preset.json`、`effort.json`、`working-activity.json`、`lang.json`、`trajectory.json`（提示退休标记）、
`resume.txt` / `last-used.json`（会话恢复）、`themes/<名>.json`（自定义主题）。

**常用环境变量**：`DSH_TUI_LANG`、`DSH_TUI_THEME`、`DSH_TUI_PRESET`、`DSH_TUI_PERSONA`、
`DSH_TUI_DISABLE_MOUSE`、`DSH_TUI_RESUME_SESSION`、`DSH_TUI_WORKSPACE_TARGET`、`DSH_TUI_SESSION_ROOT`、
`DSH_TUI_DEBUG`、`DSH_TUI_RENDER_LOG`（帧取证，可能含敏感内容）、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、
`VISUAL`/`EDITOR`（`Ctrl+G` 外部编辑器）、`DSH_PERMISSION_MODE`。旧名 `CC_TUI_*` / `DSH_CC_*` 已改名（启动会警告）。

---

## 7. 常用技巧

> 以下是从代码与文档深挖中提炼的精简技巧，也是启动提示与 `/tips` 的素材池。

**上手**
1. 按 `?`（输入框为空时）随时看快捷键菜单；输入 `/` 看全部命令——两个都有 Tab 补全。
2. 不确定环境对不对？先跑 `/doctor`；想看会话全貌用 `/status`。
3. 中英界面切换 `/lang en|zh`，即时生效并持久化。

**效率**
4. **模型工作中**：`Enter` 加塞下一步（steer）、`Tab` 排队后续指令（follow-up）、
   `Ctrl+Enter` 打断立即发——不用傻等回合结束。
5. `Alt+Up` 把最后一条未处理消息取回输入框修改，不用重打。
6. 想快速问个事又不想打断主回合、不想留历史：`/btw <问题>`。
7. 打错了想重来：**空输入双击 Esc 时间回溯**，选你的消息改完重发；`/rewind` 同款。
8. 长输入用 `Ctrl+G` 拉起 `$VISUAL` 编辑器写，保存即回填。
9. `@` 在消息任意位置补全文件：普通片段**模糊匹配**（`@ink` 也能命中 `src/ink/Box.js`），
   路径形输入（`@src/` `@./` `@~/`）**直达该目录**；目录可继续深入；图片自动变 `[Image #N]` 附件。
10. 只想引用文件的某几行：`@src/a.ts#L12` 或 `@src/a.ts#L12-14` 精确带上行区间。
11. 想盯着子代理干活：**`Ctrl+A` 打开子代理面板**，`Enter` 看详情、`X` 中断运行中的子代理；
   同款命令 `/agents`。
12. **全屏模式下点击转录里的文件路径**（工具卡、代码、`file://` 链接）会弹出操作菜单：
   打开 / 在文件管理器中定位 / 复制绝对路径。

**查看与诊断**
13. `Ctrl+O` 展开/收起工具卡详情（思考全文、参数与输出）；`Ctrl+E` 展开隐藏的旧消息。
14. `Ctrl+R` 搜输入历史（重复按跳下一匹配）；转录态 `/` 全文搜索 + `n`/`N` 跳转。
15. `Ctrl+T` 看轨迹：`[`/`]` 跳失败点、`/` 字段查询（`tool:` `kind:` `err:` `>10s` `tok>1k`）。
16. 状态栏上下文条、TPS、轨迹条、git 分支等都是 `/settings → statusBar.*` 开关——默认关的
    `tps`/`trajectory`/`contextBar` 值得打开试试。
17. 上下文压力 ≥80% 时工作摘要行会变琥珀色预警，≥95% 转红——该 `/compact` 了。
    （minimal preset 下 /compact 不可用。）
18. `/balance` 查 DeepSeek 官方余额（免费只读接口，点击行刷新）；状态栏
    `statusBar.cost` 还会按单价估算花费 `≈¥ 峰/谷`（仅官方 DeepSeek 模型显示，悬停看明细）。
    估算仅供自省，账单以 DeepSeek 平台为准。
19. 打开/恢复会话自动出**回顾摘要**（`/settings → Session → recapOnOpen`，默认开）：
    `Enter` 或点击展开详情；手动总结用 `/recap`，面板里 `a` 键应用建议标题。

**个性化**
20. `/theme` 换主题，`auto` 跟随终端背景；想要专属配色就写
    `~/.dsh-tui/themes/<名>.json`（`{base, colors}`），选中即热切换。
21. `/preset liangshen` 梁神模式：首轮最小工具集、首次工具调用后开放全目录（**新会话才生效**）。
22. `/effort` 滑杆 `←/→` 实时调推理强度；`/activity frames comet` 换状态行动画
    （帧名 30 个，`random` 随机）。
23. `/model` 切换会 fork 续聊（历史保留），持久化后重启与 `/new` 沿用——放心换模型。
24. 会话太多？`/resume` 里 `Ctrl+P` 固定常用会话置顶、`Ctrl+S` 折叠子 agent 运行、`Ctrl+X` 清理空壳会话。
25. 有文本选区时滚轮是**平移选区**不是滚动列表——想滚屏先 `Esc` 取消选区。
26. `/color` 给当前会话设强调色：无参打开调色板、`/color <名>` 直设、`/color reset` 清除；
    按会话保存，`resume` 后仍在。
27. `/settings` 改动**自动保存**（Esc 直接退出）；`shortcuts` 分组可逐动作自定义快捷键，
    保存即生效，下次按键就用新组合。
28. 输入框是 vim 党的主场：`/vim` 开启后 `Esc` 切 NORMAL（`h/l/j/k`、`0/^/$`、`w/b` 移动，
    `x/X/dd/d$/d0/dw` 删除、`u` 撤销），`i/a/o` 回 INSERT；不想要 vim 再按 `/vim` 关掉。

**避坑**
29. `/compact`、`/model` 在回合运行中会被拒绝——先 `Ctrl+C` 或等回合结束。
30. 审批条 `Esc` = 拒绝（fail closed）；问卷第 2 题起 `Esc` = 返回上一题，第 1 题 `Esc` 或任意题 `Ctrl+C` = 取消整批（模型会收到取消信号）。
31. `/update` 只更新 profile runtime 不动全局安装；提示版本错位时按提示执行
    `npm install -g @deepseek-harness-tui/dsh-tui@<版本>` 对齐启动器。
32. `/reload` 重读偏好文件（主题/语言/预设/模型/动画），但**不重读** `cordis.yml` 根配置与
    全屏布局，也不加载新构建的代码——改这些用 `/restart`（回合运行中 `/restart` 会被拒绝，先 `Ctrl+C`）。
33. macOS 的 ⌘ 键需要 iTerm2/kitty/WezTerm/ghostty/tmux；Terminal.app 用 Ctrl 即可。
34. 鼠标拖选即复制（fullscreen 模式）；`DSH_TUI_DISABLE_MOUSE=1` 可临时关闭鼠标。
35. logo 页出现 **⚠ 版本漂移警告**时按提示对齐 dsh 引擎：
    `npm i -g @deepseek-ai/dsh@<版本>`（支持范围见 §1.1）。
36. vim 模式开启时 `Esc` 归 vim 管（insert 回 normal、normal 无操作）——时间回溯请退出
    vim 模式后双击 `Esc`，或用 `/rewind`；回合运行中在 vim insert 模式按 `Esc` 也只是回
    normal，打断回合用 `Ctrl+C` / `Ctrl+Enter`。

---

> 本文档信息收集自代码与既有文档；深挖中发现的文档缺口（`/rewind` `/effort` `/settings`
> `/skills` 等命令未入 README 命令表、`Ctrl+P` 未入快捷键表、状态栏 hint 硬编码英文、
> docs/vscode.md 版本号滞后等）可作为后续文档修正的 backlog。

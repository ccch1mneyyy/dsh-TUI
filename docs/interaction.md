# 交互与命令

[文档索引](README.md) · [English](interaction.en.md)

## 输入与全局快捷键

| 按键 | 行为 |
| --- | --- |
| `Enter` | 空闲时发送；模型工作时把文本 steer 到当前回合的下一步边界；菜单打开时确认选项 |
| `Tab` | 补全 `/` 命令或 `@` 文件；模型工作且输入非空时排入当前回合之后的 follow-up |
| `Ctrl+Enter` | 打断当前回合并立即处理输入消息 |
| `Shift+Enter` | 在光标处插入换行 |
| `Shift+Tab` | 在配置的会话模式间循环（默认：默认 → 计划模式 → 完全访问） |
| `Alt/Option+Up` | 把最后一条尚未处理的消息取回输入框编辑 |
| `Up/Down` | 菜单选择；普通输入中浏览历史或在多行文本间移动 |
| `Ctrl+V` | 从系统剪贴板插入文本；Windows Explorer 复制的文件/图片会插入路径 |
| `Ctrl+X` | 用外部编辑器（`$VISUAL` → `$EDITOR` → vi）编辑当前输入，保存退出后回填；`:cq` 或非零退出保留原稿 |
| `Esc` | 按当前模式关闭菜单/选区/弹窗；有输入时清空；模型工作时中断；空输入连续两次打开 rewind |
| `Ctrl+C` | 工作时中断；空闲且有输入时清空；空输入时连续两次退出 |
| `Ctrl+D` | 空闲时连续两次退出 |
| `Ctrl+O` | 切换 transcript/verbose 详情，展开思考与完整工具参数/输出 |
| `Ctrl+T` | 展开或折叠启动时的“已加载上下文”面板 |
| `Ctrl+R` | 打开输入历史搜索；重复按或 `Down` 移到下一项 |
| `Ctrl+L` | 强制清理并重绘物理终端 |
| `?` | 输入框为空时打开快捷键和命令帮助 |
| `Shift+Up` | 进入消息选择模式；方向键移动，`Enter` 展开单条，`Esc` 退出 |

`/` 有两种语义：普通输入模式中打开 slash command 补全；`Ctrl+O` 的
transcript 模式中打开会话全文搜索。全文搜索使用 `n`/`N` 在结果间前后跳转。

## 输入编辑

| 按键 | 行为 |
| --- | --- |
| `Left/Right` | 按字符移动光标 |
| `Ctrl+Left/Right` | 按单词移动 |
| `Home/End` | 移到当前逻辑行首/行尾 |
| `Ctrl+A` / `Ctrl+E` | 编辑器中移到当前逻辑行首/行尾；`Ctrl+E` 还会展开或折叠长会话中隐藏的旧消息 |
| `Ctrl+U` | 删除光标前内容 |
| `Ctrl+K` | 删除光标后内容 |
| `Ctrl+W` | 删除前一个单词 |

Bracketed paste（右键或终端原生粘贴）会原样插入，包括换行，不会把粘贴内容误当
成 Enter 提交。

## @ 文件引用

在消息**任意位置**输入 `@` 会打开文件补全菜单：继续输入路径片段过滤，`Tab`/
`Enter` 选择，目录可继续深入。发送消息时，选中的文件内容或目录列表会自动附加
到消息中（0.3.7+）。

`Ctrl+V` 粘贴时，Windows Explorer 复制的文件/图片会直接插入为文件路径（含空格
自动加引号），而不是粘贴路径文本本身。

## 界面语言

`/lang` 在简体中文与英文界面之间切换（影响所有 UI 文案），选择持久化，重启后
沿用（0.3.7+）。

## 消息投递语义

模型正在工作时有三种不同路径：

| 操作 | 放置位置 |
| --- | --- |
| `Enter` | steer：送入正在运行的回合，在下一步边界被 Agent 领取 |
| `Tab` | follow-up：等待当前回合结束后再处理 |
| `Ctrl+Enter` | interrupt：中断当前回合并立即投递 |

输入框上方会显示尚未领取的消息。`Alt/Option+Up` 可以取回最后一条，模型工作时
按 `Esc` 会中断并立即重投当前 pending 消息。

## 会话工作流

### Resume

`/resume` 显示当前工作目录下最近使用的可恢复会话。标题取第一条用户消息，列表
按最近使用时间排序。确认后会切换 Agent 并回放持久化事件。

Windows `dsh-tui.cmd --resume` 使用 `~/.dsh-cc/resume.txt` 中最后选择的会话 ID。

### Rewind

输入框为空时连续按两次 `Esc` 打开用户消息列表。选择并确认后：

1. 找到该消息所属 turn 的开始事件。
2. 通过 DSH session fork 创建分支会话。
3. 回放该边界前的历史。
4. 把原消息放回输入框供修改和重发。

### 侧问 /btw

`/btw <问题>` 发起一次不打扰主任务的快速侧问：复用当前会话上下文（system
prompt + 已有历史）做一次**无工具、单轮**的模型调用，答案显示在可滚动的浮层
面板里。要点：

- **不进会话历史**：问答不写入 session log，也不会出现在主上下文与 token
  计数里（关闭面板即消失）。
- **不打断主回合**：模型正在流式输出时也可以触发，主任务继续运行。
- 面板内 `↑`/`↓` 滚动，`Space`/`Enter`/`Esc` 关闭，`c` 复制答案；等待答案
  时 `Esc` 取消。

### Model 与 preset

`/model` 通过在当前历史末尾 fork 会话来切换模型，因为 DSH 没有原位换模型 API。
旧会话仍保留在 `/resume` 中。

`/preset` 只允许空白会话原地切换。已经开始的会话会把选择保存为下一次 `/new`
或启动时的默认值。详细规则见[配置参考](configuration.md#agent-preset)。

## Fullscreen 与鼠标

`fullscreen: false` 是默认 inline 模式，终端模拟器拥有原生 scrollback 和选区。

`fullscreen: true` 使用 alternate screen，并启用应用内鼠标处理：

| 操作 | 行为 |
| --- | --- |
| 滚轮 | 滚动会话消息列表 |
| 拖拽 | 选择文本，松开后立即复制并清除选区 |
| 双击/三击 | 选择单词/整行并复制 |
| `Esc` | 取消正在进行的拖拽，不复制 |

复制优先使用 OSC 52；本地终端可回退到 `wl-copy`、`xclip` 或 `xsel`，tmux 使用
`load-buffer -w`。设置 `CC_TUI_DISABLE_MOUSE=1` 可临时关闭 fullscreen 鼠标。

## `ask_user_question` 问卷

模型调用问卷工具时，问卷面板暂时拥有键盘：

| 按键 | 行为 |
| --- | --- |
| `Up/Down` | 移动选项 |
| `Space` | 多选题勾选或取消 |
| `Tab` | 切换到自定义文本回答 |
| `Enter` | 提交当前题 |
| `Esc` | 取消整批提问，模型收到 `ASK_CANCELLED`（harness 侧中止仍报 `ASK_ABORTED`） |

一批多题以及并发子代理提问会按 FIFO 逐题显示。完成后，问答摘要折叠进本地
transcript。

## 计划评审（plan review）

计划模式下模型调用 `exit_plan_mode` 时，计划全文以 markdown 渲染在评审面板中
（`intent: plan-review` 的专用决策布局）：

| 按键 | 行为 |
| --- | --- |
| `Up/Down` | 在选项与底部反馈输入行之间移动 |
| `1`/`2` | 直接提交对应选项（反馈缓冲为空时；非空则数字视为反馈字符） |
| 打字 | 进入反馈输入行 |
| `Enter`（选项行） | 提交该选项；批准行有反馈时会报错——批准必须不带反馈，否则协议视为"继续规划" |
| `Enter`（输入行） | 提交"继续规划"并附上反馈文本 |
| `Esc` | 打断评审去说话（`ASK_CANCELLED`），模型停留在计划模式 |

## 工具审批（approval）

权限层发起 `approval/request` 时，审批面板显示工具名、从配对 tool call 提取的
完整命令与原因，并暂时拥有键盘（同时挂起问卷时审批优先）：

| 按键 | 行为 |
| --- | --- |
| `Up/Down` | 移动选项 |
| `1` / `2` | 允许（仅本次）/ 拒绝 |
| `Enter` | 提交当前焦点项 |
| `Esc` / `Ctrl+C` | 拒绝（fail closed） |

## Slash Commands

命令菜单由本地命令与 DSH 命令注册表合并而成。输入 `/` 查看当前组合真正可用的
全集。命令描述随界面语言（`/lang`）中英切换：内置命令与已收录的注册表命令
（`/plan`、`/goal`、`/feedback`）显示中文翻译，其余注册表命令回退注册表原文。

| 分组 | 命令 |
| --- | --- |
| 会话 | `/new`、`/resume`、`/clear`、`/compact`、`/export`、`/btw`、`/trace` |
| 状态 | `/status`、`/cost`、`/config`、`/doctor`、`/init`、`/agents` |
| 模型与显示 | `/model`、`/effort`、`/thinking`、`/tokens`、`/activity`、`/preset`、`/theme`、`/lang` |
| 账号与策略 | `/login`、`/logout`、`/permissions`、`/add-dir`、`/hooks`、`/mcp`、`/memory` |
| 打包 Skills | `/audit`、`/bug`、`/practice`、`/review`、`/pr_comments`、`/release-notes`、`/vuln-check` |
| 其他 | `/update`、`/vim`、`/terminal-setup`、`/connect`、`/help`、`/exit` |
| 注册表 | `/plan`、`/goal`，以及当前 DSH 组合注册的其他命令 |

补充语法：

- `/activity` 打开动画选择器；`/activity frames <name>` 直接设置；
  `/activity status` 查看状态。
- `/preset <id>` 与 `/preset status` 见配置文档。
- `/effort` 打开推理强度滑杆（←/→ 实时调整）；`/effort <id>` 直接设定，
  `/effort status` 查看当前档位。
- `/theme <name>` 与 `/theme status` 见主题文档。
- `/lang` 切换中英界面语言（见「界面语言」）。
- 启动后会后台检查 npm 新版本；发现更新时会提示。检测遵循 npm registry
  配置（`NPM_CONFIG_REGISTRY` 或 `~/.npmrc`），镜像源用户看到的就是安装源
  的最新版。`/update` 更新已安装的
  `@deepseek-harness-tui/dsh-tui`，然后自动重启并恢复当前会话；当前回合运行时需等待完成。
  仅在 `dsh --profile <name>` 启动时可用（源码运行等场景会提示不可用）；
  已是最新版时直接提示，不会重启。
- `/plan [off|message]` 与 `/goal ...` 由 DSH 命令插件处理并写入会话事件。
- Skill 命令只发送激活提示；实际 skill 通过 DSH skill 注册表加载。包内
  `skills/` 会在插件启动时自动注册，也可用项目或用户目录中的同名 skill 覆盖。

`/vim`、`/connect`、`/hooks` 与 `/memory` 当前是兼容占位命令；当 DSH 组合没有
对应能力时会给出明确说明，而不是静默执行。

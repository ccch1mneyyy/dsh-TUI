# Claude 后端（实验性）

[文档索引](README.md) · [English](claude-backend.en.md)

dsh-TUI 可以把会话跑在 Claude Agent 后端上，而不是 DeepSeek Harness 智能体：界面
还是同一个，背后由 Claude Agent SDK 驱动 Claude Code CLI。项目里的 `CLAUDE.md`、
设置、hooks、MCP 服务器和插件按 CLI 自己的方式加载。这个后端仍是实验性的，实现
细节见[多后端架构](agent-backend-design.md)。

## 启用

需要：

- Claude Agent SDK。它是可选依赖，默认不装。在 dsh-tui 的 profile 目录（默认
  `~/.dsh/profiles/dsh-tui`，设置了 `DSH_HOME` 时是 `$DSH_HOME/profiles/dsh-tui`）
  执行一次：

  ```sh
  cd ~/.dsh/profiles/dsh-tui && pnpm add @anthropic-ai/claude-agent-sdk@0.3.287
  ```

- 一份 Claude 凭据，见下面的「登录」。
- `claude` 命令不是必需的：`PATH` 上有能运行的 `claude` 就用它（与你平时用的 CLI 同版本、
  同一个会话库），否则用 SDK 自带的二进制。

选择后端，任选一种：

- 启动页的「内核」入口、右下角的内核区，或在会话里输入 `/kernel`，打开内核选择器。
  选中另一个内核后 dsh-TUI 记住选择（`~/.dsh-tui/kernel.json`）并重启，在新内核里开
  一个新会话；原来的会话仍可在 `/resume` 找到。回合进行中不能切换。SDK 没装或没有
  凭据时，选择器会把 Claude 标为「未安装」或「未登录」。
- `dsh-tui --backend claude`（只对这一次启动生效）。
- 在 dsh-tui 的配置行写 `backend: claude`。

显式的 `--backend` 与配置行优先于选择器记住的选择。

## 登录

按以下顺序选用凭据，`/login` 会显示当前会话用的是哪一种：

1. `/channel` 里激活的渠道（见[渠道档案](interaction.md#渠道档案channel仅-claude)）。
2. dsh-auth 的 `anthropic` 订阅登录，即 `/provider` 里的同一套 OAuth。在 Claude
   会话里执行 `/login` 会直接打开它，登录后重连会话（回合进行中则等回合结束）。使用它时
   不把环境里的 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 交给 CLI，免得旧的 key
   盖过你刚做的登录。
3. 环境里的 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`，或云厂商路由的环境变量。
4. 本机已有的 `claude login`。

订阅登录只用于 Anthropic 官方 API。`ANTHROPIC_BASE_URL`（环境变量或 Claude 设置的
`env`）指向 `https://api.anthropic.com` 以外的地址，或配置了 Unix 套接字、云厂商或网关
路由、`apiKeyHelper` 时，dsh-TUI 不使用订阅令牌，环境原样交给 CLI，`/login` 显示当前
路由。令牌快过期时在启动 CLI 前刷新；会话中被 CLI 拒绝时刷新一次并以同一会话重连，
还不行就提示你 `/login`。令牌不会写进日志。

## 和 DSH 后端相比

可用，行为与 DSH 一致：流式回复、思考（模型不给正文时只显示 token 数）、工具卡、
`Ctrl+C` 中断、排队消息与 `Esc` 停靠、`/new`、`/status`、`/export`、`!cmd` / `!!cmd`、
IDE 选区、状态栏的 git 分支、`/clear`（只清屏，Claude 保留上下文）。

可用，但由 Claude 提供：

| 功能 | 说明 |
| --- | --- |
| `/model` | Claude 自己的模型列表，不带 provider 前缀（`/model sonnet`）；选择会记住，用于之后的新会话 |
| `/effort` | 当前模型声明的档位；不支持 effort 的模型没有可选项 |
| `/permission`、`Shift+Tab` | Claude 的权限模式，见下文 |
| `/compact`、`/context` | Claude 的压缩与上下文报告 |
| `/mcp` | 服务器状态；`/mcp reconnect <服务器>`、`/mcp toggle <服务器> on\|off`，服务器名可补全 |
| `/cost`、状态栏费用 | Claude 上报的美元费用；悬停费用字段可看订阅用量（5 小时 / 7 天） |
| `/doctor` | CLI 路径与版本、SDK 版本、起始权限模式、凭据与账户 |
| `/rename`、`/color` | 标题写进 Claude 的会话列表；强调色由 dsh-TUI 按会话保存 |
| `/btw`、`/recap` | 在对话的一次性副本上问一个问题（无工具、单轮、不写入转录），每次一次模型调用；打开会话时不自动回顾 |
| Claude 自己的斜杠命令 | 出现在补全里，原样发给 Claude；与 dsh-TUI 内置命令同名的，以内置命令为准 |
| `/channel` | 仅 Claude：中转渠道的模型名与连接，见[渠道档案](interaction.md#渠道档案channel仅-claude) |

不可用（不出现在补全里，直接输入会提示不可用，不会发给模型）：`/tree`、`/agentview`、
`/bg`、`/home`、`/workspace`、`/preset`、`/provider`、`/logout`、`/balance`、`/config`、
`/reload`、`/restart`、`/setup`、`/init`、`/migrate`、`/skills`、`/plugins`、`/hooks`、
`/add-dir`。DSH 组合注册的命令（如 `/goal`、`/plan`）也不会出现。

启动时仍先到启动页；首启引导和工作区首页只在 DSH 下出现。带恢复目标的启动直接进入
会话。

## 审批与提问

- 工具审批用和 DSH 相同的面板：允许一次、始终允许、拒绝。「始终允许」只在 CLI 给出
  建议时出现，标签写明 CLI 会记住什么（例如本会话自动接受编辑，或本项目的一条权限
  规则）；记住由 CLI 完成，dsh-TUI 不写任何设置文件。焦点移到「拒绝」行（`↓` / `Tab`）
  后可以输入拒绝理由，此时「始终允许」没有数字快捷键，移过去按 `Enter`。
- 模型的提问（`AskUserQuestion`）用问卷面板；计划模式交出的计划打开计划评审：批准并
  自动接受编辑、批准但逐个确认编辑，或带反馈继续规划。
- MCP 服务器请求输入时也走问卷：表单每个字段一题，按字段约束校验，无效的回答带原因
  重问，最后选「发送」或「拒绝」。需要浏览器操作的服务器会给出链接。
- 模型拒绝请求且配置了回退模型时，会询问是否用回退模型重试。
- 以上都可以按 `Esc` 取消。

## 权限模式

`/permission` 列出 Claude 的模式：`default`（逐个询问）、`acceptEdits`（自动接受编辑）、
`plan`（只读规划）、`bypassPermissions`（跳过全部确认），模型支持时还有 `auto`。
`Shift+Tab` 在 default → acceptEdits → plan（→ auto）之间循环，永远不会进入
`bypassPermissions`，它只能在 `/permission` 里明确选择。

`/permission` 的选择会记住（`~/.dsh-tui/backends/claude/prefs.json`），下一个会话按它
启动。起始模式的优先级：环境变量 `DSH_TUI_CLAUDE_PERMISSION_MODE` > 记住的选择 >
Claude 设置 > `default`。Claude 设置里的 `defaultMode: bypassPermissions` 会降为
`default` 并提示，克隆来的仓库不能悄悄关掉所有确认；按记住的选择以 bypass 启动时，
转录里也会提示一句。

## 会话

- `/resume` 打开会话浏览器，列出你的 Claude 会话，默认显示当前项目，也可以看全部项目。
  dsh-TUI 创建的会话也在其中（Claude Code 自己的 `/resume` 选择器不显示它们，要用
  `claude --resume <id>` 打开）。`Enter` 恢复（先回放历史再继续），`Ctrl+R` 重命名，
  `Ctrl+D` 删除；当前会话和另一个 dsh-TUI 终端正在用的会话不能删。置顶按后端分开保存。
- 从 shell 恢复：`dsh-tui --backend claude --resume <id>`；不带 id 时恢复本机最近一次
  用过的 Claude 会话。退出时 dsh-TUI 会打印这条命令。另一个 dsh-TUI 终端已打开的会话会
  被拒绝；`--resume` 打不开时直接报错，不会改开新会话。状态栏的短会话 id 就是
  `--resume` 用的 id。
- `/fork` 写一份之后可以恢复的副本，当前会话不变。
- 双击 `Esc` 回退到之前的某条提问：回退对话（在截到该提问之前的副本里继续，提问回到
  输入框）、恢复 Claude 之后改过的文件（用 Claude 的文件检查点，确认前先预览），或两者
  都做。
- Claude 自己重置对话时（退出计划模式并选择清空上下文），视图、子代理和后台任务一起清空
  并提示，会话以 Claude 给的新 id 继续。
- 压缩过的会话恢复后，顶部有「加载更早消息」，每次找回一段被压缩掉的对话，只读
  Claude 自己的转录文件。长会话为限制内存会折叠旧行，同一入口也能把它们找回来。

## 子代理与后台任务

- 每次 `Agent` 委派在对话里是一张子代理卡片，子代理的文本、工具调用和 token 数只进
  卡片，不进主对话。`/agents` 列出全部，`Ctrl+A` 打开子代理面板与详情，可以停止运行中
  的子代理。
- Claude 在后台运行的命令（带 `run_in_background` 的 `Bash`，或运行中被转到后台的
  命令）显示为任务卡并点亮状态栏的任务标记，`/jobs` 列出全部，连按两次 `k` 停止。卡片
  和面板在屏幕上时显示任务输出文件的末尾（只读最后 64 KiB，每秒最多一次）。
- 中断回合不会停止后台任务。Claude 不再报告的任务或子代理显示为「状态未知」。

## 图片

粘贴图片或 `@` 引用图片文件（PNG、JPEG、GIF、WebP）即随消息发送。限制：每张最多
5 MiB、每边最多 2000 像素、最多 400 万像素；每条消息最多 20 张、合计 20 MiB。超出尺寸的
图片在装有 sharp 时会自动缩小。暂存的图片只放在内存里。恢复的会话会显示提问里带过的
图片。

## 已知限制

- 一个 dsh-TUI 进程只用一个后端，切换要经 `/kernel` 重启。
- 侧栏的工作区面板在 Claude 会话下提示不支持，轨迹面板为空。
- 不支持 `/add-dir`；拒答对话框只有「重试」和「取消」；需要浏览器操作的 MCP 请求不会
  自动打开浏览器。
- 同时用普通 `claude --resume` 打开同一个会话，dsh-TUI 察觉不到。
- 在第三方客户端里使用 claude.ai 订阅登录受 Anthropic 的条款约束；如有顾虑，改用
  API key。

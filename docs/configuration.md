# 配置参考

[文档索引](README.md) · [English](configuration.en.md)

## Profile 与补丁层

通过 npm/profile 机制安装后，用户配置位于：

```text
$DSH_HOME/profiles/dsh-tui/cordis.patch.yml
```

`DSH_HOME` 未设置时通常为 `~/.dsh`。该文件是顶层 YAML 数组，可使用 DSH
支持的 `!!js` 表达式。

Profile 启动按顺序叠加 `dsh-base`、已安装 bundle、`@deepseek-harness-tui/dsh-tui`
的包内 `cordis.patch.yml`，最后再应用用户补丁。用户配置通常通过相同 `id` 覆盖已有行；
只有确实新增服务时才使用 `insert`。

> 覆盖某一行时，`config` 是整块替换，不是逐字段深合并。需要继续生效的字段必须
> 在用户补丁中全部重写。

## TUI 配置

下面是完整的常用覆盖示例：

```yaml
- id: dsh-tui
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
    # cwd 不建议显式设置——默认解析为启动目录所在的 git worktree 根；确需固定
    # 工作区时写绝对路径（如 cwd: /repo/packages/app），不要用
    # `!!js process.cwd()`（那会把工作区钉死在启动子目录上，issue #96）。
    effort: max
    activity: true
    activityFrames: claude
    contextBar: true
    fullscreen: false
    preset: !!js process.env.DSH_TUI_PRESET ?? undefined
    workspace: !!js process.env.DSH_TUI_WORKSPACE_TARGET ?? undefined
    sessionId: !!js process.env.DSH_TUI_RESUME_SESSION ?? undefined
```

| 字段 | 默认/来源 | 说明 |
| --- | --- | --- |
| `provider` | Harness `agentDefaultModel`；裸组合回落 `deepseek-official` | DSH 模型路由名称；只有 provider 与 model 同时配置才构成显式路由 |
| `model` | Harness `agentDefaultModel`；裸组合回落 `deepseek-v4-flash` | 启动模型；`/model` 可通过 session fork 实时切换 |
| `cwd` | 启动目录所在的 git worktree 根（不在任何 worktree 内时为 `process.cwd()`；家目录的 dotfiles 仓不算） | TUI 会话侧工作区：agent meta、`@` 补全/提及展开、/resume 过滤、状态栏；恢复已有会话时以该会话持久化的 cwd 为准。注意 bash/fs-policy/sandbox 的根仍由组合层 cordis 配置决定（默认启动目录，归 dsh-base 管），与这里的会话侧 cwd 可能不同 |
| `workspace` | 未设置 | 启动工作区目标；可用本地路径、`file://` URI 或插件提供的 URI，设置后优先于 `cwd` |
| `effort` | 配置层通常为 `max` | 每个请求实际生效的推理等级（按模型档位校验，deepseek 仅 off/high/max，非法档位静默回落默认；优先于 `/effort` 持久化选择），兼作顶栏启动显示 |
| `modes` | 内置三档 | Shift+Tab 会话模式循环（plan/sandbox/approval 原子组合）；缺省为 默认 → 计划 → 完全访问 |
| `activity` | `true` | 是否显示实时工作状态行 |
| `activityFrames` | 持久化选择或 `claude` | 工作状态动画预设；也可通过 `/activity` 修改 |
| `contextBar` | `true` | 输入框下方的分段上下文进度条；`false` 隐藏该行 |
| `fullscreen` | `false` | `true` 使用 alternate screen、应用内滚动和鼠标选区；`false` 使用 inline 模式 |
| `preset` | 名册默认 `standard` | 新会话 Agent preset；显式配置优先于持久化偏好 |
| `sessionId` | 未设置 | 要恢复的会话 ID，通常由 Windows `--resume` 启动器注入 |

## 工作状态行

`dsh-working-activity` 随包安装，并由本包 patch 插入。只需要按 ID 覆盖参数：

```yaml
- id: working-activity
  config:
    publishIntervalMs: 500
```

不要再次 `insert` 同名行，也不要对同一 profile 单独执行
`dsh plugin ... add dsh-working-activity`。

## Agent Preset

每个会话通过 `@deepseek-ai/dsh-agent-presets` 组合模型可见的工具和提示词：

| ID | 名称 | 能力 |
| --- | --- | --- |
| `standard` | 标准模式（默认） | 编辑、Shell、检索、Skills、计划、Goals、子代理与工作流 |
| `code` | PTC 模式 | 标准能力，加 Code Mode SDK 呈现工具，可用 TypeScript 组合多步操作 |
| `minimal` | 极简模式 | 仅持久 Bash 与 `str_replace_editor`，不带 compaction |
| `cordis` | 创造模式 | 标准能力，加运行时检查与插件实验工具 |
| `liangshen` | 梁神模式 | 主 Agent 与子 Agent 首轮均保持 Minimal 双工具，首次工具调用后开放完整目录，压缩后重新锚定 |

使用方式：

- `/preset` 打开选择器。
- `/preset <id>` 直接选择；`/preset status` 查看当前状态。
- 空白会话可以原地切换。已经产生对话的会话遵循官方 blank-only 规则，选择只会
  保存为新默认值，在 `/new` 或下一次启动时生效。
- 默认值保存在 `~/.dsh-tui/agent-preset.json`。
- 优先级为：显式 `config.preset` 或 `DSH_TUI_PRESET`，然后持久化偏好，最后名册
  默认值 `standard`。
- 恢复旧会话时，以该会话日志记录的 preset 为准，不读取当前默认值覆盖它。
- “梁神模式”随 dsh-tui 包发布，启动时安装到用户 preset 根目录；已有同名且并非
  dsh-tui 托管的目录不会被覆盖。

自定义 preset 放在 `$DSH_HOME/.agent-presets/<name>/`，目录中应包含
`agent.cordis.yml`。默认 `DSH_HOME` 下的路径即 `~/.dsh/.agent-presets/`。

从 0.3 起，模型侧工具、plan、compaction、delegation 等由 preset 自己组合。
Profile 模式不再使用旧的 `DSH_TUI_COMPACT_RATIO`、
`DSH_TUI_COMPACT_RETAIN` 或旧版 TUI 的深度限制；这些策略应在 preset 中配置。

## MCP

官方 `@deepseek-ai/dsh-mcp-client` 同时支持 stdio 与 streamable HTTP。
每个服务挂载后，工具以 `mcp__<server>__<tool>` 注册并自动进入模型工具集。

在用户 `cordis.patch.yml` 中插入：

```yaml
- insert:
    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: context7
        command: npx
        args: ['-y', '@upstash/context7-mcp']

    - id: mcp-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: remote
        url: https://example.com/mcp
        headers:
          Authorization: !!js process.env.MCP_TOKEN
```

运行 `/mcp` 查看已连接服务与工具数量。完整字段以
[DeepSeek Harness 配置目录](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog#deepseek-ai-dsh-mcp-client)
为准。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `VISUAL` / `EDITOR` | `Ctrl+X` 打开的外部编辑器（`VISUAL` 优先，可带参数如 `code --wait`；未设置时 POSIX 回退 `vi`） |
| `DEEPSEEK_API_KEY` | DeepSeek 凭证；运行模型的必需项 |
| `DEEPSEEK_BASE_URL` | 覆盖 DeepSeek 兼容 API 端点 |
| `DSH_TUI_PERSONA` | 覆盖组合注入的 Agent persona |
| `DSH_TUI_PRESET` | 覆盖新会话默认 Agent preset |
| `DSH_TUI_THEME` | 锁定内置（`auto`/`light`/`dark`/`dark-ansi`）或自定义主题，优先于持久化选择 |
| `DSH_TUI_DISABLE_MOUSE` | 在 fullscreen 模式临时关闭鼠标处理 |
| `DSH_TUI_RESUME_SESSION` | 启动时恢复指定会话，通常由启动器设置 |
| `DSH_TUI_WORKSPACE_TARGET` | 启动时解析的工作区路径或 URI，通常由 `dsh-tui <目标>` 设置 |
| `DSH_TUI_SESSION_ROOT` | 覆盖 JSONL 会话根目录；profile 默认 `$DSH_HOME/sessions`，裸 `cordis.yml` 默认 `~/.dsh-tui/sessions` |
| `DSH_PERMISSION_MODE` | 非 Windows 平台覆盖 sandbox policy，例如 `workspace-write` 或 `danger-full-access` |
| `DSH_TUI_WORKSPACE` | Windows `dsh-tui.cmd` 采用的工作目录 |
| `DSH_TUI_DEBUG` | 启用写往 stderr 的 dsh-tui 调试日志 |
| `DSH_TUI_RENDER_LOG` | 指定文件路径，记录原始 ANSI 渲染帧用于取证 |

旧名 `CC_TUI_*` 与 `DSH_CC_*` 自本版本起不再生效；启动时检测到旧名仍被设置会
打印一行警告（只要还设着，每次启动都会提示）。唯一例外是
`DSH_TUI_RESUME_SESSION`：读端优先取新名、同时仍读取旧名
`DSH_CC_RESUME_SESSION`，写端两个变量都会设置，供旧版启动器过渡。

`DSH_TUI_RENDER_LOG` 可能捕获屏幕上可见的提示词、工具参数和输出，不应上传到
公开 issue，除非已经检查并脱敏。

## `/provider`：运行时添加模型提供方

`/provider` 打开交互向导，无需重启即可添加模型提供方：

- **内置 provider**：从 `llm.listConfigurableProviders()` 列出的 catalog
  路由（openai、anthropic、deepseek 等）中选择，只需输入 API key；baseURL
  可选覆盖（代理网关场景），协议与模型目录自动继承。
- **自定义 API 端点**：输入路由名、API key、baseURL 与协议
  （`openai-completions` / `openai-responses` / `anthropic-messages`），
  向导会用草稿凭据探测端点公布的模型供勾选（探测失败则手输模型 id）。

写入产物（profile 启动时，dsh-base 提供 settings/credentials 服务）：

| 产物 | 位置 |
| --- | --- |
| provider profile | `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.<路由名>`，写入即注册路由 |
| API key | `~/.dsh/.credentials.yaml`（0600），引用名为 `<路由名大写>_API_KEY` |

密钥答案在会话记录中只显示 `••••••`；若进程环境已有同名变量，则跳过写入、
运行时直接从环境解析。配置与 dsh web 端的 Models 设置页互通（同一 settings
section）。裸 `dsh --config cordis.yml` 启动没有这些服务，`/provider` 会提示
不可用。添加完成后运行 `/model` 即可切换到新路由的模型。

## 组合约束

- `user-interaction` 服务通常由 `dsh-base` 提供。本插件会在裸装时兜底创建，
  但 profile patch 不应重复插入。
- 自定义插入 subagent provider 时，核心 `subagent` 服务必须先挂载。
- 自定义覆盖 `plan-mode` 时，`section` 必须是非空文本。
- Profile 使用 base 的 JSONL 持久化并将根目录指向共享的 `~/.dsh/sessions`，
  因而 TUI 和 Web 可以读取同一份会话历史。
- `cordis.yml` 是裸组合示例，服务拓扑可能与 profile patch 不同。正常安装和用户
  覆盖应以 `cordis.patch.yml` 为准。

`DSH_TUI_SESSION_ROOT` 始终表示 JSONL 根目录。`dsh --profile dsh-tui` 默认使用
`$DSH_HOME/sessions`（通常为 `~/.dsh/sessions/`）；直接运行
`dsh --config cordis.yml` 的裸示例默认使用 `~/.dsh-tui/sessions/`。

权限相关配置与平台差异见[架构与限制](architecture.md#权限与安全边界)。

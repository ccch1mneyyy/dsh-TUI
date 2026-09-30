# 在 VS Code 中使用 dsh-TUI

[文档索引](README.md) · [English](vscode.en.md)

dsh-TUI 是终端程序：它把 ANSI 写进 PTY，再从 PTY 读按键。
所以任何兼容终端都能运行它，包括 **VS Code 集成终端**
（xterm.js）。本页介绍两种用法：

**companion 扩展 `dsh-tui-vscode`（推荐）**

- 会话跑在 VS Code **真实的集成终端**里（编辑器区另一侧新开一列）；
- 支持多会话并存、侧边栏会话历史、一键启动；
- 支持恢复上次会话、恢复指定会话；
- 扩展已上架 VS Code Marketplace。

**内置集成终端直接运行**

- 零安装、秒级可用；
- 适合不想装扩展的场景。

> 版本说明：本页的 `dsh-tui` 指本仓库（TUI 插件），
> `dsh-tui-vscode` 指 companion 扩展，两者版本独立、各自发布。
> 扩展完整说明见其仓库 README：
> [baobaolaodie/dsh-tui-vscode](https://github.com/baobaolaodie/dsh-tui-vscode)
>
> **选区通道要求扩展支持协议 v2**（**dsh-tui-vscode ≥ 0.7.0**）——
> 更旧的扩展下该功能静默不启用，其余功能不受影响。

## 方式一：companion 扩展 dsh-tui-vscode（推荐）

[`baobaolaodie/dsh-tui-vscode`](https://github.com/baobaolaodie/dsh-tui-vscode)
把 dsh-tui 跑进 VS Code **真实的集成终端**（用 `createTerminal`
在终端内运行 CLI），没有 webview、没有 xterm 模拟层。它不改动
TUI 核心渲染链路，只负责**运行 TUI、做编辑器集成**。

### 扩展提供的功能

- 编辑器标签栏按钮、活动栏鲸鱼图标、命令面板入口；
- 在编辑器区旁边创建名为 `DeepSeek` 的集成终端；
- 每次启动创建独立会话，已有会话继续在各自终端运行；
- 侧边栏按项目分组显示会话历史，支持刷新、恢复指定会话；
- 注入 `DSH_TUI_LANG`、`$VISUAL`、`$DSH_HOME`、指定会话 id 等环境变量；
- 关闭终端结束对应会话，TUI 内双击 `Ctrl+C` 也可退出。

| 能力 | Claude Code 官方扩展 | dsh-tui-vscode |
| --- | --- | --- |
| 入口 | 活动栏图标 + 编辑器标签栏按钮 + 命令面板 | 同（DeepSeek 鲸鱼图标） |
| 会话位置 | 编辑器区**另一侧**新开一列（`ViewColumn.Beside`） | 同，不占当前列 |
| 终端标签 | `Claude Code` + logo 图标 | `DeepSeek` + 鲸鱼图标 |
| 会话运行终端 | 真实集成终端（默认 shell：Windows = PowerShell） | 同 |
| 多会话 | 每次点击新开一个会话终端 | 同，旧会话继续运行 |
| 侧边栏 | sessions 会话列表 | 会话历史（按项目分组树，更强） |
| 自动启停 | 打开 = 启动；关闭终端 = 结束 | 同 |
| 环境注入 | — | `DSH_TUI_LANG` / `$VISUAL` / `$DSH_HOME` / 指定会话 id / `DSH_TUI_IDE_PORT/TOKEN`（选区通道） |
| 编辑器选区联动 | 选区自动进上下文，prompt 下方 `⧉ N lines selected` | 同（IDE 选区通道，见下） |

### IDE 选区通道

搭配含 IDE 选区通道的 dsh-tui 版本，扩展会在本机起一个
loopback WebSocket 服务，并写入 lock 文件（目录 0700、文件 0600）。

- 扩展启动的会话：dsh-tui 启动时通过环境变量直连；
- 手动启动的会话：扫描 lock 自动发现——只连 workspace 覆盖
  当前会话目录的窗口；没有匹配就静默禁用，绝不连别的项目。

此后：

- 编辑器选中代码 → TUI prompt 下方**实时**出现 `⧉ N lines selected`
  徽标（清空选区即消失）；
- 提交消息 → 选中行自动附加进模型上下文，transcript 用户消息上方
  渲染「⧉ Selected N lines from <相对路径>」指示行（重启后 resume
  仍能重建该指示行）；
- 选区推送携带**编辑器缓冲区自己的文本**——未保存的修改也如实附加
  （附加的就是你屏幕上看到的）；超大选区按与 @-引用相同的上限截断
  并标记；
- 无 IDE / 断连时静默降级，TUI 其余功能零影响。

![IDE 选区通道：footer 实时徽标与 transcript 指示行](../screenshots/ide-selection-badge.png)

**协议与版本**：

- 连接后 TUI 先发 `ide/hello`（token + protocolVersion）；
- 扩展验证通过才回 `ide/hello_ack`（protocolVersion + workspaceFolders）——
  只有收到合法 v2 ACK 才算连接建立，token 不对会被静默断开；
- 此后 `selection_changed` 携带绝对行号（0-based 含端）与编辑器
  缓冲区自身的选区文本；
- lock 发现只连 workspace 覆盖会话目录的窗口，无匹配即静默禁用；
- 协议两端需同版本发布。

### 前置条件

- VS Code ≥ 1.90；
- 全局安装 `dsh` CLI 与 `dsh-tui`
  （**建议 dsh-tui 0.7.0+**，见[快速开始](getting-started.md)）：

  ```sh
  npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
  ```

- 运行模型需要 `DEEPSEEK_API_KEY`（放在终端环境或 dsh 配置里）。

### 安装

**从 VS Code 扩展面板安装（推荐）**：`Ctrl+Shift+X` 搜索
**`dsh-tui`** 一键安装（发布者 `baobaolaodie`），或直接打开
[Marketplace 页面](https://marketplace.visualstudio.com/items?itemName=baobaolaodie.dsh-tui-vscode)。

或从源码构建：

```sh
git clone https://github.com/baobaolaodie/dsh-tui-vscode.git
cd dsh-tui-vscode
npm install
npm run package && code --install-extension dsh-tui-vscode-<version>.vsix --force
# 或一步到位：npm run install:local
```

### 快速上手

1. 点**编辑器标签栏右侧鲸鱼按钮**，或跑命令面板
   `dsh-tui: Start new session / 启动新会话`——编辑器区**另一侧**
   新开 **DeepSeek** 终端并自动运行 dsh-tui。
2. 点**活动栏鲸鱼图标**打开侧边栏「会话历史」，欢迎页提供
   「启动新会话」「恢复上次会话」按钮。
3. 再次点击 = **再开一个会话**，多会话并行，旧会话在自己的
   终端里继续运行。
4. **恢复上次会话**：`dsh-tui: Resume last session / 恢复上次会话`。
5. **恢复指定会话**：侧边栏「会话历史」展开项目组 → 点击会话条目。
6. **终止**：关闭终端标签（只结束该会话），或 TUI 内双击
   `Ctrl+C`；命令 `dsh-tui: Terminate session / 终止会话` 向最近
   终端发送 Ctrl+C。

有会话运行时，**状态栏**（左下）显示 `dsh-tui` 项，
点击启动新会话（对应 `dsh-tui-vscode.open`）。

### 命令清单

| 命令 ID | 标题 | 作用 |
| --- | --- | --- |
| `dsh-tui-vscode.open` | Open panel / 打开会话面板 | 启动新会话（编辑器标签栏按钮的同一入口） |
| `dsh-tui-vscode.start` | Start new session / 启动新会话 | 启动新会话 |
| `dsh-tui-vscode.resume` | Resume last session / 恢复上次会话 | `--resume` 恢复最近会话 |
| `dsh-tui-vscode.focus` | Focus session panel / 聚焦会话面板 | 聚焦最近终端，无则新开 |
| `dsh-tui-vscode.kill` | Terminate session / 终止会话 | 向最近终端发送 Ctrl+C |
| `dsh-tui-vscode.refreshSessions` | Refresh sessions / 刷新会话列表 | 手动刷新侧边栏 |
| `dsh-tui-vscode.resumeSession` | Resume session / 恢复会话 | 恢复指定会话（侧边栏点击） |
| `dsh-tui-vscode.insertAtMention` | Insert @-mention / 插入 @文件引用 | 编辑器聚焦时按 `Ctrl+Alt+K`（macOS `Cmd+Alt+K`）或编辑器右键：把当前文件/选中代码以 `@绝对路径 L起-止` 插入 dsh-tui 输入框（绝对路径与 dsh-tui 会话 cwd 无关；未选中引用整个文件；无运行会话回退为复制到剪贴板） |

### 架构与机制

- 扩展在本机起一个 loopback WebSocket 服务，并把连接信息写进 lock
  文件（目录 0700、文件 0600）。
- 从扩展启动：dsh-tui 用注入的环境变量直连该服务。
- 手动启动（如 tmux / SSH）：扫描 lock 自动发现，只连 workspace
  覆盖当前会话目录的窗口；没有匹配就静默禁用，绝不连别的项目。
- 连接走协议 v2：TUI 先发 `ide/hello`，扩展回 `ide/hello_ack`，
  之后用 `selection_changed` 推送选区。
- 无 IDE / 断连时静默降级，TUI 其余功能零影响。

### 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dsh-tui-vscode.command` | `dsh-tui` | 启动命令（按宿主 PATH 解析为绝对路径） |
| `dsh-tui-vscode.extraArgs` | `[]` | 每次启动追加的 CLI 参数，如 `["--lang","en"]` |
| `dsh-tui-vscode.lang` | `""` | `""`/`zh`/`en`，写入 `DSH_TUI_LANG` |
| `dsh-tui-vscode.injectEditor` | `true` | 未设 `$VISUAL`/`$EDITOR` 时导出 `$VISUAL` |
| `dsh-tui-vscode.editorCommand` | `code -w` | 导出为 `$VISUAL` 的命令 |
| `dsh-tui-vscode.dshHome` | `""` | 覆盖会话的 `$DSH_HOME`（空 = 继承） |

### 开发与验证

扩展仓库跑测试、打包与本地安装的入口命令：

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # 编译 + node --test（数据层单测）
npm run test:e2e    # 真实扩展宿主测试（Linux 用 xvfb-run -a）
npm run package     # 编译 + 生成 .vsix
```

`npm run install:local` 一步本地安装；CI 任务矩阵与提交钩子等扩展仓库细节，此处从略。

### 已知限制

- 会话内容即终端内容：滚动历史由 VS Code 集成终端管理；
- 指定会话恢复依赖 dsh-tui profile 的 `cordis.patch.yml`
  （dsh-tui 0.7.0+）；
- 无 `session` 头日志的项目名来自组目录解码，含连字符的项目名
  解码有损（如 `flow-comet` → `flow\comet`）——此类会话的 cwd
  仍可在悬浮提示中查看。

## 方式二：VS Code 集成终端直接运行

不想装扩展时，直接在集成终端里跑 dsh-tui。前置条件与
[快速开始](getting-started.md) 一致：全局安装 `dsh` CLI 与 `dsh-tui`
（首次启动会自举 profile，需要 pnpm）。

1. 打开 VS Code 集成终端（`` Ctrl+` ``）：

   ```sh
   dsh-tui
   ```

2. 恢复上次会话：

   ```sh
   dsh-tui --resume
   ```

   > `-c` / `--continue` 与 `--resume` 等价；`dsh-tui --resume <id>`（或
   > `--resume=<id>`，0.7.0 起）恢复指定会话。

dsh-TUI 对 xterm.js（VS Code / Cursor / code-server）有专门的兼容路径：

- truecolor 配色；
- OSC 8 链接（由 VS Code 直接渲染为可点击）；
- OSC 52 剪贴板（首次使用 VS Code 会弹授权提示）；
- 同步输出、平滑刷屏。

这些在 `src/ink/` 中按 `TERM_PROGRAM=vscode` 探测分支处理。
流式 Markdown、工具卡、滚动、双击 Esc 时间回溯等行为
与独立终端一致。

### 让 `Ctrl+G` 用 VS Code 编辑当前输入

TUI 的 `Ctrl+G` 走 `$VISUAL`/`$EDITOR`。想让它在 VS Code 里编辑，
把 `code -w` 写进终端环境（`settings.json` 中按平台设置，键名
`terminal.integrated.env.<platform>`）：

```jsonc
{
  "terminal.integrated.env.windows": { "VISUAL": "code -w" },
  "terminal.integrated.env.linux":   { "VISUAL": "code -w" },
  "terminal.integrated.env.osx":     { "VISUAL": "code -w" }
}
```

（若 `$VISUAL`/`$EDITOR` 都未设置，companion 扩展会自动导出
`code -w`，见方式一。）

### 界面语言

`DSH_TUI_LANG` 默认中文；要英文界面，在上述 env 里加
`"DSH_TUI_LANG": "en"`。

### 已知差异（内置终端）

| 能力 | 内置终端表现 |
| --- | --- |
| 鼠标滚轮/拖选 | 由集成终端处理；“松开即复制”表现为 OS 级复制行为 |
| 扩展键盘协议 | modifyOtherKeys / win32-input-mode 由 xterm.js 决定，可能与 kitty / WezTerm 不完全一致 |
| OSC 52 剪贴板 | 首次使用弹出权限提示（VS Code 自身的安全设计） |

需要完全对齐独立终端行为时，请使用独立终端窗口
（Windows Terminal / kitty / WezTerm / iTerm2 / tmux）。

## 选型建议

| 场景 | 选择 |
| --- | --- |
| 需要多会话、会话历史和指定会话恢复 | 方式一：companion 扩展 |
| 偶尔用、不想装扩展 | 方式二：内置终端 |
| 需要完全独立终端的协议行为（复杂鼠标行为等） | 独立终端窗口 |

## 验收基线

按[贡献指南](contributing.md)的约定，VS Code 属于受支持的终端平台。
任何渲染改动请在 inline / fullscreen 两种模式、窄终端宽度下，
在 VS Code 集成终端内走一遍：启动、resize、滚动、输入、取消、
干净退出。

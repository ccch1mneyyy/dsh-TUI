# 安装与快速开始

[文档索引](README.md) · [English](getting-started.en.md)

## 前置条件

- Node.js `^22.19 || >=24`。CI 使用 Node 24。
- 官方 DeepSeek Harness CLI：`@deepseek-ai/dsh`。
- `pnpm` **10 或更高**（CI 使用 11）。`dsh plugin` 会把 profile 内的包安装
  交给 pnpm；pnpm 9 对传递依赖的提升行为不同，profile 里会解析不到
  `dsh-working-activity`，表现为启动后立刻退出且几乎无报错（见 issue #60
  与下方常见问题）。
- 支持交互输入的终端 TTY。`dsh-tui` 不支持把 stdout 重定向后启动。
- `DEEPSEEK_API_KEY`。使用自定义兼容端点时还可设置
  `DEEPSEEK_BASE_URL`。

macOS/Linux：

```sh
export DEEPSEEK_API_KEY='your-key'
```

PowerShell：

```powershell
$env:DEEPSEEK_API_KEY = 'your-key'
```

不要把真实密钥提交到仓库。正常的 profile 启动直接读取环境变量。

## 安装

最快路径（全局安装后自带 `dsh-tui` 直达命令）：

```sh
# 官方 CLI + 本插件
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui

# pnpm 未安装时任选一种方式（首次启动自动初始化 profile 时需要）
npm install -g pnpm
# 或：corepack enable pnpm

# 启动：首次运行自动执行 dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@<版本>
dsh-tui
```

手工分步（等价）：

```sh
npm install -g @deepseek-ai/dsh

# pnpm 未安装时任选一种方式
npm install -g pnpm
# 或：corepack enable pnpm

dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
dsh --profile dsh-tui   # 或 dsh-tui
```

从仓库检出运行时，也可以执行：

```sh
sh install.sh
```

`install.sh` 只封装 profile 插件命令并检查 `dsh`、`pnpm` 是否可用；它不会
复制源码，也不需要本地构建。

## 从旧包迁移

旧版安装使用无 scope 包 `dsh-cc-tui` 和 `cc-tui` profile。新版本改为组织包
`@deepseek-harness-tui/dsh-tui` 与 `dsh-tui` profile；执行以下命令创建新 profile：

```sh
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
dsh --profile dsh-tui
```

本版本起，环境变量与数据目录完成更名：`CC_TUI_*` 与 `DSH_CC_*` 统一改为
`DSH_TUI_*`（如 `CC_TUI_THEME` → `DSH_TUI_THEME`），数据目录从 `~/.dsh-cc` 改为
`~/.dsh-tui`。行为要点：

- 旧名环境变量不再生效；启动时若检测到旧名仍被设置，会打印一行警告提示改用新名
  （只要还设着，每次启动都会提示）。
- 唯一例外是恢复契约：`DSH_TUI_RESUME_SESSION` 为新名，读端优先取新名、同时仍
  读取旧名 `DSH_CC_RESUME_SESSION`；写端两个变量都会设置，旧版启动器仍可用旧名
  完成过渡。
- 数据目录自动迁移：首次启动时若 `~/.dsh-cc` 存在而 `~/.dsh-tui` 不存在，会整体
  **复制**（不移动）到新目录并提示一行；主题、模型、preset 和输入历史随之生效。
  旧目录保留在原处，确认新目录正常后由你自行删除。
- `resume.txt` 例外：会同时写入新旧两个路径，保证只读旧路径的旧版启动器仍能
  找到最近会话。

确认新 profile 正常后，旧 `$DSH_HOME/profiles/cc-tui` 仅作为旧安装残留，可按需
删除；不要把旧包和新包同时添加到同一个 profile。

## 安装命令做了什么

首次执行 `dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui` 时，官方 CLI 会：

1. 在 `$DSH_HOME/profiles/dsh-tui/` 初始化 profile。未设置 `DSH_HOME` 时，
   默认根目录通常是 `~/.dsh`。
2. 让 profile 的第一层 bundle 使用 `@deepseek-ai/dsh-base`。
3. 在 profile 内通过 pnpm 安装 `@deepseek-harness-tui/dsh-tui`。
4. 读取包内 `dsh.bundle.patch` 元数据，将 `cordis.patch.yml` 追加为组合层。

启动时的主要顺序是：

```text
dsh-base -> 其他 bundle -> @deepseek-harness-tui/dsh-tui patch -> 用户 profile patch
```

base 提供 Agent、模型、会话、文件、Shell、策略和注册表等服务；本插件的 patch
覆盖或插入 TUI、Agent preset 名册、SQLite 会话持久化与工作状态行。

`dsh-working-activity` 已经是本包依赖，并由 `dsh-tui` 的 patch 自动插入。
不要对同一个 profile 再单独执行 `add dsh-working-activity`，否则可能出现重复行。

## 启动

```sh
dsh --profile dsh-tui
```

命令从当前目录启动，因此 Agent 的默认工作区也是当前目录。进入目标项目目录后再
启动即可。

Windows 仓库检出还提供：

```bat
dsh-tui.cmd
dsh-tui.cmd --resume
```

`--resume` 会读取 `%USERPROFILE%\.dsh-tui\resume.txt`，恢复 TUI 最近选择的
会话。该文件同时双写到旧路径 `%USERPROFILE%\.dsh-cc\resume.txt`，供只读旧路径的
旧版启动器过渡使用。设置 `DSH_TUI_WORKSPACE` 可以覆盖批处理启动器采用的工作目录。

## 更新到最新版本

项目迭代很快，更新复用安装命令，显式指定 `@latest`：

```sh
# 更新 Profile runtime（TUI 内 /update 做的就是这件事）
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@latest
```

如果你通过全局 `dsh-tui` 命令启动，还需要让 Launcher 对齐（TUI 内的
`/update` 只更新 profile，不会动全局安装）：

```sh
npm install -g @deepseek-harness-tui/dsh-tui@latest
# 或（原本用 pnpm 全局安装时）
pnpm add -g @deepseek-harness-tui/dsh-tui@latest
```

- 不带 `@latest` 时 pnpm 会按 profile `package.json` 里已记录的版本范围
  （如 `^0.1.4`）就地解析，可能停留在旧的主线上——这是"重复执行安装命令
  但版本没变"的常见原因。
- 修复"版本不一致"时，优先使用启动器打印的"精确版本"命令（例如
  `npm install -g @deepseek-harness-tui/dsh-tui@0.8.3`）；日常主动升级才
  使用 `@latest`。
- 确认生效：启动横幅右上角显示当前版本（`✦ dsh-TUI vX.Y.Z`）。
- 用户覆盖层 `cordis.patch.yml` 在更新中原样保留；会话数据的存放位置
  可能随版本变化（如 0.3.7 起 `/resume` 改用与 dsh web 共享的 JSONL
  会话库），跨大版本更新后旧会话不在列表属预期，原数据不会被删除。

## Profile 配置

用户覆盖文件位于：

```text
$DSH_HOME/profiles/dsh-tui/cordis.patch.yml
```

配置一个节点时，`config` 块是整段替换，不是逐字段深合并。复制示例时需要保留
仍然有效的字段。完整说明见[配置参考](configuration.md)。

仓库根目录的 `cordis.yml` 是裸组合示例；正常的 npm/profile 安装以
`cordis.patch.yml` 为准，不需要把根配置复制到 profile。

## 从源码开发

```sh
git clone --recurse-submodules https://github.com/ccch1mneyyy/dsh-TUI.git
cd dsh-TUI
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
```

本仓库有三个子模块，其中 `vendor/dsh-std` 与 `dsh-auth` 是安装必需
（`pnpm-workspace.yaml` 把 `vendor/dsh-std/packages/*` 列为 workspace 包，
`dsh-auth` 经 `link:` 引入）。漏掉 `--recurse-submodules` 会让这两个目录为空，
`pnpm install --frozen-lockfile` 直接失败。已经克隆过的检出补一条：

```sh
git submodule update --init --recursive
```

`pnpm build` 会清理忽略入库的 `lib/`，把 `src/` 编译到 `lib/types/`，再运行
构建门禁。**Git URL 安装不受支持**（workspace 依赖/子模块/pnpm ≥11 prepare 白名单三重阻断）；发布 workflow
也会在打包前显式执行干净编译和包面验证。

真实测试当前源码时，首次使用或正式模型/密钥配置变化后运行：

```sh
pnpm dev:copy-config
```

以后每次修改源码后，一条命令构建、打包、隔离安装并启动：

```sh
pnpm dev
```

`pnpm dev:copy-config` 只复制 `~/.dsh/settings.yaml` 与
`~/.dsh/.credentials.yaml`。Unix 上文件权限设为 `0600`；Windows 使用系统管理的
文件 ACL。`pnpm dev` 使用独立的 `HOME`、`DSH_HOME` 和会话目录，不覆盖正式
`~/.dsh/profiles/dsh-tui`、`~/.dsh-tui` 或正式会话。默认测试目录在 Unix 的
`$XDG_CACHE_HOME/dsh-tui-dev`（未设置时为 `~/.cache/dsh-tui-dev`），Windows
则为 `%LOCALAPPDATA%\dsh-tui-dev`；可通过 `DSH_TUI_DEV_ROOT` 覆盖。

不启动 TUI、只验证构建、打包和安装链路时运行：

```sh
pnpm dev:test
```

CI 还会运行三条渲染回归：

```sh
node --import tsx/esm scripts/repro-askpanel.tsx
node --import tsx/esm scripts/verify-askpanel-layout.tsx
node --import tsx/esm scripts/repro-toolcards.tsx
```

`pnpm tui` 调用的 `scripts/run.ts` 直接组合 DeepSeek Harness 源码 patch，默认假设
包位于 Harness monorepo 的 `packages/*` 布局中；独立 checkout 需要另外设置
`DSH_TUI_DEV_WORKSPACE` 指向 Harness 根目录。只测试本仓库当前源码时，优先使用
上述 `pnpm dev`，它会走与用户安装一致的 profile 路径。


## 常见问题

### Git URL 安装报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` / `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`

Git URL（如 `https://github.com/ccch1mneyyy/dsh-TUI`）安装不受支持，三重阻断：
源 manifest 的 `@dsh-std/*` 是 workspace 依赖（git tarball 原样保留，profile
内无法解析）；`vendor/dsh-std` 是 git 子模块（依赖抓取不带子模块内容，编译必
败）；pnpm ≥11 默认拒绝 git 依赖执行 `prepare` 构建脚本。请安装 registry 包：

```sh
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
```

### `dsh-tui requires an interactive terminal`

stdout 不是 TTY。请直接在终端中启动，不要把主进程输出管道到文件或其他命令。

如果 dsh-tui 只是装在某个 profile 里、而实际由 Web / Tauri / GUI 等非终端宿主
启动 DSH，dsh-tui 会检测到 stdout 不是 TTY 且并非由 `dsh-tui` launcher 启动，
自动跳过 TUI 前端（不报错、不影响宿主启动）；只有显式执行 `dsh-tui`（含
standalone 便携版）却没有 TTY 时才会报上面的错误。

### 找不到 `dsh` 或 `pnpm`

确认全局 npm bin 目录在 `PATH` 中，并重新打开终端。`install.sh` 会在安装前检查
这两个命令。

### 启动后立刻退回 shell，几乎没有报错（pnpm 9）

pnpm 9 安装的 profile 里，传递依赖 `dsh-working-activity` 不会被提升到
loader 可解析的位置，模块解析失败导致整棵插件树被回收，TUI 打印 resume
提示后直接退出（issue #60）。升级 pnpm 到 10+ 后重装即可：

```sh
npm install -g pnpm@latest
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@latest
```

### 模型启动失败或提示没有凭证

确认启动 `dsh` 的同一个 Shell 中存在 `DEEPSEEK_API_KEY`。自定义端点同时检查
`DEEPSEEK_BASE_URL`。

### 工作状态行重复

检查 profile 是否曾单独添加 `dsh-working-activity`。保留本包 patch 自动插入的
`working-activity` 行，移除重复 bundle 配置。

### TUI 显示错位或终端退出后状态异常

先运行 `/doctor`，记录终端类型和模式，再参考[交互文档](interaction.md)与
[架构文档](architecture.md)。渲染问题可使用 `DSH_TUI_RENDER_LOG` 采集原始帧，
但日志可能包含会话可见内容，应妥善处理。

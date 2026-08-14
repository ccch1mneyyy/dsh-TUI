# 安装与快速开始

[文档索引](README.md) · [English](getting-started.en.md)

## 前置条件

- Node.js `^22.19 || >=24`。CI 使用 Node 24。
- 官方 DeepSeek Harness CLI：`@deepseek-ai/dsh`。
- `pnpm` **10 或更高**（CI 使用 11）。`dsh plugin` 会把 profile 内的包安装
  交给 pnpm；pnpm 9 对传递依赖的提升行为不同，profile 里会解析不到
  `dsh-working-activity`，表现为启动后立刻退出且几乎无报错（见 issue #60
  与下方常见问题）。
- 支持交互输入的终端 TTY。`dsh-cc-tui` 不支持把 stdout 重定向后启动。
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
npm install -g @deepseek-ai/dsh dsh-cc-tui

# pnpm 未安装时任选一种方式（首次启动自动初始化 profile 时需要）
npm install -g pnpm
# 或：corepack enable pnpm

# 启动：首次运行自动执行 dsh plugin --profile cc-tui add dsh-cc-tui@<版本>
dsh-tui
```

手工分步（等价）：

```sh
npm install -g @deepseek-ai/dsh
dsh plugin --profile cc-tui add dsh-cc-tui
dsh --profile cc-tui   # 或 dsh-tui
```

从仓库检出运行时，也可以执行：

```sh
sh install.sh
```

`install.sh` 只封装 profile 插件命令并检查 `dsh`、`pnpm` 是否可用；它不会
复制源码，也不需要本地构建。

## 安装命令做了什么

首次执行 `dsh plugin --profile cc-tui add dsh-cc-tui` 时，官方 CLI 会：

1. 在 `$DSH_HOME/profiles/cc-tui/` 初始化 profile。未设置 `DSH_HOME` 时，
   默认根目录通常是 `~/.dsh`。
2. 让 profile 的第一层 bundle 使用 `@deepseek-ai/dsh-base`。
3. 在 profile 内通过 pnpm 安装 `dsh-cc-tui`。
4. 读取包内 `dsh.bundle.patch` 元数据，将 `cordis.patch.yml` 追加为组合层。

启动时的主要顺序是：

```text
dsh-base -> 其他 bundle -> dsh-cc-tui patch -> 用户 profile patch
```

base 提供 Agent、模型、会话、文件、Shell、策略和注册表等服务；本插件的 patch
覆盖或插入 TUI、Agent preset 名册、SQLite 会话持久化与工作状态行。

`dsh-working-activity` 已经是本包依赖，并由 `dsh-cc-tui` 的 patch 自动插入。
不要对同一个 profile 再单独执行 `add dsh-working-activity`，否则可能出现重复行。

## 启动

```sh
dsh --profile cc-tui
```

命令从当前目录启动，因此 Agent 的默认工作区也是当前目录。进入目标项目目录后再
启动即可。

Windows 仓库检出还提供：

```bat
dsh-cc.cmd
dsh-cc.cmd --resume
```

`--resume` 会读取 `%USERPROFILE%\.dsh-cc\resume.txt`，恢复 TUI 最近选择的
会话。设置 `DSH_CC_WORKSPACE` 可以覆盖批处理启动器采用的工作目录。

## 更新到最新版本

项目迭代很快，更新复用安装命令，显式指定 `@latest`：

```sh
dsh plugin --profile cc-tui add dsh-cc-tui@latest
```

- 不带 `@latest` 时 pnpm 会按 profile `package.json` 里已记录的版本范围
  （如 `^0.1.4`）就地解析，可能停留在旧的主线上——这是"重复执行安装命令
  但版本没变"的常见原因。
- 确认生效：启动横幅右上角显示当前版本（`✦ dsh-cc vX.Y.Z`）。
- 用户覆盖层 `cordis.patch.yml` 在更新中原样保留；会话数据的存放位置
  可能随版本变化（如 0.3.7 起 `/resume` 改用与 dsh web 共享的 JSONL
  会话库），跨大版本更新后旧会话不在列表属预期，原数据不会被删除。

## Profile 配置

用户覆盖文件位于：

```text
$DSH_HOME/profiles/cc-tui/cordis.patch.yml
```

配置一个节点时，`config` 块是整段替换，不是逐字段深合并。复制示例时需要保留
仍然有效的字段。完整说明见[配置参考](configuration.md)。

仓库根目录的 `cordis.yml` 是裸组合示例；正常的 npm/profile 安装以
`cordis.patch.yml` 为准，不需要把根配置复制到 profile。

## 从源码开发

```sh
git clone https://github.com/ccch1mneyyy/dsh-TUI.git
cd dsh-TUI
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
```

`pnpm build` 执行 `tsc -p tsconfig.json`，把 `src/` 编译到 `lib/types/`。
`lib/types/` 是提交并发布的产物；源码改动必须同步重建。

CI 还会运行三条渲染回归：

```sh
node --import tsx/esm scripts/repro-askpanel.tsx
node --import tsx/esm scripts/verify-askpanel-layout.tsx
node --import tsx/esm scripts/repro-toolcards.tsx
```

`pnpm tui` 调用的 `scripts/run.ts` 假设包位于 DeepSeek Harness monorepo 的
`packages/*` 布局中，不是本独立仓库的通用启动命令。独立仓库做真实集成测试时，
应安装到 profile 后在 TTY 中启动。


## 常见问题

### `cc-tui requires an interactive terminal`

stdout 不是 TTY。请直接在终端中启动，不要把主进程输出管道到文件或其他命令。

### 找不到 `dsh` 或 `pnpm`

确认全局 npm bin 目录在 `PATH` 中，并重新打开终端。`install.sh` 会在安装前检查
这两个命令。

### 启动后立刻退回 shell，几乎没有报错（pnpm 9）

pnpm 9 安装的 profile 里，传递依赖 `dsh-working-activity` 不会被提升到
loader 可解析的位置，模块解析失败导致整棵插件树被回收，TUI 打印 resume
提示后直接退出（issue #60）。升级 pnpm 到 10+ 后重装即可：

```sh
npm install -g pnpm@latest
dsh plugin --profile cc-tui add dsh-cc-tui@latest
```

### 模型启动失败或提示没有凭证

确认启动 `dsh` 的同一个 Shell 中存在 `DEEPSEEK_API_KEY`。自定义端点同时检查
`DEEPSEEK_BASE_URL`。

### 工作状态行重复

检查 profile 是否曾单独添加 `dsh-working-activity`。保留本包 patch 自动插入的
`working-activity` 行，移除重复 bundle 配置。

### TUI 显示错位或终端退出后状态异常

先运行 `/doctor`，记录终端类型和模式，再参考[交互文档](interaction.md)与
[架构文档](architecture.md)。渲染问题可使用 `DSH_CC_RENDER_LOG` 采集原始帧，
但日志可能包含会话可见内容，应妥善处理。

# 自动化 CLI

[文档索引](README.md) · [English](cli.en.md)

`dst` / `dsh-tui` 的普通启动仍进入 TUI。显式 `run`、`-p` 或 `cli` 进入独立的无界面 CLI；不会加载 React、Ink、channel、TUI 偏好或自举 TUI profile。实现位于根级 `cli/`，不在主应用 `src/` 中。跟踪：#1558、#1559（总目标 #1246）。

## 快速开始

```sh
dst -p "检查当前项目"
echo "完整任务正文" | dst run --json
echo "待分析材料" | dst run "总结以下材料" --output-format stream-json
dst run --cwd ./repo --provider deepseek-official --model deepseek-flash "检查类型"
dst run --session-id session-123 "继续"
dst run --continue "继续当前目录最近的兼容主会话"
dst cli --help
```

需要安装官方 DSH，当前自动化 adapter 验证版本是 **0.2.0-rc.2、0.2.1-rc.2、0.2.1-rc.3、0.2.1-rc.4 与 0.2.1-rc.5**；其他版本在任务开始前拒绝。`dst dsh <参数...>` 不经过本地协议转换，不限制官方版本。解析 PATH 上第一个 DSH 安装，也可用 `--dsh-bin /path/to/dsh/lib/bin.js` 或 `DSH_TUI_CLI_DSH_BIN` 指定官方包的已构建 JS 入口；不执行 `.cmd`、PowerShell 或任意 shell 字符串。

### 输入、输出和执行

- 输入是位置提示词加 stdin（两者都有时以两个换行连接），保留 stdin 的 UTF-8 和行尾。`--` 后都是字面提示词。单独 `-` 表示只读 stdin。
- stdin 上限 8 MiB；单条后端 JSONL 记录上限 32 MiB。不会无限缓存整个运行事件。
- `--cwd` / `--workspace` 指定子进程目录；`--profile` 默认 `headless`，不是 `dsh-tui`。DSH 仍拥有 `$DSH_HOME`（默认官方 home）的 profile 初始化、配置、会话与策略。
- `--patch` 可重复，路径相对调用目录解析；模型参数最终以一次性 overlay 指定准确 provider/model，不猜渠道、不持久修改默认模型。用户 overlay 和 profile 是受信任代码，不是沙箱。
- `--permission-mode` 接受 DSH 的 `read-only`、`workspace-write`、`danger-full-access`。不继承 TUI 权限记忆；不自动放宽权限。没有审批答复者时官方服务 fail-closed。`approval: never` 在 DSH 中表示拒绝审批，不是自动批准。
- `--timeout <毫秒>` 覆盖输入等待、运行与管理查询；默认 0 为无期限。Ctrl+C/SIGTERM 停止本次子进程树，等待清理，不进入 TUI 安全模式、不重放任务。Windows 的进程终止不是可协作的 POSIX 信号，强制停止后的恢复由官方日志校验决定。

| 输出格式 | 内容 |
| --- | --- |
| `text`（默认） | 最终答案；管理查询输出 JSON 便于人读，Markdown 导出除外 |
| `json` / `--json` | 一条 `schemaVersion: 1` 的 `result`，含 `ok` 与 `text/sessionId` 或管理 `data` |
| `stream-json` | 带版本的 session/status/text/thinking/tool_call/tool_result 事件，最后输出验证过的 result；失败输出 error |

流式正文来自**已提交消息**，不是逐 token 流。只有后端正常退出、结束原因为 completed、结果完整后才输出 `ok: true`。字段和类型见随包 `cli/schema-v1.json`；JSON 失败包含 `error.code`、`error.message`、`exitCode`。默认不把后端原始诊断、异常对象或凭据写进输出；明确选择流式格式会包含模型正文、思考及工具结果，应妥善保管日志。

退出码：0 成功，1 任务/运行失败，2 用法或输入上限，3 宿主/能力/会话不可用，4 协议/输出上限，124 超时，130 中断，143 终止。`dst dsh` 保留官方输出、终端描述符和退出码，不加本地 JSON 包装。

## 管理命令

```sh
dst session list --json                 # 当前 cwd，默认最多 50 条
dst session list --all --limit 100 --json
dst session show <id> --json             # 官方校验过的日志快照
dst session export <id> > session.md     # 官方当前 surface 的可见文字，非完整备份
dst models list --provider deepseek-official --json
dst skills list --json
dst mcp status --json
dst auth status --json
dst capabilities --json
dst dsh --profile headless --help
dst dsh plugin --profile dsh-tui add <package>
```

管理命令经独立 Cordis 插件调用官方 `sessionQuery`、`llm`、`skills`、`tools`、`credentials` 服务。不会扫描 JSONL、复制凭据库、读取 TUI 缓存或自行写 profile。指定的 profile 必须兼容 headless 组合；缺服务、无效记录或查询失败明确报错。

- `--session-id` 只恢复已存在、cwd 匹配、没有 preset/fork/子代理身份的官方兼容主会话。`--continue` 用官方查询结果和最近日志活动选择，不读取 TUI 的 resume.txt；找不到兼容会话失败，不静默新建。查询后取得写租约时仍由官方重新校验。
- `session export` 仅输出当前可见 user/assistant 文字的 Markdown，不含附件、完整工具结果或 ZIP；`show --json` 是校验后的事件快照，不冒充物理备份。
- `skills list` 是当前 profile 全局作用域、当前 cwd 的目录，不代表某个 TUI preset 的技能。
- `mcp status` 只报告已注册的 `mcp__...` 工具，明确返回 `connectionHealth: unavailable`，不能据此判断无工具的服务器是否连接。
- `auth status` 只查 `DEEPSEEK_API_KEY` 的配置状态及来源，不返回值，不代表账号登录成功、key 有效或所有 provider 已认证。DSH 0.2.1 的默认 headless profile 禁用了凭据服务，此命令返回 `CAPABILITY_UNAVAILABLE`（退出码 3）；需要查询时，显式选择挂载该服务的兼容 profile 或 `--patch`，CLI 不会自行启用凭据库。
- `capabilities` 声明 adapter 实现的命令及版本限制，不保证任意自定义 profile 都挂载了相应服务。

## 与 TUI 和未来官方 CLI 的边界

```text
bin/dsh-tui.js（只做惰性分发）
  cli/entry.mjs（唯一组装根）
    args + engine + protocol + process
              │ 注入 CliAdapter
    adapters/dsh/（官方子进程 + 公开服务插件）
```

`contracts.d.ts` 定义小型内部 adapter 接口。引擎不 import adapter、厂商或 `src/`；只有 entry 选择 adapter。新增命令要有实际可执行能力，不用空类、万能 service locator 或大量预占方法。未来换官方 CLI 时，实现同一接口，运行同一契约测试，切换组装根；不要改用户语法，不复制领域实现，不因执行失败切另一引擎重跑。新协议版本需要显式更新 adapter 与 schema/测试，不能把新版号当兼容证明。

global 启动器优先使用已更新 profile 中的 CLI，缺席才使用自己随包的 CLI；半安装缺模块时退出，不自动安装。普通 help/version/safe 仍不依赖 CLI。npm 包和安装器随包分发现成 ESM，无需 tsx 或 TUI 编译产物。standalone 也从解压运行时调用同一 CLI；自动化子进程需要系统 Node `^22.19 || >=24`（可用 `DSH_TUI_CLI_NODE` 指定），不把 pkg 自身当普通 node 递归启动。

暂未实现：任意 TUI preset 会话接续、设置/凭据写操作、OAuth 非交互登录、MCP 重连、常驻后台 daemon、Claude/Codex 自动化 adapter、Claude 云端/Remote Control。已有 slash 命令不因此自动变成 Shell 子命令；这些不属于二期当前验收清单，仍由总目标后续讨论。

## 程序调用示例

Node（shell:false；Windows 请定位 npm 包的 JS bin，避免 `.cmd` 插值）：

```js
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['/absolute/dsh-tui/bin/dsh-tui.js', 'run', '--json'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
child.stdin.end('检查当前目录')
let text = ''
child.stdout.setEncoding('utf8').on('data', chunk => { text += chunk })
child.stderr.on('data', chunk => process.stderr.write(chunk))
child.on('close', code => { const result = JSON.parse(text); console.log(code, result.ok) })
```

Python：

```python
import json, subprocess
p = subprocess.run(['node', '/absolute/dsh-tui/bin/dsh-tui.js', 'run', '--json'], input='检查当前目录', text=True, encoding='utf-8', capture_output=True)
result = json.loads(p.stdout)
print(p.returncode, result['ok'])
```

PowerShell：

```powershell
$result = & node 'C:\path\dsh-tui\bin\dsh-tui.js' run --json '检查当前目录'
$code = $LASTEXITCODE
$data = $result | ConvertFrom-Json
if ($code -ne 0) { throw $data.error.code }
$data.text
```

验证：`pnpm verify:cli`（跨平台、假宿主、解耦与负向测试）；`DST_TEST_DSH_BIN=<官方 JS bin> pnpm verify:cli:runtime`（临时 home + 假 provider 的真实官方运行时闭环，无付费模型）。

# Automation CLI

[Documentation index](README.md) · [简体中文](cli.md)

Plain `dst` / `dsh-tui` still opens the TUI. Explicit `run`, `-p`, or `cli` selects an independent automation application in root `cli/`, outside `src/`. It never loads React, Ink, the channel, TUI preferences, or bootstraps the TUI profile. Tracking: #1558 and #1559, under #1246.

## Getting started

```sh
dst -p "inspect this project"
echo "complete task" | dst run --json
echo "source material" | dst run "summarize the material below" --output-format stream-json
dst run --cwd ./repo --provider deepseek-official --model deepseek-flash "check types"
dst run --session-id session-123 "continue"
dst run --continue "continue this directory's latest compatible root session"
dst cli --help
```

Install the official DSH CLI. The automation adapter currently validates **0.2.0-rc.2, 0.2.1-rc.2, 0.2.1-rc.3, 0.2.1-rc.4 and 0.2.1-rc.5**; other versions are rejected before a task starts. `dst dsh <args...>` bypasses protocol conversion and this version restriction. Resolution follows the first DSH installation on PATH. Use `--dsh-bin /path/to/dsh/lib/bin.js` or `DSH_TUI_CLI_DSH_BIN` for an explicit built JS entry belonging to the official package. The adapter never executes a `.cmd`, PowerShell command, or interpolated shell string.

### Input, output and execution

- Positional prompt and piped stdin are joined with two newlines when both exist. Stdin UTF-8 and line endings are preserved. Everything after `--` is literal prompt text; a lone `-` selects stdin only.
- Input is capped at 8 MiB and each backend JSONL record at 32 MiB. The whole event stream is not retained in memory.
- `--cwd` / `--workspace` sets child cwd. `--profile` defaults to `headless`, not `dsh-tui`. DSH owns profile initialization, configuration, sessions, and policy under `$DSH_HOME` (the official default home when omitted).
- Repeatable `--patch` paths resolve relative to the invoking directory. Explicit model parameters become a temporary overlay with an exact provider/model route; no guessed route or persisted default-model change. Profiles and overlays execute trusted code, not a sandbox.
- `--permission-mode` accepts DSH `read-only`, `workspace-write`, or `danger-full-access`. TUI permission memory is not inherited. Permissions are never silently expanded. Without an answerer, official approval fails closed. DSH `approval: never` rejects approval requests; it does not auto-approve.
- `--timeout MS` covers input, execution, and management queries; default 0 is unlimited. Ctrl+C/SIGTERM stops the owned child tree and awaits cleanup, without safe mode or task replay. Windows process termination is not a cooperative POSIX signal; official log validation decides crash recovery.

| Format | Content |
| --- | --- |
| `text` (default) | Final answer; management data is pretty JSON, except Markdown export |
| `json` / `--json` | One `schemaVersion: 1` result with `ok` and `text/sessionId` or management `data` |
| `stream-json` | Versioned session/status/text/thinking/tool_call/tool_result records, followed by a verified result; failure emits error |

Text streams at **committed-message boundaries**, not per token. `ok: true` is published only after backend exit, completed outcome, and complete result validation. The shipped `cli/schema-v1.json` describes records. JSON failures carry `error.code`, `error.message`, and `exitCode`. Raw backend diagnostics, exception objects, and credentials are not reflected by default. Streaming includes model text, thinking and tool results; store logs accordingly.

Exit codes: 0 success, 1 task/runtime failure, 2 usage/input bound, 3 unavailable host/capability/session, 4 protocol/output bound, 124 deadline, 130 interrupted, 143 terminated. Native `dst dsh` preserves official streams, terminal descriptors and exit codes without JSON wrapping.

## Management

```sh
dst session list --json                  # current cwd, at most 50 rows by default
dst session list --all --limit 100 --json
dst session show <id> --json              # validated official log snapshot
dst session export <id> > session.md      # visible current-surface text, not a backup
dst models list --provider deepseek-official --json
dst skills list --json
dst mcp status --json
dst auth status --json
dst capabilities --json
dst dsh --profile headless --help
dst dsh plugin --profile dsh-tui add <package>
```

A separate Cordis plugin calls public `sessionQuery`, `llm`, `skills`, `tools`, and `credentials` services. It does not scan JSONL, copy a credential store, read TUI caches, or write profile files. The chosen profile must be headless-compatible. Missing services, invalid records, and failed queries return explicit errors.

- `--session-id` resumes only existing, cwd-matching root sessions without a preset/fork/subagent identity. `--continue` selects by validated recent log activity through official queries, not TUI resume.txt; no compatible session means failure, never a silent fresh session. DSH revalidates after acquiring its write lease.
- `session export` is Markdown user/assistant text from the current visible surface, not attachments, complete tool output or ZIP. `show --json` is a validated event snapshot, not a physical backup.
- `skills list` reads the profile's global scope for this cwd, not a TUI preset's catalog.
- `mcp status` observes registered `mcp__...` tools and explicitly returns `connectionHealth: unavailable`; it cannot determine connectivity of a server with no tools.
- `auth status` describes only `DEEPSEEK_API_KEY` presence/source. It never returns the value or claims account login, key validity, or every provider's authentication. DSH 0.2.1 disables the credential service in its default headless profile, so this command returns `CAPABILITY_UNAVAILABLE` (exit 3). To query it, explicitly choose a compatible profile or `--patch` that mounts that service; the CLI does not enable the credential store itself.
- `capabilities` describes adapter operations and version limits, not proof that an arbitrary custom profile supplies every service.

## Separation and migration

```text
bin/dsh-tui.js (lazy dispatch only)
  cli/entry.mjs (sole composition root)
    args + engine + protocol + process
              | injected CliAdapter
    adapters/dsh/ (official subprocess + public-service plugin)
```

`contracts.d.ts` defines the small internal adapter interface. The engine imports neither adapters, vendors, nor `src/`; entry alone selects an adapter. Add operations only when executable—no placeholder commands, empty classes or speculative general service locators. For a future official CLI, implement the same interface, run the same contract tests, and change composition wiring. Preserve user syntax; never duplicate domain logic or switch implementations after failure to replay a task. A new protocol version requires explicit adapter/schema/test validation; a higher version number alone proves nothing.

The global launcher prefers the updated profile's CLI, then its own shipped CLI. Missing files in a partial installation fail without installing anything. Plain help/version/safe remain independent. npm and installer distributions ship ready-to-run ESM, without tsx or TUI compilation output. Standalone invokes the same extracted CLI; automation subprocesses need system Node `^22.19 || >=24` (override `DSH_TUI_CLI_NODE`), rather than recursively treating the pkg binary as Node.

Not implemented: arbitrary TUI-preset resume, settings/credential writes, noninteractive OAuth, MCP reconnect, persistent background daemon, Claude/Codex automation adapters, or Claude cloud/Remote Control. Slash commands do not automatically become Shell commands. These are outside the current phase-two checklist and remain future scope under the parent issue.

## Programmatic examples

Node (`shell:false`; on Windows locate the package JS bin instead of interpolating a `.cmd`):

```js
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['/absolute/dsh-tui/bin/dsh-tui.js', 'run', '--json'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
child.stdin.end('inspect the current directory')
let text = ''
child.stdout.setEncoding('utf8').on('data', chunk => { text += chunk })
child.stderr.on('data', chunk => process.stderr.write(chunk))
child.on('close', code => { const result = JSON.parse(text); console.log(code, result.ok) })
```

Python:

```python
import json, subprocess
p = subprocess.run(['node', '/absolute/dsh-tui/bin/dsh-tui.js', 'run', '--json'], input='inspect the current directory', text=True, encoding='utf-8', capture_output=True)
result = json.loads(p.stdout)
print(p.returncode, result['ok'])
```

PowerShell:

```powershell
$result = & node 'C:\path\dsh-tui\bin\dsh-tui.js' run --json 'inspect the current directory'
$code = $LASTEXITCODE
$data = $result | ConvertFrom-Json
if ($code -ne 0) { throw $data.error.code }
$data.text
```

Validation: `pnpm verify:cli` (cross-platform fake processes, separation and negative tests); `DST_TEST_DSH_BIN=<official JS bin> pnpm verify:cli:runtime` (real official profile in a temporary home with a fake provider, no paid model).

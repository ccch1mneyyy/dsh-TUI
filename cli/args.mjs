/** Backend-neutral command grammar; values are never inferred from TUI state. */
import { resolve } from 'node:path'
import { CliError } from './protocol.mjs'

const valueFlags = new Map([
  ['--cwd', 'cwd'], ['--workspace', 'cwd'], ['--profile', 'profile'],
  ['--patch', 'patches'], ['--dsh-bin', 'dshBin'], ['--timeout', 'timeout'],
  ['--output-format', 'output'], ['--session-id', 'sessionId'], ['--resume', 'sessionId'],
  ['--limit', 'limit'], ['--provider', 'provider'], ['--model', 'model'],
  ['--permission-mode', 'permission'],
])
const kinds = new Set(['run', 'session', 'models', 'skills', 'mcp', 'auth', 'capabilities', 'dsh'])
const management = {
  session: ['list', 'show', 'export'], models: ['list'], skills: ['list'],
  mcp: ['status'], auth: ['status'],
}

function usage(message) { throw new CliError('INVALID_ARGUMENT', message, 2) }

/** Parse only this CLI's namespace. `dsh` is an opaque argv escape hatch. */
export function parse(argv, cwd = process.cwd()) {
  const args = [...argv]
  const namespaced = args[0] === 'cli'
  if (namespaced) args.shift()
  if (namespaced && args[0] && !args[0].startsWith('-') && !kinds.has(args[0])) usage(`Unknown CLI command ${args[0]}`)
  const kind = kinds.has(args[0]) ? args.shift() : 'run'
  if (kind === 'dsh') return { kind, args, cwd, timeout: 0, output: 'text' }
  const request = { kind, cwd, profile: 'headless', patches: [], timeout: 0, output: 'text' }
  const positional = []
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (token === '--') { positional.push(...args.slice(index + 1)); break }
    if (token === '-p' || token === '--print') {
      if (kind !== 'run') usage('--print requires run mode')
      continue
    }
    if (token === '-h' || token === '--help') { request.help = true; continue }
    if (token === '--json') {
      if (seen.has('output')) usage('Output format may be specified only once')
      seen.add('output')
      request.output = 'json'
      continue
    }
    if (token === '-c' || token === '--continue') { request.continue = true; continue }
    if (token === '--all') { request.all = true; continue }
    if (token === '-' || !token.startsWith('-')) { positional.push(token); continue }
    const equal = token.indexOf('=')
    const flag = equal < 0 ? token : token.slice(0, equal)
    const key = valueFlags.get(flag)
    if (key === undefined) usage(`Unknown option ${flag}; use dst dsh for native DSH arguments`)
    const value = equal < 0 ? args[++index] : token.slice(equal + 1)
    if (value === undefined || value === '' || (equal < 0 && value.startsWith('--'))) usage(`${flag} requires a value`)
    if (seen.has(key) && key !== 'patches') usage(`${flag} may be specified only once`)
    seen.add(key)
    if (key === 'patches') request.patches.push(resolve(cwd, value))
    else request[key] = value
  }
  if (request.help) return request
  request.cwd = resolve(cwd, request.cwd)
  if (request.dshBin) request.dshBin = resolve(cwd, request.dshBin)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(request.profile)) usage('Invalid profile name')
  if (!['text', 'json', 'stream-json'].includes(request.output)) usage('Output format must be text, json, or stream-json')
  for (const key of ['timeout', 'limit']) {
    if (request[key] === undefined) continue
    if (!/^\d+$/u.test(String(request[key]))) usage(`${key} must be an integer`)
    request[key] = Number(request[key])
    if (!Number.isSafeInteger(request[key]) || request[key] > 2147483647 || (key === 'limit' && request[key] < 1)) usage(`Invalid ${key}`)
  }
  if (kind === 'run') {
    if (request.continue && request.sessionId) usage('--continue and --session-id are mutually exclusive')
    if (request.all || request.limit) usage('--all/--limit are session list options')
    if (request.model && !request.provider) usage('--model requires --provider (no guessed model route)')
    if (request.provider && !request.model) usage('--provider requires --model in run mode')
    if (request.permission && !['read-only', 'workspace-write', 'danger-full-access'].includes(request.permission)) usage('Unknown DSH permission mode')
    request.prompt = positional.join(' ')
    if (positional.includes('-') && positional.length !== 1) usage('The stdin marker - must be the only prompt argument')
  } else if (management[kind]) {
    request.action = positional.shift() ?? management[kind][0]
    if (!management[kind].includes(request.action)) usage(`Unknown ${kind} action ${request.action}`)
    if (kind === 'session' && ['show', 'export'].includes(request.action)) {
      if (request.sessionId || !positional[0]) usage(`session ${request.action} requires one positional session id`)
      request.sessionId = positional.shift()
    }
    if (positional.length) usage('Unexpected positional arguments')
    if (request.continue || request.model || request.permission) usage('Run-only option used outside run mode')
    if (request.provider && kind !== 'models') usage('--provider is a models list option')
    if ((request.all || request.limit) && !(kind === 'session' && request.action === 'list')) usage('--all/--limit require session list')
    if (request.sessionId && !(kind === 'session' && ['show', 'export'].includes(request.action))) usage('--session-id is a run option')
  } else {
    if (positional.length || request.continue || request.sessionId || request.model || request.provider || request.permission || request.all || request.limit) usage('Unexpected capability arguments')
  }
  return request
}

/** Output selection for parser failures; values and literal prompt tails are skipped. */
export function errorFormat(argv) {
  let format = 'text'
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') break
    if (token === 'dsh' && (i === 0 || (i === 1 && argv[0] === 'cli'))) return 'text'
    if (token === '--json') format = 'json'
    if (token === '--output-format') {
      const value = argv[++i]
      if (['text', 'json', 'stream-json'].includes(value)) format = value
    } else if (token.startsWith('--output-format=')) {
      const value = token.slice('--output-format='.length)
      if (['text', 'json', 'stream-json'].includes(value)) format = value
    } else if (valueFlags.has(token)) i++
  }
  return format
}

export function help() {
  return `Usage: dst run [options] [--] [prompt...]
       dst -p [options] [prompt...]
       dst cli <command> [options]
       dst dsh <native DSH argv...>

Commands:
  run                     Run one DSH task without loading the TUI
  session list            List sessions (current cwd; --all, --limit N)
  session show <id>        Read the validated durable session log
  session export <id>      Export visible text as Markdown (JSON with --json)
  models list             List registered provider models (--provider ID)
  skills list             List global profile skills for this cwd
  mcp status              Report registered MCP tools, not connection health
  auth status             Report credential presence; never credential values
  capabilities            Describe this adapter and its supported operations
  dsh                     Forward every remaining argument unchanged to DSH

Options:
  -p, --print             One-shot mode; alias of run
  --cwd, --workspace DIR  Child working directory (default: current directory)
  --profile NAME          DSH headless-compatible profile (default: headless)
  --patch FILE            Additional DSH overlay, repeatable
  --dsh-bin FILE          Explicit official DSH JavaScript bin (not a shell shim)
  --session-id ID         Resume an existing compatible DSH session
  -c, --continue          Resume newest compatible root session in this cwd
  --provider ID --model ID  Exact run model route, applied by a launch overlay
  --permission-mode MODE  read-only | workspace-write | danger-full-access
  --output-format FORMAT text | json | stream-json (schemaVersion: 1)
  --json                  Alias for --output-format json
  --timeout MS            Entire invocation deadline; 0 means no deadline
  -h, --help              Show this help without starting DSH

Piped UTF-8 text is appended after the prompt, separated by two newlines.
Run output is committed-message streaming, not token streaming. Resume retains
DSH's preset/fork/cwd restrictions. This CLI does not inherit the TUI profile.
Exit codes: 0 success, 1 task failure, 2 usage, 3 unavailable, 4 protocol,
124 deadline, 130 interrupted, 143 terminated. Native passthrough keeps DSH codes.
`
}

#!/usr/bin/env node
/**
 * Redact raw Claude SDK recordings (scripts/probes/claude-sdk-record.mjs) into
 * committable translator fixtures, keeping every message's STRUCTURE:
 *
 *   - absolute paths: the scenario project dir → /fixture/project, the home
 *     dir → /fixture/home, the temp dir → /fixture/tmp, the recording root →
 *     /fixture/root;
 *   - identifiers: session ids and every other UUID → stable placeholders by
 *     first appearance (00000000-0000-4000-8000-00000000000N); API message
 *     ids `msg_…`, tool ids `toolu_…`, request ids `req_…` → numbered
 *     placeholders;
 *   - secrets/account: thinking `signature`s and `signature_delta`s, email /
 *     organization / account / user-id fields, api key sources;
 *   - account configuration in `system/init`: MCP servers, plugins, skills,
 *     user/plugin agents, MCP tools, non-builtin slash commands and memory
 *     paths (they name the recording user's own setup);
 *   - timing noise is kept (it is not identifying).
 *
 * Usage: node scripts/fixtures/claude/redact.mjs <raw-dir> [out-dir]
 *        (out-dir defaults to scripts/fixtures/claude/)
 * Writes `<scenario>.jsonl` per `<scenario>.raw.jsonl`, and
 * `transcripts/<scenario>.jsonl` per `<scenario>.transcript.raw.jsonl` (the
 * read-API dump of scripts/probes/claude-transcript-dump.mjs), redacted with
 * the SAME placeholder maps as its stream so ids line up between the live
 * recording and the replay. After redacting, the output is scanned for the
 * home dir, the user name and any remaining absolute path under them; a hit
 * aborts with a non-zero exit.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const rawDir = process.argv[2]
if (!rawDir) {
  console.error('usage: node redact.mjs <raw-dir> [out-dir]')
  process.exit(2)
}
const outDir = process.argv[3] ?? path.dirname(new URL(import.meta.url).pathname)
const home = os.homedir()
const user = os.userInfo().username
const tmp = os.tmpdir()
const rawRoot = path.resolve(rawDir)

/** Built-in CLI slash commands and agents that are safe to keep. */
const BUILTIN_COMMANDS = new Set(['compact', 'context', 'cost', 'init', 'review', 'security-review', 'model', 'clear', 'help', 'memory', 'status', 'doctor', 'mcp', 'agents', 'permissions', 'hooks', 'config', 'add-dir', 'export', 'resume', 'rewind', 'usage', 'pr-comments', 'release-notes', 'todos', 'output-style'])
const BUILTIN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'output-style-setup'])
const SECRET_KEYS = new Set(['signature', 'email', 'organization', 'organizationName', 'organization_uuid', 'account', 'accountUuid', 'account_uuid', 'userId', 'user_id', 'apiKeySource', 'memory_paths', 'messaging_socket_path'])

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu
const MSG_ID = /\bmsg_[A-Za-z0-9]{8,}\b/gu
const TOOL_ID = /\btoolu_[A-Za-z0-9]{8,}\b/gu
const REQ_ID = /\breq_[A-Za-z0-9]{8,}\b/gu

function makeMapper(prefix, format) {
  const map = new Map()
  return value => {
    if (!map.has(value)) map.set(value, format(map.size + 1, prefix))
    return map.get(value)
  }
}

function redactScenario(name, lines, transcriptLines = []) {
  const project = path.join(rawRoot, `project-${name}`)
  const uuid = makeMapper('', n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`)
  const msgId = makeMapper('msg_fixture_', (n, p) => `${p}${String(n).padStart(3, '0')}`)
  const toolId = makeMapper('toolu_fixture_', (n, p) => `${p}${String(n).padStart(3, '0')}`)
  const reqId = makeMapper('req_fixture_', (n, p) => `${p}${String(n).padStart(3, '0')}`)
  const realPathOf = p => { try { return fs.realpathSync(p) } catch { return p } }
  const replacements = [
    [realPathOf(project), '/fixture/project'],
    [project, '/fixture/project'],
    [realPathOf(rawRoot), '/fixture/root'],
    [rawRoot, '/fixture/root'],
    [realPathOf(tmp), '/fixture/tmp'],
    [tmp, '/fixture/tmp'],
    [home, '/fixture/home'],
  ].filter(([from], index, all) => all.findIndex(([other]) => other === from) === index)
    .sort((a, b) => b[0].length - a[0].length)
  // Project dirs under /tmp also appear munged into `-tmp-…` names.
  const munge = p => p.replace(/[^A-Za-z0-9]/gu, '-')
  const munged = [[munge(realPathOf(project)), '-fixture-project'], [munge(project), '-fixture-project'], [munge(home), '-fixture-home']]

  const string = value => {
    let out = value
    for (const [from, to] of replacements) out = out.split(from).join(to)
    for (const [from, to] of munged) out = out.split(from).join(to)
    out = out.replace(UUID, match => uuid(match.toLowerCase()))
    out = out.replace(MSG_ID, match => msgId(match)).replace(TOOL_ID, match => toolId(match)).replace(REQ_ID, match => reqId(match))
    if (user.length >= 3) out = out.split(`/${user}/`).join('/fixture-user/')
    return out
  }

  /** Delta objects already redacted as a joined run (never twice). */
  const done = new WeakSet()
  const walk = (value, key) => {
    if (typeof value === 'string') return string(value)
    if (Array.isArray(value)) return value.map(item => walk(item, key))
    if (value === null || typeof value !== 'object') return value
    if (done.has(value)) {
      return value.type === 'signature_delta' ? { ...value, signature: 'REDACTED' } : value
    }
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k)) { out[k] = typeof v === 'string' ? 'REDACTED' : v === null ? null : Array.isArray(v) ? [] : 'REDACTED'; continue }
      // Keys can be identifiers too (tool-input maps keyed by tool id).
      out[string(k)] = walk(v, k)
    }
    // signature_delta payloads
    if (out.type === 'signature_delta' && typeof out.signature === 'string') out.signature = 'REDACTED'
    return out
  }

  const scrubInit = msg => {
    if (msg?.type !== 'system' || msg.subtype !== 'init') return msg
    return {
      ...msg,
      mcp_servers: [],
      plugins: [],
      plugin_errors: [],
      skills: [],
      agents: Array.isArray(msg.agents) ? msg.agents.filter(agent => BUILTIN_AGENTS.has(agent)) : msg.agents,
      tools: Array.isArray(msg.tools) ? msg.tools.filter(tool => typeof tool === 'string' && !tool.startsWith('mcp__')) : msg.tools,
      slash_commands: Array.isArray(msg.slash_commands) ? msg.slash_commands.filter(cmd => BUILTIN_COMMANDS.has(cmd)) : msg.slash_commands,
    }
  }

  const entries = lines.map(line => JSON.parse(line))
  for (const delta of rejoinStreamDeltas(entries, string)) done.add(delta)
  const stream = entries.map(entry => {
    if (entry.msg !== undefined) entry.msg = scrubInit(entry.msg)
    return JSON.stringify(walk(entry))
  })
  // After the stream: its placeholders keep their numbering, and the
  // transcript's shared ids map to the same placeholders.
  const transcript = transcriptLines.map(line => JSON.stringify(walk(JSON.parse(line))))
  return { stream, transcript }
}

/** The payload field of each streamed delta kind. */
const DELTA_FIELD = { text_delta: 'text', thinking_delta: 'thinking', input_json_delta: 'partial_json' }

/**
 * Streamed deltas split strings at arbitrary points, so a path can straddle
 * two chunks and survive a per-string redaction. Every (response, block,
 * delta kind) run is joined, redacted as one string, and re-split into the
 * same number of chunks (structure kept; chunk boundaries move).
 */
function rejoinStreamDeltas(entries, redactString) {
  const runs = new Map()
  let response = 0
  for (const entry of entries) {
    const event = entry.dir === 'out' && entry.msg?.type === 'stream_event' ? entry.msg.event : undefined
    if (event?.type === 'message_start') response += 1
    if (event?.type !== 'content_block_delta') continue
    const field = DELTA_FIELD[event.delta?.type]
    if (field === undefined || typeof event.delta[field] !== 'string') continue
    const key = `${response}:${event.index}:${event.delta.type}`
    if (!runs.has(key)) runs.set(key, [])
    runs.get(key).push({ delta: event.delta, field })
  }
  const redacted = []
  for (const run of runs.values()) {
    const joined = redactString(run.map(part => part.delta[part.field]).join(''))
    const size = Math.ceil(joined.length / run.length)
    run.forEach((part, index) => {
      part.delta[part.field] = index === run.length - 1 ? joined.slice(index * size) : joined.slice(index * size, (index + 1) * size)
      redacted.push(part.delta)
    })
  }
  return redacted
}

fs.mkdirSync(path.join(outDir, 'transcripts'), { recursive: true })
let failures = 0
const readLines = file => fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
for (const file of fs.readdirSync(rawDir).filter(f => f.endsWith('.raw.jsonl') && !f.endsWith('.transcript.raw.jsonl')).sort()) {
  const name = file.slice(0, -'.raw.jsonl'.length)
  const lines = readLines(path.join(rawDir, file))
  const transcriptFile = path.join(rawDir, `${name}.transcript.raw.jsonl`)
  const transcriptLines = fs.existsSync(transcriptFile) ? readLines(transcriptFile) : []
  const redacted = redactScenario(name, lines, transcriptLines)
  const outputs = [[`${name}.jsonl`, redacted.stream]]
  // Transcripts live in their own directory: every top-level `*.jsonl` here
  // is a stream fixture of verify-claude-translate.
  if (transcriptLines.length > 0) outputs.push([path.join('transcripts', `${name}.jsonl`), redacted.transcript])
  for (const [out, rows] of outputs) {
    const text = rows.join('\n') + '\n'
    for (const needle of [home, rawRoot, `/${user}/`, '@anthropic.com']) {
      if (needle.length > 3 && text.includes(needle)) {
        console.error(`${out}: redacted output still contains ${JSON.stringify(needle)}`)
        failures += 1
      }
    }
    fs.writeFileSync(path.join(outDir, out), text)
    console.log(`${out}: ${rows.length} lines`)
  }
}
process.exit(failures === 0 ? 0 : 1)

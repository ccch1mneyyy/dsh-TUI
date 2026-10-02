// Maintainer probe — NOT a regression test, NOT part of CI.
//
// Dumps the SDK's read-API view of recorded sessions (docs/agent-backend-design.md
// §4.11) next to their raw stream recordings, for the resume-replay fixtures
// (scripts/verify-claude-replay.ts): for every `<name>.raw.jsonl` written by
// scripts/probes/claude-sdk-record.mjs, the session id is read from the
// recording's first `system/init`, and
//
//   getSessionMessages(id, { dir: <root>/project-<name>, includeSystemMessages: true })
//   listSubagents(id, { dir }) + getSubagentMessages(id, agentId, { dir })
//
// are written to `<name>.transcript.raw.jsonl`, one `{"kind":"main","msg":…}`
// or `{"kind":"subagent","agentId":…,"msg":…}` per line. No CLI runs and no
// model is called: it only reads the transcripts the CLI already wrote.
//
// Raw files contain real paths and ids: NEVER commit them. Run
// scripts/fixtures/claude/redact.mjs over the directory (it redacts a
// transcript together with its stream recording, so ids line up).
//
// Usage: node scripts/probes/claude-transcript-dump.mjs <raw-dir> [scenario…]
import { getSessionMessages, getSubagentMessages, listSubagents } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
if (!root) {
  console.error('usage: node claude-transcript-dump.mjs <raw-dir> [scenario…]')
  process.exit(2)
}
const only = new Set(process.argv.slice(3))

for (const file of fs.readdirSync(root).filter(name => name.endsWith('.raw.jsonl') && !name.endsWith('.transcript.raw.jsonl')).sort()) {
  const name = file.slice(0, -'.raw.jsonl'.length)
  if (only.size > 0 && !only.has(name)) continue
  const init = fs.readFileSync(path.join(root, file), 'utf8').split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line))
    .find(entry => entry.dir === 'out' && entry.msg?.type === 'system' && entry.msg.subtype === 'init')
  const sessionId = init?.msg?.session_id
  if (typeof sessionId !== 'string') {
    console.error(`${name}: no system/init in the recording; skipped`)
    continue
  }
  const dir = path.join(path.resolve(root), `project-${name}`)
  const main = await getSessionMessages(sessionId, { dir, includeSystemMessages: true })
  const lines = main.map(msg => JSON.stringify({ kind: 'main', msg }))
  for (const agentId of await listSubagents(sessionId, { dir })) {
    for (const msg of await getSubagentMessages(sessionId, agentId, { dir })) lines.push(JSON.stringify({ kind: 'subagent', agentId, msg }))
  }
  fs.writeFileSync(path.join(root, `${name}.transcript.raw.jsonl`), `${lines.join('\n')}\n`)
  console.log(`${name}: ${main.length} main messages, ${lines.length - main.length} subagent messages`)
}

/** No network/model: a process-shaped fixture for the CLI adapter tests. */
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (process.env.FAKE_DSH_ARGS) writeFileSync(process.env.FAKE_DSH_ARGS, JSON.stringify(args))
if (args[0] === '--version') { console.log('0.2.0-rc.2'); process.exit(0) }
if (args[0] === 'echo') { console.log(JSON.stringify(args.slice(1))); process.exit(Number(process.env.FAKE_EXIT ?? 0)) }
const overlayIndex = args.lastIndexOf('--patch')
const patch = JSON.parse(readFileSync(args[overlayIndex + 1], 'utf8'))
const management = patch.find(row => row.insert)?.insert?.[0]?.config?.request
const mode = process.env.FAKE_DSH_MODE
if (mode === 'hang') { setInterval(() => {}, 1000) }
else if (mode === 'invalid') process.stdout.write('not-json\n')
else if (mode === 'partial') process.stdout.write('{"type":')
else if (mode === 'missing') process.stdout.write('{"type":"session","sessionId":"one"}\n')
else if (management) {
  const data = management.action === 'continue' ? { sessionId: 'existing' } : [{ sessionId: 'existing', cwd: management.cwd }]
  console.log(JSON.stringify({ schemaVersion: 1, type: 'final', data }))
} else {
  let prompt = ''
  for await (const chunk of process.stdin) prompt += chunk
  const messages = [
    { type: 'session', sessionId: 'fixture-session' },
    { type: 'text', text: prompt },
    { type: 'status', phase: 'turn_end', reason: { kind: mode === 'outcome-error' ? 'error' : 'completed' } },
    { type: 'final', text: prompt },
  ]
  if (mode === 'error') messages.splice(1, 0, { type: 'error', message: 'secret-should-not-be-reflected' })
  for (const message of messages) {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`)
    if (mode === 'split') for (const byte of bytes) process.stdout.write(Buffer.from([byte]))
    else process.stdout.write(bytes)
  }
  if (mode === 'after-final') console.log('{"type":"text","text":"late"}')
  if (mode === 'nonzero') process.exitCode = 1
}

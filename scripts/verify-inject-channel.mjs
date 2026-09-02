/**
 * Verification for the external injection channel (src/dsh-adapter/inject-channel.ts).
 *
 * Pure parsing (no socket):
 * - parseInjectMessage accepts prompt.append (with string text) and
 *   command.execute:prompt.submit, and rejects malformed lines (non-JSON,
 *   wrong type, missing/typed-wrong fields, unknown command) with null
 *
 * End-to-end over a real Unix socket (skipped on win32, which uses named pipes):
 * - openInjectChannel binds a per-session socket, writes a discovery record
 *   into servers.json with the right cwd, and dispatches newline-delimited
 *   messages: prompt.append → append(text), command.execute → submit()
 * - two messages in one write (split on the newline) both dispatch, in order
 * - close() removes this session's discovery record and unlinks the socket
 *
 * Uses a temp HOME so the real ~/.dsh-tui is never touched.
 *
 * Run: node --import tsx/esm scripts/verify-inject-channel.mjs
 */
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point DATA_DIR at a temp home BEFORE importing the module (paths.ts reads
// homedir at import time).
const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-inject-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const mod = await import('../src/dsh-adapter/inject-channel.ts')
const { parseInjectMessage, openInjectChannel, socketPathFor, SERVERS_FILE } = mod

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    console.error(`  FAIL ${name}`)
    failures++
  }
}

console.log('parseInjectMessage:')
check('append with text', JSON.stringify(parseInjectMessage('{"type":"prompt.append","text":"@a.ts "}')) === JSON.stringify({ type: 'prompt.append', text: '@a.ts ' }))
check('submit command', JSON.stringify(parseInjectMessage('{"type":"command.execute","command":"prompt.submit"}')) === JSON.stringify({ type: 'command.execute', command: 'prompt.submit' }))
check('empty line → null', parseInjectMessage('') === null)
check('non-JSON → null', parseInjectMessage('not json') === null)
check('wrong type → null', parseInjectMessage('{"type":"nope"}') === null)
check('append without text → null', parseInjectMessage('{"type":"prompt.append"}') === null)
check('append non-string text → null', parseInjectMessage('{"type":"prompt.append","text":42}') === null)
check('unknown command → null', parseInjectMessage('{"type":"command.execute","command":"session.new"}') === null)

if (process.platform === 'win32') {
  console.log('socket e2e: skipped on win32 (named pipes)')
  process.exit(failures === 0 ? 0 : 1)
}

console.log('socket e2e:')
const sessionId = 'test-session-1234'
const cwd = '/tmp/project-x'
const appended = []
let submits = 0
const channel = openInjectChannel(
  sessionId,
  cwd,
  { append: (t) => appended.push(t), submit: () => { submits++ } },
  (m) => console.error('    channel error:', m),
)
check('openInjectChannel returned a channel', channel !== null)
check('socketPathFor matches channel path', channel?.socketPath === socketPathFor(sessionId))

// Discovery record written with our cwd.
const servers = JSON.parse(readFileSync(SERVERS_FILE, 'utf8'))
const record = servers.find((s) => s.sessionId === sessionId)
check('discovery record present', record !== undefined)
check('discovery record cwd correct', record?.cwd === cwd)
check('discovery record socketPath correct', record?.socketPath === channel?.socketPath)

// Connect and send two messages in one write.
await new Promise((resolve, reject) => {
  const client = connect(channel.socketPath, () => {
    client.write('{"type":"prompt.append","text":"@src/foo.ts "}\n{"type":"command.execute","command":"prompt.submit"}\n')
    client.end()
  })
  client.on('close', resolve)
  client.on('error', reject)
})

// Give the server loop a tick to dispatch.
await new Promise((r) => setTimeout(r, 100))
check('append received once', appended.length === 1)
check('append text correct', appended[0] === '@src/foo.ts ')
check('submit received once', submits === 1)

// close() cleans up.
channel.close()
await new Promise((r) => setTimeout(r, 50))
const after = existsSync(SERVERS_FILE) ? JSON.parse(readFileSync(SERVERS_FILE, 'utf8')) : []
check('discovery record removed after close', after.find((s) => s.sessionId === sessionId) === undefined)
check('socket file unlinked after close', !existsSync(channel.socketPath))

console.log(failures === 0 ? '\nAll injection-channel checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)

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
 * Uses a temp HOME so the real ~/.dsh-tui is never touched, and asserts that the
 * redirection actually took effect before binding anything (see the guard below:
 * paths.ts resolves homedir at *import* time, so a reordered import would point
 * DATA_DIR — and the socket — at the real home).
 *
 * The fake home is created under the shortest writable temp root. Unix sockets
 * bind through a 104-byte `sun_path` cap, and macOS hands out a ~48-byte
 * per-user TMPDIR (/var/folders/.../T), so the old `mkdtempSync(tmpdir())` root
 * plus the socket suffix overflowed it and `listen` failed with EINVAL — while
 * Linux (`/tmp`) stayed inside the cap and CI never saw it. Whether the derived
 * path fits is measured from `socketPathFor` itself rather than from a copy of
 * the on-disk layout, so a DATA_DIR rename cannot silently skew this gate; when
 * it does not fit, the socket half is reported skipped with the measured numbers
 * instead of failing the gate for a reason unrelated to injection.
 * `DSH_TUI_TEST_SUN_PATH_LIMIT` lowers the budget so that skip branch is
 * reachable on a machine that does have a short temp root (honored only when
 * lowering: it can never hide a bind failure the real cap would have caught).
 *
 * Run: node --import tsx/esm scripts/verify-inject-channel.mjs
 */
import { connect } from 'node:net'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Hard cap on a bindable Unix socket path (bytes of `sockaddr_un` `sun_path`). */
const SUN_PATH_LIMIT = 104

/**
 * Test seam for the skip branch: a positive cap below {@link SUN_PATH_LIMIT}.
 * Anything else — unset, garbage, or a raised value — keeps the real limit, so
 * the seam can only shrink the budget this gate is willing to work with.
 * @returns {number} byte budget a socket path must fit into.
 */
function bindBudget() {
  const requested = Number(process.env.DSH_TUI_TEST_SUN_PATH_LIMIT)
  return Number.isSafeInteger(requested) && requested > 0 && requested < SUN_PATH_LIMIT
    ? requested
    : SUN_PATH_LIMIT
}

/** Session id for the socket e2e; short on purpose to leave path budget. */
const sessionId = 'inject-test-1'

/**
 * Create a fake home under the shortest writable temp root, maximizing the
 * chance that whatever socket path the module derives from it still fits
 * `sun_path`. No layout knowledge here: the fit is judged after import.
 * @returns {string} The fake home, or `''` when no temp root is writable (the
 *   guard below then refuses to bind instead of falling back to the real home).
 */
function makeTempHome() {
  const roots = []
  for (const root of ['/tmp', tmpdir()]) {
    if (roots.includes(root)) continue
    try {
      accessSync(root, constants.W_OK)
      roots.push(root)
    } catch {
      // Not usable as a temp root; the next candidate may be.
    }
  }
  // Shortest first, by encoded bytes: the socket path is root + suffix, and the
  // root is the only part this script controls.
  roots.sort((a, b) => Buffer.byteLength(a, 'utf8') - Buffer.byteLength(b, 'utf8'))
  for (const root of roots) {
    try {
      return mkdtempSync(join(root, 'dsh-inj-'))
    } catch {
      // Became unusable between the check and the create; try the next root.
    }
  }
  return ''
}

// Point DATA_DIR at a temp home BEFORE importing the module (paths.ts reads
// homedir at import time).
const tmpHome = makeTempHome()
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

function cleanup() {
  if (!tmpHome) return
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // Best-effort: a leaked temp home must not change the gate verdict.
  }
}

function skipSocketE2e(reason) {
  console.log(`socket e2e: skipped (${reason})`)
  cleanup()
  console.log(failures === 0 ? '\nAll injection-channel checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

if (process.platform === 'win32') {
  skipSocketE2e('win32 uses named pipes')
}

// Bind nothing we do not own. `socketPathFor` / `SERVERS_FILE` are the module's
// own answers, so this also catches a reordered or static import that resolved
// homedir back to the real home, and a stripped-down environment where no temp
// root was writable and HOME ended up empty (which would make DATA_DIR
// relative to the repo). Either way the socket half is off the table.
const derivedPath = socketPathFor(sessionId)
if (!tmpHome || !derivedPath.startsWith(tmpHome) || !SERVERS_FILE.startsWith(tmpHome)) {
  check('fake-home redirection took effect', false)
  skipSocketE2e(`HOME='${tmpHome}' but the module derives ${derivedPath}; refusing to bind outside the fake home`)
}

const socketPathBytes = Buffer.byteLength(derivedPath, 'utf8')
const budget = bindBudget()
if (socketPathBytes > budget) {
  skipSocketE2e(`${socketPathBytes}-byte socket path exceeds the ${budget}-byte bind budget; fake home ${tmpHome}`)
}

console.log(`socket e2e: (socket path ${socketPathBytes} bytes, budget ${budget})`)
try {
  await runSocketE2E()
} catch (error) {
  check(`socket e2e threw: ${String(error && error.message ? error.message : error).split('\n')[0]}`, false)
} finally {
  cleanup()
}

console.log(failures === 0 ? '\nAll injection-channel checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)

/**
 * The socket half: bind, record, dispatch over a real connection, then close.
 * Throws on any failure to reach a bound channel — the caller turns that into a
 * single FAIL and still runs cleanup.
 */
async function runSocketE2E() {
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
  if (!channel) {
    console.error('  (remaining socket assertions skipped: no bound channel)')
    return
  }

  try {
    // Discovery record written with our cwd.
    const servers = JSON.parse(readFileSync(SERVERS_FILE, 'utf8'))
    const record = servers.find((s) => s.sessionId === sessionId)
    check('discovery record present', record !== undefined)
    check('discovery record cwd correct', record?.cwd === cwd)
    check('discovery record socketPath correct', record?.socketPath === channel.socketPath)

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
  } finally {
    // A throw above (connect reset, missing record file) must not leave a live
    // listener holding a discovery record behind.
    channel.close()
  }
}

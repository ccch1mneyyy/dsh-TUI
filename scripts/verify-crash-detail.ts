/**
 * Crash-detail serialization (src/utils/crashDetail.ts, used by the exit
 * funnel). Pure-function checks, offline, no plugin graph:
 *
 *  - multi-frame stack survives verbatim (head frame and deeper frames);
 *  - the .cause chain is serialized level by level, in order, and a
 *    self-/mutually-referring chain terminates instead of looping;
 *  - componentStack / digest attached on the error object are kept;
 *  - a stackless Error degrades to name+message (the crash path's own
 *    diagnostics must not become a second crash) and non-Error throwables
 *    still stringify;
 *  - formatCrashLogLine = "<UTC ISO> pid=<pid> <text>\n" (restart.log header
 *    style), and appendCrashLog writes exactly that line to <dir>/crash.log
 *    while swallowing write failures (unwritable dir never throws);
 *  - the funnel really wires it: plugin.ts's crash branch calls
 *    serializeCrashDetail + appendCrashLog (source tripwire — reverting the
 *    funnel to message-only turns this red).
 *
 * Run: node --import tsx/esm scripts/verify-crash-detail.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendCrashLog, formatCrashLogLine, serializeCrashDetail, UNSERIALIZABLE, unserializableCrashDetail, type CrashDetail } from '../src/utils/crashDetail.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : label + ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)))
  passed += 1
  console.log('PASS ' + label)
}

/** An Error with a fully controlled multi-frame stack (Node would otherwise grow a real one). */
function withStack(error: Error, stack: string): Error {
  error.stack = stack
  return error
}

// ── multi-frame stack ──
const multi = withStack(
  new Error('boom'),
  'Error: boom\n    at widget (src/a.ts:1:1)\n    at gadget (src/b.ts:2:2)\n    at root (src/c.ts:3:3)',
)
const d1 = serializeCrashDetail(multi)
check('multi-frame stack preserved verbatim', d1.stack === multi.stack, d1.stack)
check('head + deep frames both reach text', d1.text.includes('at widget (src/a.ts:1:1)') && d1.text.includes('at root (src/c.ts:3:3)'), d1.text)
check('summary upgrades the message-only line', d1.summary === 'Error: boom', d1.summary)

// ── cause chain, level by level ──
const root = withStack(new Error('root cause'), 'Error: root cause\n    at deep (src/deep.ts:9:9)')
const mid = withStack(new Error('mid failure'), 'Error: mid failure\n    at middle (src/mid.ts:4:4)')
;(mid as Error & { cause?: unknown }).cause = root
const top = withStack(new Error('top of the chain'), 'Error: top of the chain\n    at surface (src/top.ts:1:2)')
;(top as Error & { cause?: unknown }).cause = mid
const d2 = serializeCrashDetail(top)
check('cause chain serialized in order', d2.levels.length === 3 && d2.levels.map(l => l.message).join('|') === 'top of the chain|mid failure|root cause', d2.levels)
check('cause level keeps its own stack', d2.levels[2]?.stack?.includes('at deep (src/deep.ts:9:9)') === true, d2.levels[2])
check('levels are tagged cause in text', d2.text.includes('level 2 (cause): Error: root cause'), d2.text)

// ── cycle guards: the crash path must not become a second crash ──
const selfCause = new Error('self cause')
;(selfCause as Error & { cause?: unknown }).cause = selfCause
check('self-referencing cause terminates', serializeCrashDetail(selfCause).levels.length === 1)
const a = new Error('a')
const b = new Error('b')
;(a as Error & { cause?: unknown }).cause = b
;(b as Error & { cause?: unknown }).cause = a
check('mutual cause terminates', serializeCrashDetail(a).levels.length === 2, serializeCrashDetail(a).levels)

// ── React extras: componentStack / digest attached on the error ──
const react = withStack(new Error('Minified React error #185'), 'Error: Minified React error #185\n    at dispatchSetState (react-dom.development.js:1:1)')
;(react as Error & { componentStack?: string }).componentStack = '\n    at ContextOverlay\n    at Chat\n    at App'
;(react as Error & { digest?: string }).digest = '4b8f2c1'
const d3 = serializeCrashDetail(react)
check('componentStack kept', d3.componentStack === '\n    at ContextOverlay\n    at Chat\n    at App', d3.componentStack)
check('digest kept', d3.digest === '4b8f2c1', d3.digest)
check('componentStack reaches text', d3.text.includes('at ContextOverlay') && d3.text.includes('digest: 4b8f2c1'), d3.text)

// ── degradation: no stack, no name, non-Error ──
const bare = new Error('stackless')
bare.stack = undefined
const d4 = serializeCrashDetail(bare)
check('stackless Error degrades to name+message', d4.stack === undefined && d4.message === 'stackless' && d4.summary === 'Error: stackless', d4)
check('stackless level adds no stack section', !d4.text.includes('stack:'), d4.text)
const d5 = serializeCrashDetail('just a string')
check('non-Error stringifies with typeof name', d5.message === 'just a string' && d5.levels[0]?.name === 'string' && d5.summary === 'just a string' && d5.stack === undefined, d5)

// ── crash.log line format ──
const at = new Date('2026-10-03T12:34:56.789Z')
const line = formatCrashLogLine(d1, at, 4242)
check('line = <UTC ISO> pid=<pid> <text>\n', line === '2026-10-03T12:34:56.789Z pid=4242 ' + d1.text + '\n', line)
check('header is restart.log style', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z pid=\d+ dsh-tui crashed: /.test(line), line)

// ── appendCrashLog: real write into a temp dir, failures swallowed ──
const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-crash-detail-'))
try {
  appendCrashLog(d1, dir)
  appendCrashLog(d3, dir)
  // appendCrashLog stamps the real clock/pid; detail.text is multi-line, so
  // assert block shape: every crash opens one "header + dsh-tui crashed:"
  // record, the full detail (stacks, extras) lands between records.
  const content = readFileSync(join(dir, 'crash.log'), 'utf8')
  const records = content.split(/(?=^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z pid=\d+ dsh-tui crashed: )/m).filter(r => r !== '')
  check('crash.log keeps one record per crash', records.length === 2, content)
  check('record = live ISO header + real pid + full detail', records[0] === records[0]?.match(new RegExp('^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z pid=' + process.pid + ' )([\\s\\S]*)$'))?.[1] + d1.text + '\n', records[0])
  check('react extras land in the file', (records[1] ?? '').includes('componentStack') && (records[1] ?? '').includes('digest: 4b8f2c1'), records[1])
  // A path occupied by a regular file: mkdirSync must fail, never throw out.
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x')
  let threw = false
  try {
    appendCrashLog(d1, blocker)
  } catch {
    threw = true
  }
  check('unwritable dir is swallowed', !threw)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ── hostile throwables: getters, Proxy traps, and a
// toString + Symbol.toStringTag double-throw must degrade, never escape ──
class HostileError extends Error {
  constructor() {
    super('real message')
    const boom = (): never => { throw new Error('getter boom') }
    Object.defineProperties(this, {
      name: { get: boom, configurable: true },
      stack: { get: boom, configurable: true },
      message: { get: boom, configurable: true },
      cause: { get: boom, configurable: true },
      componentStack: { get: boom, configurable: true },
      digest: { get: boom, configurable: true },
    })
  }
}
let hostileThrew = false
let hostileDetail: CrashDetail | undefined
try {
  hostileDetail = serializeCrashDetail(new HostileError())
} catch {
  hostileThrew = true
}
check('throwing getters on every read property never escape the serializer', !hostileThrew, 'serializeCrashDetail threw')
check(
  'throwing getters degrade to bounded literals (no stack, no extras, bounded message)',
  hostileDetail !== undefined && hostileDetail.stack === undefined && hostileDetail.componentStack === undefined
    && hostileDetail.digest === undefined && hostileDetail.levels.length === 1
    && typeof hostileDetail.message === 'string' && hostileDetail.message.length <= 64,
  hostileDetail?.message,
)
{
  // A Proxy whose get trap throws for every key (instanceof still resolves
  // through the default prototype trap, so the Error branch is taken).
  const inner = new Error('proxied')
  const proxy = new Proxy(inner, {
    get() { throw new Error('proxy get boom') },
  })
  let threw = false
  let detail: CrashDetail | undefined
  try {
    detail = serializeCrashDetail(proxy)
  } catch {
    threw = true
  }
  check('Proxy get trap never escapes the serializer', !threw)
  check('Proxy detail is bounded (name/stack degrade, cause chain stops)', detail !== undefined && detail.levels.length === 1, detail?.levels.length)
}
{
  // toString AND Symbol.toStringTag both throw: safeString's second
  // conversion is itself wrapped and the fixed literal is the floor.
  const doubleThrow: object = {
    toString() { throw new Error('toString boom') },
    get [Symbol.toStringTag]() { throw new Error('toStringTag boom') },
  }
  let threw = false
  let detail: CrashDetail | undefined
  try {
    detail = serializeCrashDetail(doubleThrow)
  } catch {
    threw = true
  }
  check('toString + toStringTag double-throw never escapes', !threw)
  check('double-throw degrades to the fixed literal', detail !== undefined && detail.message === UNSERIALIZABLE && detail.summary === UNSERIALIZABLE, detail?.message)
  check('a hostile link in the cause chain degrades without breaking the walk', (() => {
    const head = new Error('head ok')
    ;(head as Error & { cause?: unknown }).cause = doubleThrow
    const d = serializeCrashDetail(head)
    return d.levels.length === 2 && d.levels[0]?.message === 'head ok' && d.levels[1]?.message === UNSERIALIZABLE
  })())
}
{
  // The funnel's fixed-literal fallback: built from literals only, cannot
  // throw, and keeps the crash.log header shape (starts "dsh-tui crashed: ").
  const fallback = unserializableCrashDetail()
  check('unserializableCrashDetail is pure literals with the header shape',
    fallback.message === UNSERIALIZABLE && fallback.levels.length === 1 && fallback.summary === ('Error: ' + UNSERIALIZABLE)
      && fallback.text.startsWith('dsh-tui crashed: '),
    fallback.text.split('\n')[0])
  check('unserializableCrashDetail is stable across calls (no clock/pid reads)', JSON.stringify(unserializableCrashDetail()) === JSON.stringify(fallback))
}

// ── funnel wiring tripwire: reverting plugin.ts to message-only goes red ──
const plugin = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
check('funnel serializes the crash', plugin.includes('(deps.serialize ?? serializeCrashDetail)(deps.error)'), 'plugin.ts crash branch no longer calls serializeCrashDetail')
check('funnel appends to crash.log', plugin.includes('appendLog: appendCrashLog'), 'plugin.ts crash branch no longer calls appendCrashLog')
check('funnel crash tail degrades diagnostics independently of cleanup', plugin.includes('export function runCrashExit'), 'plugin.ts runCrashExit extraction is gone')

// ── regression note: a deep-but-finite chain is capped, not dropped ──
const chain: Error[] = []
for (let i = 0; i < 20; i++) {
  chain.push(new Error('link ' + i))
  if (i > 0) (chain[i] as Error & { cause?: unknown }).cause = chain[i - 1]
}
const d6: CrashDetail = serializeCrashDetail(chain[19])
check('absurd chain is capped at 8 levels', d6.levels.length === 8 && d6.levels[7]?.message === 'link 12', d6.levels.map(l => l.message))

console.log('ALL PASS')
console.log(`(${passed} checks)`)

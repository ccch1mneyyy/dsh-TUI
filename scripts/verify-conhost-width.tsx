/**
 * Classic conhost width regression (issue #344).
 *
 * The legacy renderer asks the active font how wide East Asian Ambiguous
 * glyphs are, so symbols such as arrows may occupy two cells even though
 * xterm-style terminals use one. The TUI must use its conservative conhost
 * policy without changing Windows Terminal's normal width model.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

type ProbeResult = {
  widths: Record<string, number>
  line?: string
}

if (process.argv[2] === '--probe') {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  Object.defineProperty(process.stdout, 'isTTY', {
    value: process.argv[3] === 'injected' ? false : true,
  })

  for (const name of [
    'WT_SESSION',
    'TERM_PROGRAM',
    'TERMINAL_EMULATOR',
    'ConEmuANSI',
    'ConEmuPID',
    'ConEmuTask',
    'ANSICON',
    'MSYSTEM',
  ]) {
    delete process.env[name]
  }
  process.env.TERM = 'dumb'
  if (process.argv[3] === 'modern') process.env.WT_SESSION = 'test-session'

  const { stringWidth } = await import('../src/ink/stringWidth.js')
  const widths = Object.fromEntries(
    ['A', '中', '·', '…', '→', '●', '◆', '★', '⚠', '✳', '❤'].map(char => [
      char,
      stringWidth(char),
    ]),
  )
  let line: string | undefined
  if (process.argv[3] === 'conhost' || process.argv[3] === 'injected') {
    const [{ Writable }, React, { Terminal: XTerm }, { render, Text }] =
      await Promise.all([
        import('node:stream'),
        import('react'),
        import('@xterm/headless'),
        import('../src/ui.js'),
      ])
    const terminal = new XTerm({
      cols: 20,
      rows: 4,
      scrollback: 0,
      allowProposedApi: true,
    })
    class FakeStdout extends Writable {
      columns = 20
      rows = 4
      isTTY = true
      _write(
        chunk: unknown,
        _encoding: BufferEncoding,
        callback: () => void,
      ): void {
        terminal.write(String(chunk), callback)
      }
    }
    const app = await render(React.createElement(Text, null, 'A·B'), {
      stdout: new FakeStdout(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    line = terminal.buffer.active.getLine(0)?.translateToString(true) ?? ''
    await app.unmount()
  }
  process.stdout.write(`\n__RESULT__${JSON.stringify({ widths, line })}`)
  process.exit(0)
}

function probe(mode: 'conhost' | 'modern' | 'injected'): ProbeResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', fileURLToPath(import.meta.url), '--probe', mode],
    { cwd: process.cwd(), encoding: 'utf8' },
  )
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
  const marker = result.stdout.lastIndexOf('__RESULT__')
  if (marker === -1) throw new Error(`probe produced no result: ${result.stdout}`)
  return JSON.parse(result.stdout.slice(marker + '__RESULT__'.length)) as ProbeResult
}

const conhost = probe('conhost')
const modern = probe('modern')
const injected = probe('injected')
const { isClassicConhost } = await import('../src/ink/terminal.js')
const { needsConhostWidthCompensation } = await import('../src/ink/stringWidth.js')
let failures = 0

function assert(condition: boolean, message: string): void {
  if (condition) console.log(`  ok ${message}`)
  else {
    failures++
    console.error(`  FAIL ${message}`)
  }
}

assert(
  conhost.widths.A === 1 && conhost.widths['中'] === 2,
  'conhost keeps ASCII/CJK widths',
)
assert(
  ['·', '…', '→', '●', '◆', '★'].every(
    char => conhost.widths[char] === 2,
  ),
  'conhost reserves two cells for East Asian Ambiguous glyphs',
)
assert(
  ['·', '…', '→', '●', '◆', '★', '⚠', '✳', '❤'].every(
    char => modern.widths[char] === 1,
  ),
  'Windows Terminal keeps ambiguous glyphs narrow',
)
assert(
  injected.line?.indexOf('B') === 3,
  'renderer honors injected stdout instead of global stdout',
)
assert(
  conhost.line?.indexOf('B') === 3,
  'renderer anchors the cell after a narrow conhost glyph',
)
assert(isClassicConhost('win32', {}, true), 'detects a native classic conhost TTY')
assert(!isClassicConhost('win32', { WT_SESSION: 'id' }, true), 'excludes Windows Terminal')
assert(
  !isClassicConhost('win32', { TERM: 'xterm-256color' }, true),
  'excludes xterm-style hosts',
)
assert(!isClassicConhost('win32', {}, false), 'excludes non-TTY renderers')
assert(
  needsConhostWidthCompensation('❤︎', { ambiguousAsWide: true }) === false,
  'VS15 text-style heart does not trigger conhost compensation',
)
assert(
  needsConhostWidthCompensation('·', { ambiguousAsWide: true }) === true,
  'ambiguous middle dot still triggers conhost compensation',
)

if (failures > 0) process.exit(1)
console.log('conhost width policy verified')

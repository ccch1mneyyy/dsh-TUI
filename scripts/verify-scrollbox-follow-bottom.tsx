/**
 * ScrollBox `followBottom` contract:
 *
 *  - default (transcript): content that grows after filling the viewport
 *    without overflow re-pins to the new tail — the streaming behavior;
 *  - `followBottom={false}` (plugin list): the same growth keeps the viewport
 *    where it was. Positional at-bottom treats scrollTop 0 with maxScroll 0 as
 *    "at the bottom", so without the opt-out a background refresh that makes a
 *    fitting list overflow jumps to the tail and hides the selected first row.
 *
 * Both cases use the same harness and sequence; only the prop differs.
 *
 * Run: node --import tsx/esm scripts/verify-scrollbox-follow-bottom.tsx
 */
process.env.FORCE_COLOR = '3'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen, Box, Text, ScrollBox },
  termTest,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
])

const { settled, viewportLines } = termTest

const COLS = 40
const ROWS = 10
const FIT = 8
const GROWN = 20

let failed = 0
let passed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (ok ? '' : '  (' + extra + ')'))
  if (ok) passed += 1
  else failed += 1
}

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  term: XTerm
  constructor(term: XTerm) {
    super()
    this.term = term
  }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.term.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

function makeHarness(followBottom: boolean): {
  Harness: () => React.ReactNode
  grow: () => void
} {
  let setCount: React.Dispatch<React.SetStateAction<number>> = () => undefined
  function Harness(): React.ReactNode {
    const [count, set] = React.useState(FIT)
    setCount = set
    return (
      <Box flexDirection="column" width={COLS} height={ROWS}>
        <Box height={1} flexShrink={0}>
          <Text>{`count-${count}`}</Text>
        </Box>
        <ScrollBox flexDirection="column" flexGrow={1} followBottom={followBottom}>
          {Array.from({ length: count }, (_, index) => (
            <Box key={index} height={1} flexShrink={0}>
              <Text>{`follow-row-${index}`}</Text>
            </Box>
          ))}
        </ScrollBox>
      </Box>
    )
  }
  return { Harness, grow: () => setCount(GROWN) }
}

async function run(followBottom: boolean): Promise<string[]> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const { Harness, grow } = makeHarness(followBottom)
  const app = await render(<AlternateScreen><Harness /></AlternateScreen>, {
    stdout: new FakeStdout(term) as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const view = (): string => viewportLines(term).join('\n')
  const fitted = await settled(() => view().includes('follow-row-0') && view().includes(`follow-row-${FIT - 1}`))
  check(`${followBottom ? 'followBottom' : 'no-follow'}: ${FIT} rows fit without scrolling (maxScroll 0)`, fitted, view())
  grow()
  if (followBottom) {
    check(`${followBottom ? 'followBottom' : 'no-follow'}: growth re-pins to the new tail`,
      await settled(() => view().includes(`follow-row-${GROWN - 1}`)), view())
  } else {
    // The count marker proves the growth committed (and therefore that any
    // buggy follow would already have painted) without a timing window.
    const committed = await settled(() => view().includes(`count-${GROWN}`))
    check('no-follow: growth keeps the viewport at the top',
      committed && view().includes('follow-row-0') && !view().includes(`follow-row-${GROWN - 1}`), view())
  }
  const lines = viewportLines(term)
  await app.unmount()
  return lines
}

const followed = await run(true)
check('followBottom default: first row is no longer visible after the tail pin',
  !followed.some(line => line.includes('follow-row-0')), followed.join('\n'))
const stayed = await run(false)
check('no-follow: first row stays visible after growth',
  stayed.some(line => line.includes('follow-row-0')), stayed.join('\n'))

console.log(`verify-scrollbox-follow-bottom: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

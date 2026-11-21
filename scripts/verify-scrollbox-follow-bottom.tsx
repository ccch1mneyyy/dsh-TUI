/**
 * ScrollBox `followBottom` contract:
 *
 *  - default (transcript): content that grows after filling the viewport
 *    without overflow re-pins to the new tail — the streaming behavior;
 *  - `followBottom={false}` (plugin list): the same growth keeps the viewport
 *    where it was. Positional at-bottom treats scrollTop 0 with maxScroll 0 as
 *    "at the bottom", so without the opt-out a background refresh that makes a
 *    fitting list overflow jumps to the tail and hides the selected first row;
 *  - the opt-out also survives an explicit scroll that lands on the bottom:
 *    a wheel on a fitting list, and `scrollTo` onto the last row, must not
 *    re-arm the positional follow (which would pin the next growth to the
 *    tail).
 *
 * Run: node --import tsx/esm scripts/verify-scrollbox-follow-bottom.tsx
 */
import type { ScrollBoxHandle } from '../src/ui.js'

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
const VIEWPORT = ROWS - 1
const FIT = 8
const GROWN = 20
const GROWN_MORE = 30

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

function makeHarness(followBottom: boolean, initialCount = FIT, grownCount = GROWN): {
  Harness: () => React.ReactNode
  grow: () => void
  scrollBy: (dy: number) => void
  scrollTo: (y: number) => void
  scrollTop: () => number
  scrollHeight: () => number
  viewportHeight: () => number
  pendingDelta: () => number
  isSticky: () => boolean
} {
  let setCount: React.Dispatch<React.SetStateAction<number>> = () => undefined
  let handle: ScrollBoxHandle | null = null
  function Harness(): React.ReactNode {
    const [count, set] = React.useState(initialCount)
    const [scroll, setScroll] = React.useState<ScrollBoxHandle | null>(null)
    setCount = set
    handle = scroll
    return (
      <Box flexDirection="column" width={COLS} height={ROWS}>
        <Box height={1} flexShrink={0}>
          <Text>{`count-${count}`}</Text>
        </Box>
        <ScrollBox ref={setScroll} flexDirection="column" flexGrow={1} followBottom={followBottom}>
          {Array.from({ length: count }, (_, index) => (
            <Box key={index} height={1} flexShrink={0}>
              <Text>{`follow-row-${index}`}</Text>
            </Box>
          ))}
        </ScrollBox>
      </Box>
    )
  }
  return {
    Harness,
    grow: () => setCount(grownCount),
    scrollBy: dy => handle?.scrollBy(dy),
    scrollTo: y => handle?.scrollTo(y),
    scrollTop: () => handle?.getScrollTop() ?? -1,
    scrollHeight: () => handle?.getScrollHeight() ?? -1,
    viewportHeight: () => handle?.getViewportHeight() ?? -1,
    pendingDelta: () => handle?.getPendingDelta() ?? -1,
    isSticky: () => handle?.isSticky() ?? true,
  }
}

async function mountScenario(followBottom: boolean, initialCount: number, grownCount: number): Promise<{
  term: XTerm
  app: Awaited<ReturnType<typeof render>>
  harness: ReturnType<typeof makeHarness>
  view: () => string
}> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const harness = makeHarness(followBottom, initialCount, grownCount)
  const { Harness } = harness
  const app = await render(<AlternateScreen><Harness /></AlternateScreen>, {
    stdout: new FakeStdout(term) as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return { term, app, harness, view: () => viewportLines(term).join('\n') }
}

async function run(followBottom: boolean): Promise<string[]> {
  const { term, app, harness, view } = await mountScenario(followBottom, FIT, GROWN)
  const { grow } = harness
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

// A wheel on a fitting list leaves stickyScroll=false with scrollTop still 0
// and maxScroll still 0. The at-bottom restore used to read that as "the user
// scrolled home" and re-arm follow even though the list opted out.
async function runWheelThenGrow(): Promise<void> {
  const { app, harness, view } = await mountScenario(false, FIT, GROWN)
  const { grow, scrollBy, isSticky, scrollTop, pendingDelta } = harness
  await settled(() => view().includes('follow-row-0') && view().includes(`follow-row-${FIT - 1}`))
  scrollBy(-3)
  check('no-follow: wheel drain on a fitting list keeps sticky off',
    await settled(() => pendingDelta() === 0) && !isSticky(),
    `sticky=${isSticky()} top=${scrollTop()}`)
  grow()
  const committed = await settled(() => view().includes(`count-${GROWN}`))
  check('no-follow: growth after that wheel keeps the viewport at the top',
    committed && view().includes('follow-row-0') && !view().includes(`follow-row-${GROWN - 1}`), view())
  await app.unmount()
}

// `scrollTo` onto the last row also clears stickyScroll. The restore used to
// flip it back on the landing frame, so the next background refresh pinned the
// grown list to its new tail.
async function runBottomThenGrow(): Promise<void> {
  const { app, harness, view } = await mountScenario(false, GROWN, GROWN_MORE)
  const { grow, scrollTo, isSticky, scrollTop, scrollHeight, viewportHeight } = harness
  const maxBefore = GROWN - VIEWPORT
  await settled(() => scrollHeight() === GROWN && viewportHeight() === VIEWPORT)
  scrollTo(1e9)
  check('no-follow: scrollTo the last row lands on the bottom without re-pinning sticky',
    await settled(() => scrollTop() === maxBefore) && !isSticky(),
    `sticky=${isSticky()} top=${scrollTop()} max=${maxBefore}`)
  grow()
  const committed = await settled(() => view().includes(`count-${GROWN_MORE}`))
  check('no-follow: growth after scrollTo-bottom keeps the old position',
    committed && view().includes(`follow-row-${maxBefore}`) && !view().includes(`follow-row-${GROWN_MORE - 1}`), view())
  await app.unmount()
}

const followed = await run(true)
check('followBottom default: first row is no longer visible after the tail pin',
  !followed.some(line => line.includes('follow-row-0')), followed.join('\n'))
const stayed = await run(false)
check('no-follow: first row stays visible after growth',
  stayed.some(line => line.includes('follow-row-0')), stayed.join('\n'))
await runWheelThenGrow()
await runBottomThenGrow()

console.log(`verify-scrollbox-follow-bottom: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

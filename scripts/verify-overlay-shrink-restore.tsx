/**
 * Regression: when an absolute OverlayAbove becomes shorter, rows covered by
 * its previous larger rect must be recomposited from the normal-flow content
 * underneath. Clearing the old rect without repainting the underlay leaves a
 * blank band (visible when slash suggestions are filtered or a long panel is
 * replaced by a short one).
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, Box, Text, ScrollBox },
  { OverlayAbove },
  { createRenderContext, resetAbsoluteRecomposePass },
] = await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/components/OverlayAbove.js'),
    import('../src/ink/render-node-to-output.js'),
  ])
const { default: inkInstances } = await import('../src/ink/instances.js')

const COLS = 80
const ROWS = 20
const term = new XTerm({
  cols: COLS,
  rows: ROWS,
  scrollback: 200,
  allowProposedApi: true,
})

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  raw = ''
  constructor(private readonly target = term) {
    super()
  }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    const text = String(chunk)
    this.raw += text
    this.target.write(text, callback)
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: () => void,
  ) {
    callback()
  }
}

type Mode = 'tall' | 'short' | 'removed'

function Fixture({ mode }: { mode: Mode }): React.ReactNode {
  const overlayRows =
    mode === 'tall'
      ? Array.from({ length: 6 }, (_, index) => `OVERLAY-TALL-${index}`)
      : ['OVERLAY-SHORT-0', 'OVERLAY-SHORT-1']
  return (
    <Box flexDirection="column" width={COLS}>
      <Box flexDirection="column">
        {Array.from({ length: 12 }, (_, index) => (
          <Text key={index}>{`UNDERLAY-${String(index).padStart(2, '0')}`}</Text>
        ))}
      </Box>
      <Box height={3} width="100%">
        {mode === 'removed' ? null : (
          <OverlayAbove>
            <Box flexDirection="column">
              {overlayRows.map(row => (
                <Text key={row}>{row}</Text>
              ))}
            </Box>
          </OverlayAbove>
        )}
        <Text>ANCHOR</Text>
      </Box>
      <Text>FOOTER</Text>
    </Box>
  )
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(
  stage: string,
  predicate: () => boolean,
  timeoutMs = 2500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${stage}`)
}

function termText(
  target: InstanceType<typeof XTerm>,
): string {
  const buffer = target.buffer.active
  return Array.from({ length: target.rows }, (_, offset) =>
    buffer.getLine(buffer.baseY + offset)?.translateToString(true) ?? '',
  ).join('\n')
}

const stdout = new FakeStdout()
const app = await render(<Fixture mode="tall" />, {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})

function visibleText(): string {
  return termText(term)
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` (${detail})`}`,
  )
  if (!ok) failures += 1
}

// The transition signal must belong to one renderer invocation. Resetting a
// nested/second render context must never erase the outer renderer's pending
// recompose decision (the module-global implementation did exactly that).
const outerContext = createRenderContext()
const nestedContext = createRenderContext()
outerContext.layoutShifted = true
outerContext.absoluteLayoutShifted = true
outerContext.scrollHint = { top: 1, bottom: 8, delta: 2 }
nestedContext.layoutShifted = true
nestedContext.absoluteLayoutShifted = true
nestedContext.scrollHint = { top: 2, bottom: 6, delta: 1 }
resetAbsoluteRecomposePass(nestedContext)
check(
  'nested render context cannot clear outer absolute transition',
  outerContext.absoluteLayoutShifted &&
    outerContext.layoutShifted &&
    outerContext.scrollHint?.delta === 2,
)
check(
  'recompose reset is scoped to the selected context',
  !nestedContext.absoluteLayoutShifted &&
    nestedContext.layoutShifted &&
    nestedContext.recomposePass &&
    nestedContext.scrollHint === null,
)

await waitFor(
  'initial tall overlay frame',
  () => visibleText().includes('OVERLAY-TALL-5'),
)
const initialBufferLength = term.buffer.active.length
let text = visibleText()
check(
  'tall overlay is visible',
  text.includes('OVERLAY-TALL-0') && text.includes('OVERLAY-TALL-5'),
)
check(
  'tall overlay covers its underlay rows',
  !text.includes('UNDERLAY-06') && !text.includes('UNDERLAY-11'),
)

app.rerender(<Fixture mode="short" />)
await waitFor(
  'short overlay and restored underlay frame',
  () =>
    visibleText().includes('OVERLAY-SHORT-1') &&
    visibleText().includes('UNDERLAY-09'),
)
text = visibleText()
check(
  'short overlay is visible',
  text.includes('OVERLAY-SHORT-0') && text.includes('OVERLAY-SHORT-1'),
)
for (let index = 6; index <= 9; index += 1) {
  const marker = `UNDERLAY-${String(index).padStart(2, '0')}`
  check(`vacated row restores ${marker}`, text.includes(marker))
}
check(
  'shrink does not grow terminal buffer',
  term.buffer.active.length === initialBufferLength,
  `${initialBufferLength} -> ${term.buffer.active.length}`,
)

app.rerender(<Fixture mode="tall" />)
await waitFor(
  'regrown overlay frame',
  () =>
    visibleText().includes('OVERLAY-TALL-5') &&
    !visibleText().includes('OVERLAY-SHORT-0'),
)
text = visibleText()
check(
  'regrown overlay has no stale short content',
  text.includes('OVERLAY-TALL-0') && !text.includes('OVERLAY-SHORT-0'),
)
check(
  'grow does not grow terminal buffer',
  term.buffer.active.length === initialBufferLength,
  `${initialBufferLength} -> ${term.buffer.active.length}`,
)

app.rerender(<Fixture mode="removed" />)
await waitFor(
  'removed overlay underlay restoration frame',
  () => visibleText().includes('UNDERLAY-11'),
)
text = visibleText()
for (let index = 6; index <= 11; index += 1) {
  const marker = `UNDERLAY-${String(index).padStart(2, '0')}`
  check(`removed overlay restores ${marker}`, text.includes(marker))
}
check(
  'remove does not grow terminal buffer',
  term.buffer.active.length === initialBufferLength,
  `${initialBufferLength} -> ${term.buffer.active.length}`,
)

app.unmount()

// Two live Ink renderers must retain independent absolute-rect histories.
// Alternate their frames so a module-global prev/cur pair would necessarily
// rotate B's rectangles into A (and vice versa).
type TestScrollHandle = {
  scrollTo(y: number): void
  scrollBy(dy: number): void
  getScrollTop(): number
  getPendingDelta(): number
}

function IsolationFixture({
  label,
  rows,
  scrollRef,
}: {
  label: string
  rows: number
  scrollRef: React.RefObject<TestScrollHandle | null>
}): React.ReactNode {
  return (
    <Box flexDirection="column" width={COLS} height={ROWS}>
      <ScrollBox ref={scrollRef} height={12} flexDirection="column">
        {Array.from({ length: 30 }, (_, index) => (
          <Text key={index}>
            {`${label}-SCROLL-${String(index).padStart(2, '0')}`}
          </Text>
        ))}
      </ScrollBox>
      <Box height={3} width="100%">
        <OverlayAbove>
          <Box flexDirection="column">
            {Array.from({ length: rows }, (_, index) => (
              <Text key={index}>{`${label}-OVERLAY-${index}`}</Text>
            ))}
          </Box>
        </OverlayAbove>
        <Text>{`${label}-ANCHOR`}</Text>
      </Box>
    </Box>
  )
}

function createTerm(): InstanceType<typeof XTerm> {
  return new XTerm({
    cols: COLS,
    rows: ROWS,
    scrollback: 200,
    allowProposedApi: true,
  })
}

const termA = createTerm()
const termB = createTerm()
const isoRefA = React.createRef<TestScrollHandle>()
const isoRefB = React.createRef<TestScrollHandle>()
const appA = await render(
  <IsolationFixture label="ISO-A" rows={6} scrollRef={isoRefA} />,
  {
    stdout: new FakeStdout(termA) as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
const appB = await render(
  <IsolationFixture label="ISO-B" rows={2} scrollRef={isoRefB} />,
  {
    stdout: new FakeStdout(termB) as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await waitFor(
  'both renderer isolation fixtures',
  () => termText(termA).includes('ISO-A-OVERLAY-5') &&
    termText(termB).includes('ISO-B-OVERLAY-1'),
)
// Render B last, then scroll A. With shared absoluteRectsPrev/Cur, A would
// repair only B's two-row rect and leave shifted copies of A's upper rows.
isoRefA.current?.scrollBy(1)
await waitFor(
  'renderer A isolated scroll frame',
  () => isoRefA.current?.getScrollTop() === 1,
)
const liveA = termText(termA)
const liveB = termText(termB)
check(
  'two live renderers keep independent absolute-rect history',
  Array.from({ length: 6 }, (_, index) => `ISO-A-OVERLAY-${index}`).every(
    marker => liveA.split(marker).length - 1 === 1,
  ) &&
    liveB.includes('ISO-B-OVERLAY-1') &&
    !liveB.includes('ISO-A-OVERLAY'),
)
appA.unmount()
appB.unmount()

// An absolute transition triggers a paint-only second pass. It must not
// drain the same pendingScrollDelta twice. With a native-terminal viewport
// of 8 rows, pending=20 drains exactly min(7, floor(20*3/4)) = 7 once.
const scrollRef = React.createRef<TestScrollHandle>()
function DrainFixture({
  mode,
  contentRows = 40,
  scrollHandle = scrollRef,
}: {
  mode: 'tall' | 'short'
  contentRows?: number
  scrollHandle?: React.RefObject<TestScrollHandle | null>
}): React.ReactNode {
  const overlayRows = mode === 'tall' ? 6 : 2
  return (
    <Box flexDirection="column" width={COLS} height={ROWS}>
      <ScrollBox ref={scrollHandle} height={8} flexDirection="column">
        {Array.from({ length: contentRows }, (_, index) => (
          <Text key={index}>{`SCROLL-${String(index).padStart(2, '0')}`}</Text>
        ))}
      </ScrollBox>
      <Box height={3} width="100%">
        <OverlayAbove>
          <Box flexDirection="column">
            {Array.from({ length: overlayRows }, (_, index) => (
              <Text key={index}>{`DRAIN-OVERLAY-${index}`}</Text>
            ))}
          </Box>
        </OverlayAbove>
        <Text>DRAIN-ANCHOR</Text>
      </Box>
    </Box>
  )
}

let captureDrainFrame = false
let resolveDrainFrame: (() => void) | undefined
const drainFrame = new Promise<void>(resolve => {
  resolveDrainFrame = resolve
})
const drainApp = await render(<DrainFixture mode="tall" />, {
  stdout: new FakeStdout(createTerm()) as unknown as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
  onFrame: () => {
    if (!captureDrainFrame) return
    captureDrainFrame = false
    resolveDrainFrame?.()
  },
})
await waitFor(
  'pending-drain fixture mount',
  () => scrollRef.current?.getScrollHeight() === 40,
)
captureDrainFrame = true
scrollRef.current?.scrollBy(20)
drainApp.rerender(<DrainFixture mode="short" />)
await Promise.race([
  drainFrame,
  sleep(1000).then(() => {
    throw new Error('timed out waiting for overlay+scroll transition frame')
  }),
])
check(
  'overlay recompose consumes pending scroll once',
  scrollRef.current?.getScrollTop() === 7 &&
    scrollRef.current?.getPendingDelta() === 13,
  `top=${scrollRef.current?.getScrollTop()} pending=${scrollRef.current?.getPendingDelta()}`,
)
drainApp.unmount()

// A transient content-height shrink deliberately preserves the previous
// scrollTop. The first pass updates scrollHeight, so a stateful second pass
// would misclassify the same frame as settled and clamp scrollTop to zero.
// Paint-only recomposition must reuse the first pass's visual position and
// leave the DOM scroll state untouched.
const shrinkRef = React.createRef<TestScrollHandle>()
const shrinkApp = await render(
  <DrainFixture
    mode="tall"
    contentRows={40}
    scrollHandle={shrinkRef}
  />,
  {
    stdout: new FakeStdout(createTerm()) as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await waitFor(
  'transient-shrink fixture mount',
  () => shrinkRef.current?.getScrollHeight() === 40,
)
shrinkRef.current?.scrollTo(10)
await waitFor(
  'transient-shrink fixture scroll position',
  () => shrinkRef.current?.getScrollTop() === 10,
)
shrinkApp.rerender(
  <DrainFixture
    mode="short"
    contentRows={4}
    scrollHandle={shrinkRef}
  />,
)
await waitFor(
  'transient content-height shrink frame',
  // ScrollBox's inner content has flexGrow:1, so four rows still occupy the
  // eight-row viewport after Yoga settles.
  () => shrinkRef.current?.getScrollHeight() === 8,
)
check(
  'paint-only recompose preserves transient-shrink scroll state',
  shrinkRef.current?.getScrollTop() === 10,
  `top=${shrinkRef.current?.getScrollTop()}`,
)
shrinkApp.unmount()

// Changing an existing node from absolute to in-flow must be treated as an
// absolute transition too. Looking only at the node's CURRENT position loses
// the fact that its previous pixels covered an unrelated clean subtree.
function PositionModeFixture({
  absolute,
}: {
  absolute: boolean
}): React.ReactNode {
  return (
    <Box flexDirection="column" width={COLS} height={ROWS}>
      <Box flexDirection="column">
        {Array.from({ length: 12 }, (_, index) => (
          <Text key={index}>{`POSITION-UNDERLAY-${String(index).padStart(2, '0')}`}</Text>
        ))}
      </Box>
      <Box height={3} width="100%">
        <Box
          position={absolute ? 'absolute' : 'relative'}
          {...(absolute ? { bottom: '100%' as const } : {})}
          flexDirection="column"
          opaque
        >
          {Array.from({ length: 6 }, (_, index) => (
            <Text key={index}>{`POSITION-OVERLAY-${index}`}</Text>
          ))}
        </Box>
        <Text>POSITION-ANCHOR</Text>
      </Box>
    </Box>
  )
}

const positionTerm = createTerm()
const positionApp = await render(<PositionModeFixture absolute />, {
  stdout: new FakeStdout(positionTerm) as unknown as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})
await waitFor(
  'absolute-position fixture mount',
  () => termText(positionTerm).includes('POSITION-OVERLAY-5'),
)
positionApp.rerender(<PositionModeFixture absolute={false} />)
await waitFor(
  'absolute-to-relative underlay restoration frame',
  () => termText(positionTerm).includes('POSITION-UNDERLAY-11'),
)
const positionText = termText(positionTerm)
check(
  'absolute-to-relative transition restores previous underlay',
  Array.from({ length: 6 }, (_, index) =>
    `POSITION-UNDERLAY-${String(index + 6).padStart(2, '0')}`,
  ).every(marker => positionText.includes(marker)),
)
positionApp.unmount()

// Yoga's display:none path returns before the normal absolute-node paint.
// The previous-frame identity history must still recognize the node as an
// overlay and restore the unrelated underlay that its old pixels covered.
function HiddenAbsoluteFixture({ hidden }: { hidden: boolean }): React.ReactNode {
  return (
    <Box flexDirection="column" width={COLS} height={ROWS}>
      <Box flexDirection="column">
        {Array.from({ length: 12 }, (_, index) => (
          <Text key={index}>
            {`HIDDEN-UNDERLAY-${String(index).padStart(2, '0')}`}
          </Text>
        ))}
      </Box>
      <Box height={3} width="100%">
        <Box
          position="absolute"
          bottom="100%"
          display={hidden ? 'none' : 'flex'}
          flexDirection="column"
          opaque
        >
          {Array.from({ length: 6 }, (_, index) => (
            <Text key={index}>{`HIDDEN-OVERLAY-${index}`}</Text>
          ))}
        </Box>
        <Text>HIDDEN-ANCHOR</Text>
      </Box>
    </Box>
  )
}

const hiddenTerm = createTerm()
const hiddenApp = await render(<HiddenAbsoluteFixture hidden={false} />, {
  stdout: new FakeStdout(hiddenTerm) as unknown as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})
await waitFor(
  'absolute-to-hidden fixture mount',
  () => termText(hiddenTerm).includes('HIDDEN-OVERLAY-5'),
)
hiddenApp.rerender(<HiddenAbsoluteFixture hidden />)
await waitFor(
  'absolute-to-hidden underlay restoration frame',
  () => termText(hiddenTerm).includes('HIDDEN-UNDERLAY-11'),
)
const hiddenText = termText(hiddenTerm)
check(
  'absolute-to-display-none restores previous underlay',
  Array.from({ length: 6 }, (_, index) =>
    `HIDDEN-UNDERLAY-${String(index + 6).padStart(2, '0')}`,
  ).every(marker => hiddenText.includes(marker)) &&
    !hiddenText.includes('HIDDEN-OVERLAY-0'),
)
hiddenApp.unmount()

// Grow sticky content in the same frame that an overlay shrinks. The first
// pass must restore sticky exactly once and hand its follow delta to Ink;
// the paint-only second pass must neither notify again nor erase the event.
const followRef = React.createRef<TestScrollHandle>()
function FollowFixture({
  contentRows,
  overlayRows,
}: {
  contentRows: number
  overlayRows: number
}): React.ReactNode {
  return (
    <Box flexDirection="column" width={COLS} height={ROWS}>
      <ScrollBox
        ref={followRef}
        height={8}
        flexDirection="column"
        stickyScroll
      >
        {Array.from({ length: contentRows }, (_, index) => (
          <Text key={index}>{`FOLLOW-SCROLL-${String(index).padStart(2, '0')}`}</Text>
        ))}
      </ScrollBox>
      <Box height={3} width="100%">
        <OverlayAbove>
          <Box flexDirection="column">
            {Array.from({ length: overlayRows }, (_, index) => (
              <Text key={index}>{`FOLLOW-OVERLAY-${index}`}</Text>
            ))}
          </Box>
        </OverlayAbove>
        <Text>FOLLOW-ANCHOR</Text>
      </Box>
    </Box>
  )
}

type CapturedFrame = {
  followScroll?: {
    delta: number
    viewportTop: number
    viewportBottom: number
  } | null
}
type InkWithRenderer = {
  renderer: (options: unknown) => CapturedFrame
}

const followTerm = createTerm()
const followStdout = new FakeStdout(followTerm)
const followApp = await render(
  <FollowFixture contentRows={40} overlayRows={6} />,
  {
    stdout: followStdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await waitFor(
  'sticky follow fixture mount',
  () =>
    followRef.current?.getScrollHeight() === 40 &&
    followRef.current?.getScrollTop() === 32 &&
    termText(followTerm).includes('FOLLOW-OVERLAY-5'),
)
const ink = inkInstances.get(followStdout as unknown as NodeJS.WriteStream)
if (!ink) throw new Error('missing Ink instance for follow-scroll probe')
const inkWithRenderer = ink as unknown as InkWithRenderer
const originalRenderer = inkWithRenderer.renderer
const capturedFrames: CapturedFrame[] = []
inkWithRenderer.renderer = options => {
  const frame = originalRenderer(options)
  capturedFrames.push(frame)
  return frame
}
let stickyRestoreCount = 0
const unsubscribeFollow = followRef.current?.subscribe(() => {
  stickyRestoreCount += 1
})
// Break sticky without changing the position. scrollTo notifies immediately;
// reset the counter so only renderer-side restoration is counted.
followRef.current?.scrollTo(32)
stickyRestoreCount = 0
followApp.rerender(<FollowFixture contentRows={42} overlayRows={2} />)
await waitFor(
  'overlay transition with sticky follow',
  () =>
    followRef.current?.getScrollTop() === 34 &&
    followRef.current?.isSticky() === true &&
    capturedFrames.some(frame => frame.followScroll?.delta === 2),
)
const followFrame = capturedFrames.find(frame => frame.followScroll?.delta === 2)
check(
  'overlay recompose restores sticky exactly once',
  stickyRestoreCount === 1,
  `notifications=${stickyRestoreCount}`,
)
check(
  'overlay recompose hands first-pass follow-scroll to Ink',
  followFrame?.followScroll?.delta === 2 &&
    followFrame.followScroll.viewportBottom -
      followFrame.followScroll.viewportTop + 1 === 8,
  JSON.stringify(followFrame?.followScroll ?? null),
)
unsubscribeFollow?.()
followApp.unmount()

// A transparent absolute node may change its painted content while keeping
// exactly the same Yoga rect. Clearing that fixed rect and repainting only the
// shorter text must reveal the normal-flow cells underneath its vacated tail.
// PromptInput's one-row notification uses this shape in production.
function FixedTransparentFixture({ short }: { short: boolean }): React.ReactNode {
  return (
    <Box flexDirection="column" width={COLS} height={ROWS}>
      {Array.from({ length: 12 }, (_, index) => (
        <Text key={index}>
          {index === 11
            ? 'FIXED-UNDERLAY-11-RESTORE-TAIL'
            : `FIXED-UNDERLAY-${String(index).padStart(2, '0')}`}
        </Text>
      ))}
      <Box height={1} width="100%">
        <Box
          position="absolute"
          bottom="100%"
          width={40}
          height={1}
          overflow="hidden"
        >
          <Text>{short ? 'SHORT' : 'FIXED-OVERLAY-LONG-COVERS-THE-TAIL'}</Text>
        </Box>
        <Text>FIXED-ANCHOR</Text>
      </Box>
    </Box>
  )
}

const fixedTerm = createTerm()
const fixedStdout = new FakeStdout(fixedTerm)
const fixedApp = await render(<FixedTransparentFixture short={false} />, {
  stdout: fixedStdout as unknown as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})
await waitFor(
  'fixed transparent absolute fixture mount',
  () => termText(fixedTerm).includes('FIXED-OVERLAY-LONG'),
)
const fixedInitialLength = fixedTerm.buffer.active.length
const fixedRawStart = fixedStdout.raw.length
fixedApp.rerender(<FixedTransparentFixture short />)
await waitFor(
  'fixed transparent absolute tail restoration frame',
  () => termText(fixedTerm).includes('SHORT-UNDERLAY-11-RESTORE-TAIL'),
)
const fixedText = termText(fixedTerm)
const fixedTransitionRaw = fixedStdout.raw.slice(fixedRawStart)
check(
  'fixed transparent absolute restores vacated underlay tail',
  fixedText.includes('SHORT-UNDERLAY-11-RESTORE-TAIL') &&
    !fixedText.includes('FIXED-OVERLAY-LONG'),
)
check(
  'fixed transparent transition does not grow terminal buffer',
  fixedTerm.buffer.active.length === fixedInitialLength,
  `${fixedInitialLength} -> ${fixedTerm.buffer.active.length}`,
)
check(
  'fixed transparent transition emits no CSI scroll-up',
  !/\x1b\[\d+S/.test(fixedTransitionRaw),
)
fixedApp.unmount()
process.exit(failures === 0 ? 0 : 1)

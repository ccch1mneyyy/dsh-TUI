/**
 * Streaming code-frame performance gate.
 *
 * Drives a REAL StreamingMarkdown through a ConcurrentRoot app for 100
 * frames: 40 arrival frames grow the transcript through 100 sealed
 * blocks (50 prose + 50 short fences) plus two 220-line code blocks,
 * then 60 frames append to one continuously growing unclosed fence.
 *
 * The whole fixture runs for BOTH code frame styles (settings
 * `dsh-tui.codeFrameStyle`): `light` (typed decoration, one ink-text
 * leaf per block) and `full` (the structural closed box - its per-block
 * Yoga node increment is part of the product, so its per-frame bounds
 * are stated separately instead of pretending it equals light).
 *
 * REQUIRED (structural) assertions, per style:
 *  - sealed DOM text nodes keep their identity across steady frames;
 *  - in the steady phase, no source contained in the sealed prefix is
 *    ever re-formatted (format/highlight attribution via render-stats);
 *  - per-frame counter deltas are bounded constants that do not grow
 *    with the settled transcript size;
 *  - closing the fence and appending prose reproduces the settled
 *    whole-document render exactly (no duplicate/missing rows);
 *  - a plain re-render never re-formats sealed content.
 *
 * OBSERVATIONAL: p50/p95/max frame wall-clock of the steady phase are
 * printed for the record - machine-dependent, never asserted here.
 *
 * Run: node --import tsx/esm scripts/verify-markdown-codebox-performance.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [
  assertModule,
  { PassThrough, Writable },
  React,
  { render, Box },
  { StreamingMarkdown },
  { Markdown },
  { renderToScreen, scanPositions },
  { default: instances },
  { settled },
  { renderWork, resetRenderWork, setTrackFormatSources, formatSourceCounts },
  { getCliHighlightPromise },
  { cellAtIndex },
  { default: stripAnsi },
  { TerminalSizeContext },
  { applyCodeFrameStyle },
] = await Promise.all([
  import('node:assert/strict'),
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/components/StreamingMarkdown.js'),
  import('../src/components/Markdown.js'),
  import('../src/ink/render-to-screen.js'),
  import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/render-stats.js'),
  import('../src/terminal-utils/cliHighlight.js'),
  import('../src/ink/screen.js'),
  import('strip-ansi'),
  import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/tuiDisplayPrefs.js'),
])
const assert = assertModule.default

// Production fidelity: the real highlighter participates in code formatting.
const highlight = await getCliHighlightPromise()
assert.ok(highlight, 'cli-highlight must load for the gate')

const NL = '\n'
const unit = (i: number): string =>
  i % 2 === 0
    ? 'Paragraph ' + i + ': prose with **bold** and `code` words plus enough ordinary text to cross the batch-sealing budget.' + NL + NL
    : '```js' + NL + 'const value' + i + ' = compute(' + i + ') // short fence ' + i + NL + '```' + NL + NL
const SHORT_UNITS = 100
const bigBlock = (n: number): string =>
  '```ts' + NL + Array.from({ length: 220 }, (_, k) => 'export const f' + n + '_' + k + ' = ' + k + ' * 3 + 1').join(NL) + NL + '```' + NL + NL
const UNITS = Array.from({ length: SHORT_UNITS }, (_, i) => unit(i)).concat([bigBlock(1), bigBlock(2)])
const SEALED = UNITS.join('')

// The growing fence: one unclosed block that keeps receiving tail lines.
const fenceChunk = (i: number) => '  \'frame chunk ' + i + '\',' + NL
const FENCE_HEAD = '```ts' + NL + 'const tail = [' + NL
const fenceAt = (frames: number) => FENCE_HEAD + Array.from({ length: frames }, (_, i) => fenceChunk(i)).join('')

const COLS = 80
const ROWS = 1600

class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  isTTY = true
  columns = COLS
  rows = ROWS
  _write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) { done() }
}

const tree = (source: string): React.ReactNode => (
  <Box flexDirection="column" width={COLS}>
    <StreamingMarkdown>{source}</StreamingMarkdown>
  </Box>
)

function findTextNode(node: unknown, needle: string): { nodeName?: string; nodeValue?: string; childNodes?: unknown[] } | undefined {
  if (!node || typeof node !== 'object') return undefined
  const n = node as { nodeName?: string; nodeValue?: string; childNodes?: unknown[] }
  // Highlighted bodies carry ANSI between words: match on the stripped text.
  if (n.nodeName === '#text' && typeof n.nodeValue === 'string' && stripAnsi(n.nodeValue).includes(needle)) {
    return n
  }
  for (const child of n.childNodes ?? []) {
    const found = findTextNode(child, needle)
    if (found) return found
  }
  return undefined
}

function screenRows(screen: Parameters<typeof scanPositions>[0], width: number): string[] {
  const rows: string[] = []
  for (let y = 0; y < screen.height; y++) {
    let line = ''
    for (let x = 0; x < width; x++) line += cellAtIndex(screen, y * width + x).char
    rows.push(line.trimEnd())
  }
  return rows
}

type Sample = { formatToken: number; codeHighlight: number; wrapCompute: number; measureCompute: number; ms: number }

// Per-frame counter bounds. light = the original gate's numbers. full
// renders the structural closed box (~7 Yoga nodes per block), so its
// per-frame measure work carries the extra node increment - the bound
// absorbs it instead of pretending the layouts are identical.
const BOUNDS = {
  light: { formatToken: 12, codeHighlight: 3, wrapCompute: 24, measureCompute: 48 },
  full: { formatToken: 12, codeHighlight: 3, wrapCompute: 24, measureCompute: 48 },
} as const

async function drive(style: 'light' | 'full'): Promise<Sample[]> {
  applyCodeFrameStyle(style)
  resetRenderWork()
  setTrackFormatSources(true)
  const stdout = new Output()
  const app = await render(tree(UNITS[0]!), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false, patchConsole: false,
  })
  const ink = instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as {
    rootNode: { childNodes: unknown[] } & object
    frontFrame: { screen: Parameters<typeof scanPositions>[0] }
  }
  assert.ok(ink, 'ink instance must register for the stdout')

  // ── Stage A: arrival (40 frames) ─────────────────────────────────────
  for (let frame = 1; frame <= 40; frame++) {
    const units = Math.ceil((UNITS.length * frame) / 41)
    const marker = 'ARRIVAL' + frame
    const source = UNITS.slice(0, units).join('') + marker
    app.rerender(tree(source))
    assert.ok(await settled(() => scanPositions(ink.frontFrame.screen, marker).length === 1),
      style + ' arrival frame ' + frame + ' must paint its marker')
  }

  // Sealed identities captured right after arrival.
  const sealedCodeNode = findTextNode(ink.rootNode, 'const value1 =')
  const sealedProseNode = findTextNode(ink.rootNode, 'Paragraph 0:')
  assert.ok(sealedCodeNode && sealedProseNode, style + ': sealed code and prose nodes must exist after arrival')
  const sealedCodeValue = sealedCodeNode!.nodeValue
  const sealedProseValue = sealedProseNode!.nodeValue

  // Snapshot of all sources formatted so far (the sealed world).
  const beforeSteady = new Map(formatSourceCounts)
  // ── Stage B: steady tail growth (60 frames) ──────────────────────────
  // Frame 1 absorbs the arrival-to-tail boundary transition (one-time
  // token work, accepted as boundary cost). Everything
  // after it is the steady phase the structural assertions target.
  const samples: Sample[] = []
  let afterTransition: Map<string, number> | undefined
  for (let frame = 1; frame <= 60; frame++) {
    const marker = 'TAILMARK' + frame
    const source = SEALED + fenceAt(frame) + '  \'growing ' + marker + '\',' + NL
    const before = { ...renderWork }
    const t0 = performance.now()
    app.rerender(tree(source))
    assert.ok(await settled(() => scanPositions(ink.frontFrame.screen, marker).length === 1),
      style + ' steady frame ' + frame + ' must paint its marker')
    const ms = performance.now() - t0
    samples.push({
      formatToken: renderWork.formatToken - before.formatToken,
      codeHighlight: renderWork.codeHighlight - before.codeHighlight,
      wrapCompute: renderWork.wrapCompute - before.wrapCompute,
      measureCompute: renderWork.measureCompute - before.measureCompute,
      ms,
    })
    if (frame === 1) afterTransition = new Map(formatSourceCounts)
  }

  // ── Required: no sealed source is ever re-formatted in the steady phase.
  // Whitespace-only raws (space tokens) recur as boundary glue by design;
  // substantive sealed content must never format again.
  let reFormatted = 0
  const reFormattedSources: string[] = []
  for (const [source, count] of formatSourceCounts) {
    const wasThere = afterTransition!.get(source)
    if (wasThere !== undefined && count > wasThere && source.trim() !== '') {
      reFormatted++
      reFormattedSources.push(JSON.stringify(source.slice(0, 60)) + ' x' + (count - wasThere))
    }
  }
  assert.equal(reFormatted, 0,
    style + ': no substantive source formatted before the steady phase may be re-formatted while only the tail grows (found ' +
      reFormatted + ': ' + reFormattedSources.join(' | ') + ')')
  void beforeSteady

  // ── Required: per-frame work is a bounded constant, not scaling with size.
  const steadySamples = samples.slice(1)
  const bounds = BOUNDS[style]
  const maxFormat = Math.max(...steadySamples.map(s => s.formatToken))
  const maxHighlight = Math.max(...steadySamples.map(s => s.codeHighlight))
  const maxWrap = Math.max(...steadySamples.map(s => s.wrapCompute))
  const maxMeasure = Math.max(...steadySamples.map(s => s.measureCompute))
  assert.ok(maxFormat <= bounds.formatToken, style + ': per-frame format calls stay tail-sized: ' + maxFormat)
  assert.ok(maxHighlight <= bounds.codeHighlight, style + ': per-frame highlight calls stay tail-sized: ' + maxHighlight)
  assert.ok(maxWrap <= bounds.wrapCompute, style + ': per-frame wrap computes stay tail-sized: ' + maxWrap)
  assert.ok(maxMeasure <= bounds.measureCompute, style + ': per-frame measures stay tail-sized: ' + maxMeasure)
  const early = samples.slice(0, 15)
  const late = samples.slice(-15)
  const avg = (xs: Sample[], k: keyof Sample) => xs.reduce((a, s) => a + s[k], 0) / xs.length
  for (const key of ['formatToken', 'wrapCompute', 'measureCompute'] as const) {
    assert.ok(avg(late, key) <= avg(early, key) + 2,
      style + ': steady ' + key + ' work must not grow with the settled size: early=' + avg(early, key) + ' late=' + avg(late, key))
  }

  // ── Required: sealed node identity survives the whole steady phase.
  const codeAfter = findTextNode(ink.rootNode, 'const value1 =')
  const proseAfter = findTextNode(ink.rootNode, 'Paragraph 0:')
  assert.equal(codeAfter, sealedCodeNode, style + ': the sealed code body node keeps its identity')
  assert.equal(proseAfter, sealedProseNode, style + ': the sealed prose node keeps its identity')
  assert.equal(codeAfter?.nodeValue, sealedCodeValue, style + ': the sealed code body is not rewritten')
  assert.equal(proseAfter?.nodeValue, sealedProseValue, style + ': the sealed prose is not rewritten')

  // ── Required: half-open fence closes cleanly into trailing prose.
  const finalSource = SEALED + fenceAt(60) + ']' + NL + '```' + NL + 'final prose after the fence' + NL
  app.rerender(tree(finalSource))
  assert.ok(await settled(() => scanPositions(ink.frontFrame.screen, 'final prose after the fence').length === 1),
    style + ': closing prose must paint')
  const streamedRows = screenRows(ink.frontFrame.screen, COLS)
  const settledRender = renderToScreen(
    <TerminalSizeContext.Provider value={{ columns: COLS, rows: ROWS }}>
      <Box flexDirection="column" width={COLS}><Markdown>{finalSource}</Markdown></Box>
    </TerminalSizeContext.Provider>,
    COLS,
  )
  const settledRows = screenRows(settledRender.screen, COLS)
  assert.deepEqual(streamedRows, settledRows,
    style + ': closed fence + trailing prose must equal the settled whole-document render')

  // ── Required: a re-render does not re-format sealed content.
  const countsBeforeRerender = new Map(formatSourceCounts)
  app.rerender(tree(finalSource))
  assert.ok(await settled(() => scanPositions(ink.frontFrame.screen, 'final prose after the fence').length === 1))
  let sealedReFormatted = 0
  for (const [source, count] of formatSourceCounts) {
    if ((countsBeforeRerender.get(source) ?? 0) !== count && SEALED.includes(source)) sealedReFormatted++
  }
  assert.equal(sealedReFormatted, 0, style + ': a plain re-render never re-formats sealed content')

  await app.unmount()
  return samples
}

const light = await drive('light')
const full = await drive('full')
setTrackFormatSources(false)
applyCodeFrameStyle('light')

// ── Observational: steady-phase frame wall clock (never asserted).
for (const [style, samples] of [['light', light], ['full', full]] as const) {
  const times = samples.map(s => s.ms).sort((a, b) => a - b)
  const pct = (p: number) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))]!.toFixed(2)
  const steady = samples.slice(1)
  console.log(style + ' steady frames: ' + times.length +
    ' | p50=' + pct(50) + 'ms p95=' + pct(95) + 'ms max=' + times[times.length - 1]!.toFixed(2) +
    'ms (wall clock includes settle polling; observational only)')
  console.log(style + ' per-frame maxima: formatToken=' + Math.max(...steady.map(s => s.formatToken)) +
    ' highlight=' + Math.max(...steady.map(s => s.codeHighlight)) +
    ' wrap=' + Math.max(...steady.map(s => s.wrapCompute)) +
    ' measure=' + Math.max(...steady.map(s => s.measureCompute)))
}
console.log('streaming code-frame performance gate passed for both styles (structural counters required; wall clock observational)')

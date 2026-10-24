/**
 * Plugin chart kit regression (docs/plugin-ui-kit-design.md §1–§2).
 *
 *  - geometry: allocateCells sums to the budget (0 for an all-zero total),
 *    zero/negative/NaN/Infinity inputs, the keepVisible floor and its
 *    drop-the-smallest rule, 1–3 cell budgets; resample/quantize/eighthsOf;
 *  - the footer context bar on the shared allocator: a seeded differential
 *    sweep against the frozen pre-migration split (identical except a used
 *    span of ≤ visible-segment cells, where the kit rule is asserted and the
 *    bar is shown to grow monotonically), edge cases, and token attribution;
 *  - ColumnChart: any numeric `selected` (−1 = none) reserves the marker row,
 *    so moving or clearing a selection never changes the chart height;
 *  - Meter paints cell-for-cell what ProgressBar paints (the jobs progress
 *    bar runs on Meter);
 *  - every primitive laid out at 20 and 40 cells with CJK/emoji labels: each
 *    row's display width is asserted, then the same element is rendered
 *    headlessly (renderToScreen) and must produce the same rows without
 *    wrapping (one-row primitives truncate in a narrower box); the split
 *    column cell and series fills are checked by style identity against a
 *    reference Text painted with the palette's raw colors;
 *  - palette: chart1…chart8 on every built-in (dark / light / ANSI ramps),
 *    rendered under ThemeProvider for dark/light/ANSI, seriesColor
 *    wrap-around, literal colors refused, hashSeries pinned;
 *  - `format` helpers (`format.tokens` = the footer context bar's readout
 *    string for the same count, `format.duration` = the host's
 *    `formatDuration`) and the kit objects (frozen, status view subset).
 *
 * Run: node --import tsx/esm scripts/verify-plugin-ui-kit.tsx [--samples]
 */
process.env.FORCE_COLOR = '3'

const [assertModule, React, { renderToScreen }, { cellAt }, geometry, chartColor, chartFormatModule, rowsModule, stacked, sparkline, column, heatmap, legend, table, kit, ui, themeModule, { stringWidth }, metrics, tokenFormat, progressBar] = await Promise.all([
  import('node:assert/strict'),
  import('react'),
  import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'),
  import('../src/components/design-system/chartGeometry.js'),
  import('../src/components/design-system/chartColor.js'),
  import('../src/components/design-system/chartFormat.js'),
  import('../src/components/design-system/chartRows.js'),
  import('../src/components/design-system/StackedBar.js'),
  import('../src/components/design-system/Sparkline.js'),
  import('../src/components/design-system/ColumnChart.js'),
  import('../src/components/design-system/Heatmap.js'),
  import('../src/components/design-system/Legend.js'),
  import('../src/components/design-system/Table.js'),
  import('../src/components/design-system/chartKit.js'),
  import('../src/ui.js'),
  import('../src/theme.js'),
  import('../src/ink/stringWidth.js'),
  import('../src/screens/StatusMetrics.js'),
  import('../src/terminal-utils/format.js'),
  import('../src/components/design-system/ProgressBar.js'),
])
const assert = assertModule.default
const { allocateCells, resample, quantize, eighthsOf, HORIZONTAL_EIGHTHS, VERTICAL_EIGHTHS, MAX_CHART_CELLS } = geometry
const { seriesColor, hashSeries, chartColorKey, CHART_SERIES_KEYS } = chartColor
const { chartFormat, fitCells, padCells, singleCell } = chartFormatModule
const { rowWidth } = rowsModule
const { getTheme, THEME_NAMES } = themeModule
type ChartRun = import('../src/components/design-system/chartRows.js').ChartRun

const SAMPLES = process.argv.includes('--samples')
let passed = 0
let failed = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)
const text = (row: readonly ChartRun[]): string => row.map(run => run.text).join('')

/** Rendered rows (spacer cells of wide glyphs dropped), trailing blanks trimmed. */
function screenRows(element: React.ReactElement, width: number): string[] {
  const { screen, height } = renderToScreen(element, width)
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => cellAt(screen, x, y)?.char ?? '').join('').trimEnd())
}

/** Style id of the cell at (x, y). Pools are shared across renderToScreen calls. */
function styleAt(element: React.ReactElement, width: number, x: number, y: number): number {
  const { screen } = renderToScreen(element, width)
  return cellAt(screen, x, y)!.styleId
}

/** Style id a reference Text with these raw colors paints. */
function referenceStyle(glyph: string, color: string | undefined, backgroundColor?: string): number {
  return styleAt(<ui.Text color={color as never} backgroundColor={backgroundColor as never}>{glyph}</ui.Text>, 4, 0, 0)
}

/**
 * Assert every laid-out row is exactly `width` cells and that rendering the
 * element headlessly (with room to spare) reproduces the rows, unwrapped.
 */
function assertRows(name: string, rows: readonly (readonly ChartRun[])[], element: React.ReactElement, width: number): void {
  rows.forEach((row, index) => {
    assert.equal(rowWidth(row), width, `${name}: row ${index} run widths`)
    assert.equal(stringWidth(text(row)), width, `${name}: row ${index} display width ("${text(row)}")`)
  })
  const rendered = screenRows(element, width + 8)
  assert.equal(rendered.length, rows.length, `${name}: rendered row count (no wrap)`)
  rendered.forEach((line, index) => {
    assert.ok(stringWidth(line) <= width, `${name}: rendered row ${index} fits (${stringWidth(line)} > ${width})`)
    assert.equal(line, text(rows[index]!).trimEnd(), `${name}: rendered row ${index} matches the layout`)
  })
}

const dark = getTheme('dark')
const CJK = '上下文压缩'
const EMOJI = '🧠思考'

console.log('geometry')

check('allocateCells sums to the budget for every budget 0…24', () => {
  const sets = [[1], [1, 1, 1], [5, 3, 2], [100, 1, 1], [0.2, 0.3, 0.5], [7, 0, 3, 0, 1], [1e9, 1, 1, 1]]
  for (const values of sets) {
    for (let cells = 0; cells <= 24; cells += 1) {
      for (const keepVisible of [false, true]) {
        const out = allocateCells(values, cells, { keepVisible })
        assert.equal(out.length, values.length)
        assert.equal(sum(out), cells, `${JSON.stringify(values)} → ${cells} (keepVisible=${keepVisible})`)
        assert.ok(out.every(value => Number.isInteger(value) && value >= 0))
      }
    }
  }
})

check('allocateCells: an all-zero total allocates nothing; bad numbers count as 0', () => {
  assert.deepEqual(allocateCells([0, 0, 0], 10), [0, 0, 0])
  assert.deepEqual(allocateCells([0, 0], 10, { keepVisible: true }), [0, 0])
  assert.deepEqual(allocateCells([], 5), [])
  assert.deepEqual(allocateCells([-5, Number.NaN, 4, Number.POSITIVE_INFINITY], 4), [0, 0, 4, 0])
  assert.deepEqual(allocateCells([3, 1], -2), [0, 0])
  assert.deepEqual(allocateCells([3, 1], Number.NaN), [0, 0])
  assert.equal(sum(allocateCells([1, 2], Number.POSITIVE_INFINITY)), MAX_CHART_CELLS, 'runaway budget is capped')
  assert.equal(sum(allocateCells([1, 2], 7.9)), 7, 'fractional budget floors')
})

check('allocateCells: largest remainder, ties to the earlier index', () => {
  assert.deepEqual(allocateCells([1, 1, 1], 2), [1, 1, 0])
  assert.deepEqual(allocateCells([5, 3, 2], 10), [5, 3, 2])
  assert.deepEqual(allocateCells([2, 1], 2), [1, 1])
  assert.deepEqual(allocateCells([100, 1, 1], 3), [3, 0, 0], 'without keepVisible small values vanish')
})

check('StackedBar occupancy and ColumnChart stacks survive a sum that overflows', () => {
  const big = Number.MAX_VALUE
  const occupancy = stacked.layoutStackedBar({ width: 10, capacity: 1e12, segments: [{ value: big, color: 0 }, { value: big, color: 1 }] })
  assert.equal(text(occupancy), '██████████', `an overflowing sum exceeds any finite capacity: ${text(occupancy)}`)
  const rows = column.layoutColumnChart({ height: 4, columns: [{ segments: [{ value: big, color: 0 }, { value: big, color: 1 }] }, { segments: [{ value: big, color: 0 }] }] })
  const plot = rows.slice(-4).map(text)
  assert.equal(plot.map(line => line[0]).join(''), '████', `the overflowing stack fills the plot: ${JSON.stringify(plot)}`)
  assert.equal(plot.map(line => line[1]).join(''), '  ██', `the half-height column keeps its ratio: ${JSON.stringify(plot)}`)
})

check('allocateCells: finite values whose sum overflows still fill the budget', () => {
  assert.deepEqual(allocateCells([Number.MAX_VALUE, Number.MAX_VALUE], 10), [5, 5])
  assert.deepEqual(allocateCells([Number.MAX_VALUE, Number.MAX_VALUE / 4], 10), [8, 2])
  assert.equal(sum(allocateCells([Number.MAX_VALUE, Number.MAX_VALUE, 1], 7, { keepVisible: true })), 7)
})

check('allocateCells keepVisible: ≥1 cell each while it fits, else the smallest are dropped', () => {
  assert.deepEqual(allocateCells([100, 1, 1], 3, { keepVisible: true }), [1, 1, 1])
  assert.deepEqual(allocateCells([100, 1, 1], 10, { keepVisible: true }), [8, 1, 1])
  assert.deepEqual(allocateCells([1, 100, 2], 2, { keepVisible: true }), [0, 1, 1], 'keeps the two largest')
  assert.deepEqual(allocateCells([1, 100, 1], 2, { keepVisible: true }), [1, 1, 0], 'ties keep the earlier index')
  assert.deepEqual(allocateCells([0, 5, 0, 1], 1, { keepVisible: true }), [0, 1, 0, 0])
  assert.deepEqual(allocateCells([0, 5, 0, 1], 2, { keepVisible: true }), [0, 1, 0, 1], 'zeros never get a cell')
})

check('allocateCells at 1–3 cells', () => {
  for (const cells of [1, 2, 3]) {
    assert.equal(sum(allocateCells([3, 2, 1, 1], cells)), cells)
    const kept = allocateCells([3, 2, 1, 1], cells, { keepVisible: true })
    assert.equal(sum(kept), cells)
    assert.ok(kept.every(value => value <= 1), 'keepVisible below the visible count gives one cell each')
  }
})

console.log('context bar on the shared allocator')

// The context bar's allocator before it moved onto `allocateCells`
// (StatusMetrics `allocateProportionally` + `allocateBarColumns`), frozen as
// the differential oracle: the migration must reproduce it everywhere except
// the one documented regime below.
function legacyProportional(values: readonly number[], columns: number): number[] {
  if (columns <= 0) return values.map(() => 0)
  const total = values.reduce((acc, value) => acc + value, 0)
  if (total <= 0) return values.map(() => 0)
  const raw = values.map(value => (value / total) * columns)
  const out = raw.map(Math.floor)
  let remaining = columns - out.reduce((acc, value) => acc + value, 0)
  const order = raw.map((value, index) => ({ index, remainder: value - Math.floor(value) })).sort((left, right) => right.remainder - left.remainder)
  for (const slot of order) {
    if (remaining <= 0) break
    out[slot.index] = out[slot.index]! + 1
    remaining -= 1
  }
  return out
}
function legacyBarColumns(values: readonly number[], width: number): number[] {
  const visible = values.flatMap((value, index) => (value > 0 ? [index] : []))
  if (visible.length === 0 || visible.length >= width) return legacyProportional(values, width)
  const rest = legacyProportional(values, width - visible.length)
  return values.map((_, index) => (visible.includes(index) ? 1 : 0) + rest[index]!)
}
const SEGMENT_KEYS = ['system', 'prompt', 'assistant', 'thinking', 'tools'] as const
const asSegments = (values: readonly number[]) =>
  Object.fromEntries(SEGMENT_KEYS.map((key, index) => [key, values[index]!])) as Record<(typeof SEGMENT_KEYS)[number], number>
/** The bar's used span — unchanged by the migration, mirrored here. */
const usedSpan = (used: number, window: number, width: number): number =>
  Math.round(Math.max(0, Math.floor(width)) * (window > 0 ? Math.min(1, Math.max(0, used / window)) : 0))
/** Seeded LCG: the sweep is the same on every run. */
function lcg(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}
function randomSegments(next: () => number): number[] {
  const out: number[] = []
  for (let index = 0; index < 5; index += 1) {
    const pick = next()
    out.push(
      pick < 0.25 ? 0
        : pick < 0.4 ? next() // tiny
        : pick < 0.8 ? Math.round(next() * 100_000)
        : pick < 0.9 ? 10 ** (9 + next() * 6) // huge
        : out.length > 0 ? out[Math.floor(next() * out.length)]! : 7, // a tie
    )
  }
  return out
}
const topByValue = (values: readonly number[], count: number): number[] =>
  values.flatMap((value, index) => (value > 0 ? [index] : [])).sort((left, right) => values[right]! - values[left]!).slice(0, count)

check('contextBarColumns = allocateCells; byte-identical to the legacy split in both regimes', () => {
  const next = lcg(20261022)
  let identical = 0
  let smallSpan = 0
  for (let sample = 0; sample < 40_000; sample += 1) {
    const values = randomSegments(next)
    const widthPick = next()
    const width = widthPick < 0.05 ? 0 : widthPick < 0.35 ? 1 + Math.floor(next() * 3) : widthPick < 0.7 ? 4 + Math.floor(next() * 17) : 21 + Math.floor(next() * 220)
    const window = next() < 0.1 ? 0 : 1000 + Math.floor(next() * 2_000_000)
    const ratioPick = next()
    const used = ratioPick < 0.1 ? 0 : ratioPick < 0.2 ? window : ratioPick < 0.4 ? window * next() * 0.06 : ratioPick < 0.5 ? window * (1 + next()) : window * next()
    const got = metrics.contextBarColumns(asSegments(values), used, window, width)
    const span = usedSpan(used, window, width)
    const label = `${JSON.stringify(values)} used=${used} window=${window} width=${width}`
    assert.equal(sum(got.used) + got.unclassified + got.free, width, `${label}: the three parts fill the bar`)
    assert.equal(got.free, width - span, `${label}: occupancy alone fixes the free span`)
    const visible = values.filter(value => value > 0).length
    assert.deepEqual(got.used, allocateCells(values, span, { keepVisible: visible < span }), `${label}: the used split is the kit allocator`)
    assert.deepEqual(got.used, legacyBarColumns(values, span), `${label}: identical to the legacy split`)
    identical += 1
    if (span > 0 && visible >= span) smallSpan += 1
  }
  console.log(`       ${identical} identical, ${smallSpan} of them in the no-room-for-every-segment regime`)
  assert.ok(smallSpan > 1000, 'the sweep covers the small-span regime')
})

// The kit's keepVisible split is monotone as the span grows; the footer bar
// keeps its legacy proportional split below the visible count (above), so
// this property is the kit's own, measured against that split for contrast.
check('allocateCells keepVisible grows a cell at a time through the small-span regime', () => {
  const next = lcg(7)
  let legacyJumps = 0
  for (let sample = 0; sample < 5000; sample += 1) {
    const values = randomSegments(next)
    const visible = values.filter(value => value > 0).length
    for (let span = 1; span <= visible + 1; span += 1) {
      const before = allocateCells(values, span - 1, { keepVisible: true })
      const after = allocateCells(values, span, { keepVisible: true })
      assert.ok(after.every((cells, index) => cells >= before[index]!), `${JSON.stringify(values)} @${span}: no segment loses a cell`)
      const legacyBefore = legacyBarColumns(values, span - 1)
      if (legacyBarColumns(values, span).some((cells, index) => cells < legacyBefore[index]!)) legacyJumps += 1
    }
  }
  console.log(`       legacy split shrank a segment on ${legacyJumps} one-cell growth steps; the kit split on none`)
  if (SAMPLES) {
    const values = [12_000, 300, 2_500, 1_800, 9_000]
    console.log(`       growth of ${JSON.stringify(values)} (system,prompt,assistant,thinking,tools):`)
    for (let span = 1; span <= 7; span += 1) {
      console.log(`         span ${span}: legacy ${JSON.stringify(legacyBarColumns(values, span))}  kit ${JSON.stringify(allocateCells(values, span, { keepVisible: true }))}`)
    }
  }
})

check('context bar edge cases: zeros, tiny segments, 1–3 cells, huge and non-finite numbers', () => {
  const zero = metrics.contextBarColumns(asSegments([0, 0, 0, 0, 0]), 500, 1000, 10)
  assert.deepEqual(zero, { used: [0, 0, 0, 0, 0], unclassified: 5, free: 5 }, 'no composition: the span is one unclassified block')
  for (const width of [1, 2, 3]) {
    const full = metrics.contextBarColumns(asSegments([5, 4, 3, 2, 1]), 1000, 1000, width)
    assert.equal(sum(full.used), width, `@${width}: a full bar is all used`)
    assert.deepEqual(full.used, allocateCells([5, 4, 3, 2, 1], width, { keepVisible: true }))
  }
  const tiny = metrics.contextBarColumns(asSegments([0.001, 90_000, 0.002, 0, 0]), 50_000, 100_000, 40)
  assert.deepEqual(tiny.used, [1, 18, 1, 0, 0], 'tiny segments keep a cell')
  const huge = metrics.contextBarColumns(asSegments([1e15, 1e15, 1, 1, 1]), 1, 1, 60)
  assert.deepEqual(huge.used, legacyBarColumns([1e15, 1e15, 1, 1, 1], 60), 'huge values: same split as before')
  const bad = metrics.contextBarColumns(asSegments([Number.NaN, Number.POSITIVE_INFINITY, -5, 3, 1]), 10, 20, 10)
  assert.ok(bad.used.every(cells => Number.isInteger(cells) && cells >= 0) && sum(bad.used) + bad.unclassified + bad.free === 10, `non-finite weights count as 0 (${JSON.stringify(bad)})`)
  assert.deepEqual(metrics.contextBarColumns(asSegments([1, 1, 1, 1, 1]), 10, 0, 10), { used: [0, 0, 0, 0, 0], unclassified: 0, free: 10 }, 'no window: all free')
})

check('attributeBarTokens: the kit largest remainder, uncapped, identical to the legacy split', () => {
  const next = lcg(424242)
  for (let sample = 0; sample < 20_000; sample += 1) {
    const values = randomSegments(next)
    const total = next() < 0.1 ? 0 : Math.round(next() * 2_000_000)
    const got = metrics.attributeBarTokens(asSegments(values), total)
    const legacy = values.reduce((acc, value) => acc + value, 0) <= 0 ? values.map(() => 0) : legacyProportional(values, total)
    assert.deepEqual(SEGMENT_KEYS.map(key => got[key]), legacy, `${JSON.stringify(values)} → ${total}`)
    assert.equal(sum(SEGMENT_KEYS.map(key => got[key])), values.some(value => value > 0) ? total : 0)
  }
  assert.equal(sum(Object.values(metrics.attributeBarTokens(asSegments([1, 2, 3, 0, 0]), 5_000_000))), 5_000_000, 'no cell cap on a token total')
})

check('resample: bucket keeps peaks, tail keeps the newest, short input passes through', () => {
  assert.deepEqual(resample([0, 0, 9, 0, 0, 0], 3, 'bucket'), [0, 9, 0])
  assert.deepEqual(resample([1, 2, 3, 4, 5], 2, 'tail'), [4, 5])
  assert.deepEqual(resample([1, -2, Number.NaN], 5), [1, 0, 0])
  assert.deepEqual(resample([1, 2], 0), [])
  assert.equal(resample(Array.from({ length: 1000 }, (_, i) => i), 7).length, 7)
  assert.equal(Math.max(...resample(Array.from({ length: 999 }, (_, i) => (i === 500 ? 99 : 1)), 10)), 99, 'a single spike survives')
})

check('quantize / eighthsOf', () => {
  assert.equal(quantize(0, 10, 4), 0)
  assert.equal(quantize(0.001, 10, 4), 1, 'any positive value is at least level 1')
  assert.equal(quantize(10, 10, 4), 4)
  assert.equal(quantize(50, 10, 4), 4, 'above max clamps')
  assert.equal(quantize(5, 10, 4), 2)
  assert.equal(quantize(5, 0, 4), 0, 'zero scale')
  assert.equal(quantize(Number.NaN, 10, 4), 0)
  assert.equal(eighthsOf(5, 10, 2), 8)
  assert.equal(eighthsOf(50, 10, 2), 16)
  assert.equal(eighthsOf(1, 0, 2), 0)
  assert.equal(HORIZONTAL_EIGHTHS.join(''), ' ▏▎▍▌▋▊▉█')
  assert.equal(VERTICAL_EIGHTHS.join(''), ' ▁▂▃▄▅▆▇█')
})

console.log('text fitting')

check('fitCells/padCells: CJK and emoji never straddle the edge', () => {
  assert.equal(fitCells('abcdef', 4), 'abc…')
  assert.equal(fitCells(CJK, 5), '上下…')
  assert.equal(stringWidth(fitCells(CJK, 4)), 3, 'a wide glyph that would straddle is dropped whole')
  assert.equal(stringWidth(padCells(CJK, 4)), 4)
  assert.equal(padCells('7', 3, 'right'), '  7')
  assert.equal(fitCells('x', 0), '')
  assert.equal(fitCells('xy', 1), '…')
  assert.equal(fitCells('✂️ab', 2), '…', 'an emoji-presentation sequence is one 2-cell grapheme')
  assert.equal(singleCell('✂'), '✂')
  assert.equal(singleCell('✂️'), '', 'two-cell markers are dropped')
  assert.equal(singleCell('\u001B[31mX'), 'X', 'escape sequences are stripped')
  assert.equal(singleCell(42), '4')
  assert.equal(singleCell(undefined), '')
})

console.log('primitives')

for (const width of [20, 40]) {
  check(`StackedBar composition @${width}`, () => {
    const props = {
      width,
      segments: [
        { value: 120, color: 0 },
        { value: 30, color: 1 },
        { value: 1, color: 2 },
        { value: 50, color: 'success' as const, hatch: true },
      ],
      keepVisible: true,
    }
    const row = stacked.layoutStackedBar(props)
    assertRows('stacked', [row], <stacked.StackedBar {...props} />, width)
    assert.ok(text(row).includes('╱'), 'hatch glyph drawn')
    assert.ok(row.some(run => run.color === 'chart3'), 'keepVisible keeps the 1-token segment')
    assert.ok(!text(row).includes('─'), 'composition mode has no empty track')
  })

  check(`StackedBar occupancy @${width}`, () => {
    const props = { width, capacity: 1000, segments: [{ value: 200, color: 0 }, { value: 133, color: 1 }] }
    const row = stacked.layoutStackedBar(props)
    assertRows('occupancy', [row], <stacked.StackedBar {...props} />, width)
    const filled = text(row).replace(/─+$/, '')
    // 333/1000 of the width, to the nearest eighth.
    const eighths = Math.round(0.333 * width * 8)
    assert.equal(stringWidth(filled), Math.ceil(eighths / 8))
    assert.equal(row[row.length - 1]!.color, 'subtle', 'default track color')
    const custom = stacked.layoutStackedBar({ ...props, emptyColor: 'inactive' })
    assert.equal(custom[custom.length - 1]!.color, 'inactive')
  })
}

check('StackedBar edge cases: zero, bad numbers, 1–3 cells, over capacity', () => {
  for (const width of [1, 2, 3]) {
    for (const capacity of [undefined, 10]) {
      const row = stacked.layoutStackedBar({ width, capacity, segments: [{ value: 3, color: 0 }, { value: 1, color: 1 }, { value: 1, color: 2 }], keepVisible: true })
      assert.equal(rowWidth(row), width)
    }
  }
  assert.equal(text(stacked.layoutStackedBar({ width: 5, segments: [] })), '─────', 'empty composition is pure track')
  assert.equal(text(stacked.layoutStackedBar({ width: 5, segments: [{ value: Number.NaN, color: 0 }, { value: -4, color: 1 }] })), '─────')
  assert.equal(text(stacked.layoutStackedBar({ width: 4, capacity: 10, segments: [{ value: 99, color: 0 }] })), '████', 'over capacity clamps full')
  assert.equal(text(stacked.layoutStackedBar({ width: 4, capacity: 1e9, segments: [{ value: 1, color: 0 }] })), '▏───', 'tiny occupancy stays visible')
  assert.equal(text(stacked.layoutStackedBar({ width: 4, capacity: 0, segments: [{ value: 1, color: 0 }] })), '████')
  assert.deepEqual(stacked.layoutStackedBar({ width: 0, segments: [{ value: 1, color: 0 }] }), [])
  const literal = stacked.layoutStackedBar({ width: 4, segments: [{ value: 1, color: '#ff0000' as never }, { value: 1, color: 'rgb(1,2,3)' as never }] })
  assert.deepEqual(literal.map(run => run.color), ['chart1', 'chart2'], 'literal colors fall back to the series slot')
})

check('one-row primitives truncate instead of wrapping in a narrower container', () => {
  const narrow = (child: React.ReactElement): string[] => screenRows(<ui.Box width={10}>{child}</ui.Box>, 30)
  for (const rows of [
    narrow(<ui.StackedBar width={20} segments={[{ value: 1, color: 0 }, { value: 1, color: 1 }]} />),
    narrow(<ui.Sparkline width={20} values={[1, 2, 3, 4, 5, 6, 7, 8]} />),
    narrow(<ui.Meter width={20} ratio={0.5} emptyColor="inactive" />),
  ]) {
    assert.equal(rows.length, 1, `stays one row (${JSON.stringify(rows)})`)
    assert.ok(stringWidth(rows[0]!) <= 10)
  }
})

check('StackedBar renders palette colors (style identity)', () => {
  const element = <stacked.StackedBar width={6} segments={[{ value: 1, color: 0 }, { value: 1, color: 'warning' }]} />
  assert.equal(styleAt(element, 8, 0, 0), referenceStyle('█', dark.chart1))
  assert.equal(styleAt(element, 8, 5, 0), referenceStyle('█', dark.warning))
})

for (const width of [20, 40]) {
  check(`Sparkline @${width}`, () => {
    const few = { width, values: [0, 1, 2, 3, 5, 8] }
    const fewRow = sparkline.layoutSparkline(few)
    assertRows('sparkline few', [fewRow], <sparkline.Sparkline {...few} />, width)
    assert.ok(text(fewRow).startsWith(' '.repeat(width - 6)), 'left-padded')
    assert.ok(text(fewRow).endsWith('█'), 'the max reaches the top glyph')
    assert.equal(fewRow.find(run => run.text.includes('▁'))?.color, 'subtle', 'zero is the subtle baseline')
    const many = { width, values: Array.from({ length: 500 }, (_, i) => (i === 250 ? 100 : i % 7)), color: 3, max: 100 }
    const manyRow = sparkline.layoutSparkline(many)
    assertRows('sparkline bucket', [manyRow], <sparkline.Sparkline {...many} />, width)
    assert.ok(text(manyRow).includes('█'), 'bucket fit keeps the spike')
    assert.ok(manyRow.some(run => run.color === 'chart4'))
    const tail = { ...many, fit: 'tail' as const }
    assertRows('sparkline tail', [sparkline.layoutSparkline(tail)], <sparkline.Sparkline {...tail} />, width)
    assert.ok(!text(sparkline.layoutSparkline(tail)).includes('█'), 'tail fit drops the old spike (same max)')
  })
}

check('Sparkline scaling and degenerate input', () => {
  assert.equal(text(sparkline.layoutSparkline({ width: 3, values: [5, 5, 5] })), '███', 'flat positive series sits at the top')
  assert.equal(text(sparkline.layoutSparkline({ width: 3, values: [0, 0] })), ' ▁▁')
  assert.equal(text(sparkline.layoutSparkline({ width: 2, values: [10, 20], min: 10, max: 20 })), '▁█')
  assert.equal(text(sparkline.layoutSparkline({ width: 2, values: [Number.NaN, -3] })), '▁▁')
  assert.equal(rowWidth(sparkline.layoutSparkline({ width: 1, values: [1, 2, 3] })), 1)
})

check('Meter wraps ProgressBar with sanitized input', () => {
  for (const width of [20, 40]) {
    const rendered = screenRows(<ui.Meter ratio={0.42} width={width} fillColor={0} emptyColor="inactive" />, width + 8)
    assert.equal(rendered.length, 1)
    assert.ok(stringWidth(rendered[0]!) <= width)
    assert.equal(rendered[0]!.replace(/ +$/, '').length > 0, true)
  }
  assert.equal(screenRows(<ui.Meter ratio={Number.NaN} width={-3} />, 10).length, 0, 'zero width renders nothing')
  assert.equal(screenRows(<ui.Meter ratio={7} width={4} />, 10)[0], '████', 'ratio clamps to 1')
  assert.equal(styleAt(<ui.Meter ratio={1} width={2} fillColor={1} />, 4, 0, 0), referenceStyle('█', dark.chart2))
})

check('Meter paints exactly what ProgressBar paints for in-range input (JobProgress runs on Meter)', () => {
  const cells = (element: React.ReactElement, width: number): string => {
    const { screen, height } = renderToScreen(element, width)
    return Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => `${cellAt(screen, x, y)?.char ?? ''}:${cellAt(screen, x, y)?.styleId ?? ''}`).join('|')).join('\n')
  }
  for (const width of [5, 12]) {
    for (let step = 0; step <= 40; step += 1) {
      const ratio = step / 40
      assert.equal(
        cells(<ui.Meter ratio={ratio} width={width} fillColor="accent" emptyColor="inactive" />, width + 4),
        cells(<progressBar.ProgressBar ratio={ratio} width={width} fillColor="accent" emptyColor="inactive" />, width + 4),
        `ratio ${ratio} @${width}`,
      )
    }
  }
})

for (const width of [20, 40]) {
  check(`ColumnChart @${width}`, () => {
    const count = width / 2
    const columns = Array.from({ length: count }, (_, i) => ({
      segments: [{ value: (i % 5) + 1, color: 0 }, { value: (i * 3) % 7, color: 1 }, { value: i % 2, color: 'warning' as const }],
      ...(i === 3 ? { marker: '✂', markerColor: 'warning' as const } : {}),
      ...(i === 5 ? { marker: '🧠' } : {}),
    }))
    const props = { columns, height: 5, gap: 1, selected: 2 }
    const rows = column.layoutColumnChart(props)
    const chartWidth = count * 1 + (count - 1) * 1
    assertRows('columns', rows, <column.ColumnChart {...props} />, chartWidth)
    assert.equal(rows.length, 6, 'marker row on top of 5 plot rows')
    assert.equal(text(rows[0]!)[6], '✂', 'marker sits above its column')
    assert.equal(text(rows[0]!)[4], '▾', 'pointer above the selected column')
    assert.equal(text(rows[0]!)[10], ' ', 'a two-cell marker is dropped')
    const wide = { columns, height: 3, columnWidth: 2, gap: 0 }
    const wideRows = column.layoutColumnChart(wide)
    assertRows('columns wide', wideRows, <column.ColumnChart {...wide} />, count * 2)
  })
}

check('ColumnChart splits a cell exactly at a segment boundary (fg lower / bg upper)', () => {
  const props = { columns: [{ segments: [{ value: 3, color: 0 }, { value: 5, color: 1 }] }], height: 1, max: 8 }
  const rows = column.layoutColumnChart(props)
  assert.deepEqual(rows.map(text), ['▃'])
  assert.equal(rows[0]![0]!.color, 'chart1')
  assert.equal(rows[0]![0]!.backgroundColor, 'chart2')
  assert.equal(styleAt(<column.ColumnChart {...props} />, 4, 0, 0), referenceStyle('▃', dark.chart1, dark.chart2), 'rendered with both palette colors')
})

check('ColumnChart scaling, eighths, empty and selected bands', () => {
  const rows = column.layoutColumnChart({ columns: [{ segments: [{ value: 10, color: 0 }] }, { segments: [{ value: 5, color: 0 }] }, { segments: [] }], height: 2 })
  assert.deepEqual(rows.map(text), ['█  ', '██ '])
  const tiny = column.layoutColumnChart({ columns: [{ segments: [{ value: 1, color: 0 }] }, { segments: [{ value: 1000, color: 0 }] }], height: 2 })
  assert.deepEqual(tiny.map(text), [' █', '▁█'], 'a non-zero column shows at least one eighth')
  const partial = column.layoutColumnChart({ columns: [{ segments: [{ value: 13, color: 0 }] }], height: 2, max: 16 })
  assert.deepEqual(partial.map(text), ['▅', '█'], 'eighth precision on the top cell')
  const selected = column.layoutColumnChart({ columns: [{ segments: [{ value: 1, color: 0 }] }, { segments: [{ value: 4, color: 0 }] }], height: 2, selected: 0 })
  assert.equal(selected.length, 3, 'selection reserves the marker row')
  assert.equal(selected[1]![0]!.backgroundColor, 'selectionBg', 'band behind the empty cell')
  assert.equal(selected[0]![0]!.backgroundColor, 'selectionBg', 'band on the marker row')
  const outOfRange = column.layoutColumnChart({ columns: [{ segments: [{ value: 1, color: 0 }] }], height: 2, selected: 7 })
  assert.equal(outOfRange.length, 3, 'an out-of-range selection keeps the marker row')
  assert.ok(outOfRange.every(row => row.every(run => run.backgroundColor === undefined)), 'an out-of-range selection highlights nothing')
  assert.deepEqual(column.layoutColumnChart({ columns: [], height: 3 }), [])
  assert.deepEqual(column.layoutColumnChart({ columns: [{ segments: [{ value: Number.NaN, color: 0 }] }], height: 1 }).map(text), [' '])
  assert.equal(column.layoutColumnChart({ columns: Array.from({ length: 5000 }, () => ({ segments: [{ value: 1, color: 0 }] })), height: 1 })[0]!.length > 0, true)
  assert.ok(rowWidth(column.layoutColumnChart({ columns: Array.from({ length: 5000 }, () => ({ segments: [{ value: 1, color: 0 }] })), height: 1 })[0]!) <= MAX_CHART_CELLS, 'runaway column count is capped')
})

check('ColumnChart: moving or clearing the selection never changes the chart height', () => {
  const columns = Array.from({ length: 6 }, (_, i) => ({ segments: [{ value: i + 1, color: 0 }] }))
  const layout = (selected: number | undefined) => column.layoutColumnChart({ columns, height: 4, gap: 1, selected })
  // A selectable chart passes -1 for "none": the marker row is already there.
  const heights = [-1, 0, 3, 5, 6, 99, -7, Number.NaN].map(selected => layout(selected).length)
  assert.deepEqual(heights, heights.map(() => 5), `every numeric selection reserves the row (${heights.join(',')})`)
  const none = layout(-1)
  assert.equal(text(none[0]!).trim(), '', '-1 draws no pointer')
  assert.ok(none.every(row => row.every(run => run.backgroundColor === undefined)), '-1 draws no band')
  assert.deepEqual(none.slice(1).map(text), layout(2).slice(1).map(text), 'the plot rows sit at the same height with and without a selection')
  assert.equal(text(layout(2)[0]!)[4], '▾', 'a real selection still points at its column')
  assert.equal(layout(undefined).length, 4, 'a chart that never selects (undefined, no markers) has no marker row')
})

for (const width of [20, 40]) {
  check(`Heatmap @${width}`, () => {
    const cols = width / 2
    const grid = Array.from({ length: 7 }, (_, y) => Array.from({ length: cols }, (_, x) => ((x + y) % 6 === 0 ? null : (x * y) % 9)))
    const props = { rows: grid, color: 4, selected: { row: 2, col: 3 } }
    const rows = heatmap.layoutHeatmap(props)
    assertRows('heatmap', rows, <heatmap.Heatmap {...props} />, width)
    const narrow = { rows: grid, cell: 1 as const }
    assertRows('heatmap cell=1', heatmap.layoutHeatmap(narrow), <heatmap.Heatmap {...narrow} />, cols)
  })
}

check('Heatmap ladder: null blank, zero dot, levels, selected cell', () => {
  const rows = heatmap.layoutHeatmap({ rows: [[null, 0, 1, 2, 3, 4], [5]], cell: 1, max: 4 })
  assert.deepEqual(rows.map(text), [' ·░▒▓█', '█     '], 'ragged rows pad to the widest')
  assert.equal(rows[0]!.find(run => run.text === '·')?.color, 'subtle')
  assert.equal(rows[0]!.find(run => run.text.includes('░'))?.color, 'chart1')
  const two = heatmap.layoutHeatmap({ rows: [[1, 2]], levels: 2, cell: 2 })
  assert.equal(text(two[0]!), '▒▒██', 'two levels use the half and full steps')
  const selected = heatmap.layoutHeatmap({ rows: [[4, 4]], cell: 1, selected: { row: 0, col: 1 } })
  assert.deepEqual(selected[0]!.map(run => [run.text, run.color, run.backgroundColor]), [['█', 'chart1', undefined], ['█', 'text', 'selectionBg']])
  assert.deepEqual(heatmap.layoutHeatmap({ rows: [] }), [])
  assert.equal(text(heatmap.layoutHeatmap({ rows: [[Number.NaN, -1]], cell: 1 })[0]!), '··', 'bad numbers are zero, not no-data')
})

for (const width of [20, 40]) {
  check(`Legend @${width}`, () => {
    const items = [
      { color: 0, label: '系统提示', value: '12.3k' },
      { color: 1, label: 'tools', value: '4.1k' },
      { color: 2, label: EMOJI, value: '980' },
      { color: 3, label: CJK.repeat(6), value: '1.2M' },
      { color: 'warning' as const, label: 'other' },
    ]
    const props = { items, width }
    const rows = legend.layoutLegend(props)
    assertRows('legend', rows, <legend.Legend {...props} />, width)
    assert.ok(rows.length >= 2, 'wraps')
    assert.ok(rows.some(row => text(row).includes('…')), 'an over-long label is truncated with an ellipsis')
    assert.equal(rows[0]![0]!.text, '■')
    assert.equal(rows[0]![0]!.color, 'chart1')
    const capped = { items, width, maxRows: 1 }
    const cappedRows = legend.layoutLegend(capped)
    assertRows('legend capped', cappedRows, <legend.Legend {...capped} />, width)
    assert.equal(cappedRows.length, 1)
    assert.match(text(cappedRows[0]!), /\+\d+\s*$/, 'overflow collapses into +N')
    const shown = (text(cappedRows[0]!).match(/■/g) ?? []).length
    const hidden = Number(/\+(\d+)/.exec(text(cappedRows[0]!))![1])
    assert.equal(shown + hidden, items.length, '+N counts exactly the hidden chips')
  })
}

check('Legend narrow widths and text tokens', () => {
  for (const width of [1, 2, 3, 5]) {
    for (const row of legend.layoutLegend({ items: [{ color: 0, label: CJK, value: '99' }], width })) assert.equal(rowWidth(row), width)
  }
  const chip = legend.layoutLegend({ items: [{ color: 0, label: 'a', value: '1' }], width: 10 })[0]!
  assert.deepEqual(chip.map(run => run.color).slice(0, 3), ['chart1', 'text', 'inactive'], 'only the swatch wears the series color')
  assert.deepEqual(legend.layoutLegend({ items: [], width: 10 }), [])
})

for (const width of [20, 40]) {
  check(`Table @${width}`, () => {
    const columns = [
      { key: 'name', title: '名称', minWidth: 4 },
      { key: 'tokens', title: 'tokens', width: 6, align: 'right' as const },
      { key: 'note', title: 'note', grow: 2 },
    ]
    const rowsIn = [
      { name: '系统提示词', tokens: 12345, note: { text: EMOJI + ' cached', color: 2, bold: true } },
      { name: 'read_file', tokens: '980', note: 'a/very/long/path/that/never/fits/anywhere.ts' },
      { name: '\u001B[31mred\u001B[0m\nline', tokens: Number.NaN },
    ]
    const props = { columns, rows: rowsIn, width, selected: 1 }
    const rows = table.layoutTable(props)
    assertRows('table', rows, <table.Table {...props} />, width)
    assert.equal(rows.length, 4, 'header + 3 rows')
    assert.ok(rows[0]!.every(run => run.bold === true || run.text.trim() === ''), 'header is bold')
    assert.ok(rows[2]!.every(run => run.backgroundColor === 'selectionBg'), 'the selected row is banded edge to edge')
    assert.ok(text(rows[3]!).startsWith(width >= 40 ? 'red line' : 'red'), 'escape sequences stripped, newline folded')
    assert.ok(!text(rows[3]!).includes('[31m'), 'no escape residue')
    assert.ok(/ 980 /.test(text(rows[2]!)) || text(rows[2]!).includes('   980'), 'right-aligned number column')
  })
}

check('Table widths: fixed first, grow split, minWidth floor, clip at the edge', () => {
  const cols = [{ key: 'a', width: 4 }, { key: 'b' }, { key: 'c', grow: 3 }]
  assert.deepEqual(table.tableColumnWidths(cols, 20), [4, 4, 10])
  assert.deepEqual(table.tableColumnWidths([{ key: 'a', minWidth: 8 }, { key: 'b', grow: 3 }], 13), [8, 4])
  assert.deepEqual(table.tableColumnWidths([{ key: 'a', width: 10 }, { key: 'b', minWidth: 6 }], 12), [10, 6], 'overflow allowed, clipped later')
  const clipped = table.layoutTable({ columns: [{ key: 'a', width: 10 }, { key: 'b', minWidth: 6 }], rows: [{ a: CJK + CJK, b: 'xyz' }], width: 12 })
  assert.equal(rowWidth(clipped[0]!), 12)
  for (const width of [1, 2, 3]) {
    for (const row of table.layoutTable({ columns: [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }], rows: [{ a: CJK, b: 1 }], width })) assert.equal(rowWidth(row), width)
  }
  assert.equal(table.layoutTable({ columns: [{ key: 'a' }], rows: [{ a: 'x' }], width: 5 }).length, 1, 'no titles, no header')
  assert.deepEqual(table.layoutTable({ columns: [], rows: [{ a: 1 }], width: 5 }), [])
})

check('Table: a huge generated column list only lays out the columns that can show', () => {
  // Every column past width/gap starts beyond the right edge: the layout must
  // be the one of the columns that fit, and must never read the rest.
  const many: { key: string; title?: string; minWidth?: number }[] = Array.from({ length: 100_000 }, (_, index) => ({ key: 'k' + index, title: 'T' + index, minWidth: index % 3 }))
  let touched = false
  Object.defineProperty(many, 50_000, { get() { touched = true; return { key: 'far' } } })
  const rows = Array.from({ length: 50 }, (_, at) => Object.fromEntries(Array.from({ length: 30 }, (_, index) => ['k' + index, at * 100 + index])))
  const width = 20
  const bounded = table.layoutTable({ columns: many, rows, width })
  assert.equal(touched, false, 'columns that start past the edge are never read')
  assert.deepEqual(bounded, table.layoutTable({ columns: many.slice(0, width + 1), rows, width }), 'the same rows as the columns that fit')
  for (const row of bounded) assert.equal(rowWidth(row), width)
  // Dropping the clipped columns changes no width of the ones that show (the
  // gaps of the full list already left no flexible room).
  const plain = Array.from({ length: 2_000 }, (_, index) => ({ key: 'k' + index, minWidth: index % 3, ...(index % 7 === 0 ? { width: 2 } : {}) }))
  for (const at of [5, 20, 64]) {
    assert.deepEqual(table.tableColumnWidths(plain.slice(0, at + 1), at), table.tableColumnWidths(plain, at).slice(0, at + 1), `widths at ${at} cells`)
  }
})

console.log('palette')

check('every built-in carries eight distinct chart colors from its ramp', () => {
  for (const name of THEME_NAMES) {
    const palette = getTheme(name)
    const values = CHART_SERIES_KEYS.map(key => palette[key])
    assert.ok(values.every(value => typeof value === 'string' && value !== ''), `${name}: chart keys filled`)
    assert.equal(new Set(values).size, 8, `${name}: eight distinct series colors`)
    const ansi = name.endsWith('-ansi')
    assert.ok(values.every(value => value.startsWith('ansi:') === ansi), `${name}: ${ansi ? 'ANSI' : 'truecolor'} ramp`)
  }
  const light = ['light', 'pink-day', 'claude-paper', 'codex-paper'].map(name => getTheme(name).chart3)
  assert.equal(new Set(light).size, 1, 'light palettes share the light ramp')
  const darkRamp = ['dark', 'pink-night', 'claude-dark', 'codex-lavender'].map(name => getTheme(name).chart4)
  assert.equal(new Set(darkRamp).size, 1, 'dark palettes share the dark ramp')
  assert.notEqual(getTheme('dark').chart4, getTheme('light').chart4, 'light ramp is stepped for light surfaces')
})

check('seriesColor wraps and sanitizes; chartColorKey refuses literal colors', () => {
  assert.equal(seriesColor(0), 'chart1')
  assert.equal(seriesColor(7), 'chart8')
  assert.equal(seriesColor(8), 'chart1')
  assert.equal(seriesColor(-1), 'chart8')
  assert.equal(seriesColor(Number.NaN), 'chart1')
  assert.equal(seriesColor(2.9), 'chart3')
  assert.equal(chartColorKey(10), 'chart3')
  assert.equal(chartColorKey('warning'), 'warning')
  assert.equal(chartColorKey('claude'), 'accent', 'legacy aliases normalize')
  assert.equal(chartColorKey('#ff0000', 'text'), 'text')
  assert.equal(chartColorKey('ansi:red'), undefined)
  assert.equal(chartColorKey({}, 'subtle'), 'subtle')
})

check('chart colors resolve on dark, light and ANSI palettes', () => {
  for (const name of ['dark', 'light', 'dark-ansi']) {
    const palette = getTheme(name)
    for (let index = 0; index < 8; index += 1) assert.equal(palette[seriesColor(index)], palette[`chart${index + 1}` as 'chart1'])
  }
  assert.equal(getTheme('dark-ansi')[seriesColor(0)], 'ansi:blueBright')
  assert.equal(getTheme('light')[seriesColor(1)], 'rgb(217,89,38)')
  assert.equal(getTheme('dark')[seriesColor(2)], 'rgb(25,158,112)')
})

check('rendered series follow the active palette (dark / light / ANSI)', () => {
  for (const name of ['dark', 'light', 'dark-ansi', 'pink-ansi']) {
    const palette = getTheme(name)
    const element = (
      <ui.ThemeProvider theme={name}>
        <ui.StackedBar width={3} segments={[{ value: 1, color: 0 }, { value: 1, color: 1 }, { value: 1, color: 9 }]} />
      </ui.ThemeProvider>
    )
    for (const [x, key] of [[0, 'chart1'], [1, 'chart2'], [2, 'chart2']] as const) {
      assert.equal(styleAt(element, 4, x, 0), referenceStyle('█', palette[key]), `${name}: cell ${x} paints ${key}`)
    }
  }
})

check('hashSeries is a stable FNV-1a slot', () => {
  // Pinned: changing the hash recolors every plugin's open-ended series.
  assert.deepEqual(['read_file', 'bash', 'web_search', 'Task', '技能', ''].map(hashSeries), [0, 7, 2, 4, 6, 5])
  assert.equal(hashSeries('read_file'), hashSeries('read_file'))
  const slots = new Set(Array.from({ length: 64 }, (_, i) => hashSeries(`tool-${i}`)))
  assert.equal(slots.size, 8, 'spreads over all eight slots')
  assert.ok([...slots].every(slot => Number.isInteger(slot) && slot >= 0 && slot < 8))
})

console.log('format')

check('format helpers', () => {
  const f = chartFormat
  assert.deepEqual([950, 1234, 3_400_000, 1000, -5, Number.NaN].map(f.tokens), ['950', '1.2k', '3.4M', '1.0k', '0', '0'])
  assert.deepEqual([988, 12_345, 999_499, 1_000_000, 12_345_678, Number.POSITIVE_INFINITY].map(f.tokens), ['988', '12k', '999k', '1.0M', '12M', '0'])
  assert.deepEqual([850, 12_400, 185_000, 7_800_000, 3_723_000, 999.6, -1, Number.NaN, Number.POSITIVE_INFINITY].map(f.duration),
    ['850ms', '12s', '3m 5s', '2h 10m', '1h 2m 3s', '999ms', '0s', '0s', '0s'])
  assert.equal(f.percent(0.42), '42%')
  assert.equal(f.percent(0.4237, 1), '42.4%')
  assert.equal(f.percent(Number.NaN), '0%')
  const now = 1_000_000_000
  assert.deepEqual([now, now - 45_000, now - 180_000, now - 7_200_000, now - 5 * 86_400_000, now + 5000].map(at => f.relativeTime(at, now)), ['now', '45s', '3m', '2h', '5d', 'now'])
  assert.equal(f.cells(CJK), 10)
  assert.equal(f.cells('\u001B[31mab\u001B[0m'), 2)
  assert.equal(f.truncate(CJK, 5), '上下…')
  assert.equal(f.truncate('a\u001B[31mb\nc', 10), 'ab c')
})

check('format.tokens promotes at rounding boundaries (never 10.0k / 1000k / 10.0M)', () => {
  const f = chartFormat
  assert.deepEqual([9_949, 9_950, 9_960, 999_499, 999_500, 999_600, 9_949_999, 9_950_000, 9_960_000].map(f.tokens),
    ['9.9k', '10k', '10k', '999k', '1.0M', '1.0M', '9.9M', '10M', '10M'])
})

check('format.tokens prints what the footer context bar prints (one formatter, both ladders pinned)', () => {
  const f = chartFormat
  const { formatTokens } = tokenFormat
  // The bar's readout is `<used>/<window> <pct>`: a caption quoting either
  // count must print the same string.
  const counts = [0, 1, 999, 1000, 1049, 1950, 3400, 9949, 9999, 10_000, 12_345, 99_500, 128_000, 999_499, 999_999,
    1_000_000, 1_049_999, 1_234_567, 9_950_000, 12_345_678, 1e9]
  for (const used of counts) {
    for (const window of [64_000, 128_000, 1_000_000, 1_048_576]) {
      const readout = metrics.contextBarReadout(used, window)[0]!
      assert.ok(readout.startsWith(`${f.tokens(used)}/${f.tokens(window)} `), `${used}/${window}: kit ${f.tokens(used)}/${f.tokens(window)} vs bar "${readout}"`)
    }
    assert.equal(f.tokens(used), formatTokens(used, { style: 'short' }), `${used}: kit is the short ladder`)
  }
  // The default (precise) ladder is the status line's token field.
  assert.deepEqual([988, 1000, 3400, 12_345, 123_456, 1_234_567, 0.4].map(count => formatTokens(count)), ['988', '1k', '3.4k', '12.3k', '123.5k', '1.2m', '0.4'])
})

check('format.duration prints what the host prints from a second up, milliseconds below', () => {
  const f = chartFormat
  const { formatDuration } = tokenFormat
  const samples = [0, 1000, 59_999, 60_000, 61_000, 185_000, 3_599_999, 3_600_000, 3_723_000, 7_800_000, 86_400_000, 360_000_123]
  for (let ms = 1000; ms <= 4_000_000; ms += 997) samples.push(ms)
  for (const ms of samples) assert.equal(f.duration(ms), formatDuration(ms), `${ms}ms`)
  assert.deepEqual([0.2, 1, 12, 999].map(f.duration), ['1ms', '1ms', '12ms', '999ms'])
})

console.log('kit')

check('kit objects are frozen and share the ui.ts components', () => {
  const { tuiChartKit, tuiChartRowKit } = kit
  assert.ok(Object.isFrozen(tuiChartKit) && Object.isFrozen(tuiChartRowKit) && Object.isFrozen(tuiChartKit.format))
  assert.deepEqual(Object.keys(tuiChartRowKit).sort(), ['Meter', 'Sparkline', 'StackedBar', 'format', 'hashSeries', 'seriesColor'])
  assert.deepEqual(Object.keys(tuiChartKit).sort(), ['ColumnChart', 'Heatmap', 'Legend', 'Meter', 'Sparkline', 'StackedBar', 'Table', 'format', 'hashSeries', 'seriesColor'])
  for (const key of Object.keys(tuiChartKit) as (keyof typeof tuiChartKit)[]) {
    assert.equal(tuiChartKit[key], (ui as Record<string, unknown>)[key], `ui.${key} is the kit member`)
  }
})

if (SAMPLES) {
  const show = (title: string, element: React.ReactElement, width: number): void => {
    console.log(`\n--- ${title} (${width} cells)`)
    for (const line of screenRows(element, width)) console.log(`|${line.padEnd(width - (stringWidth(line) - line.length))}|`)
  }
  show('StackedBar composition', <ui.StackedBar width={40} keepVisible segments={[{ value: 120, color: 0 }, { value: 30, color: 1 }, { value: 1, color: 2 }, { value: 50, color: 3, hatch: true }]} />, 40)
  show('StackedBar occupancy', <ui.StackedBar width={40} capacity={128_000} segments={[{ value: 21_000, color: 0 }, { value: 9_500, color: 1 }, { value: 14_200, color: 2 }]} />, 40)
  show('Sparkline', <ui.Sparkline width={40} values={Array.from({ length: 120 }, (_, i) => Math.round(20 + 15 * Math.sin(i / 6) + (i % 17 === 0 ? 30 : 0)))} />, 40)
  show('Meter', <ui.Meter ratio={0.63} width={40} fillColor={0} emptyColor="inactive" />, 40)
  show('ColumnChart', <ui.ColumnChart height={6} gap={1} selected={7} columns={Array.from({ length: 20 }, (_, i) => ({
    segments: [{ value: 2 + (i % 4), color: 0 }, { value: (i * 7) % 5, color: 1 }, { value: i % 3 === 0 ? 2 : 0, color: 2 }],
    ...(i === 4 || i === 13 ? { marker: '✂', markerColor: 'warning' as const } : {}),
  }))} />, 40)
  show('Heatmap', <ui.Heatmap rows={Array.from({ length: 7 }, (_, y) => Array.from({ length: 20 }, (_, x) => ((x * 3 + y * 5) % 11 === 0 ? null : ((x + 2) * (y + 1)) % 9)))} selected={{ row: 3, col: 6 }} />, 40)
  show('Legend', <ui.Legend width={40} maxRows={2} items={[
    { color: 0, label: '系统提示', value: '12.3k' }, { color: 1, label: 'tools', value: '4.1k' },
    { color: 2, label: '🧠 thinking', value: '980' }, { color: 3, label: 'assistant', value: '22k' },
    { color: 4, label: 'user', value: '3k' }, { color: 5, label: 'files', value: '9k' }, { color: 6, label: 'skills', value: '1k' },
  ]} />, 40)
  show('Table', <ui.Table width={40} selected={1} columns={[
    { key: 'name', title: '名称', minWidth: 6 }, { key: 'tokens', title: 'tokens', width: 7, align: 'right' }, { key: 'when', title: 'when', width: 5, align: 'right' },
  ]} rows={[
    { name: '系统提示词 system prompt', tokens: ui.format.tokens(12_345), when: ui.format.relativeTime(Date.now() - 4000) },
    { name: 'read_file src/screens/Chat.tsx', tokens: ui.format.tokens(980), when: ui.format.relativeTime(Date.now() - 200_000) },
    { name: { text: '🧠 thinking', color: 2 }, tokens: ui.format.tokens(1_250_000), when: '2h' },
  ]} />, 40)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

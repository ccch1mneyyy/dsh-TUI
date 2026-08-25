/**
 * Kilo-style reasoning-effort ignition regression.
 *
 * Pins the exported style resolver and per-line sampler, then mounts the real
 * three-row prompt border with a deterministic shared clock. The checks cover
 * high/xhigh left-to-right motion, max inward motion, ultra outward motion,
 * the finite 900ms centered label, trigger/no-op/restart/cancel semantics,
 * fixed geometry, absence of terminal scrolling, and clock cleanup.
 *
 * Run: node --import tsx/esm scripts/verify-effort-ignition.tsx
 */
process.env.FORCE_COLOR = '3'

const [
  { Writable, PassThrough },
  React,
  { Terminal: XTerm },
  { render, Text },
  { EffortInputBorder },
  badge,
  { ClockContext },
  { getTheme },
  { effortBand, effortTheme },
  math,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/EffortInputBorder.js'),
  import('../src/components/EffortTierBadge.js'),
  import('../src/ink/components/ClockContext.js'),
  import('../src/theme.js'),
  import('../src/components/effort-theme.js'),
  import('../src/trajectory/effortIgnition.js'),
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : ` (${detail})`}`)
  if (!ok) failures++
}

type Style = unknown
type Resolver = (effort: string | undefined) => Style
type Palette = {
  band: string
  high: readonly string[]
  xhigh: readonly string[]
  max: readonly string[]
  ultra: readonly string[]
}
type Sampler = (options: {
  effort: string
  style: Style
  elapsedMs: number
  width: number
  onLight: boolean
  palette?: Palette
}) => ReadonlyArray<unknown>

const { EffortTierBadge } = badge
const badgeApi = badge as Record<string, unknown>
const badgeWeights = badgeApi.effortBadgeWeights as ((effort: string, count: number, progress: number) => readonly number[]) | undefined
const badgeGap = badgeApi.effortBadgeGap as ((effort: string, progress: number) => number) | undefined
const api = math as Record<string, unknown>
const resolver = (
  api.resolveEffortIgnitionStyle
  ?? api.effortIgnitionStyle
  ?? api.ignitionStyleForEffort
) as Resolver | undefined
const sampler = api.ignitionLineColors as Sampler | undefined
const accents = api.ignitionAccents as ((effort: string | undefined, onLight: boolean, palette?: Palette) => readonly string[]) | undefined
const gradient = api.themeGradient as ((colors: readonly string[], progress: number) => string | undefined) | undefined
const blendColor = api.blendThemeColor as ((base: string, accent: string, progress: number) => string) | undefined
const duration = Number(
  api.EFFORT_IGNITION_MS
  ?? api.IGNITION_DURATION_MS
  ?? api.IGNITION_TIMELINE_MS
  ?? (api.IGNITION_TIMELINE as { durationMs?: number; totalMs?: number; fadeEndMs?: number } | undefined)?.durationMs
  ?? (api.IGNITION_TIMELINE as { totalMs?: number } | undefined)?.totalMs
  ?? (api.IGNITION_TIMELINE as { fadeEndMs?: number } | undefined)?.fadeEndMs,
)

check('API: effort ignition exports a style resolver', typeof resolver === 'function')
check('API: effort ignition exports a line sampler', typeof sampler === 'function')
check('API: effort ignition exports theme-gradient helpers',
  typeof accents === 'function' && typeof gradient === 'function' && typeof blendColor === 'function')
check('API: tier badge exports deterministic per-tier motion helpers',
  typeof badgeWeights === 'function' && typeof badgeGap === 'function')
check('timeline: every transition is finite at exactly 900ms', duration === 900, `duration ${String(duration)}`)

const styles = new Map<string, Style>()
for (const effort of ['high', 'xhigh', 'max', 'ultra']) {
  const style = resolver?.(effort)
  styles.set(effort, style)
  check(`style: ${effort} resolves`, style !== undefined && style !== null && style !== false, String(style))
}
check('style: unsupported efforts resolve to no animation', resolver?.('medium') == null && resolver?.(undefined) == null)

const earlyBadge = Object.fromEntries(
  ['high', 'max', 'ultra'].map(effort => [effort, badgeWeights?.(effort, 5, 0.35) ?? []]),
) as Record<string, readonly number[]>
const twinBadge = badgeWeights?.('xhigh', 5, 0.5) ?? []
check('badge high: letter energy enters strictly left-to-right',
  earlyBadge.high[0]! > earlyBadge.high[2]! && earlyBadge.high[2]! >= earlyBadge.high[4]!, earlyBadge.high.join(','))
check('badge xhigh: twin moving peaks differ from the single high front',
  twinBadge.filter(weight => weight > 0.5).length >= 2
  && twinBadge.filter(weight => weight < 0.2).length >= 2
  && twinBadge.join(',') !== (badgeWeights?.('high', 5, 0.5) ?? []).join(','), twinBadge.join(','))
check('badge max: outer letters arrive before the center and metadata contracts inward',
  earlyBadge.max[0]! > earlyBadge.max[2]! && earlyBadge.max[4]! > earlyBadge.max[2]!
  && (badgeGap?.('max', 0.2) ?? 0) > (badgeGap?.('max', 0.8) ?? 0), earlyBadge.max.join(','))
check('badge ultra: center arrives before the edges while metadata expands outward',
  earlyBadge.ultra[2]! > earlyBadge.ultra[0]! && earlyBadge.ultra[2]! > earlyBadge.ultra[4]!
  && (badgeGap?.('ultra', 0.2) ?? 0) < (badgeGap?.('ultra', 0.8) ?? 0), earlyBadge.ultra.join(','))
check('badge: all four tiers settle to fully visible letters',
  ['high', 'xhigh', 'max', 'ultra'].every(effort =>
    (badgeWeights?.(effort, 5, 1) ?? []).every(weight => weight === 1)))

const WIDTH = 61
const CENTER = (WIDTH - 1) / 2
const colors = (effort: string, elapsedMs: number, palette?: Palette): ReadonlyArray<unknown> =>
  sampler?.({ effort, style: styles.get(effort), elapsedMs, width: WIDTH, onLight: false, palette }) ?? []
const painted = (effort: string, elapsedMs: number): number[] =>
  colors(effort, elapsedMs).flatMap((color, column) => color == null ? [] : [column])
const samples = (effort: string): number[][] =>
  Array.from({ length: 17 }, (_, index) => painted(effort, 50 + index * 50)).filter(columns => columns.length > 0)
const centroid = (columns: readonly number[]): number =>
  columns.length === 0 ? Number.NaN : columns.reduce((sum, column) => sum + column, 0) / columns.length
const radius = (columns: readonly number[]): number =>
  columns.length === 0 ? Number.NaN : columns.reduce((sum, column) => sum + Math.abs(column - CENTER), 0) / columns.length
const groups = (columns: readonly number[]): number =>
  columns.reduce((count, column, index) => count + (index === 0 || column > columns[index - 1]! + 1 ? 1 : 0), 0)
const used = (values: readonly unknown[]): string[] =>
  [...new Set(values.flatMap(value => typeof value === 'string' ? [value] : []))]

for (const effort of ['high', 'xhigh']) {
  const frames = samples(effort)
  const early = frames[0] ?? []
  const late = frames.at(-1) ?? []
  check(`${effort}: painted band travels left-to-right`,
    early.length > 0 && late.length > 0 && centroid(early) + WIDTH / 4 < centroid(late),
    `centroid ${centroid(early).toFixed(1)}→${centroid(late).toFixed(1)}`)
}
{
  const high = painted('high', 450)
  const xhigh = painted('xhigh', 450)
  check('high/xhigh: visual paths differ as one broad front versus twin narrow fronts',
    groups(high) === 1 && groups(xhigh) === 2 && high.length > xhigh.length,
    `groups ${groups(high)}/${groups(xhigh)}, columns ${high.length}/${xhigh.length}`)
}
{
  const frames = samples('max')
  const early = frames[0] ?? []
  const late = frames.at(-1) ?? []
  check('max: fronts move inward toward the center',
    early.length > 0 && late.length > 0 && radius(early) > radius(late) + WIDTH / 5,
    `radius ${radius(early).toFixed(1)}→${radius(late).toFixed(1)}`)
}
{
  const frames = samples('ultra')
  const early = frames[0] ?? []
  const late = frames.at(-1) ?? []
  check('ultra: fronts move outward from the center',
    early.length > 0 && late.length > 0 && radius(late) > radius(early) + WIDTH / 5,
    `radius ${radius(early).toFixed(1)}→${radius(late).toFixed(1)}`)
}
const darkTheme = getTheme('dark')
const lightTheme = getTheme('light')
const darkPalette = effortTheme(darkTheme) as Palette
const lightPalette = effortTheme(lightTheme) as Palette
check('theme: dark RGB palette is sourced from semantic Theme roles',
  darkPalette.band === darkTheme.promptBorder
  && darkPalette.high[0] === darkTheme.promptBorderShimmer
  && darkPalette.xhigh[1] === darkTheme.permissionShimmer
  && darkPalette.max[0] === darkTheme.warning
  && darkPalette.ultra[6] === darkTheme.rainbow_violet
  && Object.values(darkPalette).flat().every(color => color.startsWith('rgb(')))
check('theme: light RGB palette keeps the same semantic mapping with different concrete colors',
  lightPalette.band === lightTheme.promptBorder
  && lightPalette.high[1] === lightTheme.claudeShimmer
  && lightPalette.max[1] === lightTheme.warningShimmer
  && lightPalette.ultra[0] === lightTheme.rainbow_red
  && lightPalette.band !== darkPalette.band)
check('theme: prompt-owned semantic and raw session accent colors resolve as the animation band',
  effortBand(darkTheme, 'warning') === darkTheme.warning
  && effortBand(darkTheme, '#123456') === '#123456'
  && effortTheme(darkTheme, effortBand(darkTheme, 'warning')).band === darkTheme.warning)
const signatures = ['high', 'xhigh', 'max', 'ultra'].map(effort => used(colors(effort, 450, darkPalette)))
check('theme: all four tiers produce distinct dark-theme RGB color signatures',
  signatures.every(signature => signature.length > 0 && signature.every(color => color.startsWith('rgb(')))
  && new Set(signatures.map(signature => signature.join('|'))).size === 4,
  signatures.map((signature, index) => `${['high', 'xhigh', 'max', 'ultra'][index]}:${signature.length}`).join(', '))

const customPalette: Palette = {
  band: '#101010',
  high: ['#123456', '#345678'],
  xhigh: ['#2468ac', '#abcdef'],
  max: ['#c08020', '#ffe080'],
  ultra: ['#a00000', '#b06000', '#909000', '#008000', '#0060a0', '#302090', '#800080'],
}
check('custom fallback: raw non-rgb colors step between valid theme values without interpolation',
  blendColor?.(customPalette.band, customPalette.high[0]!, 0.2) === customPalette.band
  && blendColor?.(customPalette.band, customPalette.high[0]!, 0.8) === customPalette.high[0]
  && gradient?.(customPalette.high, 0.2) === customPalette.high[0]
  && gradient?.(customPalette.high, 0.8) === customPalette.high[1])
for (const effort of ['high', 'xhigh', 'max', 'ultra']) {
  const sampled = used(colors(effort, 450, customPalette))
  const allowed = new Set(customPalette[effort as keyof Omit<Palette, 'band'>])
  check(`custom fallback: ${effort} sampler preserves raw theme colors`,
    sampled.length > 0 && sampled.every(color => allowed.has(color)), sampled.join(','))
}

const ansiPalette = effortTheme(getTheme('dark-ansi')) as Palette
for (const effort of ['high', 'xhigh', 'max', 'ultra']) {
  const sampled = used(colors(effort, 450, ansiPalette))
  check(`ANSI fallback: ${effort} remains palette-based without invented RGB`,
    sampled.length > 0 && sampled.every(color => color.startsWith('ansi:')), sampled.join(','))
}

for (const effort of ['high', 'xhigh', 'max', 'ultra']) {
  check(`${effort}: sampler is dark at and after 900ms`,
    painted(effort, 900).length === 0 && painted(effort, 901).length === 0)
}

const COLS = 60
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

type ManualClock = {
  now: () => number
  subscribe: (fn: () => void, keepAlive: boolean) => () => void
  setTickInterval: (_ms: number) => void
  advance: (ms: number) => void
  subscriptions: () => number
}
function createManualClock(): ManualClock {
  let now = 0
  const listeners = new Set<() => void>()
  return {
    now: () => now,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    setTickInterval() {},
    advance(ms) {
      now += ms
      for (const listener of [...listeners]) listener()
    },
    subscriptions: () => listeners.size,
  }
}

async function makeHarness(initial: string | undefined) {
  const term = new XTerm({ cols: COLS, rows: 6, scrollback: 100, allowProposedApi: true })
  const writes: string[] = []
  const clock = createManualClock()
  let setEffort: React.Dispatch<React.SetStateAction<string | undefined>> = () => {}
  class FakeStdout extends Writable {
    columns = COLS
    rows = 6
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      writes.push(String(chunk))
      term.write(String(chunk), callback)
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  function Driver(): React.ReactNode {
    const [effort, update] = React.useState<string | undefined>(initial)
    setEffort = update
    return React.createElement(
      ClockContext.Provider,
      { value: clock },
      React.createElement(
        EffortInputBorder,
        { effort, levels: LEVELS, columns: COLS, onLight: false, idleColor: 'promptBorder' },
        React.createElement(Text, null,
          ' ',
          React.createElement(EffortTierBadge, {
            effort,
            levels: LEVELS,
            onLight: false,
            columns: COLS,
            leadingColumns: 2,
          }),
        ),
      ),
    )
  }
  const stdout = new FakeStdout()
  const instance = await render(React.createElement(Driver), {
    stdout: stdout as never,
    stdin: new FakeStdin() as never,
    stderr: stdout as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const row = (y: number): string =>
    term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? ''
  const fg = (y: number): number => {
    const line = term.buffer.active.getLine(term.buffer.active.baseY + y)
    if (line === undefined) return 0
    const found = new Set<number>()
    for (let x = 0; x < COLS; x++) {
      const cell = line.getCell(x)
      if (cell?.isFgRGB()) found.add(cell.getFgColor())
    }
    return found.size
  }
  const settle = async (): Promise<void> => { await sleep(45) }
  const set = async (effort: string | undefined): Promise<void> => {
    setEffort(effort)
    await settle()
  }
  const advance = async (ms: number): Promise<void> => {
    clock.advance(ms)
    await settle()
  }
  await settle()
  return { term, writes, clock, row, fg, set, advance, instance }
}

const top = '╭' + '─'.repeat(COLS - 2) + '╮'
const bottom = '╰' + '─'.repeat(COLS - 2) + '╯'
const stableRows = (harness: Awaited<ReturnType<typeof makeHarness>>): boolean =>
  harness.row(0).length === COLS
  && harness.row(2).length === COLS
  && harness.row(2) === bottom
  && harness.row(3) === ''
const centered = (line: string, effort: string): boolean => {
  const letters = effort.toUpperCase().split('')
  const columns: number[] = []
  let cursor = 0
  for (const letter of letters) {
    const at = line.indexOf(letter, cursor)
    if (at < 0) return false
    columns.push(at)
    cursor = at + 1
  }
  const gaps = columns.slice(1).map((column, index) => column - columns[index]! - 1)
  const middle = (columns[0]! + columns.at(-1)!) / 2
  return gaps.every(gap => gap === 1) && Math.abs(middle - (COLS - 1) / 2) <= 1
}
const hasScroll = (stream: string): boolean =>
  /\x1b\[\d*[ST]/u.test(stream)
  || /\x1b\[(?:\d+;)?\d*[rLM]/u.test(stream)

{
  const harness = await makeHarness('high')
  try {
    check('cold: mounting on a supported tier is a no-op', harness.row(0) === top && harness.fg(0) <= 1 && harness.clock.subscriptions() === 0)
    await harness.set('high')
    check('same: selecting the current tier is a no-op', harness.fg(0) <= 1 && harness.clock.subscriptions() === 0)
    await harness.set('medium')
    check('unsupported: changing to a non-animated tier is a no-op', harness.fg(0) <= 1 && harness.clock.subscriptions() === 0)

    harness.writes.length = 0
    await harness.set('xhigh')
    check('start: supported effort owns one bounded clock subscription', harness.clock.subscriptions() > 0)
    await harness.advance(550)
    check('label: uppercase one-space effort is centered during the 900ms window', centered(harness.row(1), 'xhigh'), harness.row(1).trim())
    check('geometry: animation remains exactly three stable rows', stableRows(harness))

    await harness.set(undefined)
    await harness.advance(1)
    check('cancel: clearing effort removes animation and clock ownership', harness.fg(0) <= 1 && harness.row(1).trim() === '' && harness.clock.subscriptions() === 0)

    await harness.set('max')
    await harness.advance(500)
    const before = harness.row(1)
    await harness.set('ultra')
    await harness.advance(100)
    check('restart: a new supported effort replaces the active label from time zero', !harness.row(1).includes('M A X') && harness.row(1) !== before)
    await harness.advance(800)
    check('completion: exactly 900ms returns to rest and releases the clock',
      harness.fg(0) <= 1 && harness.row(1).trim() === '' && harness.clock.subscriptions() === 0)
    check('lifecycle: no scrolling while starting, cancelling, or restarting', !hasScroll(harness.writes.join('')))
  } finally {
    harness.instance.unmount()
    await sleep(30)
    check('cleanup: unmount leaves no shared-clock subscriptions', harness.clock.subscriptions() === 0)
  }
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

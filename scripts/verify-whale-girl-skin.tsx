/**
 * 鲸娘皮肤回归（whaleGirl，assets/whaleGirl/frames.json）。两层：
 *
 * UNIT（不挂载）：
 *  - kit 加载：22 个动画、逐帧 30 行 x 42 字符、dur 恒正、调色板 <=30 个
 *    可打印非 '.' 键且全部在帧里出现过、文件体积 < 500KB；
 *  - 姿态覆盖（纯函数）：每个 CompanionMood、deepy 全部互动/上下文/通知
 *    反应语义在鲸娘侧都有落点（同名直通 + notice→smile-hearts、
 *    happy→thumbs-up 两处覆盖）；
 *  - 爱心 pass（pose.heart>0）→ smile-hearts、celebrate → thumbs-up；
 *  - 渲染冒烟：idle / smile-hearts / thumbs-up 三键预渲染 15 行、行宽 42、
 *    两两可区分，且与 deepy 同名动画可区分（无串包）；
 *  - 回退：kit 强制缺失（whaleGirlKitCache 接缝）时 WhaleGirlSkin.render
 *    落到 DeepySkin.render 且不崩；resetDeepyCacheForTests 复位后恢复。
 *
 * RENDER（AlternateScreen + xterm 无头，学 verify-companion-panel）：
 *  - skin='whaleGirl' 经设置管线生效：面板渲染半块美术行、当前动作显示
 *    皮肤 title「鲸娘」、美术宽度不超 cells.columns；
 *  - SGR 点击宠物 → 爱心 pass 真到 WhaleGirlSkin.render（pose.heart>0，
 *    即 smile-hearts 的亲昵互动接线）。
 *
 * IMAGE（图像协议层，assets/whaleGirl/img/，2026-10-02 返场后）：
 *  - timings 完整性（267 帧全保留、dur 恒正、两位帧号文件在盘）；
 *  - 选帧 whaleGirlImageFrameIndexAt 与 frameAt 逐 elapsed 同语义；
 *  - alpha **保真**抽样：半透明边缘必须存在（构建期不再二值化——kitty
 *    全保真软边，sixel 硬掩码+抖动交给渲染层编码期）；
 *  - 档位预算契约：素材总量 ≤25MB、单动画解码 RGBA ≤8MB；
 *  - sixel 掩膜抖动探针（sixelCoveragePaints）：<25% 不画 / ≥62.5% 全画 /
 *    中间 2×2 Bayer 图样交替；纯 0/255 源与旧单阈值逐像素一致；色调
 *    保真（软边）MAE 显著低于阈值掩膜；
 *  - 假 TerminalImages context（kitty）：隐藏面板零解码（visible=false
 *    零工作）、打开后惰性解码只碰「播过的 + 预热」键、raster 盒取代字母格；
 *  - 持帧/预热（2026-10-03 抽搐修复）：可见后常用互动键（idle 主键/poke
 *    左右/smile-hearts）预解进 LRU；切到未解码键保持上一帧不闪字母格；
 *    冷启动（会话内从未上过图像）字母格兜底仍工作；
 *  - SplashMascot（logo 栏吉祥物，同一渲染管线）：点击换键链（poke→
 *    smile-hearts）不闪字母格；active=false 冻结态不预热、定格帧稳定；
 *  - 假 context（无协议）：字母格回退且永不解码 raster 帧。
 *
 * Run: node --import tsx/esm scripts/verify-whale-girl-skin.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, prefs, skins, deepy, { statSync }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/components/sidePanel/companion/skins.js'),
  import('../src/components/sidePanel/companion/deepy.js'),
  import('node:fs'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, AlternateScreen, Box, Text, useInput } = ui
const { Suspense } = React
const { applySidePanelPanels, applySidePanelOpen, applySidePanelRatio, applyCompanionSkin, getCompanionSkin, normalizeCompanionSkin } = prefs
const { DeepySkin, WhaleGirlSkin, resolveCompanionSkin, whaleGirlAnimationKey, WHALE_GIRL_SEMANTIC_ANIMATION } = skins
const {
  DEEPY_CONTEXT_ANIMATION, DEEPY_IDLE_ROTATION, DEEPY_INTERACTION_ANIMATION, DEEPY_MOOD_ANIMATION,
  DEEPY_NOTIFICATION_REACTION, DEEPY_SEMANTIC_ANIMATION, loadDeepyKit, loadWhaleGirlKit,
  renderedDeepyAnimation, resetDeepyCacheForTests, whaleGirlKitCache,
} = deepy
const { settled, sleep } = termTest

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

const EXPECTED_KEYS = [
  'idle', 'idle-look', 'idle-spout', 'thinking', 'typing', 'music', 'conducting',
  'building', 'error', 'happy', 'notification', 'compacting', 'carrying', 'sleeping',
  'waking', 'poke-left', 'poke-right', 'tickle', 'drag', 'swim', 'smile-hearts', 'thumbs-up',
]

// ============================ UNIT LAYER =================================

// --- kit 加载与形状 --------------------------------------------------------
const kit = loadWhaleGirlKit()
check('unit: whaleGirl kit loads (22 animations)', kit !== undefined && Object.keys(kit?.byKey ?? {}).length === 22,
  'keys=' + Object.keys(kit?.byKey ?? {}).length)
if (kit === undefined) {
  console.error('FAILED: kit missing — 渲染层无从测起。')
  process.exit(1)
}
check('unit: kit key set matches the 22 source GIFs', EXPECTED_KEYS.every(k => kit.byKey[k] !== undefined) && Object.keys(kit.byKey).length === EXPECTED_KEYS.length)
check('unit: kit grid is 42x30 (half-block -> 42x15)', kit.columns === 42 && kit.rows === 30)
{
  let shapeOk = true
  let reason = ''
  // parseKit 会额外注入 '.'（透明）键：调色板判据按 JSON 文件键算。
  const paletteKeys = new Set(Object.keys(kit.palette).filter(c => c !== '.'))
  const used = new Set<string>()
  for (const [key, animation] of Object.entries(kit.byKey)) {
    if (animation.frames.length === 0) { shapeOk = false; reason = key + ': no frames'; break }
    for (const frame of animation.frames) {
      if (!(frame.dur > 0)) { shapeOk = false; reason = key + ': dur<=' + frame.dur; break }
      if (frame.rows.length !== 30) { shapeOk = false; reason = key + ': rows=' + frame.rows.length; break }
      for (const row of frame.rows) {
        if (row.length !== 42) { shapeOk = false; reason = key + ': row width ' + row.length; break }
        for (const char of row) {
          if (char !== '.' && !paletteKeys.has(char)) { shapeOk = false; reason = key + ': unknown palette char ' + char; break }
          if (char !== '.') used.add(char)
        }
        if (!shapeOk) break
      }
      if (!shapeOk) break
    }
    if (!shapeOk) break
  }
  check('unit: every frame is 30 rows x 42 chars, chars in palette, dur > 0', shapeOk, reason)
  check('unit: palette <= 30 printable non-dot keys, all used in frames',
    paletteKeys.size <= 30 && [...paletteKeys].every(c => c.length === 1 && c !== '.' && /[\x21-\x7e]/.test(c)) && [...paletteKeys].every(c => used.has(c)),
    'palette=' + paletteKeys.size + ' used=' + used.size)
  const size = statSync(new URL('../assets/whaleGirl/frames.json', import.meta.url)).size
  check('unit: frames.json stays under 500KB', size < 500 * 1024, Math.round(size / 1024) + 'KB')
}

// --- 姿态覆盖：mood + 全部互动/上下文/通知语义都有落点 --------------------
{
  const moods = Object.keys(DEEPY_MOOD_ANIMATION)
  check('unit: every CompanionMood covered by deepy table (source of truth)', moods.length === 9, 'moods=' + moods.join(','))
  const missingMood = moods.filter(mood => kit.byKey[whaleGirlAnimationKey(mood as never, 0)] === undefined)
  check('unit: every CompanionMood lands on an existing whaleGirl animation', missingMood.length === 0, 'missing=' + missingMood.join(','))
  check('unit: celebrate -> thumbs-up (鲸娘独有庆祝键)', whaleGirlAnimationKey('celebrate', 0) === 'thumbs-up' && kit.byKey['thumbs-up'] !== undefined)
  check('unit: heart pass -> smile-hearts (亲昵互动键)', whaleGirlAnimationKey('idle', 1) === 'smile-hearts' && whaleGirlAnimationKey('celebrate', 3) === 'smile-hearts' && kit.byKey['smile-hearts'] !== undefined)

  const semantics = [
    ...Object.keys(DEEPY_SEMANTIC_ANIMATION),
    ...Object.keys(DEEPY_INTERACTION_ANIMATION),
    ...Object.keys(DEEPY_NOTIFICATION_REACTION),
    ...DEEPY_IDLE_ROTATION,
  ]
  const missingSemantic = semantics.filter(semantic => {
    const mapped = WHALE_GIRL_SEMANTIC_ANIMATION[semantic] ?? (kit.byKey[semantic] !== undefined ? semantic : undefined)
    return mapped === undefined || kit.byKey[mapped] === undefined
  })
  check('unit: every deepy semantic (mood/context/interaction/reaction/rotation) has a whaleGirl landing', missingSemantic.length === 0, 'missing=' + missingSemantic.join(','))
  check('unit: whaleGirl overrides exactly the two unique keys',
    WHALE_GIRL_SEMANTIC_ANIMATION['notice'] === 'smile-hearts' &&
    WHALE_GIRL_SEMANTIC_ANIMATION['happy'] === 'thumbs-up' &&
    WHALE_GIRL_SEMANTIC_ANIMATION['success'] === 'happy' && // deepy 反应表同名直通
    Object.keys(WHALE_GIRL_SEMANTIC_ANIMATION).length === Object.keys(DEEPY_SEMANTIC_ANIMATION).length)
}

// --- 渲染冒烟（纯预渲染路径）----------------------------------------------
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
{
  const probes = ['idle', 'smile-hearts', 'thumbs-up']
  const renderedByKey = new Map<string, readonly string[][]>()
  let smokeOk = true
  let reason = ''
  for (const key of probes) {
    const rendered = renderedDeepyAnimation(kit, key)
    if (rendered === undefined || rendered.length === 0) { smokeOk = false; reason = key + ': empty'; break }
    renderedByKey.set(key, rendered)
    const frame = rendered[0]!
    if (frame.length !== 15) { smokeOk = false; reason = key + ': rows=' + frame.length; break }
    let artRowCount = 0
    for (const row of frame) {
      const visible = row.replace(ANSI, '')
      if (visible.length !== 42) { smokeOk = false; reason = key + ': visible width ' + visible.length; break }
      if (/[▀▄]/.test(visible)) artRowCount += 1
    }
    // 顶/底缘允许整行透明（contain 留白），但本体必须占多数行。
    if (smokeOk && artRowCount < 10) { smokeOk = false; reason = key + ': only ' + artRowCount + ' art rows' }
    if (!smokeOk) break
  }
  check('unit: whaleGirl renders 15 rows x 42 cells with half-block art', smokeOk, reason)
  const dist = (rows: readonly string[]): string => rows.map(r => r.replace(ANSI, '').replace(/[^▀▄]/g, '').length + '/' + (r.match(/▀/g)?.length ?? 0)).join(',')
  const d1 = dist(renderedByKey.get('idle')![0]!)
  const d2 = dist(renderedByKey.get('smile-hearts')![0]!)
  const d3 = dist(renderedByKey.get('thumbs-up')![0]!)
  check('unit: three animations are pairwise distinguishable', d1 !== d2 && d2 !== d3 && d1 !== d3, d1 + ' | ' + d2 + ' | ' + d3)

  // 串包防护：与 deepy 同名动画必须不同（renderedCache 以 kit.id 分域）。
  const deepyKit = loadDeepyKit()
  if (deepyKit !== undefined) {
    const deepyIdle = renderedDeepyAnimation(deepyKit, 'idle')?.[0]
    const whaleIdle = renderedByKey.get('idle')![0]!
    check('unit: whaleGirl idle differs from deepy idle (no cache cross-talk)', deepyIdle !== undefined && deepyIdle.join('|') !== whaleIdle.join('|'))
    check('unit: deepy idle still renders after whaleGirl (cache namespaced)', deepyIdle !== undefined && deepyIdle.length === 15)
  } else {
    check('unit: deepy kit available for cross-check', false, 'loadDeepyKit undefined')
  }
}

// --- 回退：kit 缺失 → DeepySkin.render，不崩 ------------------------------
{
  resetDeepyCacheForTests()
  whaleGirlKitCache.kit = undefined // 接缝：强制「已加载但缺失」
  const originalDeepyRender = DeepySkin.render
  let deepyCalls = 0
  DeepySkin.render = function spied(input: Parameters<typeof originalDeepyRender>[0]) {
    deepyCalls += 1
    return originalDeepyRender(input)
  }
  let node: unknown
  let error: unknown
  try {
    node = WhaleGirlSkin.render({ pose: { mood: 'idle', tick: 0, gestures: new Set(), blink: false, heart: 0, sleepZ: 0, facing: 'left' } as never, moodSince: 0, now: 500, width: 42 })
  } catch (e) { error = e }
  finally { DeepySkin.render = originalDeepyRender }
  check('unit: kit unavailable falls back to DeepySkin.render without crashing',
    error === undefined && deepyCalls === 1 && node !== null && node !== undefined,
    error === undefined ? 'deepyCalls=' + deepyCalls : String(error))
  resetDeepyCacheForTests()
  check('unit: resetDeepyCacheForTests restores whaleGirl kit loading', loadWhaleGirlKit() !== undefined)
}

// --- 设置管线 ---------------------------------------------------------------
{
  check('unit: normalizeCompanionSkin accepts whaleGirl', normalizeCompanionSkin('whaleGirl') === 'whaleGirl')
  applyCompanionSkin('whaleGirl')
  check('unit: applyCompanionSkin(whaleGirl) takes effect', getCompanionSkin() === 'whaleGirl')
  check('unit: registry resolves whaleGirl, unknown id falls back deepy', resolveCompanionSkin('whaleGirl') === WhaleGirlSkin && resolveCompanionSkin('nope') === DeepySkin)
}

// ============================ RENDER LAYER ================================

let channelVersion = 0
const channelListeners = new Set<() => void>()
const fakeChannel: Record<string, unknown> = {
  get version() { return channelVersion },
  working: false,
  spinnerMode: 'thinking' as string,
  goal: undefined,
  todos: [] as unknown[],
  backgroundJobs: [] as unknown[],
  subagents: [] as unknown[],
  notifications: [] as Array<{ text: string; color?: string }>,
  compaction: undefined as unknown,
  gitBranch: undefined as string | undefined,
  notify() {},
  subscribe(listener: () => void) {
    channelListeners.add(listener)
    return () => { channelListeners.delete(listener) }
  },
}
function bumpChannel(): void {
  channelVersion += 1
  for (const listener of [...channelListeners]) listener()
}

class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

interface Scene {
  app: { unmount: () => Promise<unknown> }
  term: import('@xterm/headless').Terminal
  stdin: FakeStdin
  controller: { openPanel: (id: string, opts?: { focus?: boolean }) => void } | undefined
  lines: () => string[]
}

async function scene(
  cols: number,
  rows: number,
  wrapRuntime?: (children: React.ReactNode) => React.ReactNode,
): Promise<Scene> {
  applySidePanelPanels('todo,jobs,agents,companion')
  applySidePanelOpen(true)
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    term: import('@xterm/headless').Terminal
    constructor(t: import('@xterm/headless').Terminal) { super(); this.term = t }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _write(chunk: any, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: Buffer.Encoding, cb: () => void) { cb() } }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout(term)
  let controller: Scene['controller'] = undefined
  function Harness(): React.ReactNode {
    const sp = useSidePanel({ columns: cols, fullscreen: true, editorOpen: false })
    const [, setV] = React.useState(0)
    controller = sp
    React.useEffect(
      () => (fakeChannel.subscribe as (listener: () => void) => () => void)(() => setV(previous => previous + 1)),
      [],
    )
    // 没有任何 useInput 消费者时 App 不挂 stdin 监听，注入的鼠标会静默
    // 丢失（verify-jobs-transcript-group 的坑）——照 Chat 挂一层。
    useInput((input: string, key: Record<string, boolean | undefined>) => {
      const flags = { ...key, return_: key.return_ ?? ((key as Record<string, unknown>).return === true ? true : undefined) }
      sp.handleKey(input, flags as never)
      setV(previous => previous + 1)
    })
    return wrapRuntime !== undefined ? wrapRuntime(
      <SidePanelLayout
        geometry={sp.geometry}
        focus={sp.focus}
        side={<SidePanelColumn width={sp.panelColumns} controller={sp} channel={fakeChannel as never} activity={undefined} attention={{ approvals: 0, questions: 0 }} />}
      >
        <Box flexDirection="column" flexGrow={1}>
          <Text>{'聊天行甲：鲸娘皮肤不得扰动左栏'}</Text>
        </Box>
      </SidePanelLayout>,
    ) : (
      <SidePanelLayout
        geometry={sp.geometry}
        focus={sp.focus}
        side={<SidePanelColumn width={sp.panelColumns} controller={sp} channel={fakeChannel as never} activity={undefined} attention={{ approvals: 0, questions: 0 }} />}
      >
        <Box flexDirection="column" flexGrow={1}>
          <Text>{'聊天行甲：鲸娘皮肤不得扰动左栏'}</Text>
        </Box>
      </SidePanelLayout>
    )
  }
  const app = await render(
    <AlternateScreen mouseTracking={true}>
      <ThemeProvider theme="dark">
        <Box flexDirection="column" height={rows}><Harness /></Box>
      </ThemeProvider>
    </AlternateScreen>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const lines = (): string[] => {
    const buf = term.buffer.active
    const out: string[] = []
    for (let y = 0; y < rows; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(cols, ' '))
    return out
  }
  return { app, term, stdin, get controller() { return controller }, lines }
}

const ART_RE = /[▀▄█▌▐]{6,}/
function artRows(lines: string[]): number[] {
  const rowsFound: number[] = []
  for (let y = 0; y < lines.length; y += 1) if (ART_RE.test(lines[y]!)) rowsFound.push(y)
  return rowsFound
}
function artSpan(lines: string[], row: number): { start: number; end: number } | null {
  const m = lines[row]?.match(ART_RE)
  if (m === null || m.index === undefined) return null
  return { start: m.index, end: m.index + m[0].length - 1 }
}
function findArtCell(lines: string[]): { col: number; row: number } | null {
  for (let y = 0; y < lines.length; y += 1) {
    const m = lines[y]!.match(ART_RE)
    if (m !== null && m.index !== undefined) return { col: m.index + 3, row: y }
  }
  return null
}
function sgr(button: number, col: number, row: number, release: boolean): string {
  return '\x1b[<' + button + ';' + (col + 1) + ';' + (row + 1) + (release ? 'm' : 'M')
}
function clickAt(s: Scene, col: number, row: number): void {
  s.stdin.write(sgr(0, col, row, false))
  s.stdin.write(sgr(0, col, row, true))
}
const NOW_PLAYING_PREFIX = '当前动作：'
function nowPlaying(lines: string[]): string {
  for (const line of lines) {
    const index = line.indexOf(NOW_PLAYING_PREFIX)
    if (index >= 0) return line.slice(index + NOW_PLAYING_PREFIX.length).trim()
  }
  return ''
}

try {
  // --- 面板：whaleGirl 皮肤经设置生效 -------------------------------------
  applySidePanelRatio(0.55)
  applyCompanionSkin('whaleGirl')
  const whaleGirlPoses: Array<{ heart: number }> = []
  const originalRender = WhaleGirlSkin.render
  WhaleGirlSkin.render = function recorded(input: Parameters<typeof originalRender>[0]) {
    whaleGirlPoses.push({ heart: input.pose.heart })
    return originalRender(input)
  }
  let a: Scene | undefined
  try {
    a = await scene(140, 30)
    a.controller?.openPanel('companion', { focus: true })
    await settled(() => artRows(a!.lines()).length > 0 && nowPlaying(a!.lines()) === '鲸娘', { timeoutMs: 8000 })
    check('render: whaleGirl skin renders half-block art rows', artRows(a.lines()).length > 0, 'rows=' + artRows(a.lines()).length)
    check('render: now-playing shows the whaleGirl skin title (鲸娘)', nowPlaying(a.lines()) === '鲸娘', nowPlaying(a.lines()))
    let maxSpan = 0
    for (const row of artRows(a.lines())) {
      const span = artSpan(a.lines(), row)
      if (span !== null) maxSpan = Math.max(maxSpan, span.end - span.start + 1)
    }
    check('render: pet art never exceeds the 31-cell box budget (airwall contract)', maxSpan > 0 && maxSpan <= 31, 'maxSpan=' + maxSpan)
    const petSample = (): string => artRows(a.lines()).map(r => a!.lines()[r]!.replace(ANSI, '').trimEnd()).join('|')
    const pet1 = petSample()
    await settled(() => petSample() !== pet1, { timeoutMs: 3000 })
    check('render: whaleGirl frames advance between ticks', petSample() !== pet1)

    // --- SGR 点击：爱心 pass 真到皮肤（smile-hearts 接线） ----------------
    const cell = findArtCell(a.lines())
    check('render: art cell on screen', cell !== null)
    if (cell !== null) {
      whaleGirlPoses.length = 0
      clickAt(a, cell.col, cell.row)
      await settled(() => whaleGirlPoses.some(p => p.heart > 0), { timeoutMs: 4000 })
      check('render: SGR click arms the heart pass into WhaleGirlSkin (smile-hearts wiring)',
        whaleGirlPoses.some(p => p.heart > 0), 'maxHeart=' + Math.max(0, ...whaleGirlPoses.map(p => p.heart)))
      check('render: art still present after the click (no crash)', artRows(a.lines()).length > 0)
    }
  } finally {
    WhaleGirlSkin.render = originalRender
    if (a !== undefined) {
      await a.app.unmount()
      a.term.dispose()
    }
  }
} catch (error) {
  check('fixture: no unexpected exception', false, (error as { stack?: string })?.stack ?? String(error))
} finally {
  applyCompanionSkin('deepy')
}

// ========================= IMAGE PROTOCOL LAYER ===========================
// 图像协议路径（kitty/sixel，assets/whaleGirl/img/，scripts/build-whale-girl-images.mjs
// 生成）：timings 完整性、选帧与 frameAt 同语义、alpha 二值化无半透明残留、
// 假 protocol context 注入下的惰性解码（只碰当前动画）、面板隐藏零解码、
// 无协议 context → 字母格回退（且永不解码 raster 帧）。

const {
  loadWhaleGirlImageKit, whaleGirlImageFrameIndexAt, whaleGirlDecodedAnimationKeys, resetWhaleGirlImageCacheForTests,
  whaleGirlImageBoxColumns, WHALE_GIRL_PREHEAT_KEYS, WhaleGirlSkin: WhaleGirlSkinForCells,
  useDecodedWhaleGirlFrames, subscribeDecodedImageCache, injectDecodedAnimationForTests,
  decodedImageAnimationOrderForTests, whaleGirlDecodeRequestCountForTests, injectFailedAnimationForTests,
  useHeldCommittedImage,
} = skins
const { TerminalImagesContext } = await import('../src/ink/hooks/use-terminal-images.js')
const { createRequire } = await import('node:module')
const { existsSync } = await import('node:fs')
const { join } = await import('node:path')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharpForAlpha = (createRequire(import.meta.url)('sharp')) as any

const imageKit = loadWhaleGirlImageKit()
check('image: timings kit loads with the same 22 keys as the letter kit',
  imageKit !== undefined && Object.keys(imageKit?.byKey ?? {}).length === 22
    && EXPECTED_KEYS.every(k => imageKit?.byKey[k] !== undefined),
  'keys=' + Object.keys(imageKit?.byKey ?? {}).length)
if (imageKit === undefined) {
  console.error('FAILED: image timings kit missing — 图像层无从测起。')
  process.exit(1)
}

{
  let total = 0
  let shapeOk = true
  let reason = ''
  for (const key of EXPECTED_KEYS) {
    const animation = imageKit.byKey[key]!
    if (animation.frames.length === 0) { shapeOk = false; reason = key + ': empty'; break }
    let sum = 0
    animation.frames.forEach((frame, index) => {
      if (!(frame.dur > 0)) { shapeOk = false; reason = key + ': dur=' + frame.dur }
      if (frame.file !== String(index).padStart(2, '0') + '.png') { shapeOk = false; reason = key + ': ' + frame.file }
      if (!existsSync(join(imageKit.dir, key, frame.file))) { shapeOk = false; reason = 'missing ' + key + '/' + frame.file }
      sum += frame.dur
    })
    if (sum !== animation.totalMs) { shapeOk = false; reason = key + ': totalMs mismatch' }
    total += animation.frames.length
  }
  check('image: timings keep all 267 frames (no thinning), dur > 0, two-digit files on disk',
    total === 267 && shapeOk, 'total=' + total + ' ' + reason)
}

{
  // 选帧语义：与 deepy.frameAt 逐 elapsed 比对（dur 累加取模，含边界/负值）。
  let parityOk = true
  let reason = ''
  for (const key of ['idle', 'thumbs-up', 'building']) {
    const imageAnimation = imageKit.byKey[key]!
    const letterShaped = {
      key, title: key,
      frames: imageAnimation.frames.map(timing => ({ dur: timing.dur, rows: [] as string[] })),
      totalMs: imageAnimation.totalMs,
    }
    const probes = [
      0, 1, 7, 20, 59, 60, 61, 100, 249, 250, 251, 499, 500, 501,
      imageAnimation.totalMs - 1, imageAnimation.totalMs, imageAnimation.totalMs + 1, -100,
    ]
    for (let elapsed = 0; elapsed <= imageAnimation.totalMs * 2; elapsed += 7) probes.push(elapsed)
    for (const elapsed of probes) {
      if (whaleGirlImageFrameIndexAt(imageAnimation, elapsed) !== deepy.frameAt(letterShaped as never, elapsed)) {
        parityOk = false
        reason = key + ' @' + elapsed + 'ms'
        break
      }
    }
    if (!parityOk) break
  }
  check('image: frame selection matches frameAt semantics (dur-accumulate modulo)', parityOk, reason)
}

{
  // alpha 保真抽样（2026-10-02 返场契约）：构建期不再二值化/收缩——缩放
  // 插值的半透明边缘（0<α<255）必须保留（kitty 全保真软边；sixel 的硬
  // 掩码由渲染层编码期处理）。纯 0/255 会回到硬边，所以这里断言反契约。
  const samples: Array<[string, number]> = [
    ['idle', 0], ['idle', 20], ['smile-hearts', 0], ['smile-hearts', 15],
    ['thumbs-up', 12], ['building', 23], ['sleeping', 5], ['conducting', 6],
  ]
  let everyFrameHasSemi = true
  let fractionOk = true
  let dimsOk = true
  let reason = ''
  let semiTotal = 0
  for (const [key, index] of samples) {
    const animation = imageKit.byKey[key]!
    const file = join(imageKit.dir, key, animation.frames[index]!.file)
    const decoded = await sharpForAlpha(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let a0 = 0
    let a255 = 0
    let semi = 0
    for (let i = 3; i < decoded.data.length; i += 4) {
      const alpha = decoded.data[i]
      if (alpha === 0) a0 += 1
      else if (alpha === 255) a255 += 1
      else semi += 1
    }
    semiTotal += semi
    if (semi === 0) { everyFrameHasSemi = false; reason = key + '/' + index + ' has no semi-alpha (binarized?)' }
    const fraction = a255 / (decoded.info.width * decoded.info.height)
    if (fraction < 0.05 || fraction > 0.9) { fractionOk = false; reason = key + ' opaque=' + fraction.toFixed(3) }
    // 所有帧共享同一尺寸（单源等比缩放），宽高比与源 552/528 一致。
    if (decoded.info.width !== Math.round(decoded.info.height * (552 / 528))) { dimsOk = false; reason = key + ' ' + decoded.info.width + 'x' + decoded.info.height }
  }
  check('image: sampled frames KEEP semi-transparent edges (anti-aliased alpha preserved)', everyFrameHasSemi, reason)
  check('image: sampled frames keep a sane opaque fraction (5%..90%)', fractionOk, reason + ' semiPx=' + semiTotal)
  check('image: frames share one aspect (552/528 source ratio)', dimsOk, reason)
  // 档位预算契约（构建脚本头声明的双线）：素材总量 ≤25MB、单动画解码
  // RGBA ≤8MB（最大动画 building 24 帧）。尺寸从抽到的帧读出（单源单尺寸）。
  {
    const probeAnimation = imageKit.byKey['building']!
    const probeFile = join(imageKit.dir, 'building', probeAnimation.frames[0]!.file)
    const probeDecoded = await sharpForAlpha(probeFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const rgba = probeAnimation.frames.length * probeDecoded.info.width * probeDecoded.info.height * 4
    const assets = await import('node:fs').then(fs => {
      let total = 0
      for (const key of EXPECTED_KEYS) {
        for (const frame of imageKit.byKey[key]!.frames) {
          total += fs.statSync(join(imageKit.dir, key, frame.file)).size
        }
      }
      return total
    })
    check('image: tier budget holds (assets <= 25MB, max-animation RGBA <= 8MB)',
      assets <= 25 * 1024 * 1024 && rgba <= 8 * 1024 * 1024,
      'assets=' + Math.round(assets / 1024) + 'KB rgba=' + Math.round(rgba / 1024) + 'KB')
  }
}

// ========================= SIXEL DITHER PROBE ==============================
// 用户在 Windows Terminal + sixel 上实测边缘发硬：sixel 透明是 1bit，掩膜
// 阈值把半透明边缘一刀切就是硬边。ink 的 sixel 编码器（sixel-codec.ts，
// 全仓 sixel 图像共用）现在对中间 alpha 做 2×2 Bayer 有序抖动：<25% 不画、
// ≥62.5%（含 >75%）全画、中间按图样交替——人眼把图样平均成半透明。这里
// 直接单测掩膜决策函数（sixelCoveragePaints）与旧单阈值的差异契约。

{
  const { sixelCoveragePaints: paints, sixelCoveragePaintsThreshold: oldPaints } = await import('../src/ink/sixel-codec.js')
  const positions: Array<[number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1]]
  const countPainted = (alpha: number): number => positions.filter(([x, y]) => paints(alpha, x, y)).length
  check('sixel: 0% coverage never paints, 100% always paints', countPainted(0) === 0 && countPainted(255) === 4)
  check('sixel: ~33% coverage paints exactly one Bayer cell (alternating pattern)', countPainted(84) === 1)
  check('sixel: ~50% coverage paints three Bayer cells', countPainted(128) === 3)
  check('sixel: ~66% coverage is already solid (band top at 62.5%)', countPainted(168) === 4)
  {
    // 33% 填充在 4×4 块上必须精确落在 M=0 的棋盘位（图样抖动，不是模糊）。
    let patternOk = true
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const bayer = (y & 1) === 0 ? ((x & 1) === 0 ? 0 : 2) : ((x & 1) === 0 ? 3 : 1)
        if (paints(84, x, y) !== (bayer === 0)) patternOk = false
      }
    }
    check('sixel: 33% fill lands on the exact 2x2 Bayer cell positions', patternOk)
  }
  {
    // 影响面：纯 0/255 源（截图类）的掩膜与旧单阈值逐像素一致（逐字节不变）。
    let identical = true
    for (let y = 0; y < 8 && identical; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        if (paints(0, x, y) !== oldPaints(0) || paints(255, x, y) !== oldPaints(255)) { identical = false; break }
      }
    }
    check('sixel: pure 0/255 rasters keep the exact pre-dither mask (opaque sources untouched)', identical)
  }
  {
    // 软边度量（色调保真）：8 列垂直 alpha 渐变边（每列恒定 α），
    // 掩膜列密度对 α 的平均绝对误差应远小于旧单阈值的硬 0/1 跳变。
    // 注：抖动按设计增加了逐扫描线的 on/off 交替次数（那正是图样本身），
    // 「变软」的可测证据是密度跟踪 α，而不是边界阶跃数下降。
    const cols = 8
    const rows = 4
    const alphaAt = (x: number): number => Math.round((255 * x) / (cols - 1))
    const toneError = (mode: 'old' | 'new'): number => {
      let sum = 0
      for (let x = 0; x < cols; x += 1) {
        const alpha = alphaAt(x)
        let painted = 0
        for (let y = 0; y < rows; y += 1) {
          painted += (mode === 'new' ? paints(alpha, x, y) : oldPaints(alpha)) ? 1 : 0
        }
        sum += Math.abs(painted / rows - alpha / 255)
      }
      return sum / cols
    }
    const oldErr = toneError('old')
    const newErr = toneError('new')
    check('sixel: dithered mask tracks coverage (edge tone MAE drops below 60% of threshold mask)',
      newErr < oldErr * 0.6, 'old=' + oldErr.toFixed(3) + ' new=' + newErr.toFixed(3))
    // 同时报出两侧的阶跃数供对比（抖动后上升是预期，不是回归）。
    const steps = (mode: 'old' | 'new'): number => {
      let count = 0
      for (let y = 0; y < rows; y += 1) {
        let previous = 0
        for (let x = 0; x < cols; x += 1) {
          const alpha = alphaAt(x)
          const on = (mode === 'new' ? paints(alpha, x, y) : oldPaints(alpha)) ? 1 : 0
          if (on !== previous) count += 1
          previous = on
        }
        if (previous === 1) count += 1
      }
      return count
    }
    console.log('  (sixel edge steps old=' + steps('old') + ' new=' + steps('new') + ' — dither alternates by design)')
  }
}

// ==================== 拖动空气墙契约（2026-10 修复）=========================
// 面板 clamp/点击半区/§16.6 预算全吃 skin.cells.columns；图像轨盒宽=图宽
// （钳在 cells 内）→ 盒贴边即图贴边。cells 常量必须等于**常见像元比
// （8×16）下的实际图宽**，其他像元比漂移 ≤2 格且只收不裁。
{
  const FRAME_RATIO = 301 / 288 // 构建档（288px 高）的实际帧宽高比
  const columnsAt = (cellW: number, cellH: number): number => whaleGirlImageBoxColumns({ width: cellW, height: cellH }, FRAME_RATIO)
  check('airwall: cells.columns equals the real image width at the common 8x16 cell',
    WhaleGirlSkinForCells.cells.columns === columnsAt(8, 16) && WhaleGirlSkinForCells.cells.columns === 31,
    'cells=' + WhaleGirlSkinForCells.cells.columns + ' image@8x16=' + columnsAt(8, 16))
  // 残隙语义（任务书口径）：图在 31 宽盒内居中，饱和拖动时可见美术距面板
  // 边 = (cells − 图宽)/2 ≤ 2 格 → cells − 图宽 ≤ 4。像元比带内逐点验。
  const band = [1.75, 1.8, 1.9, 2.0, 2.1, 2.2].map(ratio => columnsAt(10, Math.round(10 * ratio)))
  check('airwall: common cell-ratio band (1.75..2.2) keeps the saturated gap within 2 columns',
    band.every(columns => columns <= 31 && 31 - columns <= 4), band.join(','))
  check('airwall: extreme cell ratios clamp inside the box (contain, never clip)',
    columnsAt(10, 25) === 31 && columnsAt(10, 15) <= 31, 'wide=' + columnsAt(10, 25) + ' narrow=' + columnsAt(10, 15))
  // 字母轨开窗契约：267 帧全部美术 ⊆ [5, 5+31)——越窗即被截（防素材更新回归）。
  {
    let windowOk = true
    let reason = ''
    for (const key of EXPECTED_KEYS) {
      for (const frame of kit.byKey[key]!.frames) {
        for (const row of frame.rows) {
          const first = row.search(/[^.]/)
          if (first < 0) continue
          const last = row.length - 1 - [...row].reverse().join('').search(/[^.]/)
          if (first < 5 || last >= 5 + WhaleGirlSkinForCells.cells.columns) {
            windowOk = false
            reason = key + ' [' + first + ',' + last + ']'
          }
        }
      }
    }
    check('airwall: letter-track art fits the 31-column window (no clipping)', windowOk, reason)
  }
}

/** 假 TerminalImages store：协议/像元可控，驱动 WhaleGirlImageSkin 的分支。
 * getSnapshot/getCellSize 必须返回缓存值（useSyncExternalStore 的
 * Object.is 语义——每次新对象会触发 Maximum update depth #185）。 */
const FAKE_CELL_SIZE = Object.freeze({ width: 8, height: 16 })
function fakeImagesStore(protocol: 'kitty' | 'sixel' | undefined): object {
  return {
    subscribe: () => () => {},
    getSnapshot: () => true,
    getCellSize: () => FAKE_CELL_SIZE,
    getProtocol: () => protocol,
    request: () => () => {},
  }
}
const withKitty = (children: React.ReactNode): React.ReactNode => (
  <TerminalImagesContext.Provider value={fakeImagesStore('kitty') as never}>{children}</TerminalImagesContext.Provider>
)
const withNoProtocol = (children: React.ReactNode): React.ReactNode => (
  <TerminalImagesContext.Provider value={fakeImagesStore(undefined) as never}>{children}</TerminalImagesContext.Provider>
)

try {
  applySidePanelRatio(0.55)
  applyCompanionSkin('whaleGirl')
  resetWhaleGirlImageCacheForTests()

  // --- 隐藏面板零解码：active=todo，companion 挂载但 display:none ----------
  const observedSemantics: string[] = []
  const originalRender = WhaleGirlSkin.render
  WhaleGirlSkin.render = function recorded(input: Parameters<typeof originalRender>[0]) {
    if (input.animationSemantic !== undefined) observedSemantics.push(input.animationSemantic)
    return originalRender(input)
  }
  let k: Scene | undefined
  try {
    k = await scene(140, 30, withKitty)
    await sleep(700) // 固定窗:探针 断言隐藏面板零解码（状态不得改变）
    check('image: hidden companion panel decodes nothing (visible=false zero work)',
      whaleGirlDecodedAnimationKeys().length === 0,
      'decoded=' + whaleGirlDecodedAnimationKeys().join(','))

    // --- 打开面板 → 预热进 LRU；惰性解码只碰「播过的 + 预热」键 ------------
    k.controller?.openPanel('companion', { focus: true })
    await settled(() => WHALE_GIRL_PREHEAT_KEYS.every(key => whaleGirlDecodedAnimationKeys().includes(key)), { timeoutMs: 10000 })
    check('preheat: common interaction keys warm the LRU once displayed (idle / poke L+R / smile-hearts)',
      WHALE_GIRL_PREHEAT_KEYS.every(key => whaleGirlDecodedAnimationKeys().includes(key)),
      'decoded=' + whaleGirlDecodedAnimationKeys().join(','))
    const decodedKeys = [...whaleGirlDecodedAnimationKeys()]
    const mapped = new Set(observedSemantics.map(sem =>
      sem === 'idle-spout' ? 'smile-hearts' : sem === 'happy' ? 'thumbs-up' : sem))
    const allowed = new Set([...mapped, ...WHALE_GIRL_PREHEAT_KEYS])
    const stranger = decodedKeys.filter(key => !allowed.has(key))
    check('image: opening the panel decodes only played + preheated keys (lazy decode)',
      decodedKeys.length > 0 && stranger.length === 0,
      'decoded=' + decodedKeys.join(',') + ' stranger=' + stranger.join(','))
    await settled(() => artRows(k!.lines()).length === 0, { timeoutMs: 8000 })
    check('image: raster path replaces letter cells (kitty context → space fallback, no half-block art)',
      artRows(k.lines()).length === 0 && nowPlaying(k.lines()) === '鲸娘',
      'artRows=' + artRows(k.lines()).length + ' now=' + nowPlaying(k.lines()))

    // --- 持帧：切到未解码键保持上一帧，不得闪回字母格 ------------------------
    // success 通知 → happy 反应 → 鲸娘落点 thumbs-up（未预热键）：解码窗口内
    // 保持上一帧（空格盒），全程不得出现字母格半块行——字母格只允许冷启动
    // 兜底。（无色通知的 default 反应 'idle-look' 经 deepyAnimationFor 会回落
    // 成 'idle'——动画键不是语义键，既有 round-trip 怪癖，故用 success 档。）
    const letterFlash: number[] = []
    const letterPoll = setInterval(() => { if (artRows(k!.lines()).length > 0) letterFlash.push(Date.now()) }, 10)
    ;(fakeChannel.notifications as Array<{ text: string; color?: string }>).push({ text: '持帧探针', color: 'success' })
    bumpChannel()
    await settled(() => whaleGirlDecodedAnimationKeys().includes('thumbs-up'), { timeoutMs: 8000 })
    await sleep(500) // 固定窗:探针 覆盖「解码完成→时钟重渲染」的尾巴，断言全程无字母格闪变
    clearInterval(letterPoll)
    check('hold: switching to an undecoded key keeps the last frame (no letter-grid flash)',
      letterFlash.length === 0, 'flashes=' + letterFlash.length)
    check('hold: the new animation really took over (thumbs-up decoded after the switch)',
      whaleGirlDecodedAnimationKeys().includes('thumbs-up'),
      'decoded=' + whaleGirlDecodedAnimationKeys().join(','))
  } finally {
    WhaleGirlSkin.render = originalRender
    if (k !== undefined) {
      await k.app.unmount()
      k.term.dispose()
    }
  }

  // --- 冷启动：全新会话未解码 → 字母格兜底仍工作（一次性契约）---------------
  resetWhaleGirlImageCacheForTests()
  let m: Scene | undefined
  try {
    m = await scene(140, 30, withKitty)
    m.controller?.openPanel('companion', { focus: true })
    // 首帧必须在解码完成前以字母格起画（冷启动兜底还在）；解码完成后
    // raster 取而代之。首画窗口不可事后锚定，10ms 抢窗采样。
    const sawLetterBootstrap = await settled(() => artRows(m!.lines()).length > 0, { timeoutMs: 4000, stepMs: 10 })
    check('cold: fresh session bootstraps on the letter grid (one-time fallback intact)',
      sawLetterBootstrap, 'firstPaint=' + (sawLetterBootstrap ? 'letters' : 'missed'))
    await settled(() => artRows(m!.lines()).length === 0, { timeoutMs: 8000 })
    check('cold: raster takes over once the first animation decodes',
      artRows(m.lines()).length === 0 && nowPlaying(m.lines()) === '鲸娘',
      'artRows=' + artRows(m.lines()).length + ' now=' + nowPlaying(m.lines()))
  } finally {
    if (m !== undefined) {
      await m.app.unmount()
      m.term.dispose()
    }
  }
  resetWhaleGirlImageCacheForTests()

  // --- 无协议 context：字母格回退，且永不解码 raster 帧 ---------------------
  let u: Scene | undefined
  try {
    u = await scene(140, 30, withNoProtocol)
    u.controller?.openPanel('companion', { focus: true })
    await settled(() => artRows(u!.lines()).length > 0 && nowPlaying(u!.lines()) === '鲸娘', { timeoutMs: 8000 })
    check('image: protocol-less context falls back to the letter grid',
      artRows(u.lines()).length > 0, 'artRows=' + artRows(u.lines()).length)
    await sleep(400) // 固定窗:探针 断言无协议路径不触发任何 raster 解码
    check('image: protocol-less context never decodes raster frames',
      whaleGirlDecodedAnimationKeys().length === 0,
      'decoded=' + whaleGirlDecodedAnimationKeys().join(','))
  } finally {
    if (u !== undefined) {
      await u.app.unmount()
      u.term.dispose()
    }
  }
} catch (error) {
  check('image fixture: no unexpected exception', false, (error as { stack?: string })?.stack ?? String(error))
} finally {
  applyCompanionSkin('deepy')
  resetWhaleGirlImageCacheForTests()
}

// ===================== R5-1 · 真 LRU + 驱逐恢复（压力回归）==================
// 报告 r5-rendering.md R5-1 的独立回归形状：预置多键超过 32MiB，两个 raster
// 消费实例交错——A 始终同键播放（每个已提交 commit 把键升到最近使用位），
// B 的解码/注入提供挤出压力；断言 A 的帧持续可用或按需恢复（帧索引继续
// 推进的前提）、热键获得真实最近使用保护、卸载（隐藏）实例不保活、并发
// 消费者在途解码去重。旧实现（FIFO + effect 只依赖 [key, kit]）在本段红：
// 持续命中的键不升温被挤出、挤出后 effect 不重跑永久持帧冻结。

/** 最小 ink 挂载（无 SidePanel）：children 工厂拿 bump（驱动本树重渲染，
 *  模拟动画时钟 tick 的 commit）。 */
interface BareScene {
  app: { unmount: () => Promise<unknown> }
  term: import('@xterm/headless').Terminal
  bump: () => void
  lines: () => string[]
}
/** mountBare 的 children 工厂签名：bump 驱动重渲染，tick 是已提交的
 *  重渲染计数（R5-2/3 用它驱动 now 之类的 props）。 */
const BARE_COLS = 60
const BARE_ROWS = 24
async function mountBare(children: (bump: () => void, tick: number) => React.ReactNode): Promise<BareScene> {
  const term = new XTerm({ cols: BARE_COLS, rows: BARE_ROWS, scrollback: 0, allowProposedApi: true })
  class BareStdout extends Writable {
    columns = BARE_COLS
    rows = BARE_ROWS
    isTTY = true
    term: import('@xterm/headless').Terminal
    constructor(t: import('@xterm/headless').Terminal) { super(); this.term = t }
    _write(chunk: unknown, _e: Buffer.Encoding, cb: () => void) { this.term.write(String(chunk), cb) }
  }
  class BareStderr extends Writable { isTTY = true; _write(_c: unknown, _e: Buffer.Encoding, cb: () => void) { cb() } }
  const stdout = new BareStdout(term)
  let bumpImpl: () => void = () => {}
  function Harness(): React.ReactNode {
    const [tick, setTick] = React.useState(0)
    React.useEffect(() => { bumpImpl = () => setTick(previous => previous + 1) })
    return children(() => { bumpImpl() }, tick)
  }
  const app = await render(
    <AlternateScreen mouseTracking={false}><Harness /></AlternateScreen>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stderr: new BareStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const lines = (): string[] => {
    const buf = term.buffer.active
    const out: string[] = []
    for (let y = 0; y < BARE_ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(BARE_COLS, ' '))
    return out
  }
  return { app, term, get bump() { return () => bumpImpl() }, lines }
}

/** R5-1 的消费实例：只挂帧缓存 hook，把每次 render 观察到的帧记录出去。 */
function FramesConsumer({ activeKey, onObserve }: {
  activeKey: string | undefined
  onObserve: (frames: readonly import('../src/ink/terminal-image.js').TerminalImageSource[] | undefined) => void
}): React.ReactNode {
  const kit = loadWhaleGirlImageKit()
  const frames = useDecodedWhaleGirlFrames(activeKey, kit)
  onObserve(frames)
  return null
}

/** 假帧（R5-1 压力注入）：byteLength 决定 32MiB 账本，不解码真实 PNG。 */
function fakeFrames(mib: number): never {
  return [{ data: new Uint8Array(mib * 1024 * 1024), width: 301, height: 288 }] as never
}

try {
  applyCompanionSkin('whaleGirl')
  // --- 单元：插入/驱逐发布 revision；32MiB 逐最旧 ------------------------
  {
    resetWhaleGirlImageCacheForTests()
    let revisions = 0
    const off = subscribeDecodedImageCache(() => { revisions += 1 })
    injectDecodedAnimationForTests('a', fakeFrames(8))
    injectDecodedAnimationForTests('b', fakeFrames(8))
    check('r5-1: cache insertions publish revisions (eviction becomes effect input)',
      revisions === 2, 'revisions=' + revisions)
    injectDecodedAnimationForTests('c', fakeFrames(8))
    injectDecodedAnimationForTests('d', fakeFrames(8))
    injectDecodedAnimationForTests('e', fakeFrames(8))
    check('r5-1: 32MiB cap evicts strictly oldest-first (Map iteration order = recency)',
      decodedImageAnimationOrderForTests().join(',') === 'b,c,d,e',
      'order=' + decodedImageAnimationOrderForTests().join(','))
    off()
    resetWhaleGirlImageCacheForTests()
  }

  // --- 压力双实例 A：同键持续播放（每 commit 升温）挤出压力下不失帧 ------
  let s1: BareScene | undefined
  try {
    resetWhaleGirlImageCacheForTests()
    injectDecodedAnimationForTests('idle', fakeFrames(8))
    const obsA: Array<readonly import('../src/ink/terminal-image.js').TerminalImageSource[] | undefined> = []
    let revDuringPlayback = 0
    const offA = subscribeDecodedImageCache(() => { revDuringPlayback += 1 })
    s1 = await mountBare(() => <FramesConsumer activeKey="idle" onObserve={frames => { obsA.push(frames) }} />)
    await settled(() => obsA.some(frames => frames !== undefined), { timeoutMs: 5000 })
    check('r5-1: consumer hits the shared cache synchronously (injected frames)', obsA.some(frames => frames !== undefined))
    // 持续播放 3 个 tick：每个已提交 commit 把 idle 升到最近使用位。
    for (let tick = 0; tick < 3; tick += 1) { s1.bump(); await sleep(40) } // 固定窗:commit 窗——touch 后无 revision
    check('r5-1: commit-path LRU touch publishes no revision (no self-stimulated renders)',
      revDuringPlayback === 0, 'revisions=' + revDuringPlayback)
    // 注入 4×8MiB 压力：注入间隙保持播放 commit（每次 bump 把 idle 升回
    // 最近使用位）——「A 始终同键播放」的字面构造。旧 FIFO 语义下 idle
    // （最早插入）无论怎么 bump 都是第一个被挤出。
    for (const warm of ['warm-1', 'warm-2', 'warm-3', 'warm-4']) {
      injectDecodedAnimationForTests(warm, fakeFrames(8))
      s1.bump()
      await sleep(40) // 固定窗:commit 窗——压力注入间隙的播放 commit
    }
    await sleep(300) // 固定窗:revision 通知 → 消费者重渲染（仍应命中）
    check('r5-1: actively played key survives eviction pressure (true recency protection)',
      decodedImageAnimationOrderForTests().includes('idle'),
      'order=' + decodedImageAnimationOrderForTests().join(','))
    check('r5-1: consumer never loses frames under pressure (frame index keeps advancing)',
      obsA.length > 0 && obsA.every(frames => frames !== undefined),
      'observations=' + obsA.length + ' lost=' + obsA.filter(frames => frames === undefined).length)
    check('r5-1: resident key never triggers a redundant decode',
      whaleGirlDecodeRequestCountForTests() === 0, 'requests=' + whaleGirlDecodeRequestCountForTests())
    offA()
    // 卸载 = 隐藏实例不再消费：再注入压力后 idle 不被保活（可被逐出）。
    await s1.app.unmount()
    s1.term.dispose()
    s1 = undefined
    for (const warm of ['warm-5', 'warm-6', 'warm-7', 'warm-8']) injectDecodedAnimationForTests(warm, fakeFrames(8))
    await sleep(150) // 固定窗:卸载后保活失效观察窗
    check('r5-1: unmounted (hidden) consumer no longer keeps its key alive',
      !decodedImageAnimationOrderForTests().includes('idle'),
      'order=' + decodedImageAnimationOrderForTests().join(','))
  } finally {
    if (s1 !== undefined) { await s1.app.unmount(); s1.term.dispose() }
  }

  // --- 压力双实例 B：key 未变但缓存失去 → 按需恢复解码（不永久冻结）----
  let s2: BareScene | undefined
  try {
    resetWhaleGirlImageCacheForTests()
    injectDecodedAnimationForTests('idle', fakeFrames(8))
    const obsB: Array<readonly import('../src/ink/terminal-image.js').TerminalImageSource[] | undefined> = []
    s2 = await mountBare(() => <FramesConsumer activeKey="idle" onObserve={frames => { obsB.push(frames) }} />)
    await settled(() => obsB.some(frames => frames !== undefined), { timeoutMs: 5000 })
    // 不再 bump（无 commit → 不 touch）：idle 保持最旧，注入即被挤出。
    const requestsBefore = whaleGirlDecodeRequestCountForTests()
    for (const warm of ['warm-1', 'warm-2', 'warm-3', 'warm-4']) injectDecodedAnimationForTests(warm, fakeFrames(8))
    await settled(() => obsB.some(frames => frames === undefined), { timeoutMs: 4000 })
    check('r5-1: key-unchanged consumer observes the eviction (cache lost under its feet)',
      obsB.some(frames => frames === undefined))
    // 旧实现：effect 依赖 [key, kit] 未变 → 永不重跑 → 永久持帧冻结。
    await settled(() => obsB[obsB.length - 1] !== undefined, { timeoutMs: 15000 })
    check('r5-1: evicted active key re-decodes on demand (animation recovers, not frozen)',
      obsB[obsB.length - 1] !== undefined, 'lastObservation=' + (obsB[obsB.length - 1] === undefined ? 'lost' : 'frames'))
    check('r5-1: recovery decode is bounded and deduped (exactly one request)',
      whaleGirlDecodeRequestCountForTests() - requestsBefore === 1,
      'requests=' + (whaleGirlDecodeRequestCountForTests() - requestsBefore))
  } finally {
    if (s2 !== undefined) { await s2.app.unmount(); s2.term.dispose() }
  }

  // --- 并发消费者：同键在途解码去重 ---------------------------------------
  let s3: BareScene | undefined
  try {
    resetWhaleGirlImageCacheForTests()
    const obsC1: Array<readonly import('../src/ink/terminal-image.js').TerminalImageSource[] | undefined> = []
    const obsC2: Array<readonly import('../src/ink/terminal-image.js').TerminalImageSource[] | undefined> = []
    const before = whaleGirlDecodeRequestCountForTests() // mount 首commit 的 effect 即发起解码，必须先采样
    s3 = await mountBare(() => (
      <>
        <FramesConsumer activeKey="thumbs-up" onObserve={frames => { obsC1.push(frames) }} />
        <FramesConsumer activeKey="thumbs-up" onObserve={frames => { obsC2.push(frames) }} />
      </>
    ))
    await settled(() => obsC1.some(frames => frames !== undefined) && obsC2.some(frames => frames !== undefined), { timeoutMs: 15000 })
    check('r5-1: both concurrent consumers resolve frames (decode completed)',
      obsC1.some(frames => frames !== undefined) && obsC2.some(frames => frames !== undefined))
    check('r5-1: concurrent consumers share one inflight decode (no duplicate work)',
      whaleGirlDecodeRequestCountForTests() - before === 1,
      'requests=' + (whaleGirlDecodeRequestCountForTests() - before))
    const last1 = [...obsC1].reverse().find(frames => frames !== undefined)
    const last2 = [...obsC2].reverse().find(frames => frames !== undefined)
    check('r5-1: concurrent consumers observe the identical frames reference', last1 === last2)
  } finally {
    if (s3 !== undefined) { await s3.app.unmount(); s3.term.dispose() }
  }
  resetWhaleGirlImageCacheForTests()
} catch (error) {
  check('r5-1 fixture: no unexpected exception', false, (error as { stack?: string })?.stack ?? String(error))
} finally {
  applyCompanionSkin('deepy')
  resetWhaleGirlImageCacheForTests()
}

// ===================== R5-2 · 失败键健康链兜底（回归）=======================
// 报告 r5-rendering.md R5-2 的独立回归形状：模拟单键解码失败（不动真实
// 资产），覆盖 working/typing、heart/poke/smile-hearts、idle 失败与全部
// 失败；断言解析出的键一定满足 hasKey、健康兜底接管、坏键不逐 tick
// 重解、所有候选失败时有界收敛（持帧/字母格降级，不闪不循环）。旧实现
// 的 heart/mood 返回路径绕过守卫：失败的 typing/smile-hearts 会被再次
// 选中，画面钉死在持帧上（报告实测两例在本段单元级复现）。

/** 最小 pose 夹具（CompanionPose 运行时契约形状）。 */
function fakePose(mood: import('../src/components/sidePanel/companion/mood.js').CompanionMood, heart = 0): never {
  return { mood, heart, tick: 0, gestures: new Set(), blink: false, sleepZ: 0, facing: 'left' } as never
}

/** 完整皮肤的裸挂载组件（R5-2 渲染级）：走 WhaleGirlSkin.render → 协议
 *  裁决 → raster 全链，需要假 kitty context。 */
function SkinHost({ pose, semantic, now }: {
  pose: import('../src/components/sidePanel/companion/pose.js').CompanionPose
  semantic: string | undefined
  now: number
}): React.ReactNode {
  return <>{WhaleGirlSkin.render({ pose, moodSince: 0, now, width: 31, animationSemantic: semantic })}</>
}

try {
  const resolve = skins.resolveWhaleGirlAnimationKey
  const allKeys = [...EXPECTED_KEYS]
  const healthy = (failed: readonly string[]) => (key: string) => allKeys.includes(key) && !failed.includes(key)
  // 报告 R5-2 两个机制例（旧实现分别返回 typing / smile-hearts）。
  check('r5-2: failed semantic typing with working mood degrades to healthy idle (was: typing)',
    resolve(fakePose('working'), 'typing', healthy(['typing'])) === 'idle')
  check('r5-2: failed poke-left + smile-hearts with heart pass degrades to mood layer idle (was: smile-hearts)',
    resolve(fakePose('idle', 1), 'poke-left', healthy(['poke-left', 'smile-hearts'])) === 'idle')
  // 健康优先级与原契约一致。
  check('r5-2: healthy chain keeps original priorities (semantic > heart > mood)',
    resolve(fakePose('idle'), 'tickle', healthy([])) === 'tickle'
    && resolve(fakePose('idle', 1), undefined, healthy([])) === 'smile-hearts'
    && resolve(fakePose('celebrate'), undefined, healthy([])) === 'thumbs-up'
    && resolve(fakePose('working'), undefined, healthy([])) === 'typing')
  // 心情键失败 → 健康 idle；idle 也失败 → undefined（有界链终点）。
  check('r5-2: failed mood key falls to healthy idle',
    resolve(fakePose('error'), undefined, healthy(['error'])) === 'idle')
  check('r5-2: every candidate unhealthy resolves to undefined (bounded chain end)',
    resolve(fakePose('idle', 1), 'smile-hearts', healthy(['idle', 'smile-hearts'])) === undefined
    && resolve(fakePose('working'), 'typing', healthy(['typing', 'idle'])) === undefined)
  // 裁决结果永远满足健康判据（穷举 mood×heart×失败形状样本）。
  {
    let alwaysHealthy = true
    let offender = ''
    const moods = ['sleeping', 'idle', 'waiting', 'thinking', 'working', 'responding', 'attention', 'celebrate', 'error'] as const
    const failureShapes: readonly string[][] = [[], ['typing'], ['smile-hearts', 'poke-left'], ['idle'], ['idle', 'typing', 'smile-hearts']]
    for (const mood of moods) {
      for (const heart of [0, 1]) {
        for (const semantic of [undefined, 'typing', 'poke-left', 'smile-hearts', 'tickle']) {
          for (const failed of failureShapes) {
            const resolved = resolve(fakePose(mood, heart), semantic, healthy(failed))
            if (resolved !== undefined && !healthy(failed)(resolved)) {
              alwaysHealthy = false
              offender = mood + '/h' + heart + '/' + semantic + '/failed=[' + failed.join(',') + '] → ' + resolved
            }
          }
        }
      }
    }
    check('r5-2: resolved key always satisfies the health guard (exhaustive samples)', alwaysHealthy, offender)
  }
} catch (error) {
  check('r5-2 unit fixture: no unexpected exception', false, (error as { stack?: string })?.stack ?? String(error))
}

try {
  applyCompanionSkin('whaleGirl')

  // --- 渲染级 1：semantic typing 失败 → 健康 idle 接管，坏键零解码 -------
  let f1: BareScene | undefined
  try {
    resetWhaleGirlImageCacheForTests()
    injectFailedAnimationForTests('typing')
    f1 = await mountBare((_bump, tick) => withKitty(<SkinHost pose={fakePose('working')} semantic="typing" now={2000 + tick * 120} />))
    await settled(() => whaleGirlDecodedAnimationKeys().includes('idle'), { timeoutMs: 10000 })
    check('r5-2: failed semantic key degrades to a healthy animation (idle decoded and played)',
      whaleGirlDecodedAnimationKeys().includes('idle'),
      'decoded=' + whaleGirlDecodedAnimationKeys().join(','))
    check('r5-2: the failed key never gets decoded (excluded by the health guard)',
      !decodedImageAnimationOrderForTests().includes('typing'),
      'order=' + decodedImageAnimationOrderForTests().join(','))
    // bump 推进时钟会合法触发预热（poke 左右/smile-hearts 未失败时预解）
    // ——断言收敛为「坏键不进缓存，新增解码只来自预热键」。
    for (let tick = 0; tick < 5; tick += 1) { f1.bump(); await sleep(30) } // 固定窗:tick commit 窗——预热合法、坏键不得入缓存
    const orderAfterTicks = decodedImageAnimationOrderForTests()
    check('r5-2: a failed key is not retried per tick (never cached; churn limited to preheat keys)',
      !orderAfterTicks.includes('typing') && orderAfterTicks.every(key => WHALE_GIRL_PREHEAT_KEYS.includes(key)),
      'order=' + orderAfterTicks.join(','))
  } finally {
    if (f1 !== undefined) { await f1.app.unmount(); f1.term.dispose() }
  }

  // --- 渲染级 2：heart 链（poke-left + smile-hearts）失败 → mood 层 idle --
  let f2: BareScene | undefined
  try {
    resetWhaleGirlImageCacheForTests()
    injectFailedAnimationForTests('poke-left')
    injectFailedAnimationForTests('smile-hearts')
    f2 = await mountBare((_bump, tick) => withKitty(<SkinHost pose={fakePose('idle', 1)} semantic="poke-left" now={2000 + tick * 120} />))
    await settled(() => whaleGirlDecodedAnimationKeys().includes('idle'), { timeoutMs: 10000 })
    check('r5-2: failed heart-pass chain falls to the healthy mood layer (idle, not smile-hearts)',
      decodedImageAnimationOrderForTests().includes('idle') && !decodedImageAnimationOrderForTests().includes('smile-hearts'),
      'order=' + decodedImageAnimationOrderForTests().join(','))
  } finally {
    if (f2 !== undefined) { await f2.app.unmount(); f2.term.dispose() }
  }

  // --- 渲染级 3：全部候选失败 → 明确不可用态（冷启动字母格 / 持帧）-------
  let f3: BareScene | undefined
  try {
    resetWhaleGirlImageCacheForTests()
    for (const key of EXPECTED_KEYS) injectFailedAnimationForTests(key)
    f3 = await mountBare((_bump, tick) => withKitty(<SkinHost pose={fakePose('idle')} semantic="poke-left" now={2000 + tick * 120} />))
    await sleep(600) // 固定窗:探针 全失败态的观察窗（不得解码、不得崩、不得循环）
    check('r5-2: all-candidates-failed resolves to the unavailable state with zero decodes',
      whaleGirlDecodeRequestCountForTests() === 0,
      'requests=' + whaleGirlDecodeRequestCountForTests())
    check('r5-2: all-failed cold start stays on the letter grid (bounded convergence, no crash)',
      artRows(f3.lines()).length > 0, 'artRows=' + artRows(f3.lines()).length)
    for (let tick = 0; tick < 4; tick += 1) { f3.bump(); await sleep(30) } // 固定窗:tick commit 窗——全失败态有界收敛
    check('r5-2: ticking an all-failed skin stays bounded (letter grid, zero decode churn)',
      whaleGirlDecodeRequestCountForTests() === 0 && artRows(f3.lines()).length > 0)
  } finally {
    if (f3 !== undefined) { await f3.app.unmount(); f3.term.dispose() }
  }

  // --- 渲染级 4：上过屏后全失败 → 持帧（不闪回字母格，契约保全）----------
  let f4: BareScene | undefined
  try {
    resetWhaleGirlImageCacheForTests()
    f4 = await mountBare((bump, tick) => withKitty(<SkinHost pose={fakePose('idle')} semantic={tick >= 2 ? 'poke-left' : undefined} now={2000 + tick * 120} />))
    await settled(() => whaleGirlDecodedAnimationKeys().includes('idle') && artRows(f4.lines()).length === 0, { timeoutMs: 10000 })
    check('r5-2: healthy skin reaches the raster path first (image on screen)',
      artRows(f4.lines()).length === 0)
    for (const key of EXPECTED_KEYS) injectFailedAnimationForTests(key)
    f4.bump() // semantic → poke-left：全链不健康 → activeKey=undefined → 持帧
    await sleep(400) // 固定窗:探针 持帧窗口（无字母格闪变）
    check('r5-2: after all candidates fail post-image, the panel holds the frame (no letter flash)',
      artRows(f4.lines()).length === 0, 'artRows=' + artRows(f4.lines()).length)
  } finally {
    if (f4 !== undefined) { await f4.app.unmount(); f4.term.dispose() }
  }
  resetWhaleGirlImageCacheForTests()
} catch (error) {
  check('r5-2 fixture: no unexpected exception', false, (error as { stack?: string })?.stack ?? String(error))
} finally {
  applyCompanionSkin('deepy')
  resetWhaleGirlImageCacheForTests()
}

// ===================== R5-3 · 持帧/预热记账以提交为准 ======================
// 报告 r5-rendering.md R5-3 的独立回归形状：真 ConcurrentRoot（ink 的
// react-reconciler ConcurrentRoot）+ Suspense 受控挂起——A 已提交，B 渲染
// 后挂起并被同步 C 更新放弃，C 缺帧；断言持住 A（不是从未提交的 B）、未
// 提交渲染不改变冷启动/预热许可。旧实现 render 期写 ref：丢弃渲染把 B
// 记成「上一帧」并提前解锁预热（本段红）。

const NEVER_PROMISE = new Promise<void>(() => {})
function SuspendForever(): never {
  throw NEVER_PROMISE
}

/** 生产持帧 hook 的探针：记录每次 render 的 [visible, ever]。 */
function HoldProbe({ candidate, onRender }: {
  candidate: React.ReactNode
  onRender: (visible: React.ReactNode, ever: boolean) => void
}): React.ReactNode {
  const [visible, ever] = useHeldCommittedImage(candidate)
  onRender(visible, ever)
  return null
}

try {
  applyCompanionSkin('whaleGirl')

  // --- 1. 丢弃渲染不污染持帧：A 提交 → B 挂起放弃 → C 缺帧持 A ----------
  let h1: BareScene | undefined
  try {
    resetWhaleGirlImageCacheForTests()
    const aElement = <Text>a</Text>
    const bElement = <Text>b</Text>
    const records: Array<{ phase: string; visible: React.ReactNode; ever: boolean }> = []
    let phase: 'A' | 'B' | 'C' = 'A'
    h1 = await mountBare(() => {
      const candidate = phase === 'A' ? aElement : phase === 'B' ? bElement : undefined
      return (
        <Suspense fallback={<Text>fallback</Text>}>
          <HoldProbe candidate={candidate} onRender={(visible, ever) => { records.push({ phase, visible, ever }) }} />
          {phase === 'B' && <SuspendForever />}
        </Suspense>
      )
    })
    await sleep(150) // 固定窗:探针 A 的 commit 窗
    const aCommits = records.filter(r => r.phase === 'A')
    check('r5-3: committed candidate A renders as itself (cold)', aCommits.length > 0 && aCommits.every(r => r.visible === aElement))
    phase = 'B'
    h1.bump() // B render 执行（丢弃候选写入观察记录）→ SuspendForever 挂起 → 放弃
    await sleep(250) // 固定窗:探针 挂起窗口：B 永不 resolve，primary 不提交
    const bRenders = records.filter(r => r.phase === 'B')
    check('r5-3: discarded render B executes its candidate (observed) but never commits',
      bRenders.length > 0 && bRenders.every(r => r.visible === bElement),
      'bRenders=' + bRenders.length)
    phase = 'C'
    h1.bump() // 同步默认优先级更新插队：C（缺帧）提交
    await settled(() => records.some(r => r.phase === 'C'), { timeoutMs: 4000 })
    h1.bump() // 持帧窗口内继续 tick（candidate 仍缺）：观察引用稳定性
    h1.bump()
    await sleep(150) // 固定窗:探针 持帧 tick 窗
    const cRecords = records.filter(r => r.phase === 'C')
    const lastC = cRecords[cRecords.length - 1]
    check('r5-3: missing-frame render holds the last COMMITTED candidate (A), not the discarded one (B)',
      lastC !== undefined && lastC.visible === aElement && lastC.ever === true,
      'visible===' + (lastC?.visible === aElement ? 'A' : lastC?.visible === bElement ? 'B' : String(lastC?.visible)))
    check('r5-3: hold keeps a stable element reference across ticks (no subtree repaint churn)',
      cRecords.length > 1 && cRecords.every(r => r.visible === aElement),
      'cRenders=' + cRecords.length)
  } finally {
    if (h1 !== undefined) { await h1.app.unmount(); h1.term.dispose() }
  }

  // --- 2. 丢弃渲染的 now 不解锁预热；提交的时钟走动才解锁 -----------------
  let h2: BareScene | undefined
  try {
    resetWhaleGirlImageCacheForTests()
    let phase: 'A' | 'B' | 'C' | 'D' = 'A'
    h2 = await mountBare(() => {
      const now = phase === 'B' ? 5000 : phase === 'D' ? 1300 : 1000
      return withKitty(
        <Suspense fallback={<Text>fallback</Text>}>
          <SkinHost pose={fakePose('idle')} semantic={undefined} now={now} />
          {phase === 'B' && <SuspendForever />}
        </Suspense>,
      )
    })
    await settled(() => whaleGirlDecodedAnimationKeys().includes('idle'), { timeoutMs: 10000 })
    await sleep(400) // 固定窗:探针 A 态观察窗：now 恒 1000，预热必须不发生
    check('r5-3: committed static clock never preheats (frozen contract intact)',
      whaleGirlDecodedAnimationKeys().every(key => key === 'idle'),
      'decoded=' + whaleGirlDecodedAnimationKeys().join(','))
    phase = 'B'
    h2.bump() // B：now=5000 渲染后挂起放弃（旧实现：render 期写 ref 提前解锁预热）
    await sleep(400) // 固定窗:探针 挂起窗口观察
    phase = 'C'
    h2.bump() // C：now 回到 1000（与上一提交值相同）→ 不得预热
    await sleep(500) // 固定窗:探针 C 态观察窗（旧实现被丢弃渲染污染后在此预热 → 红）
    check("r5-3: a discarded render's clock advance does not unlock preheat",
      whaleGirlDecodedAnimationKeys().every(key => key === 'idle'),
      'decoded=' + whaleGirlDecodedAnimationKeys().join(','))
    phase = 'D'
    h2.bump() // D：now=1300 已提交地走动 → 预热解锁
    await settled(() => WHALE_GIRL_PREHEAT_KEYS.every(key => whaleGirlDecodedAnimationKeys().includes(key)), { timeoutMs: 10000 })
    check('r5-3: a committed clock advance still unlocks preheat (feature intact)',
      WHALE_GIRL_PREHEAT_KEYS.every(key => whaleGirlDecodedAnimationKeys().includes(key)),
      'decoded=' + whaleGirlDecodedAnimationKeys().join(','))
  } finally {
    if (h2 !== undefined) { await h2.app.unmount(); h2.term.dispose() }
  }

  // --- 3. #185 高频 commit 轰炸：持帧/预热记账在提交风暴下零异常 ----------
  let h3: BareScene | undefined
  try {
    resetWhaleGirlImageCacheForTests()
    const semantics = [undefined, 'typing', 'poke-left', 'smile-hearts', 'tickle', 'idle-look', 'happy', undefined]
    h3 = await mountBare((_bump, tick) => withKitty(
      <SkinHost pose={fakePose(tick % 4 === 0 ? 'working' : 'idle', tick % 3 === 0 ? 1 : 0)} semantic={semantics[tick % semantics.length]} now={1000 + tick * 16} />,
    ))
    let bombed = 0
    const bomber = setInterval(() => { bombed += 1; h3!.bump() }, 16)
    await sleep(2000) // 固定窗:探针 2s 高频提交风暴（16ms 换语义/now，语义轮换触发换键持帧路径）
    clearInterval(bomber)
    check('r5-3: high-frequency commit storm survives (no #185 nested-update explosion)',
      bombed >= 80, 'bumps=' + bombed)
    check('r5-3: commit storm keeps decode churn bounded (lazy keys only)',
      whaleGirlDecodedAnimationKeys().length <= EXPECTED_KEYS.length,
      'decoded=' + whaleGirlDecodedAnimationKeys().length)
  } finally {
    if (h3 !== undefined) { await h3.app.unmount(); h3.term.dispose() }
  }
  resetWhaleGirlImageCacheForTests()
} catch (error) {
  check('r5-3 fixture: no unexpected exception', false, (error as { stack?: string })?.stack ?? String(error))
} finally {
  applyCompanionSkin('deepy')
  resetWhaleGirlImageCacheForTests()
}

// ========================= SPLASH MASCOT LAYER =============================
// Logo 栏吉祥物（SplashMascot → WhaleGirlSkin.render → 同一图像管线）：持帧/
// 预热修在共享层、这里显式验证 logo 栏形态——活跃态点击换键链（poke →
// smile-hearts）全程不闪字母格；active=false 冻结态（定格 idle 帧 0、零时钟）
// 不预热、定格帧稳定（whaleFrozen 契约）。SplashMascot 无悬停路径（点击/
// 三连点两种互动，无 onMouseEnter），悬停驻留不涉及。
{
  const { SplashMascot } = await import('../src/components/sidePanel/companion/SplashMascot.js')
  const MASCOT_COLS = 80
  const MASCOT_ROWS = 24
  async function mascotScene(active: boolean): Promise<{
    app: { unmount: () => Promise<unknown> }
    term: import('@xterm/headless').Terminal
    stdin: FakeStdin
    lines: () => string[]
  }> {
    const term = new XTerm({ cols: MASCOT_COLS, rows: MASCOT_ROWS, scrollback: 0, allowProposedApi: true })
    class MascotStdout extends Writable {
      columns = MASCOT_COLS
      rows = MASCOT_ROWS
      isTTY = true
      term: import('@xterm/headless').Terminal
      constructor(t: import('@xterm/headless').Terminal) { super(); this.term = t }
      _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
    }
    class MascotStderr extends Writable { isTTY = true; _write(_c: unknown, _e: Buffer.Encoding, cb: () => void) { cb() } }
    const stdin = new FakeStdin()
    const stdout = new MascotStdout(term)
    function Harness(): React.ReactNode {
      // App 无 useInput 消费者时 stdin 监听不挂（既有坑）——照主场景挂一层。
      useInput(() => {})
      return withKitty(
        <ThemeProvider theme="dark">
          <Box flexDirection="column" alignItems="center" paddingTop={2}>
            <SplashMascot skin="whaleGirl" active={active} />
          </Box>
        </ThemeProvider>,
      )
    }
    const app = await render(
      <AlternateScreen mouseTracking={true}><Harness /></AlternateScreen>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: new MascotStderr() as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    )
    const lines = (): string[] => {
      const buf = term.buffer.active
      const out: string[] = []
      for (let y = 0; y < MASCOT_ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(MASCOT_COLS, ' '))
      return out
    }
    return { app, term, stdin, lines }
  }

  // --- 活跃态：点击换键链（poke → smile-hearts → idle）不闪字母格 -----------
  resetWhaleGirlImageCacheForTests()
  const mascotSemantics: string[] = []
  const originalMascotRender = WhaleGirlSkin.render
  WhaleGirlSkin.render = function recordedMascot(input: Parameters<typeof originalMascotRender>[0]) {
    if (input.animationSemantic !== undefined) mascotSemantics.push(input.animationSemantic)
    return originalMascotRender(input)
  }
  let p: Awaited<ReturnType<typeof mascotScene>> | undefined
  try {
    p = await mascotScene(true)
    // 定位用几何而非首画采样：warm 进程里 idle 解码可能快于首个 30ms 轮询
    // （冷启动字母格兜底契约已由面板 cold 场景钉住）。80 列终端、31 宽吉祥
    // 物盒居中 → 左缘 ~24、行 2..16（paddingTop 2 + 15 行）。
    const mascotCell = { col: 38, row: 9 }
    // raster 就位 + 预热完成后，点击换键链期间采样字母格闪变。
    await settled(() => artRows(p!.lines()).length === 0
      && WHALE_GIRL_PREHEAT_KEYS.every(key => whaleGirlDecodedAnimationKeys().includes(key)), { timeoutMs: 10000 })
    check('splash: active mascot reaches the raster path (image box up, preheat warm)',
      artRows(p.lines()).length === 0, 'artRows=' + artRows(p.lines()).length)
    const splashFlashes: number[] = []
    const splashPoll = setInterval(() => { if (artRows(p!.lines()).length > 0) splashFlashes.push(Date.now()) }, 10)
    clickAt(p, mascotCell.col, mascotCell.row)
    await settled(() => mascotSemantics.includes('smile-hearts'), { timeoutMs: 6000 })
    await sleep(600) // 固定窗:探针 覆盖 poke→smile-hearts→idle 的换键窗口尾巴
    clearInterval(splashPoll)
    check('splash: poke -> smile-hearts key chain reaches the mascot',
      (mascotSemantics.includes('poke-left') || mascotSemantics.includes('poke-right')) && mascotSemantics.includes('smile-hearts'),
      'seen=' + [...new Set(mascotSemantics)].join(','))
    check('splash: mascot key switches never flash the letter grid (shared hold + preheat)',
      splashFlashes.length === 0, 'flashes=' + splashFlashes.length)
  } finally {
    WhaleGirlSkin.render = originalMascotRender
    if (p !== undefined) {
      await p.app.unmount()
      p.term.dispose()
    }
  }

  // --- 冻结态（active=false）：不预热、定格帧稳定 ----------------------------
  resetWhaleGirlImageCacheForTests()
  let z: Awaited<ReturnType<typeof mascotScene>> | undefined
  try {
    z = await mascotScene(false)
    // 冻结态照常解码活跃键（idle——定格帧 0 要画），但时钟从未走动，
    // 绝不预热互动键；画面定格后字节级稳定（零时钟契约）。
    await settled(() => whaleGirlDecodedAnimationKeys().includes('idle') && artRows(z!.lines()).length === 0, { timeoutMs: 8000 })
    await sleep(900) // 固定窗:探针 冻结态观察窗：时钟若误走/预热若误触都会在此窗内显形
    const decodedFrozen = [...whaleGirlDecodedAnimationKeys()]
    check('splash: frozen mascot (active=false) never preheats interaction keys',
      decodedFrozen.every(key => key === 'idle'), 'decoded=' + decodedFrozen.join(','))
    const frozenFrame1 = z.lines().join('|')
    await sleep(600) // 固定窗:探针 定格帧稳定性观察窗
    const frozenFrame2 = z.lines().join('|')
    check('splash: frozen mascot frame stays byte-stable (zero clock)', frozenFrame1 === frozenFrame2)
  } finally {
    if (z !== undefined) {
      await z.app.unmount()
      z.term.dispose()
    }
  }
  resetWhaleGirlImageCacheForTests()
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: whale girl skin all checks passed.')
process.exit(0)

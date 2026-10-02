/**
 * 启动页吉祥物回归（LogoV2 × companion.skin，2026-10 复用轮）。
 *
 * - 皮肤跟随：deepy/whaleGirl → 吉祥物进艺术槽（字母格路径，无协议即回退）；
 *   whale → 原分层鲸路径（钉住皮肤断言鲸美术仍在）；
 * - 稳态契约（用户拍板）：启动页**不做空闲轮换**——语义恒 'idle'；
 * - 点击：左/右半 poke（鲸娘 poke 后接 smile-hearts 爱心档）；900ms 内
 *   ≥3 连点 → tickle；播完自然回稳态 idle；
 * - 欢迎语：tagline/求星标语保持原「艺术下方居中」渲染路径（2026-10
 *   用户拍板撤气泡；内容契约在 verify-splash-eggs 锁，这里锁吉祥物形态
 *   下的位置——在美术行之下、无圆角边框）；
 * - 首帧红线：无协议时字母格首帧同步可画；图像协议（假 kitty context）
 *   下首帧字母格、解码完 raster 让位；
 * - 零时钟：working 冻结后定格且点击无效；卸载后输出静默（无残留定时器）。
 *
 * Run: node --import tsx/esm scripts/verify-splash-mascot.tsx
 */
import fakeHome from './lib/fake-home.mjs' // 必须最先：usageStats 的 DATA_DIR 在 import 时定死
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { LogoV2 }, prefs, skins, { TerminalImagesContext }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/LogoV2.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/components/sidePanel/companion/skins.js'),
  import('../src/ink/hooks/use-terminal-images.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, AlternateScreen, Box, Text, useInput } = ui
const { applyCompanionSkin } = prefs
const { DeepySkin, WhaleGirlSkin } = skins
const { settled, sleep } = termTest

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

const ART_RE = /[▀▄█▌▐]{6,}/

class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

interface Scene {
  app: { unmount: () => Promise<unknown> }
  term: import('@xterm/headless').Terminal
  stdin: FakeStdin
  bytesRef: { count: number }
  lines: () => string[]
}

/** LogoV2 直挂场景（学 verify-splash-eggs 的静态上下文 + 我的鼠标管线）。 */
async function scene(
  cols: number,
  rows: number,
  props: Record<string, unknown>,
  wrapRuntime?: (children: React.ReactNode) => React.ReactNode,
): Promise<Scene> {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  const bytesRef = { count: 0 }
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    term: import('@xterm/headless').Terminal
    constructor(t: import('@xterm/headless').Terminal) { super(); this.term = t }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _write(chunk: any, _e: BufferEncoding, cb: () => void) { bytesRef.count += String(chunk).length; this.term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: Buffer.Encoding, cb: () => void) { cb() } }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout(term)
  function Harness(): React.ReactNode {
    // App 只在有 useInput 消费者时挂 stdin readable 监听——没有它注入的
    // SGR 鼠标静默丢失（verify-jobs-transcript-group 的坑）。
    useInput(() => {})
    return <LogoV2 drift={null} tip={{ id: 'probe-tip', zh: '探针提示', en: 'probe tip' } as never} {...(props as never)} />
  }
  const tree = (
    <AlternateScreen mouseTracking={true}>
      <ThemeProvider theme="dark">
        <Box flexDirection="column" height={rows}>
          {wrapRuntime !== undefined ? wrapRuntime(<Harness />) : <Harness />}
        </Box>
      </ThemeProvider>
    </AlternateScreen>
  )
  const app = await render(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const lines = (): string[] => {
    const buf = term.buffer.active
    const out: string[] = []
    for (let y = 0; y < rows; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(cols, ' '))
    return out
  }
  return { app, term, stdin, bytesRef, lines }
}

/** 艺术槽区（左侧 38 列）里有块字形美术的行——吉祥物盒（31 格）在 40 格
 * 艺术列里居中（跨约 4..35），大字 DEEPSEEK/HARNESS 从第 42 列起，必须
 * 排除，否则「raster 让位字母格」永远读不成立。 */
const ART_REGION_COLUMNS = 38
function artRows(lines: string[]): number[] {
  const rowsFound: number[] = []
  for (let y = 0; y < lines.length; y += 1) {
    if (ART_RE.test(lines[y]!.slice(0, ART_REGION_COLUMNS))) rowsFound.push(y)
  }
  return rowsFound
}

/** 皮肤渲染语义记录器：patch 皮肤.render 收集 animationSemantic。 */
function spySemantics(skin: { render: (input: { animationSemantic?: string }) => unknown }): { samples: string[]; restore: () => void } {
  const original = skin.render.bind(skin)
  const samples: string[] = []
  skin.render = function recorded(input: { animationSemantic?: string }) {
    if (input.animationSemantic !== undefined) samples.push(input.animationSemantic)
    return original(input as never) as never
  } as never
  return { samples, restore: () => { skin.render = original as never } }
}

/** 首个美术行的块字形起点列（吉祥物居中在 40 格艺术列内，点击位从这里
 * 推导而不是写死）。 */
function artStartCol(lines: string[], row: number): number {
  const match = /[▀▄█▌░]{1,}/.exec(lines[row]?.slice(0, ART_REGION_COLUMNS) ?? '')
  return match === null ? 6 : (match.index ?? 6)
}

function sgr(button: number, col: number, row: number, release: boolean): string {
  return '\x1b[<' + button + ';' + (col + 1) + ';' + (row + 1) + (release ? 'm' : 'M')
}
function clickAt(s: Scene, col: number, row: number): void {
  s.stdin.write(sgr(0, col, row, false))
  s.stdin.write(sgr(0, col, row, true))
}

const BASE_PROPS = { model: 'splash-mascot-probe', cwd: '/splash/cwd', skipIntro: true, fontId: 'bold', starChance: 0 }

try {
  // ── S1/S2 稳态：deepy 与鲸娘（无协议→字母格）首帧同步可画、语义恒 idle ──
  for (const skinId of ['deepy', 'whaleGirl'] as const) {
    applyCompanionSkin(skinId)
    const spy = spySemantics(skinId === 'deepy' ? DeepySkin : WhaleGirlSkin)
    let s: Scene | undefined
    try {
      s = await scene(120, 34, { ...BASE_PROPS })
      // xterm 解析是异步的，用 settled 等**首帧**上屏——这里锁的是「不等任何
      // 图像解码就有字母格美术」（无协议路径本来就没有异步步骤）。
      const painted = await settled(() => artRows(s!.lines()).length > 0, { timeoutMs: 4000 })
      check(skinId + ': mascot letter art paints without waiting on image decode', painted, 'rows=' + artRows(s.lines()).length)
      await sleep(1100) // 固定窗:墙钟 覆盖一个 IDLE_ROTATE_MS 级窗口，断言语义不轮换
      check(skinId + ': steady-state semantic stays idle (no rotation on splash)',
        spy.samples.length > 0 && spy.samples.every(semantic => semantic === 'idle'),
        'samples=' + [...new Set(spy.samples)].join(','))
      const taglineRow = s.lines().findIndex(line => line.includes('探索未至之境！'))
      check(skinId + ': welcome tagline stays centered BELOW the art (no bubble, original path)',
        taglineRow > 0
          && !(s.lines()[taglineRow] ?? '').includes('│') && !(s.lines()[taglineRow - 1] ?? '').includes('╭')
          && artRows(s.lines()).every(row => row < taglineRow),
        'taglineRow=' + taglineRow)
    } finally {
      spy.restore()
      if (s !== undefined) { await s.app.unmount(); s.term.dispose() }
    }
  }

  // ── S3 whale 皮肤：原分层鲸路径不动 ─────────────────────────────────────
  {
    applyCompanionSkin('whale')
    let s: Scene | undefined
    try {
      s = await scene(120, 34, { ...BASE_PROPS })
      const whalePainted = await settled(() => artRows(s!.lines()).length > 0, { timeoutMs: 4000 })
      check('whale skin keeps the layered pixel-whale art path', whalePainted,
        'rows=' + artRows(s.lines()).length)
      const spy = spySemantics(DeepySkin)
      const before = spy.samples.length
      await sleep(400) // 固定窗:探针 断言鲸鱼档不触碰吉祥物渲染
      check('whale skin never invokes the mascot skin render', spy.samples.length === before)
      spy.restore()
    } finally {
      if (s !== undefined) { await s.app.unmount(); s.term.dispose() }
    }
  }

  // ── S4 求星彩蛋在美术下方（掷骰强开档） ─────────────────────────────────
  {
    applyCompanionSkin('deepy')
    let s: Scene | undefined
    try {
      s = await scene(120, 34, { ...BASE_PROPS, starChance: 1, starReveal: 'instant' })
      await settled(() => s!.lines().some(line => line.includes('小星星')), { timeoutMs: 4000 })
      const rowsNow = s.lines()
      const titleRow = rowsNow.findIndex(line => line.includes('小星星'))
      // headless 终端报不支持 OSC 8 → ask 行整行不画（splash-eggs 已锁该
      // 契约）；这里锁吉祥物形态下 title + stats 落在美术下方原位。
      check('star easter egg renders below the art (title + stats)',
        titleRow >= 0 && rowsNow.some(line => line.includes('已陪你')),
        (rowsNow[titleRow] ?? '').trim())
      check('star block sits below the mascot art (original position)',
        titleRow > 0 && artRows(rowsNow).every(row => row < titleRow), 'titleRow=' + titleRow)
    } finally {
      if (s !== undefined) { await s.app.unmount(); s.term.dispose() }
    }
  }

  // ── S5 点击：左/右半 poke；鲸娘 poke 后接 smile-hearts；连点 tickle ──────
  {
    applyCompanionSkin('deepy')
    const spy = spySemantics(DeepySkin)
    let s: Scene | undefined
    try {
      s = await scene(120, 34, { ...BASE_PROPS, whaleIdle: true })
      await settled(() => artRows(s!.lines()).length > 0, { timeoutMs: 4000 })
      const art = artRows(s.lines())[0] ?? 3
      const start = artStartCol(s.lines(), art)
      clickAt(s, start + 2, art)
      await settled(() => spy.samples.includes('poke-left'), { timeoutMs: 4000 })
      check('left-half click pokes left', true)
      await sleep(1700) // 固定窗:墙钟 等过 poke 档（1400ms）断言自然回稳态
      const afterPoke = spy.samples.slice(spy.samples.lastIndexOf('poke-left'))
      check('poke ends back at the steady idle', afterPoke.includes('idle'),
        'tail=' + [...new Set(afterPoke)].join(','))
      clickAt(s, start + 28, art)
      await settled(() => spy.samples.includes('poke-right'), { timeoutMs: 4000 })
      check('right-half click pokes right', true)
    } finally {
      spy.restore()
      if (s !== undefined) { await s.app.unmount(); s.term.dispose() }
    }
  }
  {
    applyCompanionSkin('whaleGirl')
    const spy = spySemantics(WhaleGirlSkin)
    let s: Scene | undefined
    try {
      s = await scene(120, 34, { ...BASE_PROPS, whaleIdle: true })
      await settled(() => artRows(s!.lines()).length > 0, { timeoutMs: 4000 })
      const art = artRows(s.lines())[0] ?? 3
      const start = artStartCol(s.lines(), art)
      clickAt(s, start + 2, art)
      await settled(() => spy.samples.includes('poke-left'), { timeoutMs: 4000 })
      await settled(() => spy.samples.includes('smile-hearts'), { timeoutMs: 6000 })
      check('whaleGirl click chains poke → smile-hearts (亲昵互动)', true)
      // 连点 tickle：窗口内 3 连击（复用面板判定常量）
      spy.samples.length = 0
      for (let click = 0; click < 3; click += 1) clickAt(s, start + 2, art)
      await settled(() => spy.samples.includes('tickle'), { timeoutMs: 4000 })
      check('three rapid clicks tickle', true, 'samples=' + [...new Set(spy.samples)].join(','))
    } finally {
      spy.restore()
      if (s !== undefined) { await s.app.unmount(); s.term.dispose() }
    }
  }

  // ── S6 冻结与零时钟：working 后定格、点击无效、卸载后输出静默 ───────────
  {
    applyCompanionSkin('deepy')
    const spy = spySemantics(DeepySkin)
    let s: Scene | undefined
    try {
      s = await scene(120, 34, { ...BASE_PROPS, whaleIdle: true, working: true })
      await settled(() => artRows(s!.lines()).length > 0, { timeoutMs: 4000 })
      const before = s.lines().map(line => line.replace(/[▀▄█▌░]/g, '')).join('|')
      const art = artRows(s.lines())[0] ?? 3
      clickAt(s, artStartCol(s.lines(), art) + 2, art)
      await sleep(700) // 固定窗:探针 断言冻结档美术静止且点击无效
      const after = s.lines().map(line => line.replace(/[▀▄█▌░]/g, '')).join('|')
      check('frozen mascot is static and ignores clicks', before === after && !spy.samples.includes('poke-left'),
        'semantics=' + [...new Set(spy.samples)].join(','))
      await s.app.unmount()
      await sleep(300) // 固定窗:pacing 卸载退出序列的落帧（异步 flush）排空后再取基线
      const bytesAfterUnmount = s.bytesRef.count
      await sleep(700) // 固定窗:探针 断言此后零输出（无残留定时器在推帧）
      check('unmounted splash produces no further output (zero clock)', s.bytesRef.count === bytesAfterUnmount,
        'delta=' + (s.bytesRef.count - bytesAfterUnmount))
    } finally {
      spy.restore()
      if (s !== undefined) {
        try { await s.app.unmount() } catch { /* 已卸载 */ }
        s.term.dispose()
      }
    }
  }

  // ── S7 鲸娘图像协议（假 kitty context）：首帧字母格、解码完 raster 让位 ──
  {
    applyCompanionSkin('whaleGirl')
    skins.resetWhaleGirlImageCacheForTests()
    const CELL = Object.freeze({ width: 8, height: 16 })
    const fakeStore = { subscribe: () => () => {}, getSnapshot: () => true, getCellSize: () => CELL, getProtocol: () => 'kitty', request: () => () => {} }
    let s: Scene | undefined
    try {
      s = await scene(120, 34, { ...BASE_PROPS }, children => (
        <TerminalImagesContext.Provider value={fakeStore as never}>{children}</TerminalImagesContext.Provider>,
      ))
      const paintedBeforeDecode = await settled(() => artRows(s!.lines()).length > 0, { timeoutMs: 4000 })
      check('kitty-context first frame still paints the letter mascot (no decode wait)', paintedBeforeDecode)
      await settled(() => skins.whaleGirlDecodedAnimationKeys().length > 0, { timeoutMs: 8000 })
      await settled(() => artRows(s!.lines()).length === 0, { timeoutMs: 8000 })
      check('decoded raster replaces the letter cells (kitty context)', artRows(s.lines()).length === 0)
    } finally {
      if (s !== undefined) { await s.app.unmount(); s.term.dispose() }
      skins.resetWhaleGirlImageCacheForTests()
    }
  }
} catch (error) {
  check('fixture: no unexpected exception', false, (error as { stack?: string })?.stack ?? String(error))
} finally {
  applyCompanionSkin('deepy')
  skins.resetWhaleGirlImageCacheForTests()
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: splash mascot all checks passed.')
process.exit(0)

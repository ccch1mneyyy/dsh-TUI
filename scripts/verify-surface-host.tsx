/**
 * Scene host API + host-owned file preview regression (docs/plugin-ui-kit-
 * design.md 二期, WP3). The panel half of the shared verbs is covered in
 * verify-plugin-panels.tsx; this script proves the scene half and the preview:
 *
 * - The scene outlet hands every plugin scene `host` (additive to React/ui/
 *   channel/close): `useParams()` reads the params the scene was opened with
 *   and a re-open with new params re-renders WITHOUT remounting; `snapshot()`
 *   carries usage and the render context's attention; openScene/openPanel/
 *   toast act as the registering activation (own-only, missing services → false).
 * - `host.openFile` from a scene opens the preview over it and closing the
 *   preview lands back on that scene (params intact); a scene disposed while
 *   covered is not resurrected — the close lands on chat.
 * - The preview: header with path, line count and target line; the target
 *   line on screen; file control bytes shown as control pictures (never sent
 *   to the terminal); ↓/End scroll; q closes; directory / binary / >2 MiB /
 *   missing / FIFO show notices instead of content.
 * - Pure helpers: line splitting (CRLF/CR/BOM/trailing newline), tab stops,
 *   bidi controls, cell-exact horizontal slicing across wide characters.
 *
 * Run: node --import tsx/esm scripts/verify-surface-host.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { ReactNode } from 'react'
import type { TuiSceneProps } from '../src/scenes.js'

const [cordis, React, XTermMod, ui, termTest, i18nMod, scenesMod, outletMod, previewMod, surface] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
  import('../src/i18n.js'),
  import('../src/dsh-adapter/scenes.js'),
  import('../src/dsh-adapter/channel-scene-outlet.js'),
  import('../src/components/FilePreviewScene.js'),
  import('../src/dsh-adapter/surface-host.js'),
])
const { Context } = cordis
const { Terminal: XTerm } = XTermMod
const { render, ThemeProvider, AlternateScreen } = ui
const { settled, sleep } = termTest
i18nMod.setLang('zh')
const { t } = i18nMod

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra === '' || ok ? '' : '  (' + extra + ')'))
  if (!ok) failed += 1
}

// ── pure helpers ───────────────────────────────────────────────────────────
const { splitPreviewLines, displayRuns, sliceRuns, runsWidth, loadFilePreview, previewPathText, FILE_PREVIEW_MAX_BYTES } = previewMod
check('split: CRLF, CR and LF all break; trailing newline dropped',
  JSON.stringify(splitPreviewLines('a\r\nb\rc\nd\n')) === JSON.stringify(['a', 'b', 'c', 'd']))
check('split: BOM stripped, empty file has no lines',
  JSON.stringify(splitPreviewLines('﻿x')) === '["x"]' && splitPreviewLines('').length === 0)
const shown = displayRuns([{ text: 'a\tb' }, { text: '\u001b[31m‮z' }])
check('display: tab expands to the next 4-cell stop', shown[0]?.text === 'a   b', JSON.stringify(shown))
check('display: ESC becomes its control picture, bidi override becomes U+FFFD',
  shown[1]?.text === '␛[31m�z' && !shown.some(run => run.text.includes('\u001b')), JSON.stringify(shown))
const wide = displayRuns([{ text: 'ab中文cd', color: 'red' }])
check('display: width counts CJK as two cells', runsWidth(wide) === 8)
check('slice: a wide char cut by the left edge becomes a space',
  sliceRuns(wide, 3, 3).map(run => run.text).join('') === ' 文', JSON.stringify(sliceRuns(wide, 3, 3)))
check('slice: a wide char cut by the right edge becomes a space',
  sliceRuns(wide, 0, 3).map(run => run.text).join('') === 'ab ', JSON.stringify(sliceRuns(wide, 0, 3)))
check('slice: run colour is kept', sliceRuns(wide, 0, 2)[0]?.color === 'red')
check('display: work stops at the visible window (minified one-liners)',
  runsWidth(displayRuns([{ text: 'abcdefghij'.repeat(100_000) }, { text: 'tail' }], 12)) === 12)
{
  // Zero-width content produces no cells, so the cell bound alone would walk
  // (and measure) all of it: one huge combining cluster, or a ZWSP flood.
  const sourceRead = (runs: { text: string }[]): number => runs.reduce((total, run) => total + run.text.length, 0)
  const cluster = displayRuns([{ text: 'a' + '\u0301'.repeat(1_000_000) }, { text: 'tail' }], 12)
  const flood = displayRuns([{ text: '\u200b'.repeat(1_000_000) + 'visible' }], 12)
  check('display: a huge zero-width cluster or flood costs a bounded walk',
    sourceRead(cluster) <= 12 * 32 + 256 && sourceRead(flood) <= 12 * 32 + 256,
    String(sourceRead(cluster)) + ' / ' + String(sourceRead(flood)))
  // Zero-width padding so the budget (not the cells) ends the walk, exactly
  // on the emoji's high surrogate.
  const emoji = displayRuns([{ text: '\u200b'.repeat(12 * 32 + 255) + '😀' }], 12).map(run => run.text).join('')
  check('display: the source budget never ends on half a surrogate pair',
    emoji.length === 12 * 32 + 255 && !/[\ud800-\udbff]/.test(emoji), String(emoji.length))
  check('display: ordinary wide text is untouched by the source budget',
    runsWidth(displayRuns([{ text: '👩🏽‍👩🏽‍👦🏽‍👦🏽'.repeat(50) }], 40)) === 40)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-preview-'))
const fixture = join(dir, 'sample.ts')
const body = Array.from({ length: 40 }, (_, index) => 'const line' + String(index + 1) + ' = ' + String(index + 1))
body[4] = 'const esc = "\u001b]52;c;ZXZpbA==\u0007"'
body[5] = '\tconst tabbed = 1'
writeFileSync(fixture, body.join('\n') + '\n')
writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x01]))
writeFileSync(join(dir, 'huge.txt'), Buffer.alloc(FILE_PREVIEW_MAX_BYTES + 1, 0x61))
mkdirSync(join(dir, 'folder'))

check('load: text file → lines', await loadFilePreview(fixture).then(load => load.kind === 'text' && load.lines.length === 40))
check('load: directory refused', (await loadFilePreview(join(dir, 'folder'))).kind === 'directory')
check('load: NUL sniff refuses binaries', (await loadFilePreview(join(dir, 'blob.bin'))).kind === 'binary')
check('load: > 2 MiB refused before reading', (await loadFilePreview(join(dir, 'huge.txt'))).kind === 'too-large')
const missing = await loadFilePreview(join(dir, 'nope.txt'))
check('load: missing file reports the error code', missing.kind === 'error' && missing.message === 'ENOENT')
writeFileSync(join(dir, 'exact.txt'), 'x'.repeat(31) + '\n')
check('load: a file exactly at the cap is read whole', await loadFilePreview(join(dir, 'exact.txt'), 32).then(load => load.kind === 'text' && load.size === 32))
const big = Buffer.alloc(200 * 1024, 0x62)
writeFileSync(join(dir, 'big.txt'), big)
check('load: a file larger than the first read chunk is read to the end',
  await loadFilePreview(join(dir, 'big.txt')).then(load => load.kind === 'text' && load.size === big.length && load.lines[0]?.length === big.length))
if (process.platform === 'linux' && existsSync('/proc/self/status')) {
  // procfs reports size 0: the preview must read to EOF, not to the stat.
  const proc = await loadFilePreview('/proc/self/status')
  check('load: a procfs file (stat size 0) is read to EOF',
    proc.kind === 'text' && proc.lines.length > 5 && proc.lines.some(line => line.startsWith('Name:')), JSON.stringify(proc).slice(0, 200))
  // Under the cap by stat, over it by content (the same path a file growing
  // mid-read takes): the over-cap notice, not a silently cut text.
  const grown = await loadFilePreview('/proc/self/status', 16)
  check('load: content past the cap mid-read shows the over-cap notice', grown.kind === 'too-large' && grown.size > 16, JSON.stringify(grown).slice(0, 200))
} else {
  console.log('SKIP load: procfs (not Linux)')
}
check('header path: bidi overrides and controls are neutralized like the body',
  previewPathText('a‮b\u001bc⁦d') === 'a�b␛c�d', JSON.stringify(previewPathText('a‮b\u001bc⁦d')))
if (process.platform !== 'win32') {
  let fifoMade = false
  try {
    execFileSync('mkfifo', [join(dir, 'pipe')])
    fifoMade = true
  } catch {
    console.log('SKIP load: FIFO (mkfifo unavailable)')
  }
  if (fifoMade) {
    // 固定窗:墙钟 「读 FIFO 不阻塞」本身是被测语义：2s 上限内必须返回。
    const fifo = await Promise.race([loadFilePreview(join(dir, 'pipe')), sleep(2000).then(() => 'timeout' as const)])
    check('load: FIFO refused without blocking', fifo !== 'timeout' && fifo.kind === 'special', JSON.stringify(fifo))
  }
}

// A valid filename may start or end with spaces: the request keeps it as given.
{
  const spaced = surface.resolveSurfaceFileRequest('/w', ' report.txt ', undefined, () => {})
  check('openFile: leading/trailing spaces in a valid filename are kept', spaced?.path === '/w/ report.txt ', JSON.stringify(spaced))
}

// Plugin JavaScript may hand over options whose read throws: refused, never thrown.
{
  const warned: string[] = []
  const throwing = { get line(): number { throw new Error('boom') } }
  const proxy = new Proxy({}, { get() { throw new Error('trap') } })
  let threw = false
  let results: unknown[] = []
  try {
    results = [throwing, proxy].map(options => surface.resolveSurfaceFileRequest('/w', 'a.txt', options, message => { warned.push(message) }))
  } catch {
    threw = true
  }
  check('openFile: options whose read throws are refused, not thrown',
    !threw && results.every(result => result === undefined) && warned.length === 2 && warned.every(line => line.includes('unreadable options')),
    JSON.stringify({ threw, results, warned }))
}

// Scene params belong to their composition: two scene registries in one
// process (the host preview shares its id in both) never see each other's.
{
  const rootA = new Context()
  const rootB = new Context()
  await rootA.plugin(scenesMod.TuiSceneRuntime)
  await rootB.plugin(scenesMod.TuiSceneRuntime)
  const scenesA = rootA.get('tuiScenes') as InstanceType<typeof scenesMod.TuiSceneRuntime>
  const scenesB = rootB.get('tuiScenes') as InstanceType<typeof scenesMod.TuiSceneRuntime>
  scenesMod.openHostFilePreview(scenesA, { path: '/a/one.txt' })
  check('params: the host preview in one composition does not reach another',
    JSON.stringify(surface.getSurfaceParams(scenesMod.sceneParamsKeyFor(scenesA, scenesMod.HOST_FILE_PREVIEW_SCENE_ID))) === '{"path":"/a/one.txt"}'
      && surface.getSurfaceParams(scenesMod.sceneParamsKeyFor(scenesB, scenesMod.HOST_FILE_PREVIEW_SCENE_ID)) === undefined)
  const previewKeyA = scenesMod.sceneParamsKeyFor(scenesA, scenesMod.HOST_FILE_PREVIEW_SCENE_ID)
  rootA.registry.delete(scenesMod.TuiSceneRuntime as never)
  rootB.registry.delete(scenesMod.TuiSceneRuntime as never)
  await new Promise(resolve => setImmediate(resolve)) // the service's teardown settles a tick later
  check('params: a disposed composition leaves no preview params behind', surface.getSurfaceParams(previewKeyA) === undefined)
}

// A throwing scene listener never escapes the verb that moved the scene, and
// the listeners after it are still told.
{
  const rootC = new Context()
  rootC.logger.warn = () => undefined
  await rootC.plugin(scenesMod.TuiSceneRuntime)
  let pluginScenes: InstanceType<typeof scenesMod.TuiSceneRuntime> | undefined
  rootC.inject(['tuiScenes'], ctx => { pluginScenes = ctx.get('tuiScenes') as InstanceType<typeof scenesMod.TuiSceneRuntime> })
  await new Promise(resolve => setImmediate(resolve))
  pluginScenes!.register({ id: 'loud', component: () => null })
  pluginScenes!.open('loud')
  pluginScenes!.subscribe(() => { throw new Error('listener boom') })
  let later = 0
  scenesMod.getHostSceneRuntime(rootC.get('tuiScenes') as never)!.subscribe(() => { later += 1 })
  let opened: unknown
  let threw: unknown
  try {
    opened = scenesMod.openHostFilePreview(rootC.get('tuiScenes') as never, { path: '/w/file.txt' })
  } catch (error) {
    threw = error
  }
  check('scenes: a throwing listener does not escape openFile', threw === undefined && opened === true, String(threw))
  check('scenes: … and the listeners after it are still told', later === 1, String(later))
  rootC.registry.delete(scenesMod.TuiSceneRuntime as never)
}

// ── scene host through the outlet ─────────────────────────────────────────
const root = new Context()
await root.plugin(scenesMod.TuiSceneRuntime)
const sceneHost = scenesMod.getHostSceneRuntime(root.get('tuiScenes') as never)!
let pluginCtx: InstanceType<typeof Context> | undefined
root.inject(['tuiScenes'], ctx => { pluginCtx = ctx })
let otherCtx: InstanceType<typeof Context> | undefined
root.inject(['tuiScenes'], ctx => { otherCtx = ctx })
await new Promise(resolve => setImmediate(resolve))
if (pluginCtx === undefined || otherCtx === undefined) throw new Error('could not create plugin activations')
type ScenesService = InstanceType<typeof scenesMod.TuiSceneRuntime>
const scenes = pluginCtx.get('tuiScenes') as ScenesService
const otherScenes = otherCtx.get('tuiScenes') as ScenesService

// A nested activation registering a scene with its plugin's ctx as the
// trailing `identity` runs inside the child's own activation — the shape of
// a plugin's `ctx.inject([...], cb)` — and must pass the same ancestor rule
// as panels and status (assertCallerContext); a sibling's ctx stays refused.
let nestedSceneOk = false
let nestedSiblingRefused = false
const parentCtx = pluginCtx
const siblingCtx = otherCtx
parentCtx.inject(['tuiScenes'], child => {
  const childScenes = child.get('tuiScenes') as ScenesService
  const dispose = childScenes.register({ id: 'nested-scene', component: () => null }, parentCtx)
  nestedSceneOk = typeof dispose === 'function'
  try {
    childScenes.register({ id: 'nested-scene-sibling', component: () => null }, siblingCtx)
  } catch {
    nestedSiblingRefused = true
  }
  child.effect(() => dispose)
})
await new Promise(resolve => setImmediate(resolve))
check('scene: a nested activation may pass its plugin ctx as identity', nestedSceneOk)
check('scene: a sibling plugin ctx as identity is still refused', nestedSiblingRefused)

let mounts = 0
let lastProps: TuiSceneProps | undefined
let lastParams: unknown
function ProbeScene(props: TuiSceneProps): ReactNode {
  React.useEffect(() => { mounts += 1 }, [])
  lastProps = props
  lastParams = props.host.useParams()
  return React.createElement(props.ui.Text, null, 'probe-scene ' + JSON.stringify(lastParams ?? null))
}
const disposeProbe = scenes.register({ id: 'probe', component: ProbeScene })
const disposeOther = otherScenes.register({ id: 'other', component: () => null })

const notices: string[] = []
const resumed: string[] = []
const channel = {
  version: 0, rows: [], status: 'idle', working: false, sessionId: 's1', cwd: dir,
  spinnerMode: 'idle', goal: undefined, todos: [], subagents: [], backgroundJobs: [],
  provider: 'anthropic', model: 'x',
  tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
  contextOccupancy: { usedTokens: 900, contextWindow: 1000, source: 'backend' },
  contextBreakdown: undefined,
  costReport: undefined,
  notify(text: string) { notices.push(text); return () => {} },
  subscribe() { return () => {} },
  async resumeTo(sessionId: string) { resumed.push(sessionId); return { ok: true as const } },
  closePluginScene() { sceneHost.close() },
}

const outlet = outletMod.createChannelSceneOutlet(() => sceneHost.active)
const COLS = 50
const ROWS = 12
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal) { super(); this.term = term }
  override _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; override _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; override ref() { return this }; override unref() { return this } }

/** Mirror of Chat's scene slot: re-renders on every scene transition. */
function SceneSlot(): ReactNode {
  const active = React.useSyncExternalStore(sceneHost.subscribe, () => sceneHost.active)
  if (active === undefined) return React.createElement(ui.Text, null, 'chat-screen')
  return outlet(active.id, channel as never, { attention: { approvals: 0, questions: 1 } })
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdin = new FakeStdin()
const app = await render(
  <AlternateScreen>
    <ThemeProvider theme="dark"><SceneSlot /></ThemeProvider>
  </AlternateScreen>,
  {
    stdout: new FakeStdout(term) as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
function lines(): string[] {
  const out: string[] = []
  for (let y = 0; y < ROWS; y += 1) out.push((term.buffer.active.getLine(y)?.translateToString(false) ?? '').trimEnd())
  return out
}
async function press(sequence: string): Promise<void> {
  stdin.write(sequence)
  await sleep(60) // 固定窗:pacing 键入步间（每次按键后由 settled 断言结果）
}

check('outlet: chat before any scene', await settled(() => lines().some(line => line.includes('chat-screen'))))
check('scene: opens with params', scenes.open('probe', { tab: 'trend' }) === true)
check('scene: host.useParams() reads them on first render', await settled(() => lines().some(line => line.includes('probe-scene {"tab":"trend"}'))), lines().join('|'))
const host = lastProps!.host
check('scene: additive props — React/ui/channel/close/host all present',
  lastProps?.React !== undefined && lastProps.ui !== undefined && lastProps.channel === (channel as never) && typeof lastProps.close === 'function' && host !== undefined)
check('scene: ui is the facade module plus the panel kit Markdown/CodeBlock and the chart kit',
  Object.keys(ui).every(key => (lastProps!.ui as unknown as Record<string, unknown>)[key] === (ui as unknown as Record<string, unknown>)[key])
    && typeof lastProps!.ui.Markdown === 'function' && typeof lastProps!.ui.CodeBlock === 'function'
    && lastProps!.ui.StackedBar !== undefined && typeof lastProps!.ui.format.tokens === 'function')
check('scene: host carries every surface verb + snapshot/storage',
  ['openSession', 'openFile', 'copy', 'openScene', 'openPanel', 'useParams', 'toast', 'snapshot'].every(key => typeof (host as unknown as Record<string, unknown>)[key] === 'function') && 'storage' in host)
check('scene: re-open with new params re-renders without remounting',
  scenes.open('probe', { tab: 'files' }) === true
  && await settled(() => lines().some(line => line.includes('probe-scene {"tab":"files"}'))) && mounts === 1, 'mounts=' + String(mounts))
const sceneSnap = host.snapshot()
check('scene: snapshot carries usage from the channel and attention from the render context',
  sceneSnap.usage.occupancy?.usedTokens === 900 && sceneSnap.usage.occupancy.source === 'backend'
  && sceneSnap.attention.questions === 1 && sceneSnap.sessionId === 's1')
check('scene: storage is undefined without tuiPluginStorage', host.storage === undefined)
check('scene: toast is false without tuiToast', host.toast('hi') === false)
check('scene: openPanel is false without tuiPanels', host.openPanel('x') === false)
check('scene: openScene refuses a foreign scene', host.openScene('other') === false && sceneHost.active?.id === 'probe')
check('scene: openScene with invalid params refused', host.openScene('probe', { n: Number.NaN }) === false)
check('scene: copy validates', host.copy('') === false)

// openFile over the scene → the preview, then back to the scene.
const probeClose = lastProps!.close
check('openFile: relative path opens the preview over the scene',
  host.openFile('sample.ts', { line: 30 }) === true && sceneHost.active?.id === scenesMod.HOST_FILE_PREVIEW_SCENE_ID)
probeClose()
check('scene: a close kept past the scene closes nothing else (the preview stays)', sceneHost.active?.id === scenesMod.HOST_FILE_PREVIEW_SCENE_ID)
check('preview: header shows path, line count and target',
  await settled(() => lines()[0]?.includes('sample.ts') === true && lines()[0]?.includes('40 行') === true && lines()[0]?.includes('L30') === true),
  lines()[0] ?? '')
check('preview: the target line is on screen', lines().some(line => /^\s*30 const line30 = 30/u.test(line)), lines().join('|'))
check('preview: hint row present', lines().some(line => line.includes('Esc/q 关闭')))
await press('\u001b[F')
check('preview: End jumps to the last line', await settled(() => lines().some(line => /^\s*40 const line40/u.test(line))), lines().join('|'))
await press('\u001b[H')
check('preview: Home jumps to the first line', await settled(() => lines().some(line => /^\s*1 const line1 = 1/u.test(line))), lines().join('|'))
check('preview: file control bytes render as pictures, never as an escape',
  lines().some(line => line.includes('␛]52;c;ZXZpbA==␇')), lines().join('|'))
check('preview: tabs expand', lines().some(line => /^\s*6     const tabbed = 1/u.test(line)), lines().join('|'))
await press('\u001b[B')
check('preview: ↓ scrolls one line', await settled(() => lines()[1]?.includes('2 const line2') === true), lines()[1] ?? '')
await press('q')
check('preview: q closes back to the scene that opened it',
  await settled(() => sceneHost.active?.id === 'probe' && lines().some(line => line.includes('probe-scene {"tab":"files"}'))), String(sceneHost.active?.id))

// Notices instead of content.
for (const [file, text] of [
  ['folder', t('file-preview-directory')],
  ['blob.bin', '二进制文件'],
  ['huge.txt', '文件过大'],
  ['nope.txt', 'ENOENT'],
] as const) {
  host.openFile(file)
  check('preview notice: ' + file, await settled(() => lines().some(line => line.includes(text))), lines().join('|'))
}
writeFileSync(join(dir, 'rtl‮evil.ts'), 'const x = 1\n')
host.openFile('rtl‮evil.ts')
check('preview: a bidi override in the file name is shown as U+FFFD in the header, never obeyed',
  await settled(() => lines()[0]?.includes('rtl�evil.ts') === true) && !lines()[0]!.includes('‮'), lines()[0] ?? '')
{
  // Switching files never paints the previous contents under the new name:
  // every parsed frame is checked while the preview moves from A to B (short
  // names: the header truncates long paths in the middle).
  writeFileSync(join(dir, 'A1.txt'), 'ALPHA-MARKER line\n')
  // Large enough that its read spans frames: a stale body would be painted.
  writeFileSync(join(dir, 'B2.txt'), 'BETA-MARKER line\n' + 'filler line of text\n'.repeat(75_000))
  host.openFile('A1.txt')
  await settled(() => lines().some(line => line.includes('ALPHA-MARKER')))
  let staleFrame = false
  const watch = term.onWriteParsed(() => {
    const screen = lines()
    if (screen[0]?.includes('B2.txt') === true && screen.some(line => line.includes('ALPHA-MARKER'))) staleFrame = true
  })
  host.openFile('B2.txt')
  const switched = await settled(() => lines().some(line => line.includes('BETA-MARKER')))
  watch.dispose()
  check('preview: a file switch never shows the previous contents under the new name', switched && !staleFrame, lines().join('|'))
}
{
  // Holding Right on a huge single line stops at the scroll bound instead of
  // segmenting ever more of the line on every press.
  const { FILE_PREVIEW_MAX_LEFT } = previewMod
  writeFileSync(join(dir, 'wide.txt'), 'a'.repeat(FILE_PREVIEW_MAX_LEFT) + 'MARKER' + 'b'.repeat(200_000) + '\n')
  host.openFile('wide.txt')
  await settled(() => lines()[0]?.includes('wide.txt') === true)
  // Arrow sequences parse as one key each (a run of 'l' arrives as one text chunk).
  stdin.write('\u001b[C'.repeat(2_000))
  check('preview: horizontal scroll stops at its bound', await settled(() => lines().some(line => / MARKER/u.test(line))), lines().join('|'))
}
await press('q')
check('preview: closing after several files still returns to the scene', await settled(() => sceneHost.active?.id === 'probe'))

// A covered scene that goes away is not resurrected.
host.openFile('sample.ts')
await settled(() => sceneHost.active?.id === scenesMod.HOST_FILE_PREVIEW_SCENE_ID)
disposeProbe()
sceneHost.close()
check('preview: a disposed covered scene → close lands on chat', await settled(() => sceneHost.active === undefined && lines().some(line => line.includes('chat-screen'))))
check('scene: params cleared on dispose', surface.getSurfaceParams(scenesMod.sceneParamsKeyFor(scenes, 'probe')) === undefined)
// A host the disposed scene kept past its unload (a pending promise, a timer)
// acts as no one: no session switch, no preview, no clipboard write.
check('scene: a disposed registration\'s host refuses every verb',
  await host.openSession('s2') === false && resumed.length === 0
  && host.openFile('sample.ts') === false && sceneHost.active === undefined
  && host.copy('stale') === false && host.openScene('probe') === false && host.storage === undefined
  && host.snapshot().sessionId === '' && host.snapshot().usage.occupancy === undefined,
  'resumed=' + JSON.stringify(resumed) + ' active=' + String(sceneHost.active?.id))

// A plugin's explicit open replaces the preview's return target.
const disposeProbe2 = scenes.register({ id: 'probe', component: ProbeScene })
scenes.open('probe')
await settled(() => lines().some(line => line.includes('probe-scene null')))
lastProps!.host.openFile('sample.ts')
await settled(() => sceneHost.active?.id === scenesMod.HOST_FILE_PREVIEW_SCENE_ID)
check('scene: the preview is not the plugin\'s active scene', scenes.active === undefined)
check('scene: a plugin cannot close the host preview', (() => { scenes.close(); return sceneHost.active?.id === scenesMod.HOST_FILE_PREVIEW_SCENE_ID })())
otherScenes.open('other')
sceneHost.close()
check('scene: another scene opened over the preview closes to chat, not to the covered scene', sceneHost.active === undefined)

// A legal plugin scene id that names an Object.prototype member (`constructor`
// matches /^[a-z][a-z0-9_-]*$/) still resolves to the plugin's own component.
const disposeCtor = scenes.register({ id: 'constructor', component: () => React.createElement(ui.Text, null, 'ctor-scene') })
check('scene: id "constructor" opens', scenes.open('constructor') === true)
check('scene: id "constructor" renders its own component, not Object.prototype.constructor',
  await settled(() => lines().some(line => line.includes('ctor-scene'))), lines().join('|'))
sceneHost.close()
disposeCtor()

await app.unmount()
disposeProbe2()
disposeOther()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) {
  console.error('verify-surface-host FAILED: ' + failed)
  process.exit(1)
}
console.log('verify-surface-host ALL PASS')

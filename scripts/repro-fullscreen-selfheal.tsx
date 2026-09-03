/**
 * repro-fullscreen-selfheal — alt-screen 模式重置自愈复现（用户报告：
 * 有时页面自动退出 fullscreen、失去鼠标交互）。
 *
 * 病根：Windows conpty 在 DPI 变化 / 窗口跨屏 / 渲染器重启时会静默重置
 * DEC 私有模式（1049 alt-screen + 1000/1002/1003/1006 鼠标）。应用侧
 * altScreenActive 仍为 true，后续帧全部画到主屏（看起来就是"自己退出了
 * 全屏"），鼠标跟踪同时失效。
 *
 * 自愈链路：FOCUS_IN（用户焦点回窗，模式重置后第一个可观测时机）→
 * probeAltScreenHealth()：盲写 ENABLE_MOUSE_TRACKING（幂等）+ DECRQM 探测
 * 1049 → 仅当终端明确回答 "reset" 才 reenterAltScreen（防 iTerm2 的
 * 已在 alt 再进 = 清屏闪烁）。
 *
 * 用 headless xterm 验证（xterm 的 buffer.active.type 如实反映 1049 状态）：
 *   1. 挂载 AlternateScreen → xterm 进入 alternate buffer；
 *   2. term.reset() 模拟 conpty 模式重置 → buffer 掉回 normal；
 *   3. 发出「尺寸未变」的 resize（终端最小化→恢复的现场形态）+ 伪造
 *      DECRPM "1049;2 reset" 应答 → 应用写回 1049h + 2J、完整重绘；
 *   4. 查询在途的增量提交不泄漏到 main；1049=set 时原 buffer 全帧修复；
 *   5. 0×0/FOCUS_IN/>5s gap 都能补全静态层；inline 走 viewport 重锚。
 *
 * 运行：node --import tsx/esm scripts/repro-fullscreen-selfheal.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
// Exercise the Windows Terminal DEC-2026 path on every CI host. The field
// failure happens under WT_SESSION, where ED2 inside a synchronized block is
// not equivalent to Ctrl+L's proven out-of-band clear.
process.env.WT_SESSION ??= 'repro-fullscreen-selfheal'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen, Text, useInput }, { default: instances }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/ink/instances.js'),
])

/** 输入管线开关：App 的 stdin 读循环随 raw-mode（useInput 消费者）启用，
 *  没有 useInput 的树不读 stdin——探针需要一个保活消费者。 */
function KeepAlive(): React.ReactElement {
  useInput(() => {})
  return null
}

const COLS = 80, ROWS = 24
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Poll a positive condition (CI-load tolerant) instead of a fixed window. */
async function until(ok: () => boolean, budgetMs = 4_000, stepMs = 30): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < budgetMs) {
    if (ok()) return true
    await sleep(stepMs)
  }
  return ok()
}
/** Resolve the querier's pending queue (headless xterm never answers), so a
 *  leftover query from an unanswered scenario cannot eat the next scenario's
 *  injected DECRPM reply (querier FIFO first-match). */
function drainQuerier(): void {
  const q = (instances.get(stdout) as any)?.app?.querier
  if (!q) return
  for (const p of q.queue.splice(0)) {
    if (p.kind === 'query') p.resolve(undefined)
    else p.resolve()
    p.releaseRawMode?.()
  }
}
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const writes: string[] = []
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    writes.push(String(chunk))
    term.write(String(chunk), cb)
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin(), stdout = new FakeStdout()

const inst = await render(
  <AlternateScreen>
    <Text>probe</Text>
    <KeepAlive />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stdout as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(500)
const screenText = () => {
  const buffer = term.buffer.active
  return Array.from({ length: term.rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').join('\n')
}
check('挂载后 xterm 进入 alternate buffer', term.buffer.active.type === 'alternate', term.buffer.active.type)
check('挂载后内容完整', screenText().includes('probe'))

// 模拟 conpty 模式重置：term.reset() 把 xterm 一切归零（含 1049 / 1004 / 2004）。
writes.length = 0
term.reset()
check('term.reset() 后 buffer 掉回 normal（模拟 conpty 重置）', term.buffer.active.type === 'normal', term.buffer.active.type)

// Windows Terminal 最小化→恢复常发出一个「尺寸未变」的 resize。若把它当
// no-op 丢掉，1049 已掉而应用仍以为在 alt，后续增量帧就会画进 main buffer。
stdout.emit('resize')
await sleep(150)
check('同尺寸 resize 后发出 DECRQM 1049 探测', writes.some(w => w.includes('\x1b[?1049$p')),
  writes.filter(w => w.includes('$p')).map(w => JSON.stringify(w)).join(' ').slice(0, 60))
check('同尺寸 resize 重断言 focus/paste 模式',
  writes.some(w => w.includes('\x1b[?1004h')) && writes.some(w => w.includes('\x1b[?2004h')))
// 查询在途期间模拟鲸鱼/状态栏动画提交。物理终端已掉进 main 时，这个
// 增量帧必须被合并，不能把局部内容写进主屏/scrollback。
inst.rerender(
  <AlternateScreen>
    <Text>probe-next</Text>
    <KeepAlive />
  </AlternateScreen>,
)
await sleep(100)
check('1049 查询在途不向 main 泄漏增量帧',
  term.buffer.active.type === 'normal' && !screenText().includes('probe-next') && !writes.some(w => w.includes('probe-next')))
// DECRPM: mode 1049 status 2 (reset)。DA1 哨兵应答 ×2：第一枚被启动时
// XTVERSION 探针的未决哨兵吃掉（headless xterm 不回 XTVERSION/DA1，
// 真终端永远会答，故真机不堆积），第二枚才收尾本探测的 flush。
stdin.write('\x1b[?1049;2$y\x1b[?c\x1b[?c')
await sleep(400)
if (process.env.SELFHEAL_DEBUG) {
  console.log('--- phase3 writes ---')
  for (const w of writes) console.log('   ', JSON.stringify(w).slice(0, 80))
}
check('收到 reset 应答后重进 alt-screen（1049h + 2J）',
  term.buffer.active.type === 'alternate',
  `type=${term.buffer.active.type}`)
check('重进时带鼠标跟踪重断言', writes.some(w => w.includes('\x1b[?1000h') || w.includes('\x1b[?1006h')))
check('重进后同一恢复事务完整重绘最新内容', screenText().includes('probe-next'), JSON.stringify(screenText().slice(0, 80)))

// 1049 仍健康、但物理像素面被终端 renderer 弄脏：同尺寸 resize 应做
// 全帧刷新，不得重进 1049（避免 iTerm2 的重复-enter 清屏副作用）。
await new Promise<void>(resolve => term.write('\x1b[2J\x1b[HSTALE-SURFACE', resolve))
writes.length = 0
stdout.emit('resize')
await sleep(150)
check('健康同尺寸 resize 仍探测 1049', writes.some(w => w.includes('\x1b[?1049$p')))
stdin.write('\x1b[?1049;1$y\x1b[?c\x1b[?c')
await sleep(400)
check('1049=set 时不重复进入 alt', !writes.some(w => w.includes('\x1b[?1049h')))
check('1049=set 后全帧修复脏 surface',
  term.buffer.active.type === 'alternate' && screenText().includes('probe-next') && !screenText().includes('STALE-SURFACE'))
// Ctrl+L fixes the field corruption because its ED2 runs outside DEC-2026.
// Automatic recovery must use the same WT-safe boundary: an ED2 enclosed by
// BSU/ESU can leave the viewport/surface partially stale on Windows Terminal.
const surfaceFrame = writes.find(w => w.includes('\x1b[2J') && w.includes('probe-next')) ?? ''
const surfaceEraseAt = surfaceFrame.indexOf('\x1b[2J')
const surfaceOpenBefore = surfaceFrame.lastIndexOf('\x1b[?2026h', surfaceEraseAt)
const surfaceCloseBefore = surfaceFrame.lastIndexOf('\x1b[?2026l', surfaceEraseAt)
check('WT surface 恢复的 ED2 位于同步块外',
  surfaceEraseAt >= 0 && (surfaceOpenBefore < 0 || surfaceCloseBefore > surfaceOpenBefore),
  JSON.stringify(surfaceFrame.slice(Math.max(0, surfaceEraseAt - 30), surfaceEraseAt + 30)))

// 最小化期间 ConPTY 可能短暂报告 0×0。不得把它替换成构造期的 80×24
// fallback 并画一帧；保留最后有效布局，恢复到正尺寸后再做一次完整刷新。
writes.length = 0
stdout.columns = 0
stdout.rows = 0
stdout.emit('resize')
inst.rerender(
  <AlternateScreen>
    <Text>probe-after-minimize</Text>
    <KeepAlive />
  </AlternateScreen>,
)
await sleep(120)
check('0×0 最小化窗口不写合成尺寸帧',
  writes.length === 0 && !screenText().includes('probe-after-minimize'), `writes=${writes.length}`)
const RESTORED_COLS = COLS + 7
const RESTORED_ROWS = ROWS + 3
term.resize(RESTORED_COLS, RESTORED_ROWS)
stdout.columns = RESTORED_COLS
stdout.rows = RESTORED_ROWS
stdout.emit('resize')
await sleep(150)
check('0×0→新尺寸恢复后触发 surface 健康探测', writes.some(w => w.includes('\x1b[?1049$p')))
stdin.write('\x1b[?1049;1$y\x1b[?c\x1b[?c')
await sleep(400)
check('0×0→新尺寸恢复后完整绘出最新帧',
  term.cols === RESTORED_COLS && term.rows === RESTORED_ROWS &&
  term.buffer.active.type === 'alternate' && screenText().includes('probe-after-minimize'))

// The common minimize shape is 0×0 → the SAME original dimensions. Preserve
// bypassRefreshDedupe through the same-size branch: it must bypass the 250ms
// benign-signal dedupe and render the React changes accumulated while writes
// were suppressed. Pin lastSurfaceRefreshAt to expose the otherwise timing-
// dependent loss deterministically.
drainQuerier()
stdout.columns = 0
stdout.rows = 0
stdout.emit('resize')
inst.rerender(
  <AlternateScreen>
    <Text>probe-same-size-restore</Text>
    <KeepAlive />
  </AlternateScreen>,
)
await sleep(100)
stdout.columns = RESTORED_COLS
stdout.rows = RESTORED_ROWS
const sameSizeInk = instances.get(stdout) as any
sameSizeInk.lastSurfaceRefreshAt = Date.now()
writes.length = 0
stdout.emit('resize')
await sleep(150)
check('0×0→同尺寸恢复绕过去抖并触发探测', writes.some(w => w.includes('\x1b[?1049$p')))
stdin.write('\x1b[?1049;1$y\x1b[?c\x1b[?c')
await sleep(400)
check('0×0→同尺寸恢复绘出最小化期间最新帧', screenText().includes('probe-same-size-restore'))

// 有些终端恢复焦点但尺寸完全不变、也不发 resize。FOCUS_IN 本身就是
// surface 恢复边界：1049=set 时不重复 enter，但必须完整重绘脏像素面。
await new Promise<void>(resolve => term.write('\x1b[2J\x1b[HFOCUS-STALE', resolve))
writes.length = 0
stdin.write('\x1b[I')
await sleep(150)
check('无 resize 的 FOCUS_IN 触发 surface 健康探测', writes.some(w => w.includes('\x1b[?1049$p')))
stdin.write('\x1b[?1049;1$y\x1b[?c\x1b[?c') // status 1 = set（双 DA1 同理）
await sleep(400)
check('FOCUS_IN + 1049=set 不重复进入 alt', !writes.some(w => w.includes('\x1b[?1049h')))
check('FOCUS_IN 无 resize 仍完整修复 surface',
  term.buffer.active.type === 'alternate' && screenText().includes('probe-same-size-restore') && !screenText().includes('FOCUS-STALE'))

const ink = instances.get(stdout) as any
// Bootstrap paradox: the terminal may deliver FOCUS_OUT, then lose DECSET
// 1004 while minimized, so FOCUS_IN never arrives. Any later real user input
// proves focus returned and must synthesize the missing strong surface signal.
// Keep the stdin gap deliberately short: this exercises focus-state recovery,
// not the independent >5s fallback below.
drainQuerier()
await sleep(300)
stdin.write('\x1b[O')
await sleep(80)
ink.app.lastStdinTime = Date.now()
await new Promise<void>(resolve => term.write('\x1b[2J\x1b[HNO-FOCUS-KEY-STALE', resolve))
writes.length = 0
stdin.write('y')
await sleep(150)
check('FOCUS_IN 丢失后首个普通键升级为 surface 恢复',
  (ink.app as any).pendingFocusProbe === false && (ink as any).altScreenSurfaceRecoveryPending === true)
stdin.write('\x1b[?1049;1$y\x1b[?1049;1$y\x1b[?c\x1b[?c')
check('FOCUS_IN 丢失后普通键完整修复 surface',
  await until(() => screenText().includes('probe-same-size-restore') && !screenText().includes('NO-FOCUS-KEY-STALE'), 3_000))

// Same bootstrap gap for mouse-only use. ParsedMouse used to continue before
// the generic focus failsafe, so hover could probe 1049=set forever without
// ever requesting a repaint of unchanged cells.
drainQuerier()
await sleep(300)
stdin.write('\x1b[O')
await sleep(80)
ink.app.lastStdinTime = Date.now()
await new Promise<void>(resolve => term.write('\x1b[2J\x1b[HNO-FOCUS-MOUSE-STALE', resolve))
writes.length = 0
stdin.write('\x1b[<35;6;6M')
await sleep(150)
check('FOCUS_IN 丢失后首个 hover 升级为 surface 恢复',
  (ink as any).altScreenSurfaceRecoveryPending === true)
stdin.write('\x1b[?1049;1$y\x1b[?1049;1$y\x1b[?c\x1b[?c')
check('FOCUS_IN 丢失后 hover 完整修复 surface',
  await until(() => screenText().includes('probe-same-size-restore') && !screenText().includes('NO-FOCUS-MOUSE-STALE'), 3_000))
drainQuerier()
await sleep(300)

// focus/resize 模式都被 renderer reset 吞掉时，最小化期间累积的 >5s stdin
// gap 是最后信号。首个普通键会先走交互 probe，再在 batch tail 触发强制
// surface refresh；静态输入框/Todo/页边距必须在这一拍恢复。
await new Promise<void>(resolve => term.write('\x1b[2J\x1b[HGAP-STALE', resolve))
ink.app.lastStdinTime = Date.now() - 6_000
writes.length = 0
stdin.write('x')
await sleep(150)
check('>5s gap 后首个普通键触发 surface 健康探测', writes.some(w => w.includes('\x1b[?1049$p')))
stdin.write('\x1b[?1049;1$y\x1b[?1049;1$y\x1b[?c\x1b[?c')
await sleep(400)
check('>5s gap 恢复完整重绘静态 surface',
  screenText().includes('probe-same-size-restore') && !screenText().includes('GAP-STALE'))

// 0×0 期间若 PTY 在恢复正尺寸时漏发 resize，FOCUS_IN 也必须先同步尺寸
// 状态，再走同尺寸 surface 恢复；静态页面不能永远卡在 unavailable。
writes.length = 0
stdout.columns = 0
stdout.rows = 0
stdout.emit('resize')
inst.rerender(
  <AlternateScreen>
    <Text>probe-focus-zero</Text>
    <KeepAlive />
  </AlternateScreen>,
)
await sleep(100)
stdout.columns = RESTORED_COLS
stdout.rows = RESTORED_ROWS
stdin.write('\x1b[I') // 故意不 emit('resize')
await sleep(150)
check('0×0→正尺寸漏 resize 时 FOCUS_IN 补触发探测', writes.some(w => w.includes('\x1b[?1049$p')))
stdin.write('\x1b[?1049;1$y\x1b[?c\x1b[?c')
await sleep(400)
check('0×0→正尺寸漏 resize 时 FOCUS_IN 完整绘出', screenText().includes('probe-focus-zero'))

// Apple Terminal 不能安全接收 DECRQM（会把尾字节 p 打到屏幕）：同尺寸
// 恢复直接在当前 alt buffer 全绘，既不探测也不盲目重复 1049h。
await new Promise<void>(resolve => term.write('\x1b[2J\x1b[HAPPLE-STALE', resolve))
const savedTermProgram = process.env.TERM_PROGRAM
process.env.TERM_PROGRAM = 'Apple_Terminal'
writes.length = 0
stdout.emit('resize')
await sleep(200)
if (savedTermProgram === undefined) delete process.env.TERM_PROGRAM
else process.env.TERM_PROGRAM = savedTermProgram
check('不支持 DECRQM 的终端零探测字节', !writes.some(w => w.includes('\x1b[?1049$p')))
check('不支持 DECRQM 的终端仍完整修复 surface',
  term.buffer.active.type === 'alternate' && screenText().includes('probe-focus-zero') && !screenText().includes('APPLE-STALE'))

// 失联 multiplexer 连 DA1 都不回时，surface gate 也不能永久冻结。1s
// fallback 在当前 buffer 全绘；迟到的明确 reset 回包仍可在后续补做 re-entry。
// （等待窗口须超出 consecutive-refresh 去抖窗口，Apple 场景刚完成一次刷新。）
await sleep(150)
await new Promise<void>(resolve => term.write('\x1b[2J\x1b[HNO-DA1-STALE', resolve))
writes.length = 0
stdout.emit('resize')
check('DECRQM/DA1 无应答时 bounded fallback 解冻并全绘',
  await until(() => screenText().includes('probe-focus-zero') && !screenText().includes('NO-DA1-STALE'), 3_000))

// 上一个场景故意不回包，其查询仍挂在 querier 队列里；排空后再注入，防止
// FIFO first-match 吃掉本场景的健康回复（静默退化保护）。
drainQuerier()
// NO-DA1 的兜底刷新刚完成：越过 consecutive-refresh 去抖窗口再触发新恢复。
await sleep(300)

// 门闩自愈回归：refreshSurface 查询无应答期间，任意普通探针（hover/键）
// 的健康回复（1049=set）必须完成在途恢复并释放渲染门闩——此前只有 reset
// 回复或兜底计时器能清闸，健康终端上持续打字会永久冻结 UI。
await new Promise<void>(resolve => term.write('\x1b[2J\x1b[HHEAL-STALE', resolve))
writes.length = 0
stdout.emit('resize')
await sleep(150)
check('无应答恢复期间门闩已置位', writes.some(w => w.includes('\x1b[?1049$p')))
await sleep(300) // 越过 250ms 交互节流，让 hover 普通探针真正发出查询
stdin.write('\x1b[<35;5;5M') // hover → 普通探针（skipMouseReassert）
await sleep(150)
stdin.write('\x1b[?1049;1$y\x1b[?c\x1b[?c') // set 回复完成普通探针
check('普通探针健康回复完成在途恢复',
  await until(() => screenText().includes('probe-focus-zero') && !screenText().includes('HEAL-STALE'), 3_000))
writes.length = 0
inst.rerender(
  <AlternateScreen>
    <Text>heal-next</Text>
    <KeepAlive />
  </AlternateScreen>,
)
check('健康回复后渲染门闩已释放',
  await until(() => screenText().includes('heal-next'), 3_000))

// A destructive/manual redraw supersedes not only an in-flight query gate but
// also a strong probe that was deferred before it could start (for example,
// resize during a held gesture). It must not resurrect an obsolete recovery
// after Ctrl+L has already rebuilt the surface.
ink.pendingProbeRequest = { refreshSurface: true, bypassRefreshDedupe: true }
ink.forceRedraw()
check('Ctrl+L 取消尚未启动的延期 surface probe', ink.pendingProbeRequest === undefined)

await inst.unmount()

// 恢复发生在「完全静态」的画面上（无动画、无 React 变化提交）：全绘的
// erase 已就绪但没有可写的 diff。恢复必须让下一次内容帧全屏重画，而不是
// 把屏幕留在空白（回归：帧重置后 erase 悬空、空 diff 直接跳过写）。
const staticTerm = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const staticWrites: string[] = []
class StaticStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    staticWrites.push(String(chunk))
    staticTerm.write(String(chunk), cb)
  }
}
const staticStdout = new StaticStdout()
const staticInk = await render(
  <AlternateScreen>
    <Text>static-probe</Text>
    <KeepAlive />
  </AlternateScreen>,
  { stdout: staticStdout as any, stdin: new FakeStdin() as any, stderr: staticStdout as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(300)
const staticText = () => {
  const buffer = staticTerm.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').join('\n')
}
check('static 挂载内容完整', staticText().includes('static-probe'))
await new Promise<void>(resolve => staticTerm.write('\x1b[2J\x1b[HSTATIC-STALE', resolve))
staticWrites.length = 0
staticStdout.emit('resize')
await sleep(200)
check('static 同尺寸恢复发出健康探测', staticWrites.some(w => w.includes('\x1b[?1049$p')))
// 无 DA1 应答：1s 兜底在当前 buffer 全绘（refreshAltScreenSurface）。
check('static 空 diff 恢复后画面不空白且脏像素消失',
  await until(() => staticText().includes('static-probe') && !staticText().includes('STATIC-STALE'), 3_000))

// A genuinely blank target has zero cell diff against resetFramesForAltScreen's
// blank baseline. needsEraseBeforePaint itself must make the frame write-worthy;
// otherwise the physical garbage survives forever because no content patch
// exists to enter the old `hasDiff` branch.
staticInk.rerender(
  <AlternateScreen>
    <KeepAlive />
  </AlternateScreen>,
)
await sleep(250)
await new Promise<void>(resolve => staticTerm.write('\x1b[2J\x1b[HBLANK-TARGET-STALE', resolve))
staticWrites.length = 0
staticStdout.emit('resize')
check('全空白目标仍消费 recovery erase',
  await until(() => !staticText().includes('BLANK-TARGET-STALE') && staticWrites.some(w => w.includes('\x1b[2J')), 3_000))
await staticInk.unmount()
staticTerm.dispose()

// Inline/main-screen 同样把「尺寸未变」resize 当成物理 surface 失效信号，
// 但不能碰 1049 或清原生 scrollback：走绝对 viewport-home 重锚全绘。
const inlineTerm = new XTerm({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })
const inlineWrites: string[] = []
class InlineStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    inlineWrites.push(String(chunk))
    inlineTerm.write(String(chunk), cb)
  }
}
const inlineStdout = new InlineStdout()
const inlineStdin = new FakeStdin()
const inline = await render(
  <>
    <Text>inline-probe</Text>
    <KeepAlive />
  </>,
  { stdout: inlineStdout as any, stdin: inlineStdin as any, stderr: inlineStdout as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(300)
const inlineText = () => {
  const buffer = inlineTerm.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').join('\n')
}
check('inline 初始内容完整', inlineText().includes('inline-probe'))
// FOCUS_IN is a physical-surface boundary in inline mode too. Previously the
// Ink callback returned early outside alt-screen, even though the existing
// viewport re-anchor is exactly the safe full-repaint primitive needed here.
await new Promise<void>(resolve => inlineTerm.write('\x1b[2J\x1b[HINLINE-FOCUS-STALE', resolve))
inlineWrites.length = 0
inlineStdin.write('\x1b[I')
await sleep(250)
check('inline 无 resize 的 FOCUS_IN 全帧重锚',
  inlineText().includes('inline-probe') && !inlineText().includes('INLINE-FOCUS-STALE'))

await new Promise<void>(resolve => inlineTerm.write('\x1b[2J\x1b[HINLINE-STALE', resolve))
inlineWrites.length = 0
inlineStdout.emit('resize')
await sleep(250)
check('inline 同尺寸恢复用全帧重锚修复 surface',
  inlineText().includes('inline-probe') && !inlineText().includes('INLINE-STALE'))
check('inline 恢复不进入 1049', !inlineWrites.some(w => w.includes('\x1b[?1049h')))
await inline.unmount()
inlineTerm.dispose()
term.dispose()

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

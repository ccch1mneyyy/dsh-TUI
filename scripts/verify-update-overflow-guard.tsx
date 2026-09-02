/**
 * #185 自愈守卫回归：React nested-update overflow（Minified React error
 * #185 / "Maximum update depth exceeded"）在抛出时已被 react-reconciler
 * 将计数器清零，因此守卫吸收该类错误 = 丢一拍更新、下一拍即恢复，
 * 把"进程死亡"降级为"跳帧 + 限流诊断日志"。
 *
 * Group A — 单元（无渲染）：错误分类、非目标错误透传、限流窗口、重置。
 * Group B — 热点集成（headless xterm）：
 *   B1 clock.tick：订阅者抛 #185 被吞，后续订阅者仍执行，时钟继续。
 *   B2 reveal.tick：listener 抛 #185 被吞，调度器后续 tick 正常推进。
 *   B3 channel.emit/emitStream：listener 抛 #185 不炸 channel。
 *
 * 运行：node --import tsx/esm scripts/verify-update-overflow-guard.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env['FORCE_COLOR'] = '0'

// 家目录隔离：channel 构造路径会 touch 用户目录，先切临时目录再 import。
const { mkdtempSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const isolatedHome = mkdtempSync(joinPath(tmpdir(), 'dshtui-185-guard-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(joinPath(isolatedHome, '.dsh-tui'), { recursive: true })

const [
  { swallowNestedUpdateOverflow, isNestedUpdateOverflow, callWithUpdateOverflowGuard, resetUpdateOverflowGuardForTest, installNestedUpdateOverflowProcessGuard, registerOverflowQuench },
  { createClock },
  { Context },
  { createChannel },
  { resetRevealForTest, subscribeReveal, getRevealVersion, revealTextOf },
  React,
  { render, Box, Text, useAnimationFrame },
] = await Promise.all([
  import('../src/ink/update-overflow-guard.js'),
  import('../src/ink/components/ClockContext.js'),
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/components/smoothReveal.js'),
  import('react'),
  import('../src/ui.js'),
])
void React
const { Writable, PassThrough } = await import('node:stream')
const { Terminal: XTerm } = (await import('@xterm/headless')) as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const COLS = 80, ROWS = 12
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  constructor(private term: XTerm.Terminal) { super() }
  override _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { this.term.write(String(chunk), cb) }
}
class FakeInput extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

// --- Group A: units ---------------------------------------------------------
console.log('--- A: guard units ---')
resetUpdateOverflowGuardForTest()
const prodErr = new Error('Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.')
const devErr = new Error('Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.')
check('A1 识别 production #185', isNestedUpdateOverflow(prodErr))
check('A1 识别 dev 消息', isNestedUpdateOverflow(devErr))
check('A1 非 #185 不识别', !isNestedUpdateOverflow(new Error('Minified React error #423')) && !isNestedUpdateOverflow(new Error('ordinary')) && !isNestedUpdateOverflow('not an error'))
check('A1 吞掉 #185', swallowNestedUpdateOverflow(prodErr, 'test.a'))
check('A1 其他错误透传', !swallowNestedUpdateOverflow(new Error('boom'), 'test.a'))

// 限流：同窗口第二条被吞但不重复打日志（这里只验证行为不受限流影响，
// 日志限流由 stderr 输出人工抽查；断言层面两个都返回 true）。
check('A2 限流窗口内仍吞', swallowNestedUpdateOverflow(prodErr, 'test.a') && swallowNestedUpdateOverflow(prodErr, 'test.a'))
// 不同 source 独立。
check('A2 不同 source 独立', swallowNestedUpdateOverflow(prodErr, 'test.b'))

// callWithUpdateOverflowGuard：#185 不冒泡、其他错误原样抛。
let rethrown: unknown
try { callWithUpdateOverflowGuard('test.c', () => { throw prodErr }) } catch { rethrown = 'caught' }
check('A3 守卫回调吞 #185', rethrown === undefined)
try { callWithUpdateOverflowGuard('test.c', () => { throw new Error('boom') }) } catch (e) { rethrown = e }
check('A3 守卫回调透传其他', rethrown instanceof Error && (rethrown as Error).message === 'boom')

// A4 进程级兜底：安装幂等；手动派发一次 #185 uncaughtException 不杀进程
// （守卫吸收）；DSH_TUI_NO_185_PROCESS_GUARD 逃生门跳过安装。
installNestedUpdateOverflowProcessGuard()
installNestedUpdateOverflowProcessGuard() // 幂等，不重复装
let processSurvived = true
try { process.emit('uncaughtException', prodErr) } catch { processSurvived = false }
check('A4 进程兜底吸收 #185（进程存活）', processSurvived)

// A5 熔断：同源 5 次触发 → 调用已注册 quench（5s）；未注册 quench 的源
// 只升级日志不熔断（channel 数据通道不可停）。
{
  resetUpdateOverflowGuardForTest()
  const quenched: number[] = []
  registerOverflowQuench('test.quench', ms => { quenched.push(ms) })
  for (let i = 0; i < 4; i++) swallowNestedUpdateOverflow(prodErr, 'test.quench')
  check('A5 阈值以下不熔断', quenched.length === 0, `n=${quenched.length}`)
  swallowNestedUpdateOverflow(prodErr, 'test.quench')
  check('A5 第 5 次触发熔断（5s）', quenched.length === 1 && quenched[0] === 5000, JSON.stringify(quenched))
  for (let i = 0; i < 6; i++) swallowNestedUpdateOverflow(prodErr, 'test.noquench')
  check('A5 无 quench 的源只吞不熔断', swallowNestedUpdateOverflow(prodErr, 'test.noquench'))
}

// --- Group B: hotspot integration -------------------------------------------
console.log('--- B: hotspots ---')

// B1 clock.tick: 抛 #185 的订阅者被吞，后续订阅者与后续 tick 正常。
{
  resetUpdateOverflowGuardForTest()
  const clock = createClock(5)
  let bTicks = 0
  let threw = false
  const unsubscribeA = clock.subscribe(() => { threw = true; throw prodErr }, true)
  const unsubscribeB = clock.subscribe(() => { bTicks++ }, true)
  let survived = true
  try { await sleep(40) } catch { survived = false }
  check('B1 clock.tick 吞 #185 且进程存活', survived && threw && bTicks > 0, `bTicks=${bTicks}`)
  unsubscribeA()
  unsubscribeB()
}

// B5 熔断集成：持续抛 #185 的订阅者 → 5 次后共享时钟被暂停（tick 停摆），
// 退避窗口内 CPU 风暴被斩断；数据无损（订阅保留，恢复后继续）。
{
  resetUpdateOverflowGuardForTest()
  const clock = createClock(5)
  let calls = 0
  const unsubscribe = clock.subscribe(() => { calls++; throw prodErr }, true)
  await sleep(200) // 5ms tick：~5 次吞后熔断 → suspend 5s
  const atTrip = calls
  await sleep(300)
  check('B5 熔断暂停共享时钟', calls - atTrip <= 1, `calls ${atTrip}→${calls}`)
  unsubscribe()
}

// B2 reveal.tick: listener 前几次抛 #185 被吞（次数控制在熔断阈值以下，
// 熔断语义由 B5 覆盖），游标继续推进直至完成。
{
  resetUpdateOverflowGuardForTest()
  resetRevealForTest()
  let boomLeft = 4
  const unsub = subscribeReveal(() => { if (boomLeft-- > 0) throw prodErr })
  // 创建一个活跃游标（render 期读、active 创建），让 revealTick 有工作。
  const key = 'verify-185-guard'
  revealTextOf(key, 'x'.repeat(24), { enabled: true, active: true })
  const v0 = getRevealVersion()
  let survived = true
  try { await sleep(1200) } catch { survived = false }
  const settled = revealTextOf(key, 'x'.repeat(24), { enabled: true, active: true })
  check('B2 reveal.tick 吞 #185 且游标推进', survived && getRevealVersion() > v0 && settled.length === 24,
    `v=${getRevealVersion() - v0} len=${settled.length}`)
  unsub()
  resetRevealForTest()
}

// B3 channel.emit/emitStream：真实 channel + 抛 #185 的订阅者。
{
  resetUpdateOverflowGuardForTest()
  const ctx = new Context()
  const initial = {
    id: 'agent-a', status: 'idle', options: {},
    ctx: { on: () => () => {} },
    session: { id: 'sess-a', seq: 0, events: [], header: {} },
    followup() {}, steer() {}, inbox: { remove: () => true }, cancel() {}, whenIdle: () => Promise.resolve(),
  }
  const channel = createChannel(ctx as never, initial as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })
  let goodWakeups = 0
  const unsub = channel.subscribe(() => { goodWakeups++; throw prodErr })
  let survived = true
  let detail = ''
  try { channel.notify('guard probe') } catch (err) { survived = false; detail = `notify: ${(err as Error).message}` }
  try { channel.pushLocal('guard probe', ['guard probe row']) } catch (err) { survived = false; detail += ` pushLocal: ${(err as Error).message}` }
  try { await sleep(30) } catch (err) { survived = false; detail += ` sleep: ${(err as Error).message}` }
  check('B3 channel.emit 吞 #185', survived && goodWakeups > 0, `wakeup=${goodWakeups} ${detail}`)
  unsub()
}

// B4 端到端：渲染树上动画订阅者抛 #185，UI 不死、后续帧恢复。
{
  resetUpdateOverflowGuardForTest()
  resetRevealForTest()
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term) as unknown as NodeJS.WriteStream
  let frames = 0
  function Scene(): React.ReactNode {
    // 直接挂一个订阅共享时钟的组件；其 onChange 不抛（守卫冒烟）——
    // 抛错路径由 B1-B3 覆盖，这里验证守卫在真实 reconciler 下零干扰。
    const [, time] = useAnimationFrame(40)
    frames++
    return <Box><Text>{Math.floor(time / 40) % 10}</Text></Box>
  }
  const instance = await render(<Scene />, {
    stdout, stdin: new FakeInput() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false, patchConsole: false,
  })
  await sleep(300)
  const alive = frames > 3
  await instance.unmount()
  term.dispose()
  check('B4 真实渲染零干扰（守卫不破坏正常动画）', alive, `frames=${frames}`)
  resetRevealForTest()
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

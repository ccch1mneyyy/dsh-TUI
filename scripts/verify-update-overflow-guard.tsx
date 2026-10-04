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
 * Group C — 根边界恢复：commit 期 #185（热点守卫与进程兜底都看不到的
 *   类别）由根 App 边界恢复（清 state 重挂载，细节落 crash.log），窗口
 *   内恢复次数封顶，耗尽回落原崩溃退出。
 * Group D — 恢复落点：一次性重挂标记（note/consume）+ 三处接线 tripwire
 *   （App 记标记、Chat 消费、皮肤 hook 停逐 commit 入队——真凶修复的
 *   源码级断言，crash.log 2026-10-03 栈直指 skins 的 setDisplayed）。
 *
 * 运行：node --import tsx/esm scripts/verify-update-overflow-guard.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env['FORCE_COLOR'] = '0'

// 家目录隔离：channel 构造路径会 touch 用户目录，先切临时目录再 import。
const { mkdtempSync, mkdirSync, readFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const isolatedHome = mkdtempSync(joinPath(tmpdir(), 'dshtui-185-guard-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(joinPath(isolatedHome, '.dsh-tui'), { recursive: true })

const [
  { swallowNestedUpdateOverflow, isNestedUpdateOverflow, callWithUpdateOverflowGuard, resetUpdateOverflowGuardForTest, installNestedUpdateOverflowProcessGuard, registerOverflowQuench, fatalReasonForExit, shouldRecoverBoundaryOverflow, noteBoundaryRecoveryRemount, consumeBoundaryRecoveryRemount },
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
const { settled } = await import('./lib/term-test.mjs')
const { default: inkInstances } = await import('../src/ink/instances.js')

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
  // 固定窗:待迁移 断言 bTicks>0 是正向变化，但 sleep 同时被 try/catch 包着
  // 承担「异常不得逃逸」语义，改成 settled 需重排 survived 的捕获点
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
  await sleep(200) // 固定窗:墙钟 5ms tick 跑满熔断阈值（~5 次吞）→ suspend 5s
  const atTrip = calls
  // 固定窗:探针 熔断退避窗口内 tick 不得继续（断言 calls 基本不变）
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
  // 固定窗:待迁移 断言游标推进是正向变化，但重新求值要调用有副作用的
  // revealTextOf（读即创建/推进游标），轮询会改被测行为
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
  // 固定窗:探针 goodWakeups 在 notify 时已同步递增，这个窗口测的是被吞的
  // #185 不得异步逃逸炸掉进程
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
  const alive = await settled(() => frames > 3)
  await instance.unmount()
  term.dispose()
  check('B4 真实渲染零干扰（守卫不破坏正常动画）', alive, `frames=${frames}`)
  resetRevealForTest()
}

// B6 致命原因规范化：`Promise.reject()` / `throw undefined` 交给退出漏斗时必须是
// 非 undefined 的错误——漏斗用 `error !== undefined` 选崩溃路径，undefined 会走
// 干净退出（exit 0），而 sink 却已声明接管进程（CodeRabbit 在 PR #1174 指出）。
{
  const fromRejection = fatalReasonForExit(undefined, 'unhandledRejection')
  const fromThrow = fatalReasonForExit(undefined, 'uncaughtException')
  const defined = new Error('boom')
  const nonError = { code: 'EBOOM' }
  check('B6 undefined 拒绝原因被规范化为 Error', fromRejection instanceof Error && fromRejection.message.includes('unhandledRejection'))
  check('B6 undefined 未捕获原因被规范化为 Error', fromThrow instanceof Error && fromThrow.message.includes('uncaughtException'))
  check('B6 已定义原因按引用原样透传', fatalReasonForExit(defined, 'uncaughtException') === defined)
  check('B6 非 Error 的已定义原因不被包装', fatalReasonForExit(nonError, 'unhandledRejection') === nonError)
}

// --- Group C: root-boundary recovery ---------------------------------------
// 真实用户级 #185：throw 发生在 React 自己的 commit 里（无依赖 layout
// effect 链式排更新 → 嵌套 commit 计数），热点守卫与进程兜底都看不到——只有根 App 边界接得住，历史上
// componentDidCatch 直接 handleExit 整应用崩溃。C 组锁定恢复契约：
// react-reconciler 抛出前已清零嵌套计数器，边界清掉 error 态即从干净
// 计数器重挂载整树；窗口内恢复次数封顶，耗尽回落原崩溃退出。
{
  console.log('--- C: root-boundary recovery ---')
  resetUpdateOverflowGuardForTest()
  const t0 = 1_000_000_000
  check('C1 窗口内恢复次数封顶（3 次）', shouldRecoverBoundaryOverflow(t0) && shouldRecoverBoundaryOverflow(t0 + 1) && shouldRecoverBoundaryOverflow(t0 + 2) && !shouldRecoverBoundaryOverflow(t0 + 3))
  check('C1 窗口滑动后恢复额度回来', shouldRecoverBoundaryOverflow(t0 + 60_001))
  resetUpdateOverflowGuardForTest()
}

// C2：一次 #185 → 恢复（重挂载）→ 实例存活；细节落 crash.log（隔离家目录）。
{
  resetUpdateOverflowGuardForTest()
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term) as unknown as NodeJS.WriteStream
  let mounts = 0
  function OnceOscillator(): React.ReactNode {
    const [mount] = React.useState(() => ++mounts)
    const [tick, setTick] = React.useState(0)
    // 只在第一次挂载振荡：无依赖 layout effect 每次 commit 排下一次更新 →
    // 嵌套 commit 计数 → #185 于 commit 期抛出、componentStack 指向本组件
    //（探针 .local/tmp-probe-osc.tsx 实证 ~52 拍必现；正是逃过热点守卫与
    // 进程兜底、只能被根边界接住的类别）。恢复后的新树（mount ≥ 2）不振荡
    // ——模拟「重挂载后状态归零，振荡消失」的真实自愈形态。
    React.useLayoutEffect(() => { if (mount === 1) setTick(tick + 1) })
    return <Box><Text>osc{mount}</Text></Box>
  }
  const instance = await render(<OnceOscillator />, {
    stdout, stdin: new FakeInput() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false, patchConsole: false,
  })
  let exitReason: unknown
  let cleanExit = false
  void instance.waitUntilExit().then(() => { cleanExit = true }, (reason: unknown) => { exitReason = reason })
  const recovered = await settled(() => mounts >= 2)
  await sleep(150) // 固定窗:探针 恢复后观察窗——断言实例不退出、crash.log 已落（状态不变量）
  const crashPath = joinPath(isolatedHome, '.dsh-tui', 'crash.log')
  let crashText = ''
  try { crashText = readFileSync(crashPath, 'utf8') } catch { /* absence asserted below */ }
  check('C2 #185 后根边界恢复（树重挂载且只挂一次）', recovered && mounts === 2, `mounts=${mounts}`)
  check('C2 恢复后实例未退出（ink 实例仍在册、无拒绝）', inkInstances.get(stdout) !== undefined && exitReason === undefined && !cleanExit, `reason=${String(exitReason)}`)
  check('C2 细节已落 crash.log（含 #185 标记）', crashText.includes('#185') || crashText.includes('Maximum update depth'))
  try { await instance.unmount() } catch { /* teardown failure surfaces above */ }
  term.dispose()
}

// C3：永不停歇的振荡 → 3 次恢复耗尽 → 回落原崩溃退出（waitUntilExit 拒绝携带 #185）。
{
  resetUpdateOverflowGuardForTest()
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term) as unknown as NodeJS.WriteStream
  let mounts = 0
  function AlwaysOscillator(): React.ReactNode {
    React.useState(() => ++mounts)
    const [tick, setTick] = React.useState(0)
    // 每次挂载都振荡：恢复多少次都再犯 → 额度耗尽 → 回落原崩溃退出。
    React.useLayoutEffect(() => { setTick(tick + 1) })
    return <Box><Text>osc</Text></Box>
  }
  const crashPath = joinPath(isolatedHome, '.dsh-tui', 'crash.log')
  const countCrashLines = (): number => {
    try { return readFileSync(crashPath, 'utf8').split('\n').filter((l: string) => l.includes('pid=')).length } catch { return 0 }
  }
  // 计数窗必须在 render 之前开：整条振荡→恢复→耗尽→拆除链在首次同步
  // render 里就全部完成（探针与 C3 首跑实证 mounts 在 render 返回时已=4）。
  const before = countCrashLines()
  const instance = await render(<AlwaysOscillator />, {
    stdout, stdin: new FakeInput() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false, patchConsole: false,
  })
  let exitReason: unknown
  const crashed = await settled(() => {
    void instance.waitUntilExit().then(() => {}, (reason: unknown) => { exitReason = reason })
    return inkInstances.get(stdout) === undefined || exitReason !== undefined
  })
  const lines = countCrashLines() - before
  check('C3 恢复额度耗尽后回落崩溃退出（ink 实例被拆除或退出承诺结算）', crashed && (inkInstances.get(stdout) === undefined || (exitReason instanceof Error && /#185|Maximum update depth/.test(exitReason.message))), `gone=${String(inkInstances.get(stdout) === undefined)} reason=${String(exitReason)}`)
  check('C3 崩溃前恰有 3 次恢复（crash.log +3 条、挂载 4 次）', lines === 3 && mounts === 4, `lines=+${lines} mounts=${mounts}`)
  term.dispose()
}
// --- Group D: recovery remount mark + wiring tripwires ----------------------
{
  console.log('--- D: recovery remount mark ---')
  resetUpdateOverflowGuardForTest()
  check('D1 未恢复时消费为假', !consumeBoundaryRecoveryRemount())
  noteBoundaryRecoveryRemount()
  check('D1 恢复后首次消费为真', consumeBoundaryRecoveryRemount())
  check('D1 消费一次性（再读为假）', !consumeBoundaryRecoveryRemount())
  noteBoundaryRecoveryRemount()
  resetUpdateOverflowGuardForTest()
  check('D1 重置清标记', !consumeBoundaryRecoveryRemount())

  // 接线 tripwire：三处关键落点各在源码里存在（行为级端到端由 C 组的
  // 边界恢复 + 用户真机覆盖；源码断言防未来重构悄悄拆线）。
  const { readFileSync: readSrc } = await import('node:fs')
  const readRepo = (rel: string): string => readSrc(new URL(rel, import.meta.url), 'utf8')
  const appSrc = readRepo('../src/ink/components/App.tsx')
  const chatSrc = readRepo('../src/screens/Chat.tsx')
  const skinsSrc = readRepo('../src/components/sidePanel/companion/skins.tsx')
  check('D2 App 恢复路径记标记', appSrc.includes('noteBoundaryRecoveryRemount();'))
  check('D2 Chat 消费标记并门住启动页', chatSrc.includes('!recoveryRemountOnBoot)') && chatSrc.includes('consumeBoundaryRecoveryRemount()'))
  check('D2 皮肤 hook 已去逐 commit 入队（ref 镜像在位、bail 更新器已删）', skinsSrc.includes('displayedRef.current !== next') && !skinsSrc.includes('setDisplayed(previous =>'))
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

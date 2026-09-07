/**
 * ScrollBox 底部超滚门控回归（overscroll at the bottom is a true no-op）。
 *
 * 用户报告：转录区已滚到最底（sticky 贴底）后继续 wheel-down 仍可见
 * "强拖+闪烁"。根因链：每个向下 notch 走 ScrollBox.scrollBy(+3) → 无条件
 * 清 stickyScroll → 渲染器 at-bottom re-pin 恢复 → 每格一次 sticky
 * flip-flop（isSticky 是 React 状态）→ MessageList 虚拟化窗口/缓存
 * churn + 「↓ 回到底部」pill 在用户已在底部时闪现 + 整屏重绘；measure
 * 帧 innerHeight 伪影下 drain 把 scrollTop 推过 maxScroll 再拉回。
 * 修复 = scrollBy 的底部超滚门控（dy>0 且贴底/位置在底时直接 return，
 * 不清 sticky/不积 delta/不通知）。本脚本钉死修复后的契约：
 *   A. 底部连续 wheel-down：零画面帧变化、零内容写入、终帧与稳定帧全等；
 *   B. 滚轮双向未被门控误吞：wheel-up 离开底部可见滚动，wheel-down
 *      能滚回底部（着陆格放行 + at-bottom re-pin 恢复 sticky）。
 *
 * Run: node --import tsx/esm scripts/verify-scrollbox-bottom-overscroll.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
delete process.env.WT_SESSION
delete process.env.TERM_PROGRAM
delete process.env.TMUX

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen, ScrollBox, Box, Text },
  { Chat },
  { QuestionStore },
  { LOCAL_COMMANDS, completeCommands },
  termTest,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
])
const { default: instances } = await import('../src/ink/instances.js')
const { sleep } = termTest

const COLS = 120
const ROWS = 36
const BOTTOM_MARKER = '★尾行标记-在最后一条消息的最后一行★'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

function makeRows(): any[] {
  const rows: any[] = []
  let id = 1
  for (let turn = 0; turn < 20; turn++) {
    rows.push({ id: id++, kind: 'user', text: `历史用户消息 ${turn}：请检查模块 ${turn} 的边界行为，这里补足一些文字。`, time: 1_700_000_000_000 + turn * 2000 })
    const last = turn === 19
    rows.push({
      id: id++,
      kind: 'assistant',
      text: `助手回复 ${turn}：${'分析结果与建议。'.repeat(8)}${last ? `\n\n${BOTTOM_MARKER}` : ''}`,
      time: 1_700_000_000_800 + turn * 2000,
    })
  }
  return rows
}

function makeChannel(rows: any[]) {
  const listeners = new Set<() => void>()
  return {
    version: 0,
    whaleIdle: false,
    rows,
    status: 'idle',
    sessionTitle: 'verify-bottom-overscroll',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    reasoningEffort: 'max',
    effortLevels: [],
    tokens: { input: 0, output: 0 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    pending: [],
    commandList: LOCAL_COMMANDS,
    notifications: [],
    mode: { plan: false, sandbox: undefined },
    activityFrames: 'moon8',
    agentPreset: undefined,
    subagents: [],
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    submit: () => {},
    cancel: () => {},
    clear: () => {},
    notify: () => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => Promise.resolve([]),
    deleteSession: () => Promise.resolve(true),
    renameSessionTo: () => Promise.resolve(true),
    setResumeTarget: () => {},
    loadOlder: () => {},
    mcpStatus: () => [],
    pushLocal: () => {},
    commandCompletions: (input: string) => completeCommands(input),
  } as any
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

function norm(line: string): string { return line.replace(/\s+$/, '') }

async function runScenario(tag: string, burstDown: number, seekUpThenDown: boolean): Promise<void> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const writes: string[] = []
  const frames: string[][] = [] // 每次 stdout 写入后的屏幕快照（去重）
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    override _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      const text = String(chunk)
      writes.push(text)
      term.write(text, () => {
        const lines: string[] = []
        for (let y = 0; y < ROWS; y++) lines.push(norm(term.buffer.active.getLine(y)?.translateToString(true) ?? ''))
        const last = frames[frames.length - 1]
        if (!last || last.some((l, i) => l !== lines[i]!)) frames.push(lines)
        callback()
      })
    }
  }
  class FakeStderr extends Writable {
    isTTY = true
    override _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
  }
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const tree = (
    <AlternateScreen>
      <Chat channel={makeChannel(makeRows())} questionStore={new QuestionStore()} fullscreen />
    </AlternateScreen>
  )
  const instance = await render(tree, {
    stdout: stdout as any,
    stdin: stdin as any,
    stderr: new FakeStderr() as any,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.set(process.stdout, instances.get(stdout)!)
  instance.rerender(tree)
  await sleep(900) // 固定窗:探针 等界面真正就绪的观察窗——S0 基线要求完整首屏，轮询空屏会得到假基线

  const wheel = (dir: 'up' | 'down', ticks: number): void => {
    const button = dir === 'up' ? 64 : 65
    for (let i = 0; i < ticks; i++) stdin.write(`\x1b[<${button};60;20M`)
  }
  const markerRow = (lines: string[]): number => lines.findIndex(l => l.includes(BOTTOM_MARKER))
  const atBottom = () => frames.length > 0 && markerRow(frames[frames.length - 1]!) >= 0

  // 新会话 sticky 应直接落在底部；保险起见 seek（seek 也是功能路径）。
  let seek = 0
  while (!atBottom() && seek < 120) {
    wheel('down', 1)
    seek++
    await sleep(16) // 固定窗:pacing 滚轮事件步间（seek 逐格）
  }
  await sleep(400) // 固定窗:pacing 静置窗——S0 基线帧取样前等残余渲染落定，无可轮询条件
  if (!atBottom()) throw new Error(`${tag}: setup failed — never reached the bottom`)
  const S0 = frames[frames.length - 1]!
  const s0Row = markerRow(S0)
  check(`${tag}: 稳定在底部（尾行标记可见于行 ${s0Row}）`, s0Row >= 0, `seekTicks=${seek}`)

  if (seekUpThenDown) {
    // B: 先滚上去离开底部（门控不得吞 wheel-up），再循环滚回底部——
    // 着陆格/贴底帧必须放行并恢复 sticky（marker 重现 = 回底成功）。
    const beforeUp = frames.length
    wheel('up', 5)
    await sleep(320) // 固定窗:pacing 收集 wheel-up 中间帧的观察窗——滚出证据在中间帧，轮询终态会丢取证帧
    const afterUp = frames.slice(beforeUp).find(lines => markerRow(lines) < 0)
    check(`${tag}: wheel-up 离开底部正常滚动`, afterUp !== undefined, `marker 已滚出视口`)
    const beforeDown = frames.length
    let downTicks = 0
    while (downTicks < 40 && !frames.slice(beforeDown).some(lines => markerRow(lines) >= 0)) {
      wheel('down', 1)
      downTicks++
      await sleep(34) // 固定窗:pacing 滚轮事件步间（downTicks 循环步长）
    }
    await sleep(400) // 固定窗:pacing 静置窗——滚回底部的渲染帧收集完毕后再扫描 backFrames
    const backFrames = frames.slice(beforeDown)
    const back = backFrames.find(lines => markerRow(lines) >= 0)
    check(`${tag}: wheel-down 能滚回底部（着陆格未被门控吞掉）`, back !== undefined, `downTicks=${downTicks}`)
    if (back === undefined) {
      const last = backFrames[backFrames.length - 1] ?? []
      console.log(`--- B 诊断: down ${downTicks} 格后尾部 8 行 ---`)
      console.log(last.slice(Math.max(0, ROWS - 8)).map((l, i) => `${String(i + Math.max(0, ROWS - 8)).padStart(2)}|${l}`).join('\n'))
    }
    await sleep(200) // 固定窗:pacing 场景 B 收尾静置窗——卸载前残余渲染落定
  } else {
    // A: 底部连续 wheel-down —— 修复前的每格 sticky flip-flop / pill 闪现 /
    // 整屏重绘帧在这里会表现为画面帧变化；修复后必须零帧、零内容写。
    const beforeWrites = writes.length
    const burstStart = frames.length
    for (let i = 0; i < burstDown; i++) {
      wheel('down', 1)
      await sleep(30) // 固定窗:pacing 滚轮事件步间（burst 逐格）
    }
    await sleep(500) // 固定窗:探针 残余 drain 静置窗——随后断言零帧变化/零写入是「不得改变」不变式，轮询无意义

    const burstFrames = frames.slice(burstStart)
    const changed = burstFrames.filter(lines => lines.some((l, r) => l !== S0[r]!))
    check(`${tag}: 底部 ${burstDown} 格 wheel-down 期间零画面帧变化`, changed.length === 0, `${changed.length} 帧变化`)
    const pillFrames = burstFrames.filter(lines => lines.some(l => l.includes('回到底部')))
    check(`${tag}: 期间无「回到底部」pill 闪现`, pillFrames.length === 0, `${pillFrames.length} 帧含 pill`)
    const finalFrame = burstFrames[burstFrames.length - 1] ?? S0
    check(`${tag}: 终帧与稳定帧全等`, !finalFrame.some((l, r) => l !== S0[r]!))
    const contentBytes = writes.slice(beforeWrites).join('').length
    check(`${tag}: 期间无重绘级内容写入`, contentBytes <= 32, `${contentBytes} bytes`)
  }

  await instance.unmount()
  instances.delete(process.stdout)
  term.dispose()
}

async function runUnitScenario(tag: string): Promise<void> {
  // C: maxScroll-1 死区回归（裸 ScrollBox 单元）。±1 行调用方（面板 ↑/↓、
  // seek/scrollTo 落点）可以让 sticky 已破的视图静止在 maxScroll - 1
  // （差 1 行到真底）：渲染器 re-pin 要求 scrollTop >= maxScroll，该位置
  // 无帧可自愈——门控若在 >= maxScroll - 1 就吞 dy>0，最后一行永不可达、
  // sticky 永不恢复。断言：+1 必须落底并把 sticky 恢复。
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    override _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  class FakeStderr extends Writable {
    isTTY = true
    override _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
  }
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const handleRef: { current: any } = { current: null }
  const lines = Array.from({ length: 200 }, (_, i) => `第 ${i} 行内容-滚动单元测试`)
  const tree = (
    <AlternateScreen>
      <ScrollBox ref={(h: any) => { handleRef.current = h }} stickyScroll height={30} width={COLS} flexDirection="column">
        {lines.map((text, i) => (
          <Box key={i} height={1} width="100%"><Text>{text}</Text></Box>
        ))}
      </ScrollBox>
    </AlternateScreen>
  )
  const instance = await render(tree, {
    stdout: stdout as any,
    stdin: stdin as any,
    stderr: new FakeStderr() as any,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.set(process.stdout, instances.get(stdout)!)
  instance.rerender(tree)
  await sleep(500) // 固定窗:pacing 等单元树挂载渲染落定（无单一可轮询锚点）
  const h = handleRef.current
  if (!h) throw new Error(`${tag}: ScrollBox handle not mounted`)

  const maxScrollOf = (): number =>
    Math.max(0, (h.getScrollHeight() ?? 0) - (h.getViewportHeight() ?? 0))
  // 1. 跳到真底（scrollTo 越过 maxScroll，渲染帧 clamp 落底；restore 帧
  //    会恢复 sticky——先确认工具路径本身工作）。
  h.scrollTo(1e9)
  await sleep(200) // 固定窗:pacing 静置窗——scrollTo 越界钳制的渲染帧应用后再断言落底
  check(`${tag}: scrollTo 落底（scrollTop == maxScroll）`, h.getScrollTop() === maxScrollOf(), `top=${h.getScrollTop()} max=${maxScrollOf()}`)
  // 2. 打破 sticky 并停到 maxScroll - 1（差 1 行）：-1 格上滚。
  h.scrollBy(-1)
  await sleep(250) // 固定窗:pacing 静置窗——scrollBy(-1) 渲染帧应用后断言停在 maxScroll-1
  check(`${tag}: 静止于 maxScroll - 1（sticky 已破）`, h.getScrollTop() === maxScrollOf() - 1 && !h.isSticky(), `top=${h.getScrollTop()} max=${maxScrollOf()} sticky=${h.isSticky()}`)
  // 3. 死区核心：+1 必须放行落底并恢复 sticky（门控若含 epsilon 则在此
  //    吞掉——最后一行永不可达）。
  h.scrollBy(1)
  await sleep(300) // 固定窗:pacing 静置窗——scrollBy(+1) 渲染帧应用后断言落底与 sticky 恢复
  check(`${tag}: maxScroll-1 的 +1 能落底`, h.getScrollTop() === maxScrollOf(), `top=${h.getScrollTop()} max=${maxScrollOf()}`)
  check(`${tag}: 落底后 sticky 恢复`, h.isSticky() === true, `sticky=${h.isSticky()}`)

  await instance.unmount()
  instances.delete(process.stdout)
  term.dispose()
}

await runScenario('A.贴底超滚', 12, false)
await runScenario('B.滚上再滚回', 5, true)
await runUnitScenario('C.maxScroll-1 死区')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

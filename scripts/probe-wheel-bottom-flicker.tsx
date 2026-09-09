/**
 * Probe: 已经滑到最底部后继续 wheel-down，是否仍产生可见"拖动/闪烁"。
 *
 * 真实 Chat + 长历史，settle 在底部（末条消息可见且连续两帧相同），然后
 * 连续 wheel-down N 格，逐帧（每次 stdout 写入后）截图对比稳定帧 S0：
 *   - framesAfter: 与 S0 不同的中间帧数（0 = 完全无可见拖动）
 *   - 列出第一个差异帧的差异行
 * 同时 DSH_TUI_GEOMETRY_TRACE=<file> 打印 burst 期间每帧的 scroll 几何，
 * 看 sticky/scrollTop/maxScroll/pending 的 flip-flop。
 *
 * Run: node --import tsx/esm scripts/probe-wheel-bottom-flicker.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
delete process.env.WT_SESSION
delete process.env.TERM_PROGRAM
delete process.env.TMUX

const TRACE = process.env.DSH_TUI_GEOMETRY_TRACE_FILE ?? ''
if (TRACE) process.env.DSH_TUI_GEOMETRY_TRACE = TRACE

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
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
const { sleep, settled } = termTest

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
  const channel = {
    version: 0,
    whaleIdle: false,
    rows,
    status: 'idle',
    sessionTitle: 'probe-bottom-flicker',
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
  ;(channel as any).bump = () => { channel.version++; for (const cb of listeners) cb() }
  return channel as any
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

function norm(line: string): string { return line.replace(/\s+$/, '') }

async function main(): Promise<void> {
  const STREAMING = process.env.PROBE_STREAM === '1'
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
  // 底部区域最后内容行（滚动态）：记录每帧最后一行非空白文本所在行号与文本
  function bottomContentRow(lines: string[]): number {
    for (let r = ROWS - 1; r >= 0; r--) {
      if (lines[r]!.trim().length > 0) return r
    }
    return -1
  }
  class FakeStderr extends Writable {
    isTTY = true
    override _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
  }
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const channel = makeChannel(makeRows())
  const tree = (
    <AlternateScreen>
      <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
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
  await sleep(900)

  const atBottom = () =>
    frames.length > 0 && frames[frames.length - 1]!.some(l => l.includes(BOTTOM_MARKER))
  // 若初始不在底部（理论上新会话 sticky 应在），wheel-down 找底
  let seek = 0
  while (!atBottom() && seek < 200) {
    stdin.write(`\x1b[<65;60;20M`)
    seek++
    await sleep(16)
  }
  await sleep(300)
  if (!atBottom()) throw new Error('probe setup failed: never reached the bottom')
  const S0 = frames[frames.length - 1]!
  const s0Index = frames.length - 1
  console.log(`settled at bottom, seekTicks=${seek}, frame#${s0Index}${STREAMING ? ', STREAMING 模式' : ''}`)

  const beforeWrites = writes.length
  const burstStartFrame = frames.length
  if (!STREAMING) {
    // 连续 wheel-down 12 格（真实 flick 节奏 ~30ms）
    for (let i = 0; i < 12; i++) {
      stdin.write(`\x1b[<65;60;20M`)
      await sleep(26)
    }
    await sleep(400) // 等全部 drain 落定
  } else {
    // 流式 + wheel-down 交错：4 条新消息逐字 chunk，同时 12 格 wheel-down
    let rowId = 1000
    const chunks = ['流式消息 A 的内容，'.repeat(3), '流式消息 B 的内容，'.repeat(3), '流式消息 C 的内容，'.repeat(3), '流式消息 D 的内容，'.repeat(3)]
    const streamer = setInterval(() => {
      const text = chunks.shift()
      if (!text) { clearInterval(streamer); return }
      channel.rows.push({ id: rowId++, kind: 'assistant', text, time: Date.now() })
      channel.bump()
    }, 140)
    for (let i = 0; i < 12; i++) {
      stdin.write(`\x1b[<65;60;20M`)
      await sleep(26)
    }
    await sleep(600)
    clearInterval(streamer)
    // 揭示动画追平 + settle
    let last = ''
    for (let i = 0; i < 60 && last !== (frames[frames.length - 1] ?? ['']).join('\n'); i++) {
      last = (frames[frames.length - 1] ?? ['']).join('\n')
      await sleep(120)
    }
    await sleep(300)
  }

  const burstFrames = frames.slice(burstStartFrame)
  if (!STREAMING) {
    const diffFrames = burstFrames.filter(lines => lines.some((l, r) => l !== S0[r]!))
    console.log(`burst 期间 stdout 写入 ${writes.length - beforeWrites} bytes, 新画面帧 ${burstFrames.length - 1} 个, 其中与底部稳定帧不同的帧 ${diffFrames.length} 个`)

    const firstDiff = diffFrames[0]
    if (firstDiff) {
      const diffs: string[] = []
      for (let r = 0; r < ROWS; r++) {
        if (firstDiff[r] !== S0[r]) {
          diffs.push(`row ${r}: S0|${S0[r]}\n      D |${firstDiff[r]}`)
        }
      }
      console.log('首个差异帧内容:')
      console.log(diffs.slice(0, 8).join('\n'))
    }

    const finalFrame = burstFrames[burstFrames.length - 1] ?? S0
    check(
      '回到底部后最终画面与稳定帧一致',
      !finalFrame.some((l, r) => l !== S0[r]),
    )
    check(
      '底部 wheel-down 期间零可见拖动帧',
      diffFrames.length === 0,
      `${diffFrames.length} 个帧画面被拖动/变化`,
    )
    check('底部 wheel-down 无多余 stdout 写入', writes.length - beforeWrites <= 0, `${writes.length - beforeWrites} bytes`)
  } else {
    // 流式期合法变化 = 新行从底部揭示出现；异常 = 整屏空白带 / 旧内容瞬移 /
    // 底部内容行号跳变后回弹（拖动）。
    const emptyFrames: number[] = []
    const blankBands: Array<{ idx: number; rows: number[] }> = []
    for (let i = 0; i < burstFrames.length; i++) {
      const lines = burstFrames[i]!
      const top = bottomContentRow(lines)
      if (top < 0) { emptyFrames.push(i); continue }
      // 转录区行 (≈0..ROWS-5)；统计内容空白带（连续空行夹在非空行之间）
      const band: number[] = []
      let inBand = false
      for (let r = 0; r <= top; r++) {
        const empty = lines[r]!.trim().length === 0
        if (empty && !inBand) { inBand = true; band.length = 0 }
        if (empty) band.push(r)
        if (!empty && inBand) {
          if (band.length >= 2) blankBands.push({ idx: i, rows: [...band] })
          inBand = false
        }
      }
    }
    console.log(`stream burst 期间 stdout 写入 ${writes.length - beforeWrites} bytes, 新画面帧 ${burstFrames.length - 1} 个`)
    check('流式+底部 wheel-down：无整屏空白帧', emptyFrames.length === 0, emptyFrames.join(','))
    check('流式+底部 wheel-down：转录区无 ≥2 行空白带', blankBands.length === 0, JSON.stringify(blankBands.slice(0, 4)))
    const tail = burstFrames[burstFrames.length - 1] ?? []
    check('流式+底部 wheel-down：终帧底部内容行贴近屏幕底部', bottomContentRow(tail) >= ROWS - 6, `top content row=${bottomContentRow(tail)}`)
    const paintedStream = burstFrames.some(lines => lines.some(l => l.includes('流式消息')))
    check('流式消息已进入画面（harness 自检）', paintedStream)
    const pillFrames = burstFrames.map((lines, i) => ({ i, pill: lines.some(l => l.includes('回到底部')) })).filter(x => x.pill)
    check('底部 wheel-down+流式期间「回到底部」pill 零闪现（sticky 不被误破）', pillFrames.length === 0, JSON.stringify(pillFrames.slice(0, 6)))
    console.log('burst writes bytes:', writes.length - beforeWrites)
  }

  await instance.unmount()
  instances.delete(process.stdout)
  term.dispose()
}

await main()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

/**
 * inline 重锚残影复现（用户现场：鲸鱼重影 + 文字压住输入框）。
 *
 * 触发链（真机 pty 抓帧确认）：
 *   1. inline 模式下帧高涨过视口 —— 溢出的行被推进终端原生 scrollback；
 *   2. 帧再缩回来 —— 终端不会把那些行拉回来，只在视口底部留一条空带；
 *   3. 空闲 >5s 后按键 —— ink.tsx 的 stdin-gap 自愈盲发一次 viewport 重锚
 *      （requestViewportReanchor），整屏 CSI H + ED0 后重画。
 *
 * 重锚若按「当前帧高」推算视口顶部对应的帧行，就会把已经进 scrollback 的
 * 那几行重新画回视口；下一次滚动再把它们推进去一份 —— 回滚区里出现重复
 * 的 logo/转录带，且后续写入按错位的行号落笔，糊住输入框。
 *
 * 视口顶部实际由帧高的**历史峰值**决定（log-update 的 State.peakHeight）。
 * 运行：node --import tsx/esm scripts/repro-reanchor-ghost.tsx
 */
process.env.FORCE_COLOR = '0'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { default: instances }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/ink/instances.js'),
  ])
const { useEffect, useState } = React
const { Box, Text } = await import('../src/ui.js')

const COLS = 60
const ROWS = 20
const TALL = 30
const SHRUNK = 26

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    term.write(String(chunk), cb)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

function allLines(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: buf.length }, (_, y) =>
    (buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
}

/** 每行内容唯一，出现两次即为残影。 */
function duplicatedRows(): Array<{ first: number; again: number; text: string }> {
  const hits: Array<{ first: number; again: number; text: string }> = []
  const seen = new Map<string, number>()
  allLines().forEach((line, index) => {
    if (line.trim() === '') return
    const prior = seen.get(line)
    if (prior === undefined) seen.set(line, index)
    else hits.push({ first: prior, again: index, text: line })
  })
  return hits
}

let setRows: ((n: number) => void) | undefined
function Probe(): React.ReactNode {
  const [count, setCount] = useState(TALL)
  useEffect(() => {
    setRows = setCount
  }, [])
  return (
    <Box flexDirection="column">
      {Array.from({ length: count }, (_, i) => (
        <Text key={i}>{`ROW ${String(i).padStart(2, '0')} ${'ab'.repeat(6)}${i}`}</Text>
      ))}
    </Box>
  )
}

const stdout = new FakeStdout()
const instance = await render(<Probe />, {
  stdout: stdout as never,
  stdin: new FakeStdin() as never,
  stderr: new FakeStderr() as never,
  exitOnCtrlC: false,
  patchConsole: false,
})
await sleep(300)

const ink = instances.get(stdout as never)
check('拿到 ink 实例', ink !== undefined)
check('起步无重复行', duplicatedRows().length === 0, `${duplicatedRows().length} 行`)

// 帧高 30 > 视口 20：溢出的行进 scrollback。再缩到 26，终端不会回滚。
setRows?.(SHRUNK)
await sleep(300)
const afterShrink = duplicatedRows()
check('缩回后无重复行', afterShrink.length === 0, `${afterShrink.length} 行`)

// 空闲后按键触发的盲重锚。真实路径是 ink.tsx 的 stdin-gap 自愈。
ink?.reanchorViewport()
setRows?.(SHRUNK - 1)
await sleep(300)
ink?.reanchorViewport()
setRows?.(SHRUNK)
await sleep(400)

const ghosts = duplicatedRows()
check('重锚后无重复行', ghosts.length === 0, `${ghosts.length} 行`)
for (const ghost of ghosts.slice(0, 8)) {
  console.log(`      行 ${ghost.first} 在 ${ghost.again} 重复: ${ghost.text.slice(0, 50)}`)
}

if (failed > 0) {
  const buf = term.buffer.active
  console.log(`\n=== buffer ${buf.length} 行 / 视口 ${ROWS}（V 为视口内） ===`)
  allLines().forEach((line, index) => {
    console.log(`${index >= buf.length - ROWS ? 'V' : ' '}${String(index).padStart(4)}|${line}`)
  })
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
await instance.unmount()
process.exit(failed === 0 ? 0 : 1)

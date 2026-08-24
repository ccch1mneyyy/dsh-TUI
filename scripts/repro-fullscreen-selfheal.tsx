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
 *   3. 注入 FOCUS_IN + 伪造 DECRPM "1049;2 reset" 应答 → 应用写回
 *      1049h + 2J → buffer 恢复 alternate；
 *   4. 反向：DECRPM 回答 "set"(1) 时不重进（不出现新的 2J）。
 *
 * 运行：node --import tsx/esm scripts/repro-fullscreen-selfheal.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen, Text, useInput }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
])

/** 输入管线开关：App 的 stdin 读循环随 raw-mode（useInput 消费者）启用，
 *  没有 useInput 的树不读 stdin——探针需要一个保活消费者。 */
function KeepAlive(): React.ReactElement {
  useInput(() => {})
  return null
}

const COLS = 80, ROWS = 24
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
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
check('挂载后 xterm 进入 alternate buffer', term.buffer.active.type === 'alternate', term.buffer.active.type)

// 模拟 conpty 模式重置：term.reset() 把 xterm 一切归零（含 1049）
writes.length = 0
term.reset()
check('term.reset() 后 buffer 掉回 normal（模拟 conpty 重置）', term.buffer.active.type === 'normal', term.buffer.active.type)

// 焦点回窗 → 触发探测；伪造 DECRPM 应答 1049;2（reset）
stdin.write('\x1b[I') // FOCUS_IN
await sleep(150)
check('FOCUS_IN 后发出 DECRQM 1049 探测', writes.some(w => w.includes('\x1b[?1049$p')),
  writes.filter(w => w.includes('$p')).map(w => JSON.stringify(w)).join(' ').slice(0, 60))
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

// 反向：再触发一次探测，应答 set(1) → 不得出现新的清屏重进
writes.length = 0
stdin.write('\x1b[I')
await sleep(150)
stdin.write('\x1b[?1049;1$y\x1b[?c\x1b[?c') // status 1 = set（双 DA1 同理）
await sleep(400)
check('应答 set 时不重进（无 2J）', !writes.some(w => w.includes('\x1b[2J')))
check('buffer 保持 alternate', term.buffer.active.type === 'alternate')

await inst.unmount()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

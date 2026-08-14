/**
 * Headless verification of the main-screen shrink repaint.
 *
 * Scenario (the user-reported bug): content taller than the viewport, then
 * the content shrinks. In main-screen mode the terminal viewport does NOT
 * follow the content bottom — a stale-offset incremental path would leave
 * old status rows behind and mix old/new characters on the same lines.
 *
 * 修复演进：旧方案是收缩帧发 full-reset（CSI 10000 S 清屏 + 整帧重打）——
 * 正确但每次把整份 UI 复制进 scrollback（issue #38/#39/#19 的"上滚看到
 * 重复渲染"即由此累积）。现方案就地重画视口（光标锚定在 park 行 → 上移
 * 到视口顶 → ED 清 → 重打帧尾窗口），零滚动、零 scrollback 沉积。
 * 本脚本因此从字节形态断言（必须发 CSI 10000S）升级为语义断言：用
 * xterm-headless 重建终端，验证收缩后【用户看到什么】。
 *
 * Checks:
 *  1. the shrink frame emits NO scroll-up clear (CSI n S) — no scrollback
 *     deposit — and NO ESC[2J/ESC[3J (those snap the Windows Terminal
 *     viewport to the top inside DEC 2026 sync blocks, claude-code #35580);
 *  2. after the shrink the viewport shows the tail of the 40-line content
 *     with the bottom-pinned marker on its last content row;
 *  3. no stale rows: lines 40..59 from the pre-shrink frame are gone from
 *     the viewport;
 *  4. no mixed/duplicated rows: every visible content line appears at most
 *     once, in ascending order.
 * Run: node scripts/verify-shrink.mjs
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm' // DEC-2026 路径，与真机一致

const { Writable, PassThrough } = await import('node:stream')
const React = await import('react')
const m = await import('@xterm/headless'); const XTerm = m.default?.Terminal ?? m.Terminal
const { render, Box, Text } = await import('../lib/types/ui.js')

const COLS = 100
const ROWS = 28

function makeStreams(term) {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      const str = String(chunk)
      stdout.frames.push(str)
      term.write(str, cb)
    },
  })
  stdout.columns = COLS
  stdout.rows = ROWS
  stdout.isTTY = true
  stdout.frames = []
  const stderr = new Writable({
    write(_c, _e, cb) {
      cb()
    },
  })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed = 1
}

// Render a tall list + a bottom marker; then shrink the list and verify the
// viewport the user actually sees (xterm-reconstructed).
{
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true })
  const { stdout, stderr, stdin } = makeStreams(term)
  const App = ({ lineCount }) =>
    React.createElement(
      Box,
      { flexDirection: 'column' },
      Array.from({ length: lineCount }, (_, i) =>
        React.createElement(Text, { key: `l${i}` }, `line ${i} padded content`),
      ),
      React.createElement(Text, null, 'BOTTOM_PINNED_MARKER'),
    )
  const instance = await render(React.createElement(App, { lineCount: 60 }), {
    stdout,
    stderr,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await sleep(500)
  const framesBefore = stdout.frames.length

  // Shrink: 60 -> 40 lines.
  instance.rerender(React.createElement(App, { lineCount: 40 }))
  await sleep(500)
  const shrinkBytes = stdout.frames.slice(framesBefore).join('')

  // 1. 无 scrollback 沉积、无 WT 跳顶序列。
  check(
    'shrink frame emits NO scroll-up clear (CSI n S)',
    !/\x1b\[\d*S/.test(shrinkBytes),
  )
  check(
    'shrink frame emits NO ESC[2J/ESC[3J',
    !/\x1b\[2J|\x1b\[3J/.test(shrinkBytes),
  )

  // 2-4. xterm 重建的视口语义断言。
  const buf = term.buffer.active
  const start = Math.max(0, buf.length - ROWS)
  const viewport = []
  for (let y = start; y < buf.length; y++) {
    viewport.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  }
  const markerRow = viewport.findIndex(l => l.includes('BOTTOM_PINNED_MARKER'))
  check('marker visible in viewport', markerRow >= 0)
  check(
    'marker is the last content row',
    markerRow >= 0 && viewport.slice(markerRow + 1).every(l => l === ''),
    `marker at ${markerRow}/${ROWS}`,
  )
  // 收缩后帧高 41 > 视口 28：视口应显示帧尾窗口（line 14..39 + marker），
  // 且 line 40..59（旧内容）一行都不许残留。
  const staleRows = viewport.filter(l => /line (4\d|5\d) padded/.test(l))
  check('no stale rows from the taller frame', staleRows.length === 0, staleRows.slice(0, 3).join(' | '))
  const nums = viewport
    .map(l => /^line (\d+) padded content$/.exec(l.trim()))
    .filter(Boolean)
    .map(m => Number(m[1]))
  const ascendingUnique = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)
  check('visible lines are consecutive and unique', ascendingUnique, nums.join(','))
  check(
    'tail window ends at line 39',
    nums.length > 0 && nums[nums.length - 1] === 39,
    `last=${nums[nums.length - 1]}`,
  )

  await instance.unmount()
}

process.exit(failed)

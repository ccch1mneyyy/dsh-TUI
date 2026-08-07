/**
 * Headless verification of the main-screen shrink repaint fix.
 *
 * Scenario (the user-reported bug): content taller than the viewport, then
 * the content shrinks. In main-screen mode the terminal viewport does NOT
 * follow the content bottom — incremental paths (eraseLines or scroll-up +
 * slice repaint) write rows at stale physical offsets, leaving old status
 * rows behind and mixing old/new characters on the same lines.
 *
 * The fix: on shrink in main-screen mode, full-repaint via a scroll-up-to-top
 * clear sequence (CSI 10000 S) — no ESC[2J/ESC[3J (those snap the Windows
 * Terminal viewport to the top inside DEC 2026 sync blocks, claude-code
 * #35580), scrollback preserved.
 *
 * Checks:
 *  1. the shrink frame emits the scroll-up clear (CSI 10000 S);
 *  2. the shrink frame emits NO ESC[2J / ESC[3J;
 *  3. the repainted frame contains the bottom-pinned marker text;
 *  4. the frame repaints ALL rows (full repaint, not a partial slice);
 *  5. the marker is in the LAST rows of the emitted frame (bottom-pinned).
 * Run: node scripts/verify-shrink.mjs
 */
process.env.FORCE_COLOR = '3'

const { Writable, PassThrough } = await import('node:stream')
const React = await import('react')
const { render } = await import('../lib/types/ui.js')
const { Box, Text } = await import('../lib/types/ui.js')

function makeStreams(rows = 28) {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      cb()
    },
  })
  stdout.columns = 100
  stdout.rows = rows
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
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failed = 1
}

// Render a tall list + a bottom marker; then shrink the list and verify the
// emitted frame handles the shrink without clearing the screen.
{
  const { stdout, stderr, stdin } = makeStreams()
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
  const first = stdout.frames.join('')
  check('initial frame has no clear sequence', !/\x1b\[2J\x1b\[3J/.test(first))

  // Shrink: 60 -> 40 lines. Main-screen shrink must FULLY repaint (partial
  // paths write at stale physical offsets → duplicated/mixed rows) via the
  // scroll-up clear sequence (no ESC[2J/3J → no WT viewport jump).
  instance.rerender(React.createElement(App, { lineCount: 40 }))
  await sleep(500)
  const shrink = stdout.frames[stdout.frames.length - 1]
  check(
    'shrink frame emits scroll-up-to-top clear',
    /\x1b\[10000S/.test(shrink),
  )
  check(
    'shrink frame emits NO ESC[2J/ESC[3J',
    !/\x1b\[2J|\x1b\[3J/.test(shrink),
  )
  check(
    'shrink frame repaints the marker',
    shrink.includes('BOTTOM_PINNED_MARKER'),
  )

  // The marker must be painted near the BOTTOM of the emitted content:
  // normalize cursor-right moves to spaces, strip ANSI, and check the marker
  // row index is in the last 2 rows of the frame's text lines.
  const toPlain = s =>
    s
      .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
      .replace(/\x1b\[[0-9;?>:]*[a-zA-Z]/g, '')
      .replace(/\x1b\]9;[^\x07]*\x07/g, '')
  check(
    'shrink frame repaints ALL rows (full repaint)',
    toPlain(shrink).includes('line 0 padded content') &&
      toPlain(shrink).includes('line 39 padded content'),
  )
  const plain = toPlain(shrink)
  const linesOut = plain.split('\n')
  const markerIdx = linesOut.findIndex(l => l.includes('BOTTOM_PINNED_MARKER'))
  check(
    `marker painted in last rows (found at ${markerIdx}/${linesOut.length})`,
    markerIdx >= linesOut.length - 2,
  )

  await instance.unmount()
}

process.exit(failed)

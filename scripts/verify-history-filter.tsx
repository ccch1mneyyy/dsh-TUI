/** Regression: duplicate history rows must disappear when filtering reaches zero results. */
process.env.DSH_TUI_LANG = 'zh'

import { PassThrough, Writable } from 'node:stream'
import React from 'react'
const [
  { Box, Text, render },
  { HistorySearchDialog },
  { OverlayAbove },
  { t },
  { Terminal },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/components/HistorySearchDialog.js'),
  import('../src/components/OverlayAbove.js'),
  import('../src/i18n.js'),
  import('@xterm/headless'),
])

const COLS = 100
const ROWS = 24
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })
class Out extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) { term.write(String(chunk), callback) }
}
class Err extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) { callback() }
}
class In extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const consoleErrors: string[] = []
const originalConsoleError = console.error
console.error = (...args: unknown[]) => {
  consoleErrors.push(args.map(String).join(' '))
}
const entries = Array.from({ length: 5 }, (_, index) => ({
  text: '你好',
  ts: Date.now() - index * 60_000,
}))

function Probe(): React.ReactNode {
  const [query, setQuery] = React.useState('')
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery('知道'), 300)
    return () => clearTimeout(timer)
  }, [])
  const matches = query === '' ? entries : entries.filter(entry => entry.text.includes(query))
  return React.createElement(
    Box,
    { height: ROWS, flexDirection: 'column' },
    React.createElement(Box, { flexGrow: 1 }),
    React.createElement(
      Box,
      { height: 1 },
      React.createElement(
        OverlayAbove,
        null,
        React.createElement(HistorySearchDialog, {
          query,
          cursorOffset: query.length,
          matches,
          focusIndex: 0,
        }),
      ),
      React.createElement(Text, null, 'prompt'),
    ),
  )
}

const app = await render(
  React.createElement(Probe),
  { stdout: new Out(), stderr: new Err(), stdin: new In(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(800)
const lines = Array.from({ length: ROWS }, (_, index) => term.buffer.active.getLine(index)?.translateToString(true) ?? '')
const staleLines = lines.filter(line => line.includes('你好'))
const emptyText = t('history-search-empty')
const emptyLine = lines.find(line => line.includes(emptyText))
app.unmount()
console.error = originalConsoleError

const ok = staleLines.length === 0 && emptyLine !== undefined && consoleErrors.length === 0
console.log(`${ok ? 'PASS' : 'FAIL'}: duplicate history rows are cleared after a zero-result filter`)
if (!ok) {
  console.error(JSON.stringify({ staleLines, emptyLine, consoleErrors }, null, 2))
  process.exit(1)
}

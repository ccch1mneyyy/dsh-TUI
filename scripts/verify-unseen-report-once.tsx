/**
 * Contract verifier for the #185 follow-up fix (MessageList unseen-count
 * report): onUnseenCount must fire ONLY when the reported count changes.
 *
 * Why this matters: the report calls the parent's setUnseenCount. Under dense
 * streaming commits, pending passive effects flush INSIDE the next commit, so
 * a same-value report dispatches an in-commit setState whose SyncLane stays
 * pending at the commit epilogue — React's nested-update counter climbs, and
 * 50+ consecutive dirty commits crash with React error #185 (post-#146 this
 * chain, not the measure tick, was the live one). The ref gate in MessageList
 * breaks it by never re-reporting an unchanged count.
 *
 * A/B: on unpatched HEAD every no-op commit re-reports (fails here); patched
 * reports the settled value once (passes). Production mode like the
 * measure-depth verifier.
 */
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { render } from '../src/ui.js'
import { MessageList } from '../src/components/MessageList.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class Output extends Writable {
  columns = 100
  rows = 30
  isTTY = true
  text = ''
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.text += String(chunk)
    callback()
  }
}
class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

// 30 settled rows (~2 terminal lines each) so plenty sit below the fold.
const rows = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  kind: (i % 2 ? 'assistant' : 'user') as 'assistant' | 'user',
  text: `row ${i + 1}\nsecond line of row ${i + 1}`,
  streaming: false,
}))
// Every row with id > 5 is "new"; rows past the viewport bottom count as unseen.
const ANCHOR_ID = 5

const reports: number[] = []
const props = {
  expanded: false,
  expandedRows: new Set<number>(),
  selectedId: null,
  onToggleRow: () => {},
  model: 'deepseek-chat',
  showAll: true,
  onToggleAll: () => {},
  newSinceRowId: ANCHOR_ID as number | null,
  onUnseenCount: (count: number) => { reports.push(count) },
}

const stdout = new Output()
const stderr = new Output()
const instance = await render(<MessageList rows={rows} {...props} />, {
  stdout,
  stderr,
  stdin: new Input(),
  exitOnCtrlC: false,
  patchConsole: false,
})

// Let measurements settle (heights land, base corrects, count stabilizes).
await sleep(500)
const settledLen = reports.length
const settledValue = reports[settledLen - 1]
if (settledLen === 0 || settledValue === undefined || settledValue <= 0) {
  console.error(`FAIL: expected a positive settled unseen count, got reports=${JSON.stringify(reports)}`)
  process.exit(1)
}

// Six no-op commits: identical tree, identical rows — nothing about the unseen
// count changes, so a correct report stays silent.
for (let i = 0; i < 6; i++) {
  instance.rerender(<MessageList rows={rows} {...props} />)
  await sleep(60)
}
const afterNoop = reports.length
if (afterNoop !== settledLen) {
  console.error(
    `FAIL: onUnseenCount re-reported ${afterNoop - settledLen} time(s) across no-op commits ` +
    `(values ${JSON.stringify(reports.slice(settledLen))}) — same-value in-commit setState ` +
    `is what drives the nested-update counter to React #185 under dense streaming`,
  )
  process.exit(1)
}

// A real change MUST still report exactly once: append a new row below the fold.
rows.push({ id: 31, kind: 'assistant', text: 'fresh row\nwith two lines', streaming: false })
instance.rerender(<MessageList rows={rows} {...props} />)
await sleep(300)
const finalLen = reports.length
if (finalLen !== settledLen + 1 || reports[finalLen - 1] === settledValue) {
  console.error(
    `FAIL: expected exactly one new report with a changed value after appending a row, ` +
    `got reports=${JSON.stringify(reports)} (settled at ${settledValue})`,
  )
  process.exit(1)
}

await instance.unmount()
const output = stdout.text + stderr.text
if (/Maximum update depth|Minified React error #185/.test(output)) {
  console.error('FAIL: nested measurement update loop detected')
  process.exit(1)
}
console.log(`PASS: unseen count reported on change only (settled=${settledValue}, after row append=${reports[finalLen - 1]})`)

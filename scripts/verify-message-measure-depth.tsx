import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { render } from '../src/ui.js'
import { MessageList } from '../src/components/MessageList.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class Output extends Writable {
  columns = 120
  rows = 36
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

let textRevision = 0
const rows = [{
  id: 1,
  kind: 'assistant' as const,
  get text(): string {
    textRevision = Math.min(60, textRevision + 1)
    return Array.from({ length: textRevision }, (_, line) => `measured line ${line}`).join('\n')
  },
  streaming: false,
}]

const stdout = new Output()
const stderr = new Output()
const stdin = new Input()
const instance = await render(<MessageList
  rows={rows}
  expanded={false}
  expandedRows={new Set()}
  selectedId={null}
  onToggleRow={() => {}}
  model="deepseek-chat"
  showAll
  onToggleAll={() => {}}
/>, {
  stdout,
  stderr,
  stdin,
  exitOnCtrlC: false,
  patchConsole: false,
})

const deadline = Date.now() + 2000
while (textRevision < 60 && Date.now() < deadline) await sleep(25)

await instance.unmount()
const output = stdout.text + stderr.text
if (/Maximum update depth|Minified React error #185/.test(output)) {
  console.error('FAIL: MessageList entered a nested measurement update loop')
  process.exit(1)
}
if (textRevision !== 60) {
  console.error(`FAIL: MessageList measurement stopped at revision ${textRevision}`)
  process.exit(1)
}
console.log('PASS: MessageList measurements settle without nested update overflow')

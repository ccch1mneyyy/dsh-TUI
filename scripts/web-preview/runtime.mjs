import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { render, AlternateScreen } from '../../lib/types/ui.js'
import { Chat } from '../../lib/types/screens/Chat.js'
import { QuestionStore } from '../../lib/types/dsh-adapter/questions.js'
import { setLang } from '../../lib/types/i18n.js'
import { createDemoChannel } from './demo-channel.mjs'

class TerminalInput extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

class TerminalOutput extends Writable {
  isTTY = true
  columns = 100
  rows = 32
  _write(chunk, _encoding, callback) { process.stdout.write(chunk, callback) }
}

const input = new TerminalInput()
const output = new TerminalOutput()
const channel = createDemoChannel()
let instance
let started = false
setLang('zh')

process.on('message', async message => {
  try {
    if (message.type === 'resize') {
      output.columns = message.cols
      output.rows = message.rows
      if (started) output.emit('resize')
      else {
        started = true
        instance = await render(
          React.createElement(AlternateScreen, null,
            React.createElement(Chat, { channel, questionStore: new QuestionStore(), onExit: () => process.exit(0) })),
          { stdout: output, stdin: input, stderr: process.stderr, exitOnCtrlC: false, patchConsole: false },
        )
        process.send?.({ type: 'ready' })
      }
    } else if (message.type === 'input' && instance) input.write(message.data)
  } catch (error) {
    process.stderr.write(`${error.stack}\n`)
    process.exit(1)
  }
})
process.on('disconnect', () => process.exit(0))

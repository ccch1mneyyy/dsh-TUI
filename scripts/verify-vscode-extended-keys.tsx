/** #1927: known stable VS Code capability, real App negotiation/input/cleanup.
 * Fake TTY and encoded keys; no claim of physical VS Code or WSL encoding.
 * Run: node --import tsx/esm scripts/verify-vscode-extended-keys.tsx
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import React, { useEffect } from 'react'
import xterm from '@xterm/headless'
import type { Key } from '../src/ink/events/input-event.js'
import { settled, viewportLines } from './lib/term-test.mjs'

if (process.argv[2] === '--fixture') {
  process.env.TERM_PROGRAM = 'vscode'
  process.env.TERM_PROGRAM_VERSION = process.argv[3]
  process.env.DSH_TUI_LANG = 'en'
  // Exercise the non-ConPTY branch on the Windows CI/local host too.
  process.env.DSH_TUI_DISABLE_WIN32_INPUT_MODE = '1'
  for (const name of ['WT_SESSION', 'NVIM', 'VIM_TERMINAL', 'DSH_TUI_FORCE_EXTENDED_KEYS', 'DSH_TUI_DISABLE_EXTENDED_KEYS']) delete process.env[name]
  const { render, Text, useInput } = await import('../src/ui.js')
  const { Terminal } = xterm
  class Output extends Writable {
    isTTY = true
    columns = 80
    rows = 24
    wire = ''
    terminal = new Terminal({ cols:80,rows:24,scrollback:0,allowProposedApi:true })
    _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void { this.wire += String(chunk); this.terminal.write(String(chunk),done) }
  }
  class Input extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    override ref(): this { return this }
    override unref(): this { return this }
  }
  const input = new Input()
  const output = new Output()
  const errors = new Output()
  const events: { text: string; key: Key }[] = []
  let mounted = false
  function Probe() {
    const [label,setLabel] = React.useState('keyboard fixture')
    useInput((text, key) => {
      events.push({ text, key })
      setLabel(`${key.return ? 'Enter' : text} shift=${Number(key.shift)} ctrl=${Number(key.ctrl)}`)
    })
    useEffect(() => { mounted = true }, [])
    return <Text>{label}</Text>
  }
  const app = await render(<Probe />, { stdin: input as never, stdout: output as never,
    stderr: errors as never, exitOnCtrlC: false, patchConsole: false })
  let report
  const screens:string[] = []
  try {
    assert.ok(await settled(() => mounted), JSON.stringify({ wire:output.wire,stderr:errors.wire }))
    assert.ok(await settled(() => viewportLines(output.terminal).some(line=>line.includes('keyboard fixture'))), 'actual painted fixture, not a raw-byte substring')
    const modern = process.argv[3] === '1.145.2'
    assert.equal(output.wire.includes('\x1b[>1u'), modern, 'Kitty push follows the capability gate')
    assert.equal(output.wire.includes('\x1b[>4;2m'), modern, 'retain the existing negotiation pair')
    if (modern) {
      for (const [sequence, expected] of [
        ['\x1b[13;2u', { return: true, shift: true, ctrl: false }],
        ['\x1b[13;5u', { return: true, shift: false, ctrl: true }],
        ['\x1b[99;5u', { return: false, shift: false, ctrl: true }],
      ] as const) {
        const before = events.length
        input.write(sequence)
        assert.ok(await settled(() => events.length === before + 1), 'one actual App input event')
        const event = events[before]!
        for (const [name, value] of Object.entries(expected)) assert.equal(event.key[name as keyof Key], value)
        assert.ok(!event.text.includes('u'), 'no encoded sequence suffix enters the draft')
        if (sequence === '\x1b[99;5u') assert.equal(event.text, 'c', 'Ctrl+C remains the control key')
        const marker = `${event.key.return ? 'Enter' : event.text} shift=${Number(event.key.shift)} ctrl=${Number(event.key.ctrl)}`
        assert.ok(await settled(() => viewportLines(output.terminal).some(line=>line.includes(marker))))
        screens.push(viewportLines(output.terminal).filter(line=>line.trim()!=='').join('\n'))
      }
    } else {
      input.write('\r')
      assert.ok(await settled(() => events.length === 1))
      assert.equal(events[0]!.key.return, true)
      assert.equal(events[0]!.key.shift, false)
      assert.equal(events[0]!.key.ctrl, false)
    }
    report = { version: process.argv[3], modern, screens, events: events.map(event => ({ text:event.text, return:event.key.return,shift:event.key.shift,ctrl:event.key.ctrl })) }
  } finally {
    app.unmount()
    // Xterm acknowledges writes asynchronously; keep it alive until the
    // actual mode-reset writes have drained through the Writable.
    const drained = await settled(() => output.writableLength === 0 && errors.writableLength === 0
      && output.wire.includes('\x1b[<u') && output.wire.includes('\x1b[>4m'))
    output.terminal.dispose()
    errors.terminal.dispose()
    assert.ok(drained, 'mode-reset writes acknowledged before terminal disposal')
  }
  assert.ok(output.wire.includes('\x1b[<u'), 'cleanup pops Kitty mode')
  assert.ok(output.wire.includes('\x1b[>4m'), 'cleanup disables modifyOtherKeys')
  console.log('@@VSCODE@@' + JSON.stringify(report))
} else {
  const { supportsExtendedKeys } = await import('../src/ink/terminal.js')
  for (const version of ['1.112.0', '1.112.1', '1.145.2']) {
    assert.equal(supportsExtendedKeys('vscode', { TERM_PROGRAM_VERSION: version }), true, `${version}: stable supported VS Code`)
  }
  for (const version of [undefined, '', '1.109.0', '1.110.0', '1.111.9', '1.112.0-insider', '6.0.0', 'unknown']) {
    assert.equal(supportsExtendedKeys('vscode', { TERM_PROGRAM_VERSION: version }), false, `${version}: retain legacy encoding`)
  }
  assert.equal(supportsExtendedKeys('vscode', { TERM_PROGRAM_VERSION:'1.145.2', DSH_TUI_DISABLE_EXTENDED_KEYS:'1' }), false)
  assert.equal(supportsExtendedKeys('vscode', { TERM_PROGRAM_VERSION:'6.0.0', DSH_TUI_FORCE_EXTENDED_KEYS:'1' }), true)
  assert.equal(supportsExtendedKeys('vscode', { TERM_PROGRAM_VERSION:'1.145.2', DSH_TUI_FORCE_EXTENDED_KEYS:'1', DSH_TUI_DISABLE_EXTENDED_KEYS:'1' }), false)
  assert.equal(supportsExtendedKeys('vscode', { TERM_PROGRAM_VERSION:'1.145.2', NVIM:'/private/editor.sock' }), false)
  assert.equal(supportsExtendedKeys('vscode', { TERM_PROGRAM_VERSION:'1.145.2', VIM_TERMINAL:'1' }), false)
  for (const version of ['1.145.2', '1.111.9', '6.0.0']) {
    const stdout = await new Promise<string>((resolve,reject) => {
      execFile(process.execPath, ['--import','tsx/esm',fileURLToPath(import.meta.url),'--fixture',version],
        { timeout:15000, windowsHide:true, env:{...process.env} }, (error,out,err) => {
          if (error !== null) reject(new Error(`${version}: ${error.message}\n${out}\n${err}`))
          else resolve(String(out))
        })
    })
    const line = stdout.split(/\r?\n/u).find(text=>text.includes('@@VSCODE@@'))
    assert.ok(line, `${version}: actual child result`)
    console.log('PASS App ' + line.slice(line.indexOf('@@VSCODE@@')+10))
  }
  console.log('VS Code extended keys OK (16 gate cases,3 real App routes)')
}

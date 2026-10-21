/**
 * Windows copy ordering and stdin transport with controlled child processes.
 * Run after compiling: node scripts/verify-windows-copy.mjs
 * Does not access the system clipboard; native Windows validation is separate.
 */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { setImmediate as nextTurn } from 'node:timers/promises'

const savedSpawn = childProcess.spawn
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
const savedEnv = { SSH_CONNECTION: process.env.SSH_CONNECTION, TMUX: process.env.TMUX }
const children = []
childProcess.spawn = (file, args, options) => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  let input = ''
  child.stdin.write = value => { input += value }
  child.stdin.end = () => {}
  children.push({ file, args, options, child, input: () => input })
  return child
}
syncBuiltinESMExports()
Object.defineProperty(process, 'platform', { value: 'win32' })
delete process.env.SSH_CONNECTION
delete process.env.TMUX

try {
  const { setClipboard } = await import('../lib/types/ink/termio/osc.js')
  const payload = "中文 日本語 😀 e\u0301\n'`$()"
  const emitted = []
  const first = setClipboard(payload).then(value => emitted.push(value))
  const second = setClipboard('B').then(value => emitted.push(value))
  await nextTurn()
  assert.equal(children.length, 1, 'B waits for A, including A native write')
  assert.equal(emitted.length, 0, 'OSC 52 waits for the native process')
  assert.equal(children[0].input(), payload)
  assert.equal(children[0].file, 'powershell.exe')
  assert.equal(children[0].options.timeout, 2000)
  assert.ok(children[0].args.includes('-STA'))
  assert.ok(children[0].args.at(-1).includes('UTF8Encoding'))
  assert.ok(!children[0].args.join(' ').includes(payload), 'text is stdin only')
  children[0].child.emit('close', 0)
  await nextTurn()
  assert.equal(children.length, 2)
  assert.equal(emitted.length, 1)
  assert.ok(emitted[0].includes(Buffer.from(payload).toString('base64')))
  children[1].child.emit('close', null) // Native timeout/failure.
  await nextTurn()
  assert.equal(children.length, 3)
  assert.equal(children[2].file, 'pwsh.exe')
  assert.equal(children[2].input(), 'B')
  children[2].child.emit('error', new Error('ENOENT'))
  await Promise.all([first, second])
  assert.equal(emitted.length, 2, 'B still emits OSC 52 after both failures')
  assert.ok(emitted[1].includes(Buffer.from('B').toString('base64')))

  process.env.SSH_CONNECTION = 'fixture'
  const ssh = await setClipboard('remote')
  assert.equal(children.length, 3, 'SSH never starts a native clipboard writer')
  assert.ok(ssh.includes(Buffer.from('remote').toString('base64')))
  process.env.TMUX = 'fixture'
  const tmux = setClipboard('tmux')
  await nextTurn()
  assert.equal(children[3].file, 'tmux')
  children[3].child.emit('close', 0)
  assert.ok((await tmux).startsWith('\x1bPtmux;'))
} finally {
  childProcess.spawn = savedSpawn
  syncBuiltinESMExports()
  Object.defineProperty(process, 'platform', platform)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
console.log('verify-windows-copy: all checks passed')

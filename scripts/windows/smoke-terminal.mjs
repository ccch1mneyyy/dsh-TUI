/** Exercise shipped Windows native modules inside a caller-supplied isolated installation. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const prefix = resolve(process.argv[2])
const require = createRequire(join(prefix, 'node_modules/@deepseek-ai/dsh/package.json'))
const pty = require('node-pty')
const koffi = require('koffi')
const library = koffi.load('kernel32.dll')
assert.ok(library.func('unsigned int GetCurrentProcessId()')() > 0)
library.unload()

await new Promise((complete, reject) => {
  const child = pty.spawn(process.env.ComSpec, ['/d', '/c', 'echo DSH_PTY_SMOKE_OK'], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env: process.env,
  })
  let output = ''
  const timer = setTimeout(() => { child.kill(); reject(new Error('ConPTY smoke timed out')) }, 15_000)
  child.onData(data => { output += data })
  child.onExit(({ exitCode }) => {
    clearTimeout(timer)
    try { assert.equal(exitCode, 0); assert.match(output, /DSH_PTY_SMOKE_OK/); complete() }
    catch (error) { reject(error) }
  })
})
console.log('ConPTY and Koffi native runtime: OK')
// node-pty's Windows bridge retains native handles after onExit. This standalone
// verifier has observed the child exit and has no further work or buffered files.
process.exit(0)

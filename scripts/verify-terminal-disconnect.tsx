/**
 * PTY loss must settle waitUntilExit and release component/input resources.
 * Run: node --import tsx/esm scripts/verify-terminal-disconnect.tsx
 * Linux PTY cases use Python's standard-library pty module, without tmux or a backend.
 */
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import React, { useEffect } from 'react'
import { render, Text, AlternateScreen, useInput } from '../src/ui.js'
import App from '../src/ink/components/App.js'
import instances from '../src/ink/instances.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
class Input extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(raw: boolean) { this.isRaw = raw; return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  isTTY = true
  columns = 40
  rows = 12
  writes = 0
  failure: Error | undefined
  _write(_chunk: unknown, _encoding: BufferEncoding, done: (error?: Error) => void) { this.writes++; done(this.failure) }
}

if (process.argv.includes('--pty-child')) {
  let cleaned = false
  function Probe() {
    useInput(() => {})
    useEffect(() => () => { cleaned = true }, [])
    return React.createElement(Text, null, 'terminal disconnect')
  }
  const child = React.createElement(Probe)
  const tree = process.env.PROBE_FULLSCREEN === '1'
    ? React.createElement(AlternateScreen, { mouseTracking: true }, child) : child
  const syncUnmount = process.env.PROBE_SYNC_UNMOUNT === '1'
  const input = syncUnmount ? new Input() : process.stdin
  const instance = await render(tree, { stdin: input as never, patchConsole: false, exitOnCtrlC: false })
  if (syncUnmount) process.once('SIGUSR2', () => instance.unmount())
  await tick()
  const ink = instances.get(process.stdout)
  assert.ok(ink?.app)
  const app = ink.app
  app.lastStdinTime = Date.now() - 6000
  process.stderr.write('READY\n')
  const timeout = setTimeout(() => { process.stderr.write('EXIT TIMEOUT\n'); process.exit(2) }, 5000)
  await instance.waitUntilExit()
  clearTimeout(timeout)
  assert.equal(cleaned, true)
  // A revoked device can reject tcsetattr; Node's isRaw cache then stays true.
  assert.equal(app.rawModeEnabledCount, 0)
  assert.equal(input.listenerCount('readable'), 0)
  process.stderr.write('CLEAN EXIT\n')
  process.exit(0)
}

// EOF-like readable event after idle must not reassert; actual input must still do so.
{
  const stdin = new Input()
  let resumes = 0
  const app = new App({ stdin, ownsStdin: () => true, onStdinResume: () => { resumes++ } } as unknown as ConstructorParameters<typeof App>[0])
  app.lastStdinTime = Date.now() - 6000
  app.handleReadable()
  assert.equal(resumes, 0, 'empty readable must not reassert terminal modes')
  app.processInput = () => {}
  stdin.write('x')
  app.lastStdinTime = Date.now() - 6000
  app.handleReadable()
  assert.equal(resumes, 1, 'real input after idle still reasserts')
  stdin.destroy()
}
console.log('PASS EOF versus real input')

// A non-TTY file's I/O failure is not a terminal hangup.
{
  const stdin = new PassThrough()
  const stdout = new Output()
  stdout.isTTY = false
  const instance = await render(React.createElement(Text, null, 'file output'), {
    stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false,
  })
  const exit = instance.waitUntilExit()
  const error = Object.assign(new Error('file EIO'), { code: 'EIO' })
  assert.throws(() => stdout.emit('error', error), error)
  instance.unmount()
  await exit
  stdin.destroy()
  stdout.destroy()
  console.log('PASS non-TTY I/O errors remain fatal')
}

for (const fullscreen of [false, true]) {
  for (const loss of ['end', 'stdin-EIO', 'stdout-EIO', 'stdout-EPIPE', 'stdout-close']) {
    const stdin = new Input()
    const stdout = new Output()
    let cleanups = 0
    function Probe() {
      useInput(() => {})
      useEffect(() => () => { cleanups++ }, [])
      return React.createElement(Text, null, 'probe')
    }
    const child = React.createElement(Probe)
    const tree = fullscreen ? React.createElement(AlternateScreen, { mouseTracking: true }, child) : child
    const instance = await render(tree, { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, patchConsole: false, exitOnCtrlC: false })
    const exit = instance.waitUntilExit()
    await tick()
    const ink = instances.get(stdout as never)
    assert.ok(ink)
    const writes = stdout.writes
    if (loss === 'end') stdin.end()
    else if (loss === 'stdout-close') stdout.destroy()
    else {
      const error = Object.assign(new Error(loss), { code: loss.endsWith('EPIPE') ? 'EPIPE' : 'EIO' })
      if (loss.startsWith('stdin')) stdin.emit('error', error)
      else { stdout.failure = error; stdout.write('pending frame') }
    }
    let timeout: ReturnType<typeof setTimeout>
    try {
      await Promise.race([exit, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('exit did not settle')), 1500) })])
    } finally { clearTimeout(timeout!) }
    assert.equal(cleanups, 1)
    assert.equal(stdin.isRaw, false)
    assert.equal(stdin.listenerCount('readable'), 0)
    assert.equal(stdin.listenerCount('end'), 0)
    assert.equal(instances.get(stdout as never), undefined)
    ink.reassertTerminalModes()
    stdout.emit('resize')
    assert.equal(stdout.writes, writes + (loss === 'stdout-EIO' || loss === 'stdout-EPIPE' ? 1 : 0), 'no writes after disconnect, including cleanup')
    // Errors from writes queued before shutdown must remain handled.
    stdout.emit('error', Object.assign(new Error('late EIO'), { code: 'EIO' }))
    assert.throws(() => stdout.emit('error', Object.assign(new Error('other failure'), { code: 'ENOSPC' })), /other failure/)
    stdin.destroy()
    stdout.destroy()
    console.log(`PASS ${fullscreen ? 'fullscreen' : 'inline'} ${loss}`)
  }
}

// Real kernel EOF/error ordering, including narrow terminals. No controlling
// terminal or process-group signal: this isolates device loss from SIGHUP.
if (process.platform === 'linux') {
  const python = `
import os,pty,subprocess,select,time,fcntl,termios,struct,sys,tempfile,signal
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',12,int(sys.argv[2]),0,0))
with tempfile.TemporaryFile() as errors:
 p=subprocess.Popen([sys.argv[1],'--import','tsx/esm','scripts/verify-terminal-disconnect.tsx','--pty-child'],stdin=slave,stdout=slave,stderr=errors)
 os.close(slave)
 deadline=time.monotonic()+10
 while time.monotonic()<deadline and p.poll() is None:
  if select.select([master],[],[],.05)[0]:
   try: os.read(master,65536)
   except OSError: break
  errors.seek(0)
  if b'READY' in errors.read(): break
 os.close(master)
 if os.environ.get('PROBE_SYNC_UNMOUNT')=='1': os.kill(p.pid,signal.SIGUSR2)
 try: p.wait(timeout=8)
 except subprocess.TimeoutExpired: p.kill();p.wait();raise
 errors.seek(0);log=errors.read().decode();print(log)
 assert p.returncode==0,(p.returncode,log)
 assert 'CLEAN EXIT' in log,log
`
  for (const fullscreen of ['0', '1']) for (const width of ['40', '100']) for (const syncUnmount of ['0', '1']) {
    const result = spawnSync('python3', ['-c', python, process.execPath, width], {
      env: { ...process.env, PROBE_FULLSCREEN: fullscreen, PROBE_SYNC_UNMOUNT: syncUnmount, TERM: 'xterm-256color', TERM_PROGRAM: 'ghostty' },
      encoding: 'utf8', timeout: 25000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    console.log(`PASS real PTY fullscreen=${fullscreen} width=${width} syncUnmount=${syncUnmount}`)
  }
}

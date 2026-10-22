/** Native Windows acceptance for #929; Node 24, no package install or build.
 * Run: node scripts/verify-update-process-windows.mjs
 * Linux/macOS report SKIP (never Windows PASS). --check only checks the minimal
 * source compilation/import; it does not execute Win32 APIs.
 * An independent native guard owns every disposable worker and descendant,
 * including failure paths. Only the production runInstallerProcess is tested.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const script = fileURLToPath(import.meta.url)
const repository = resolve(dirname(script), '..')
const signalNames = ['SIGINT', 'SIGTERM', 'SIGHUP']
const report = (name, details) => console.log(JSON.stringify({ case: name, ...details }))
const read = path => existsSync(path) ? readFileSync(path, 'utf8') : ''
async function until(predicate, label, timeout = 5000) {
  const started = performance.now()
  while (!predicate()) {
    assert.ok(performance.now() - started < timeout, label)
    await delay(40)
  }
}
function compile(root) {
  // Compile only the production dependency closure. Imports remain the source's
  // own relative .js imports; builtins are untouched and no implementation is mocked.
  const compiled = new Set()
  function visit(relative) {
    if (compiled.has(relative)) return
    compiled.add(relative)
    const input = join(repository, 'src', relative.replace(/\.js$/u, '.ts'))
    const output = join(root, 'lib', 'types', relative)
    const code = stripTypeScriptTypes(readFileSync(input, 'utf8'), { mode: 'strip' })
    for (const match of code.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+\.js)\1/gu)) {
      visit(join(dirname(relative), match[2]))
    }
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, code)
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  visit('updateProcess.js')
  mkdirSync(join(root, 'assets'), { recursive: true })
  for (const name of ['windows-installer.ps1', 'windows-installer.cs']) {
    copyFileSync(join(repository, 'assets', name), join(root, 'assets', name))
  }
  return { moduleUrl: pathToFileURL(join(root, 'lib/types/updateProcess.js')).href, files: [...compiled] }
}
const payload = `
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [mode, directory, ...args] = process.argv.slice(2)
if (mode === 'normal' || mode === 'nonzero') {
  console.log('Done')
  process.stderr.write('diagnostic\\n')
  process.exitCode = mode === 'nonzero' ? 7 : 0
} else if (mode === 'fragmented') {
  const bytes = Buffer.from('中文 café 😀\\n')
  process.stdout.write(bytes.subarray(0, 1))
  process.stderr.write(bytes.subarray(0, 2))
  setTimeout(() => { process.stdout.write(bytes.subarray(1)); process.stderr.write(bytes.subarray(2)) }, 80)
} else if (mode === 'argv') {
  console.log(JSON.stringify(args))
} else if (mode === 'stdin') {
  const input = readFileSync(0, 'utf8')
  process.stdout.write('stdout:' + input)
  process.stderr.write('stderr:' + input)
} else if (mode === 'must-not-run') {
  writeFileSync(join(directory, 'payload-ran'), 'unsafe')
} else if (mode === 'unrelated') {
  writeFileSync(join(directory, 'unrelated.ready'), String(process.pid))
  setInterval(() => appendFileSync(join(directory, 'unrelated.ticks'), '.'), 60)
} else if (mode === 'root') {
  writeFileSync(join(directory, 'root.pid'), String(process.pid))
  // Avoid libuv's own non-detached child kill job: these descendants must
  // survive their Node parent while remaining in the production Windows job.
  const child = spawn(process.execPath, [import.meta.filename, 'child', directory], { stdio: 'inherit', detached: true })
  child.unref()
  const wait = setInterval(() => {
    if (existsSync(join(directory, 'grandchild.ready'))) {
      clearInterval(wait)
      writeFileSync(join(directory, 'root.exiting'), 'root exits before descendants')
      console.log('ROOT_EXITING')
      process.exit(0)
    }
  }, 20)
} else if (mode === 'child') {
  writeFileSync(join(directory, 'child.pid'), String(process.pid))
  const grandchild = spawn(process.execPath, [import.meta.filename, 'grandchild', directory], { stdio: 'inherit', detached: true })
  grandchild.unref()
  setInterval(() => appendFileSync(join(directory, 'child.ticks'), '.'), 60)
} else if (mode === 'grandchild') {
  writeFileSync(join(directory, 'grandchild.pid'), String(process.pid))
  writeFileSync(join(directory, 'grandchild.ready'), 'ready')
  setInterval(() => {
    appendFileSync(join(directory, 'grandchild.ticks'), '.')
    process.stdout.write('grandchild alive\\n')
    process.stderr.write('grandchild diagnostic\\n')
  }, 60)
} else throw new Error('Unknown payload mode: ' + mode)
`
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
async function worker(root, mode) {
  // The guard assigns this waiting process before any disposable child starts.
  await until(() => existsSync(join(root, mode + '.go')), 'guard did not assign worker', 10000)
  const { runInstallerProcess } = await import(pathToFileURL(join(root, 'lib/types/updateProcess.js')).href)
  const fixtureDirectory = join(root, 'installer path with spaces 演示')
  mkdirSync(fixtureDirectory, { recursive: true })
  const fixture = join(fixtureDirectory, 'installer payload.mjs')
  writeFileSync(fixture, payload)
  process.stdout.write('')
  process.stderr.write('')
  const baseline = () => signalNames.map(signal => process.listenerCount(signal))
  const resources = () => {
    const names = process.getActiveResourcesInfo()
    return ['ProcessWrap', 'PipeWrap', 'Timeout'].map(kind => names.filter(name => name === kind).length)
  }
  async function run(name, args, options = {}, command = process.execPath) {
    const events = []
    let stdout = ''
    let stderr = ''
    const before = baseline()
    const resourcesBefore = resources()
    const started = performance.now()
    const result = await runInstallerProcess(command, args, {
      category: name, timeoutMs: 20000, terminationGraceMs: 150,
      onStdout: text => { stdout += text },
      onStderr: text => { stderr += text },
      ...options,
      onEvent: event => { events.push(event); options.onEvent?.(event) },
    })
    assert.deepEqual(baseline(), before, name + ': signal listeners released')
    assert.equal(events.filter(event => event.stage === 'close').length, 1, name + ': one settlement')
    await until(() => resources().every((count, index) => count <= resourcesBefore[index]), name + ': process/pipe/timer handles released')
    report(name, { result, elapsedMs: Math.round(performance.now() - started), events, stdout, stderr })
    return { result, events, stdout, stderr }
  }
  if (mode === 'restricted') {
    const result = await run('restricted-job-supervisor-launch-denied', [fixture, 'must-not-run', fixtureDirectory])
    assert.equal(result.result, 127)
    assert.ok(result.events.some(event => event.stage === 'error' || event.stage === 'cleanup-error'))
    assert.equal(result.events.some(event => event.stage === 'start'), false, 'denied supervisor launch never reports installer start')
    assert.ok(result.events.every(event => event.pid === undefined), 'denied supervisor launch never invents an installer PID')
    assert.equal(existsSync(join(fixtureDirectory, 'payload-ran')), false, 'denied launch never executes installer')
    report('restricted-job', { status: 'PASS', scope: 'Native outer job process limit denies supervisor launch; this is not an AssignProcessToJobObject failure test' })
    return
  }
  const unrelated = spawn(process.execPath, [fixture, 'unrelated', root], { stdio: 'ignore' })
  const unrelatedClosed = new Promise((resolveClose, reject) => {
    unrelated.once('close', resolveClose)
    unrelated.once('error', reject)
  })
  try {
    await until(() => existsSync(join(root, 'unrelated.ready')), 'unrelated process startup')
    const preAborted = new AbortController()
    preAborted.abort()
    const preEvents = []
    assert.equal(await runInstallerProcess(process.execPath, [fixture, 'must-not-run', root], { category: 'pre-aborted', signal: preAborted.signal, onEvent: event => preEvents.push(event) }), 130)
    assert.equal(preEvents.some(event => event.stage === 'start'), false)
    assert.equal(existsSync(join(root, 'payload-ran')), false)
    report('pre-aborted', { status: 'PASS', events: preEvents })
    const missing = await run('missing-executable', [], {}, join(root, 'missing-installer.exe'))
    assert.equal(missing.result, 127)
    assert.equal(missing.events.some(event => event.stage === 'start'), false)
    const normal = await run('normal-exit', [fixture, 'normal', root])
    assert.equal(normal.result, 0)
    assert.match(normal.stdout, /Done/u)
    assert.match(normal.stderr, /diagnostic/u)
    assert.match(normal.events.find(event => event.stage === 'start')?.message ?? '', /membership verified.*inheritance disabled/u, 'real helper verified job membership and noninheritable handle')
    assert.equal((await run('nonzero-exit', [fixture, 'nonzero', root])).result, 7)
    const fragmented = await run('fragmented-utf8-output', [fixture, 'fragmented', root])
    assert.equal(fragmented.result, 0)
    assert.equal(fragmented.stdout, '中文 café 😀\n')
    assert.equal(fragmented.stderr, '中文 café 😀\n')
    const cmd = join(fixtureDirectory, 'launcher spaces 演示.cmd')
    writeFileSync(cmd, '@echo off\r\n"' + process.execPath + '" "%~dp0installer payload.mjs" argv unused %*\r\n', 'utf8')
    const argumentsToCheck = ['argument with spaces', '中文 café', 'plain']
    const argv = await run('cmd-unicode-spaces', argumentsToCheck, { shell: true }, cmd)
    assert.equal(argv.result, 0)
    assert.deepEqual(JSON.parse(argv.stdout.trim()), argumentsToCheck)
    const wrapper = join(root, 'stdin-wrapper.mjs')
    writeFileSync(wrapper, `import { runInstallerProcess } from ${JSON.stringify(pathToFileURL(join(root, 'lib/types/updateProcess.js')).href)}\nprocess.exitCode = await runInstallerProcess(process.execPath, [${JSON.stringify(fixture)}, 'stdin', 'unused'], { category: 'stdin', timeoutMs: 20000, onStdout: text => process.stdout.write(text), onStderr: text => process.stderr.write(text) })\n`)
    const input = 'inherited stdin: 中文 with spaces\n'
    const stdin = spawnSync(process.execPath, [wrapper], { input, encoding: 'utf8', timeout: 30000 })
    assert.ifError(stdin.error)
    assert.equal(stdin.status, 0, stdin.stderr)
    assert.equal(stdin.stdout, 'stdout:' + input)
    assert.equal(stdin.stderr, 'stderr:' + input)
    report('inherited-stdin-stdout-stderr', { status: 'PASS', inputBytes: Buffer.byteLength(input) })
    for (const reason of ['timeout', 'cancel', 'supervisor-crash']) {
      const directory = join(root, reason)
      mkdirSync(directory)
      const controller = new AbortController()
      let triggerError
      const beforeTreeResources = resources()
      const trigger = (async () => {
        try {
          await until(() => existsSync(join(directory, 'root.exiting')) && read(join(directory, 'grandchild.ticks')).length >= 3, reason + ': root/descendants startup', 18000)
          const rootPid = Number(read(join(directory, 'root.pid')))
          await until(() => !alive(rootPid), reason + ': root really exited')
          assert.ok(alive(Number(read(join(directory, 'child.pid')))), 'child survives root')
          assert.ok(alive(Number(read(join(directory, 'grandchild.pid')))), 'grandchild survives root')
          if (reason === 'cancel') controller.abort()
          if (reason === 'supervisor-crash') writeFileSync(join(root, 'fault.request'), 'terminate only pinned owned supervisor')
        } catch (error) { triggerError = error; controller.abort() }
      })()
      const outcome = await run('root-first-' + reason, [fixture, 'root', directory], {
        timeoutMs: 20000,
        signal: controller.signal,
      })
      await trigger
      await until(() => resources().every((count, index) => count <= beforeTreeResources[index]), reason + ': process/pipe/timer resources converge after trigger')
      if (triggerError) throw triggerError
      if (reason === 'supervisor-crash') {
        assert.notEqual(outcome.result, 0)
        assert.ok(outcome.events.some(event => event.stage === 'cleanup-error'), 'abnormal supervisor reports unconfirmed cleanup')
        assert.ok(existsSync(join(root, 'fault.done')), 'native exact-handle fault executed')
      } else {
        assert.equal(outcome.result, reason === 'timeout' ? 124 : 130)
        assert.equal(outcome.events.some(event => event.stage === 'cleanup-error'), false, 'owned job cleanup confirmed')
        assert.ok(outcome.events.some(event => event.stage === reason && event.pid > 0 && event.lastOutputAt > 0))
      }
      assert.match(outcome.stdout, /ROOT_EXITING/u)
      assert.match(outcome.stderr, /grandchild diagnostic/u)
      for (const role of ['child', 'grandchild']) {
        await until(() => !alive(Number(read(join(directory, role + '.pid')))), reason + ': ' + role + ' terminated')
        const ticks = read(join(directory, role + '.ticks'))
        assert.ok(ticks.length > 0, role + ' was active before cancellation')
        await delay(400)
        assert.equal(read(join(directory, role + '.ticks')), ticks, role + ' marker stopped')
      }
      const before = read(join(root, 'unrelated.ticks')).length
      await delay(200)
      assert.equal(unrelated.exitCode, null, 'unrelated Node process stays alive')
      assert.ok(read(join(root, 'unrelated.ticks')).length > before, 'unrelated process keeps making progress')
      report('root-first-' + reason + '-convergence', { status: 'PASS', descendantsStopped: true, unrelatedAlive: true })
    }
  } finally {
    if (unrelated.exitCode === null) unrelated.kill()
    await unrelatedClosed
  }
  report('native-windows-worker', { status: 'PASS', nesting: 'production job inside independent guard job' })
}

if (process.argv[2] === '--worker') {
  try { await worker(process.argv[3], process.argv[4]) } catch (error) {
    console.error(error.stack)
    process.exitCode = 1
  }
} else if (process.platform !== 'win32' && !process.argv.includes('--check')) {
  report('native-windows', { status: 'SKIP', platform: process.platform, reason: 'Real Win32 Job Object acceptance requires Windows; no native checks executed' })
} else {
  const root = mkdtempSync(join(tmpdir(), 'dsh-windows-installer-'))
  let nativePassed = false
  try {
    const compilation = compile(root)
    const production = await import(compilation.moduleUrl)
    assert.equal(typeof production.runInstallerProcess, 'function')
    if (process.argv.includes('--check')) {
      report('minimal-source-compile-import', { status: 'PASS', files: compilation.files })
      report('native-windows', { status: 'SKIP', reason: '--check does not execute Win32 acceptance' })
    } else {
      report('native-environment', { platform: process.platform, node: process.version, architecture: process.arch })
      for (const mode of ['normal', 'restricted', 'native-denial']) {
        const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repository, 'scripts/fixtures/update-process-windows/harness.ps1'), '-NodePath', process.execPath, '-ScriptPath', script, '-RootPath', root, '-Mode', mode], { stdio: 'inherit', timeout: mode === 'normal' ? 255000 : 75000, windowsHide: true })
        assert.ifError(result.error)
        assert.equal(result.status, 0, mode + ' native guard/worker failed')
      }
      nativePassed = true
    }
  } catch (error) {
    console.error(error.stack)
    process.exitCode = 1
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  if (nativePassed) report('native-windows', { status: 'PASS', productionRunner: true, nativeJobs: true })
}

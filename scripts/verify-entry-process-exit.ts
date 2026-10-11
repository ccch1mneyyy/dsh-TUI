/**
 * The standalone entry's signal/process ownership (src/dsh-adapter/process-exit.ts),
 * each case in a child process that receives a real signal; the root dispose
 * during profile composition (src/dsh-adapter/root-dispose.ts) on a Cordis
 * root whose plugin is still applying; and the `dsh --profile` delegation's
 * signal mirroring.
 *
 * Run: node --import tsx/esm scripts/verify-entry-process-exit.ts
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

if (process.argv[2] === '--child') {
  const { installEntrySignals, dieBySignal } = await import('../src/dsh-adapter/process-exit.js')
  const mode = process.argv[3]
  const say = (line: string): void => { process.stdout.write(`${line}\n`) }
  const seam: import('../src/dsh-adapter/process-exit.js').ProcessExitSeam = {}
  if (mode === 'exiting') {
    seam.request = request => {
      say(`request ${request.kind === 'signal' ? request.signal : request.code}`)
      // The funnel's tail: restore, dispose, then die by the signal.
      setTimeout(() => { say('funnel done'); if (request.kind === 'signal') dieBySignal(request.signal) }, 100)
      return 'exiting'
    }
  } else if (mode === 'busy' || mode === 'stalled') {
    seam.request = () => { say('request'); return 'exiting' }
  } else if (mode === 'supervising') {
    seam.request = () => { say('request'); return 'supervising' }
  } else if (mode === 'refused') {
    seam.request = () => 'refused'
  }
  if (mode === 'foreign') process.on('SIGTERM', () => { say('foreign listener') })
  installEntrySignals({
    seam,
    disposeRoot: async () => { say('dispose'); await new Promise(resolve => setTimeout(resolve, 50)) },
    log: event => { say(`log ${event}`) },
  })
  say('ready')
  // Kept alive by a timer, as the real process is by its screen.
  setInterval(() => undefined, 1000)
} else {
  type Outcome = { code: number | null; signal: NodeJS.Signals | null; out: string; ms: number }
  const runChild = (mode: string, send: (child: ReturnType<typeof spawn>) => void, timeoutMs = 15000): Promise<Outcome> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), '--child', mode], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    let sentAt = 0
    const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${mode}: child did not end; output:\n${out}`)) }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const ready = !out.includes('ready') && (out + chunk).includes('ready')
      out += chunk
      if (ready) { sentAt = Date.now(); send(child) }
    })
    child.on('exit', (code, signal) => { clearTimeout(killer); resolve({ code, signal, out, ms: Date.now() - sentAt }) })
  })

  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    const unowned = await runChild('none', child => { child.kill(signal) })
    check(`no owner, ${signal}: the root is disposed, then the process ends by ${signal}`,
      unowned.signal === signal && unowned.code === null && unowned.out.includes('dispose'), unowned)
  }
  const refused = await runChild('refused', child => { child.kill('SIGTERM') })
  check('a refusing owner (tree torn down): the entry disposes the root itself and ends by the signal',
    refused.signal === 'SIGTERM' && refused.out.includes('dispose'), refused)

  const owned = await runChild('exiting', child => { child.kill('SIGINT') })
  check('the funnel takes SIGINT: no fallback dispose, the process ends by SIGINT after the funnel',
    owned.signal === 'SIGINT' && owned.out.includes('request SIGINT') && owned.out.includes('funnel done') && !owned.out.includes('dispose'), owned)

  const second = await runChild('busy', child => { child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGTERM') }, 200) })
  check('a second signal forces the exit at once while the owner is still busy',
    second.signal === 'SIGTERM' && second.out.includes('second signal') && second.ms < 2000, second)

  const stalled = await runChild('stalled', child => { child.kill('SIGHUP') })
  check('an owner that never ends the process: the backstop ends it by the signal (after the dispose bound)',
    stalled.signal === 'SIGHUP' && stalled.out.includes('backstop') && stalled.ms >= 5000, stalled)

  const supervising = await new Promise<{ alive: boolean; out: string }>(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), '--child', 'supervising'], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const ready = !out.includes('ready') && (out + chunk).includes('ready')
      out += chunk
      if (ready) child.kill('SIGTERM')
    })
    setTimeout(() => {
      const alive = child.exitCode === null && child.signalCode === null
      child.kill('SIGTERM') // the second signal ends it
      child.on('exit', () => { resolve({ alive, out }) })
      if (!alive) resolve({ alive, out })
    }, 7500)
  })
  check('a supervising owner arms no backstop (the replacement decides; a second signal still ends it)', supervising.alive && supervising.out.includes('request'), supervising)

  const foreign = await runChild('foreign', child => { child.kill('SIGTERM') })
  check('a foreign SIGTERM listener cannot keep the process alive', foreign.signal === 'SIGTERM' && foreign.out.includes('foreign listener'), foreign)

  // ── a root dispose while the profile composes ─────────────────────────
  // The dispose waits for the tracked composition (a plugin still applying)
  // to settle, then runs; a failed or finished composition no longer holds it.
  {
    const { Context } = await import('@deepseek-ai/cordis')
    const { disposeRootSettled, trackComposition } = await import('../src/dsh-adapter/root-dispose.js')
    const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))
    const ctx = new Context()
    const log: string[] = []
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    const applying = ctx.plugin({
      name: 'slow-composition',
      apply: async (context: import('@deepseek-ai/cordis').Context) => {
        context.effect(() => () => { log.push('plugin disposed') })
        await gate
        log.push('applied')
      },
    } as never)
    const composition = trackComposition(ctx, () => applying)
    const disposed = disposeRootSettled(ctx, () => { log.push('dispose'); return ctx.root.fiber.dispose() })
    await tick()
    check('a dispose waits while the composition applies, and marks it disposing',
      log.length === 0 && composition.disposing, log)
    open()
    await disposed
    check('the dispose runs once the composition settled, and tears the plugin down',
      log.join(',') === 'applied,dispose,plugin disposed', log)
    composition.done()

    const failing = new Context()
    trackComposition(failing, () => Promise.reject(new Error('activation failed')))
    let ran = false
    await disposeRootSettled(failing, async () => { ran = true })
    check('a failed composition does not block the dispose', ran)

    const settledRoot = new Context()
    const stale = trackComposition(settledRoot, () => new Promise(() => undefined))
    const current = trackComposition(settledRoot, () => new Promise(() => undefined))
    stale.done()
    let waited = true
    void disposeRootSettled(settledRoot, async () => { waited = false })
    check('a superseded tracker\'s done() leaves the current one in force', waited && current.disposing)
    current.done()
    let immediate = false
    void disposeRootSettled(settledRoot, async () => { immediate = true })
    check('after done() (or untracked) the dispose runs at once', immediate)
  }

  // ── delegateToDsh (DSH without the in-entry path) ─────────────────────
  // The entry mirrors a fake `dsh`'s exit (by the signal when dsh died by one)
  // and forwards a SIGTERM sent to it alone.
  const sandbox = mkdtempSync(join(tmpdir(), 'verify-entry-delegate-'))
  const bin = join(sandbox, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'dsh'), `#!/bin/sh
case "$FAKE_DSH" in
  sig*) kill -"\${FAKE_DSH#sig}" $$ ; sleep 5 ;;
  wait) trap 'echo dsh-got-term; exit 0' TERM; echo dsh-ready; while :; do sleep 0.1; done ;;
esac
`)
  chmodSync(join(bin, 'dsh'), 0o755)
  const runDelegate = (fake: string, send?: (child: ReturnType<typeof spawn>) => void): Promise<Outcome> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', join(here, '../src/dsh-adapter/host-entry.ts')], {
      stdio: ['ignore', 'pipe', 'inherit'],
      cwd: join(here, '..'),
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: sandbox,
        DSH_HOME: join(sandbox, '.dsh'),
        DSH_TUI_BACKEND: 'dsh',
        FAKE_DSH: fake,
      },
    })
    let out = ''
    const startedAt = Date.now()
    const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`delegate ${fake}: did not end; output:\n${out}`)) }, 20000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const ready = !out.includes('dsh-ready') && (out + chunk).includes('dsh-ready')
      out += chunk
      if (ready) send?.(child)
    })
    child.on('exit', (code, signal) => { clearTimeout(killer); resolve({ code, signal, out, ms: Date.now() - startedAt }) })
  })
  for (const signal of ['INT', 'TERM', 'HUP'] as const) {
    const outcome = await runDelegate(`sig${signal}`)
    check(`delegate: dsh dies by SIG${signal}, the entry dies by it too (not 0)`, outcome.signal === `SIG${signal}` && outcome.code === null, outcome)
  }
  const forwarded = await runDelegate('wait', child => { child.kill('SIGTERM') })
  check('delegate: SIGTERM to the entry alone reaches dsh, whose exit the entry mirrors', forwarded.out.includes('dsh-got-term') && forwarded.code === 0, forwarded)

  // Two past bugs with no cheap behavioural repro: a non-DSH kernel downgraded
  // to DSH, and the codex hub pool left open when the funnel never filled.
  const entry = readFileSync(join(here, '../src/dsh-adapter/host-entry.ts'), 'utf8')
  check('the entry runs the kernel its route found, not a literal backend', /await runInEntry\(entryKernel\(/u.test(entry))
  check('the entry\'s own dispose closes the backend resources the funnel also closes', /await unloadBackends\(\)/u.test(entry))

  console.log(`\nverify-entry-process-exit: ${passed} checks passed`)
}

/**
 * Real Chat + Channel UI lease regression for migration hints during shutdown.
 * Drives only the 12s/10s hint deadlines; React scheduling and the migration
 * scan stay real. Covers active, unmount, detach and in-flight scan cancellation
 * in inline and fullscreen modes, with isolated foreign-agent stores.
 * Run: node --import tsx/esm scripts/verify-migrate-hint-lifecycle.tsx
 */
import assert from 'node:assert/strict'
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

const fixtureHome = mkdtempSync(join(tmpdir(), 'verify-migrate-hint-'))
process.env.HOME = fixtureHome
process.env.USERPROFILE = fixtureHome
process.env.DSH_HOME = join(fixtureHome, '.dsh')
process.env.GROK_HOME = join(fixtureHome, '.grok')
process.env.DSH_TUI_LANG = 'zh'
process.env.FORCE_COLOR = '0'
const projectDir = join(fixtureHome, '.claude', 'projects', 'fixture')
mkdirSync(projectDir, { recursive: true })
writeFileSync(join(projectDir, 'recent-session.jsonl'), '{}\n')

const [React, { render, AlternateScreen }, { Chat }, { createChannel },
  { mountChannelUi }, { registerTuiChannel }, { bindChannelCommands },
  { QuestionStore }, { finishExit }, { EXIT_ALT_SCREEN },
  { collectActivitySamples, recentAgentsFrom }, { MIGRATION_ADAPTERS },
  { MIGRATE_SCAN_SPECS }] = await Promise.all([
  import('react'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel-ui.js'),
  import('../src/adapter/channel/host-registry.js'),
  import('../src/dsh-adapter/channel/commands.js'),
  import('../src/channel/questions.js'),
  import('../src/dsh-adapter/plugin.js'),
  import('../src/ink/termio/dec.js'),
  import('../src/dsh-adapter/migrate/recent-agents.js'),
  import('../src/dsh-adapter/migrate/index.js'),
  import('../src/dsh-adapter/migrate/picker.js'),
])

assert.equal(recentAgentsFrom(collectActivitySamples(
  MIGRATION_ADAPTERS, adapter => MIGRATE_SCAN_SPECS[adapter.id],
), Date.now())[0]?.agentId, 'claude-code')

// Capture only hint-related deadlines, leaving renderer and shutdown timers
// untouched. Clear/fire use the same handles as production effect cleanup.
const setTimer = globalThis.setTimeout
const clearTimer = globalThis.clearTimeout
const timers = new Map<ReturnType<typeof setTimeout>, { delay: number; fire(): void }>()
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
  if (delay !== 12_000 && delay !== 10_000) return setTimer(callback, delay, ...args)
  const timer = setTimer(() => {}, 2_147_483_647).unref()
  timers.set(timer, { delay, fire: () => callback(...args) })
  return timer
}) as typeof setTimeout
globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
  timers.delete(timer as ReturnType<typeof setTimeout>)
  clearTimer(timer)
}) as typeof clearTimeout
function fireDeadline(delay: number): void {
  for (const [timer, entry] of [...timers]) {
    if (entry.delay !== delay) continue
    timers.delete(timer)
    clearTimer(timer)
    entry.fire()
  }
}

class VirtualStdout extends Writable {
  isTTY = true
  columns = 40
  rows = 24
  chunks: string[] = []
  fd = openSync(join(fixtureHome, 'terminal.ansi'), 'w')
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
    this.chunks.push(String(chunk))
    done()
  }
}
class VirtualStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
}

const originalStdout = process.stdout
try {
  for (const fullscreen of [false, true]) {
    for (const scenario of ['active', 'unmount', 'detach', 'inflight']) {
      const ctx = {
        on: () => () => undefined,
        get: () => undefined,
        logger: { warn() {}, info() {}, debug() {} },
      }
      const session = {
        ref: { backendId: 'fake', sessionId: 'hint-fixture' },
        cwd: fixtureHome, status: 'idle' as const, capabilities: { native: {} },
        history: async () => [], subscribe: () => () => undefined,
        submit: async () => { assert.fail('fixture must never submit') },
        cancel: async () => ({ stillQueued: [], outcome: 'confirmed' as const }),
        dispose: async () => undefined,
      }
      const raw = createChannel(ctx as never, session, {
        model: 'fixture', provider: '', cwd: fixtureHome,
        activity: false, whale: false, whaleIdle: false, minimalUi: true,
      })
      let hints = 0
      const notify = raw.notify
      raw.notify = (text, options) => {
        if (text.includes('Claude Code')) hints += 1
        return notify(text, options)
      }
      const unregister = registerTuiChannel(ctx, raw)
      const mount = mountChannelUi(ctx, raw, undefined, 'new')
      bindChannelCommands(raw, mount.channel)
      let revoked = false
      const revoke = () => {
        if (revoked) return
        revoked = true
        mount.dispose()
        unregister()
        raw.releaseContributions()
      }
      const stdout = new VirtualStdout()
      Object.defineProperty(process, 'stdout', { value: stdout, configurable: true })
      let mounted: () => void
      const ready = new Promise<void>(resolve => { mounted = resolve })
      let cleaned = false
      function Probe() {
        React.useEffect(() => {
          mounted()
          return () => { cleaned = true }
        }, [])
        return <Chat channel={mount.channel} questionStore={new QuestionStore()}
          onExit={() => { assert.fail('unexpected user exit') }}
          fullscreen={fullscreen} openHomeOnBoot={false} launchpadOnBoot={false}
          onboardingOnBoot={false} starPrompt={null} />
      }
      const instance = await render(fullscreen ? <AlternateScreen><Probe /></AlternateScreen> : <Probe />, {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new VirtualStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false, patchConsole: false,
      })
      try {
        await ready
        assert.equal([...timers.values()].filter(timer => timer.delay === 12_000).length, 1)
        if (scenario === 'active' || scenario === 'inflight') {
          fireDeadline(12_000)
        }
        if (scenario === 'active') {
          await new Promise(resolve => setImmediate(resolve))
          assert.equal(hints, 1, 'active hint must still be delivered')
          assert.ok([...timers.values()].some(timer => timer.delay === 10_000))
        }
        if (scenario === 'unmount') {
          instance.unmount()
          await new Promise(resolve => setImmediate(resolve))
          revoke()
        } else if (scenario === 'inflight') {
          // The scan has been queued, but its promise has not resumed yet.
          instance.detachForShutdown()
          revoke()
        } else {
          const outputBeforeExit = stdout.chunks.length
          await finishExit(ctx as never, instance, fullscreen, undefined, undefined, () => {
            revoke()
            instance.unmount()
          }, { keepAltScreen: fullscreen })
          assert.ok(!stdout.chunks.slice(outputBeforeExit).join('').includes(EXIT_ALT_SCREEN),
            'handoff cleanup must preserve the alternate screen')
        }
        assert.equal(cleaned, true, 'shutdown must run React cleanup')
        fireDeadline(12_000)
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(hints, scenario === 'active' ? 1 : 0, 'no hint may arrive after shutdown')
        assert.equal(timers.size, 0, 'shutdown must clear hint and dismissal timers')
      } finally {
        instance.detachForShutdown()
        revoke()
        instance.cleanup()
        closeSync(stdout.fd)
        Object.defineProperty(process, 'stdout', { value: originalStdout, configurable: true })
      }
      console.log('PASS ' + (fullscreen ? 'fullscreen' : 'inline') + ' ' + scenario)
    }
  }
} finally {
  globalThis.setTimeout = setTimer
  globalThis.clearTimeout = clearTimer
  for (const timer of timers.keys()) clearTimer(timer)
  Object.defineProperty(process, 'stdout', { value: originalStdout, configurable: true })
  rmSync(fixtureHome, { recursive: true, force: true })
}

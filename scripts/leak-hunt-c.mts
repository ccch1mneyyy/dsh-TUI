/**
 * leak-hunt-c.mts — Phase C: FULL render path (real Ink loop + Chat tree)
 * with a black-hole fake stdout. Reproduces the real-terminal heap growth
 * without needing a terminal.
 *
 * Usage: node --expose-gc --import tsx/esm packages/ui/cc-tui/scripts/leak-hunt-c.mts [rounds]
 */
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import v8 from 'node:v8'
import React from 'react'

process.env.DSH_HOME = resolve(homedir(), '.dsh-cc')
const workspace = resolve(import.meta.dirname, '../../../..')
const dshHome = process.env.DSH_HOME
const ROUNDS = Number(process.argv[2] ?? 10)

try {
  const t = readFileSync(join(workspace, '.env'), 'utf8')
  const m = t.match(/^DEEPSEEK_API_KEY=(.*)$/m)
  if (m) process.env.DEEPSEEK_API_KEY = m[1].trim()
} catch {}

// --- Fake TTY stdout: swallow all bytes, report a fixed geometry ---
// SLOW_MODE: simulate a slow terminal (Windows ConPTY) — delayed consumption
// creates backpressure if the renderer doesn't honor write() return values.
const SLOW_MODE = process.env.SLOW_TTY === '1'
class FakeStdout extends Writable {
  columns = 120
  rows = 40
  isTTY = true
  private emitter = new EventEmitter()
  _write(_chunk: any, _enc: any, cb: () => void) {
    if (SLOW_MODE) setTimeout(cb, 20) // 20ms per write ≈ slow conhost
    else cb()
  }
  on(event: string, fn: any) { this.emitter.on(event, fn); return this }
  off(event: string, fn: any) { this.emitter.off(event, fn); return this }
  write(...args: any[]) { super.write(args[0], args[1], args[2]); return true }
}

const { boot, healProfilesModuleFallback, loadOverlayPatches } =
  await import('@deepseek-ai/dsh-app-boot')
const { SessionId } = await import('@deepseek-ai/dsh-session')

const patches = [
  ...loadOverlayPatches('dsh', resolve(workspace, 'packages/bundle/base/cordis.patch.yml')),
  ...loadOverlayPatches('dsh', resolve(workspace, 'packages/activity/working-activity/cordis.patch.yml')),
  ...loadOverlayPatches('dsh', resolve(workspace, 'packages/ui/cc-tui/cordis.patch.yml')),
  { id: 'dsh-tui', disabled: true },
]
healProfilesModuleFallback(resolve(workspace, 'apps/cli/package.json'))
writeFileSync(join(dshHome, 'profiles/dsh-tui/cordis.yml'), '[]\n')

console.error(`[leakC] rounds=${ROUNDS} booting...`)
const ctx = await boot('dsh', join(dshHome, 'profiles/dsh-tui/cordis.yml'), patches, async () => {})
const agents = ctx.get('agents')

const handle = await agents.create({
  sessionId: SessionId(randomUUID()),
  meta: { cwd: workspace },
  agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
})
const agent = handle.agent

const { createChannel } = await import('../src/channel.ts')
const channel = createChannel(ctx, agent, {
  model: 'deepseek-v4-flash',
  cwd: workspace,
  provider: 'deepseek-official',
  handle,
})

// Real Ink render loop against the fake stdout
const { render, ThemeProvider } = await import('../src/ui.ts')
const { Chat } = await import('../src/screens/Chat.tsx')
const fakeOut = new FakeStdout() as unknown as NodeJS.WriteStream
const tree = React.createElement(
  ThemeProvider,
  null,
  React.createElement(Chat, { channel, onExit: () => {} }),
)
const instance = await render(tree, {
  stdout: fakeOut,
  exitOnCtrlC: false,
  patchConsole: false,
} as any)
console.error('[leakC] Ink render loop started (fake stdout)')

const snapshotDir = join(dshHome, 'leak-snapshots')
mkdirSync(snapshotDir, { recursive: true })
function takeSnapshot(tag: string) {
  v8.writeHeapSnapshot(join(snapshotDir, `heapC-${tag}.heapsnapshot`))
}
function sampleHeap(tag: string): number {
  globalThis.gc?.(); globalThis.gc?.()
  const heap = process.memoryUsage().heapUsed
  console.error(`[leakC] ${tag}: heap=${(heap / 1024 / 1024).toFixed(1)}MB`)
  return heap
}

const samples: number[] = []
sampleHeap('boot')
takeSnapshot('boot')

for (let round = 1; round <= ROUNDS; round++) {
  // Realistic workload: tool call + long thinking + long markdown reply
  channel.submit(`Round ${round}: run 'git log --oneline -5' with bash, then explain in detail (with markdown code blocks) what each commit does.`)
  await new Promise<void>((r) => {
    const off = ctx.on('session/event', (_s: any, e: any) => {
      if (e.type === 'turn/end') { off(); setTimeout(r, 800) }
    })
    setTimeout(r, 120000)
  })
  // Let the render loop drain a few frames
  await new Promise((r) => setTimeout(r, 500))
  samples.push(sampleHeap(`round-${round}`))
  if (round === Math.floor(ROUNDS / 2)) takeSnapshot('mid')
}

takeSnapshot('end')
instance.unmount()

const first = samples[0]
const last = samples[samples.length - 1]
const growthPerRound = (last - first) / Math.max(1, samples.length - 1) / 1024
console.error(`[leakC] first=${(first / 1024 / 1024).toFixed(1)}MB last=${(last / 1024 / 1024).toFixed(1)}MB`)
console.error(`[leakC] growth: ${growthPerRound.toFixed(0)}KB/round`)
console.error(`[leakC] trend: ${samples.map((s) => (s / 1024 / 1024).toFixed(0)).join(' -> ')}`)
console.error(`[leakC] ${growthPerRound > 512 ? '❌ LEAK CONFIRMED' : growthPerRound > 100 ? '⚠️ SUSPICIOUS' : '✅ STABLE'}`)
process.exit(0)

/**
 * leak-hunt.mts — reproduce the dsh-cc long-session heap growth.
 *
 * Two phases:
 *   A) core runtime only (agent-loop + session, no channel/TUI)
 *   B) runtime + createChannel (render path, no actual terminal)
 *
 * Sends N rounds of real LLM messages, samples heapUsed after each round
 * (with --expose-gc, forces GC before sampling). Linear growth = leak.
 *
 * Usage:
 *   node --expose-gc --import tsx/esm packages/ui/cc-tui/scripts/leak-hunt.mts [phase] [rounds]
 */
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import v8 from 'node:v8'

process.env.DSH_HOME = resolve(homedir(), '.dsh-cc')
const workspace = resolve(import.meta.dirname, '../../../..')
const dshHome = process.env.DSH_HOME
const phase = process.argv[2] ?? 'A'
const ROUNDS = Number(process.argv[3] ?? 15)

try {
  const t = readFileSync(join(workspace, '.env'), 'utf8')
  const m = t.match(/^DEEPSEEK_API_KEY=(.*)$/m)
  if (m) process.env.DEEPSEEK_API_KEY = m[1].trim()
} catch {}

const { boot, healProfilesModuleFallback, loadOverlayPatches } =
  await import('@deepseek-ai/dsh-app-boot')
const { SessionId } = await import('@deepseek-ai/dsh-session')
const { createUserMessage } = await import('@deepseek-ai/dsh-llm')

const patches = [
  ...loadOverlayPatches('dsh', resolve(workspace, 'packages/bundle/base/cordis.patch.yml')),
  ...loadOverlayPatches('dsh', resolve(workspace, 'packages/activity/working-activity/cordis.patch.yml')),
  ...loadOverlayPatches('dsh', resolve(workspace, 'packages/ui/cc-tui/cordis.patch.yml')),
  { id: 'dsh-tui', disabled: true },
]
healProfilesModuleFallback(resolve(workspace, 'apps/cli/package.json'))
writeFileSync(join(dshHome, 'profiles/dsh-tui/cordis.yml'), '[]\n')

console.error(`[leak] phase=${phase} rounds=${ROUNDS} booting...`)
const ctx = await boot('dsh', join(dshHome, 'profiles/dsh-tui/cordis.yml'), patches, async () => {})
const agents = ctx.get('agents')

const snapshotDir = join(dshHome, 'leak-snapshots')
writeFileSync(join(snapshotDir + '.marker'), '') // ensure dir parent exists
const { mkdirSync } = await import('node:fs')
mkdirSync(snapshotDir, { recursive: true })

function takeSnapshot(tag: string): string {
  const file = join(snapshotDir, `heap-${tag}.heapsnapshot`)
  v8.writeHeapSnapshot(file)
  return file
}

function sampleHeap(tag: string): number {
  globalThis.gc?.()
  globalThis.gc?.()
  const heap = process.memoryUsage().heapUsed
  console.error(`[leak] ${tag}: heap=${(heap / 1024 / 1024).toFixed(1)}MB`)
  return heap
}

const samples: number[] = []

// --- Phase A: core only, direct agent use ---
const handle = await agents.create({
  sessionId: SessionId(randomUUID()),
  meta: { cwd: workspace },
  agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
})
const agent = handle.agent

// --- Phase B: wrap in channel (render path) ---
let channel: any = null
if (phase === 'B') {
  const { createChannel } = await import('../src/channel.ts')
  channel = createChannel(ctx, agent, {
    model: 'deepseek-v4-flash',
    cwd: workspace,
    provider: 'deepseek-official',
    handle,
  })
  channel.subscribe(() => {}) // simulate TUI re-render subscription
  console.error('[leak] channel created')
}

sampleHeap('boot')
takeSnapshot('boot')

for (let round = 1; round <= ROUNDS; round++) {
  const prompt = `Round ${round}: count from 1 to 30 with commas.`
  if (channel) {
    channel.submit(prompt)
  } else {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
  }
  // Wait for turn end
  await new Promise<void>((r) => {
    const off = ctx.on('session/event', (_s: any, e: any) => {
      if (e.type === 'turn/end') { off(); setTimeout(r, 500) }
    })
    setTimeout(r, 60000)
  })
  const heap = sampleHeap(`round-${round}`)
  samples.push(heap)
  if (round === Math.floor(ROUNDS / 2)) takeSnapshot('mid')
}

takeSnapshot('end')

// Growth analysis
const first = samples[0]
const last = samples[samples.length - 1]
const growthPerRound = (last - first) / (samples.length - 1) / 1024
console.error(`[leak] first=${(first / 1024 / 1024).toFixed(1)}MB last=${(last / 1024 / 1024).toFixed(1)}MB`)
console.error(`[leak] growth: ${growthPerRound.toFixed(0)}KB/round`)
console.error(`[leak] trend: ${samples.map((s) => (s / 1024 / 1024).toFixed(0)).join(' -> ')}`)
if (growthPerRound > 512) {
  console.error('[leak] ❌ LEAK CONFIRMED (>512KB/round after GC)')
} else if (growthPerRound > 100) {
  console.error('[leak] ⚠️ SUSPICIOUS growth (100-512KB/round)')
} else {
  console.error('[leak] ✅ STABLE (<100KB/round)')
}
console.error(`[leak] snapshots in ${snapshotDir}`)
process.exit(0)

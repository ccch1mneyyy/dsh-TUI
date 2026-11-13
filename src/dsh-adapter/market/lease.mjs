/** Coordinate application-owned updates with processes using this profile. */
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withLegacyFileLock } from './prepare.mjs'
import { liveRuntimeProcesses, ownedDirectory, runtimeStatus } from './runtime-profile.mjs'

export const name = 'dsh-tui-runtime-lease'
const startupKey = Symbol.for('dsh-tui.runtime-startup-lease')

export async function apply(ctx) {
  const profile = ctx.get('profileContext')
  // A directly composed development host has no managed profile to lease.
  if (profile === undefined) {
    ctx.provide('tuiRuntimeLease', {})
    return
  }
  const dir = realpathSync(profile.dir)
  const startup = globalThis[startupKey]
  if (startup !== undefined && (startup.dir !== dir || startup.pid !== process.pid)) {
    throw new Error('The TUI startup lease belongs to a different profile')
  }
  const lease = startup?.lease ?? await acquireLease({ ...profile, dir })
  if (startup !== undefined) delete globalThis[startupKey]
  try {
    ctx.effect(() => lease.dispose, 'dsh-tui runtime lease')
    ctx.provide('tuiRuntimeLease', { profileDir: profile.dir })
  } catch (error) {
    await lease.dispose()
    throw error
  }
}

/** Own the actual application PID before loading any profile dependencies. */
export async function acquireStartupLease(profileDir) {
  if (globalThis[startupKey] !== undefined) throw new Error('The TUI startup lease is already active')
  const dir = realpathSync(profileDir)
  const lease = await acquireLease({ dir })
  const startup = { dir, pid: process.pid, lease }
  globalThis[startupKey] = startup
}

async function acquireLease({ dir, installAnchor }) {
  let atomicPath
  try { if (installAnchor !== undefined) atomicPath = createRequire(installAnchor).resolve('@deepseek-ai/dsh-atomic-write') }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  }
  const atomic = atomicPath === undefined ? undefined : await import(pathToFileURL(atomicPath).href)
  const withFileLock = typeof atomic?.withFileLock === 'function' ? atomic.withFileLock : withLegacyFileLock
  const owned = ownedDirectory(dir)
  await mkdir(owned, { recursive: true, mode: 0o700 })
  const token = randomUUID()
  // The kernel closes this marker on SIGKILL too. A reused PID or port cannot
  // answer with the old token; no stale timestamp or OS-specific process probe.
  const marker = createServer(socket => {
    socket.on('error', () => {})
    socket.setTimeout(2000, () => socket.destroy())
    socket.unref()
    socket.end(`${token}\n`)
  })
  await new Promise((resolve, reject) => {
    marker.once('error', reject)
    marker.listen(0, '127.0.0.1', () => { marker.removeListener('error', reject); resolve() })
  })
  marker.unref()
  const port = marker.address().port
  const closeMarker = () => new Promise(resolve => marker.close(resolve))
  const record = join(owned, 'running.json')
  const writeRecord = async entries => {
    const data = `${JSON.stringify(entries)}\n`
    if (typeof atomic?.writeFileAtomic === 'function') {
      return atomic.writeFileAtomic(record, data, { mode: 0o600 })
    }
    // Readers must see a complete ledger even on hosts without atomic helpers.
    const temporary = `${record}.${token}.tmp`
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
      await rename(temporary, record)
    } finally { await rm(temporary, { force: true }) }
  }
  const update = operation => withFileLock(join(owned, 'setup.json'), async () => {
    const entries = operation(await liveRuntimeProcesses(dir, { keepUnverified: true }))
    await writeRecord(entries)
  }, { waitMs: 120000 })
  try {
    await update(entries => {
      if (!runtimeStatus(dir).ready) throw new Error('The TUI runtime profile is incomplete; run dsh-tui to repair it')
      return [...entries, { pid: process.pid, token, port }]
    })
    let disposal
    return { dispose: () => disposal ??= (async () => {
      try { await update(entries => entries.filter(entry => entry.token !== token)) }
      finally { await closeMarker() }
    })() }
  } catch (error) {
    await closeMarker()
    throw error
  }
}

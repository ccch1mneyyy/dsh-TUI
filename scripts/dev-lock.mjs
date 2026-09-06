#!/usr/bin/env node
/**
 * Interprocess mutex for the dev loop (scripts/dev-test.mjs). Concurrent
 * `pnpm dev` runs sharing one DSH_TUI_DEV_ROOT are not safe: tsc writes to
 * lib/, the fingerprint cache, the shared packageRoot cleanup, and
 * `dsh plugin add` would race each other. The lock is held for the
 * build/pack/install phase and released before the TUI launches, so a second
 * run never waits on an interactive session.
 *
 * mkdir is atomic on POSIX and Windows. Staleness is detected only for locks
 * whose owner is gone (dead pid) or not yet written (pid file missing beyond
 * a grace window) — a live owner is never evicted by age: waiters time out
 * with a clear remedy instead of risking a concurrent build. release() is
 * ownership-checked via a per-acquisition token, so a run can never remove
 * another run's lock (the check-then-remove window is documented, and far
 * smaller than the mis-release cascade it prevents).
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LOCK_DIR = 'dev-loop.lock'
const POLL_MS = 250
// A lock directory without a pid file is only treated as fresh within this
// grace window — the creator writes its pid immediately after mkdir.
const FRESH_LOCK_MS = 5_000

function lockOwner(lockDir) {
  try {
    // Token format is `<pid>:<uuid>`; parseInt stops at the colon.
    const pid = Number.parseInt(readFileSync(join(lockDir, 'pid'), 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function processAlive(pid) {
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Acquire the dev-loop mutex under devRoot; returns an idempotent release().
 * Throws after waitMs when another live run keeps holding the lock.
 */
export function acquireDevLoopLock(devRoot, { waitMs = 120_000 } = {}) {
  const lockDir = join(devRoot, LOCK_DIR)
  const token = `${process.pid}:${randomUUID()}`
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'pid'), token)
      let released = false
      return () => {
        if (released) return
        released = true
        let current = null
        try {
          current = readFileSync(join(lockDir, 'pid'), 'utf8').trim()
        } catch {
          return // lock directory already gone
        }
        if (current !== token) {
          console.error(`dev-lock: leaving ${lockDir} in place — owned by another run`)
          return
        }
        rmSync(lockDir, { recursive: true, force: true })
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }

    const owner = lockOwner(lockDir)
    let ageMs
    try {
      ageMs = Date.now() - statSync(lockDir).mtimeMs
    } catch (error) {
      // The observed lock was released between our failed mkdir and this
      // stat; retry acquisition immediately.
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const staleOwner = owner === null ? ageMs > FRESH_LOCK_MS : !processAlive(owner)
    if (staleOwner) {
      rmSync(lockDir, { recursive: true, force: true })
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `another pnpm dev run holds the dev-loop lock (pid ${owner}); `
        + `if that is stale, delete ${lockDir}`,
      )
    }
    sleepSync(POLL_MS)
  }
}

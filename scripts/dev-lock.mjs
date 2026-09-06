#!/usr/bin/env node
/**
 * Interprocess mutex for the dev loop (scripts/dev-test.mjs). Concurrent
 * `pnpm dev` runs sharing one DSH_TUI_DEV_ROOT are not safe: tsc writes to
 * lib/, the fingerprint cache, the shared packageRoot cleanup, and
 * `dsh plugin add` would race each other. The lock is held for the
 * build/pack/install phase and released before the TUI launches, so a second
 * run never waits on an interactive session.
 *
 * mkdir is atomic on POSIX and Windows; staleness is detected via the pid file
 * (dead owner) with an age fallback (staleMs) for crashed-or-killed runs.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LOCK_DIR = 'dev-loop.lock'
const POLL_MS = 250
// A lock directory without a pid file is only treated as fresh within this
// grace window — the creator writes its pid immediately after mkdir.
const FRESH_LOCK_MS = 5_000

function lockOwner(lockDir) {
  try {
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
export function acquireDevLoopLock(devRoot, { waitMs = 120_000, staleMs = 2 * 60 * 60_000 } = {}) {
  const lockDir = join(devRoot, LOCK_DIR)
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'pid'), String(process.pid))
      let released = false
      return () => {
        if (released) return
        released = true
        rmSync(lockDir, { recursive: true, force: true })
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }

    const owner = lockOwner(lockDir)
    const ageMs = Date.now() - statSync(lockDir).mtimeMs
    const staleOwner = owner === null ? ageMs > FRESH_LOCK_MS : !processAlive(owner)
    if (staleOwner || ageMs > staleMs) {
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

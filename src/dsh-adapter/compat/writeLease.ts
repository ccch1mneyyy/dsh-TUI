/**
 * The exclusive write lease the host's JSONL persistence layer holds on one
 * session's log, probed from a process that does not hold it.
 *
 * `dsh web` opens its own "new session" placeholder in the SHARED session
 * store (`~/.dsh/sessions`): the placeholder is a real session of this install,
 * its derived index entry correctly says no person ever prompted there, and it
 * is in no TUI mount ledger (`sessionMounts.readSessionOwners`) because
 * `dsh web` never writes that ledger. Nothing in the sweep's layers ①/②/③ can
 * therefore tell it apart from a historical shell, and the exit sweep would
 * delete the session the user is looking at (REVIEW CR-2).
 *
 * The host's own arbiter answers where the ledger cannot. One writer owns a
 * session log at a time, and the JSONL persistence layer takes that ownership
 * for the whole life of a write handle — a non-blocking `flock(2)` on the
 * session directory's `session.lock` on POSIX, a named kernel semaphore
 * derived from that path on Windows, released by the kernel on process death
 * (`dsh-session-persistence-jsonl/lib/index.js:616-720`). That is exactly the
 * ownership a peer's write handle holds, `dsh web`'s included.
 *
 * The lease is reached through that same public API instead of being
 * re-derived here, so each platform keeps its own arbiter and this module
 * restates neither the lock file name nor the semaphore name:
 * `sessionPersistence.acquireWriteLease({id, cwd})` resolves when nobody owns
 * the session and rejects `SessionAlreadyOwnedError` when somebody does. A
 * probe that acquires releases at once — the acquisition is the fact, the lock
 * is never kept.
 *
 * The POSIX addon (`@deepseek-ai/node-addon-system/flock`) is deliberately NOT
 * the probe: it is POSIX-only by construction (`lib/flock.js` refuses every
 * other platform with `ERR_FLOCK_UNSUPPORTED_PLATFORM`, and the package ships
 * no win32 prebuild), so a probe built on it could not see a Windows holder at
 * all — every Windows session would read `unknown`, the sweep would spare its
 * whole index, and the cleanup this change exists to keep would silently stop
 * on the platform it ships on most. Going through the service also keeps this
 * module free of a second dependency and of a second opinion about where a
 * session's lock lives.
 *
 * `acquireWriteLease` is reached structurally: the session-persistence SERVICE
 * declares the port (`create`/`open`/`stat`/`list`) and not the lease, which
 * only the JSONL backend implements. Reading the service structurally is this
 * adapter's established shape for exactly that case
 * (`channel/session-tree.ts:24`, `channel/subagent-transcript.ts:68`); a
 * composition that serves no lease (another backend, a browser host, a service
 * that is already gone) reads as `unknown`, which spares.
 *
 * Never throws and never blocks on anything but the probe itself: no service,
 * no lease method, a missing `cwd`, an unexpected `errno` and a failed release
 * all report `unknown`, and only `free` may let a session be removed
 * (DESIGN D5: an unknown stays).
 *
 * @module @deepseek-harness-tui/dsh-tui/dsh-adapter/compat/writeLease
 */

/** What one lease probe concluded. Every value but `free` spares the session. */
export type WriteLeaseState = 'free' | 'held' | 'unknown'

/**
 * The lease port, narrowed out of the persistence service. `acquireWriteLease`
 * resolves to the held lease when nobody owns the session.
 */
interface WriteLeasePort {
  acquireWriteLease?(header: { readonly id: string; readonly cwd: string }): Promise<HeldWriteLease>
}

/** The lease object's one teardown; closing it is what releases the lock. */
interface HeldWriteLease {
  release?(): unknown
}

/**
 * Whether a failure is the host's own "another handle owns this session"
 * verdict, matched by name. The class lives in
 * `@deepseek-ai/dsh-session-persistence` and sets `name` in its constructor
 * (`lib/index.js:44-52`); matching it structurally keeps this module from
 * adding one more package reference for one string.
 * @param error - Whatever the acquisition rejected with.
 * @returns True when the session is already owned by an active write handle.
 */
function isAlreadyOwned(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionAlreadyOwnedError'
}

/**
 * Build the probe for one persistence seam.
 *
 * The host thunk is called once per probe rather than captured: the service is
 * resolved lazily from the running context, and the exit path must not hold a
 * service reference across the teardown it precedes.
 *
 * @param host - Resolves the persistence service (`ctx.sessionPersistence`).
 * @returns A probe that reports `free` only when no writer holds the session.
 */
export function createWriteLeaseProbe(
  host: () => unknown,
): (sessionId: string, cwd: string) => Promise<WriteLeaseState> {
  return async (sessionId, cwd) => {
    let port: WriteLeasePort | undefined
    try {
      port = (await host()) as WriteLeasePort | undefined
    } catch {
      // A service that cannot even be resolved proves nothing.
      return 'unknown'
    }
    const acquire = port?.acquireWriteLease
    if (typeof acquire !== 'function') return 'unknown'
    let lease: HeldWriteLease
    try {
      lease = await acquire.call(port, { id: sessionId, cwd })
    } catch (error) {
      return isAlreadyOwned(error) ? 'held' : 'unknown'
    }
    // The acquisition was the answer; a lock this process cannot hand back is
    // not a fact about the session, so it cannot be reported as `free`.
    if (typeof lease.release !== 'function') return 'unknown'
    try {
      await lease.release()
    } catch {
      return 'unknown'
    }
    return 'free'
  }
}

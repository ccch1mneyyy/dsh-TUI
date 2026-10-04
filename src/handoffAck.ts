/**
 * Replacement side of the fullscreen kernel-switch handoff.
 *
 * The old TUI process keeps the alternate screen open while it spawns the
 * replacement, so the user never drops back to the main screen in between.
 * The replacement reports on an extra pipe (fd 3) with two lines:
 *
 *   adopted  its AlternateScreen mounted on the screen it inherited (no
 *            second 1049h);
 *   ready    its first frame after that has been flushed to the terminal.
 *
 * The alternate screen is closed exactly once: the old process closes it if
 * the replacement dies before `ready`; from `ready` on the replacement owns
 * it and closes it on its own exit.
 *
 * The old process's side (spawn, reading the pipe, classifying the outcome)
 * is restartTui in src/update.ts. This module only tracks the replacement's
 * state; the ACK is a writeSync to the given fd.
 */
import { writeSync } from 'node:fs'

/** fd number of the ACK pipe (stdio[3] of the spawn). */
export const HANDOFF_ACK_FD_ENV = 'DSH_TUI_HANDOFF_ACK_FD'
/** 'alt' when the previous process left the terminal in the alternate screen. */
export const HANDOFF_SCREEN_ENV = 'DSH_TUI_HANDOFF_SCREEN'
/** Attempt id, echoed in every ACK line and in restart.log. */
export const HANDOFF_ATTEMPT_ENV = 'DSH_TUI_HANDOFF_ATTEMPT'

/** ACK line format: `dsh-tui-handoff <kind> <attemptId>`. */
export const ACK_PREFIX = 'dsh-tui-handoff'

export type HandoffAckKind = 'adopted' | 'ready'

export type HandoffAckState = {
  attemptId: string
  fd: number
  /**
   * 'armed': env received, screen not mounted yet. 'adopted': AlternateScreen
   * mounted; until ready this process must not write 1049l. 'ready': first
   * frame flushed and acknowledged; this process now owns the screen.
   */
  adoption: 'armed' | 'adopted' | 'ready'
  /** The pipe stopped accepting writes (the old process is gone): stop sending. */
  dead: boolean
}

let state: HandoffAckState | undefined

/** Read (and remove) the handoff env early in boot; undefined when this is not a handoff. */
export function beginHandoffAck(env: NodeJS.ProcessEnv = process.env): HandoffAckState | undefined {
  if (state !== undefined) return state
  const fdRaw = env[HANDOFF_ACK_FD_ENV]
  const attemptId = typeof env[HANDOFF_ATTEMPT_ENV] === 'string' ? env[HANDOFF_ATTEMPT_ENV]! : ''
  // Removed right away so a host recompose or a child of this process never sees them.
  delete env[HANDOFF_ACK_FD_ENV]
  delete env[HANDOFF_SCREEN_ENV]
  delete env[HANDOFF_ATTEMPT_ENV]
  if (fdRaw === undefined) return undefined
  const fd = Number(fdRaw)
  if (!Number.isInteger(fd) || fd < 0) return undefined
  state = { attemptId, fd, adoption: 'armed', dead: false }
  return state
}

/** Whether this boot is a handoff replacement (read by AlternateScreen). */
export function handoffAckArmed(): boolean {
  return state !== undefined
}

/** The handoff attempt id, for restart.log; undefined outside a handoff. */
export function handoffAttemptId(): string | undefined {
  return state?.attemptId === '' ? undefined : state?.attemptId
}

function sendAck(kind: HandoffAckKind): void {
  if (state === undefined || state.dead) return
  try {
    writeSync(state.fd, ACK_PREFIX + ' ' + kind + ' ' + state.attemptId + '\n')
  } catch {
    // The old process is gone or closed the pipe. Ownership is not
    // transferred by a lost ACK; ownsAltScreenExit() lets this process close
    // the screen itself from now on.
    state.dead = true
  }
}

/**
 * Called by AlternateScreen once it has mounted on the inherited screen.
 * Until ready, this process's exit cleanup leaves 1049l to the old process.
 */
export function noteScreenAdopted(): void {
  if (state === undefined || state.adoption !== 'armed') return
  sendAck('adopted')
  if (!state.dead) state.adoption = 'adopted'
}

/** The first frame after adoption has been flushed: send ready and take over the screen. */
export function markScreenReady(): void {
  if (state === undefined || state.adoption !== 'adopted') return
  sendAck('ready')
  // A failed write marks the pipe dead instead; see ownsAltScreenExit.
  if (!state.dead) state.adoption = 'ready'
}

/**
 * Whether this process should write 1049l when it leaves the alternate
 * screen. Always true outside a handoff. During one it is false until ready,
 * because the old process closes the screen if this one dies first. A dead
 * pipe also makes it true: closing twice is better than leaving the terminal
 * in the alternate screen.
 */
export function ownsAltScreenExit(): boolean {
  if (state === undefined) return true
  return state.adoption === 'ready' || state.dead
}

/**
 * Wrap stdout.write until the first write after adoption, and send ready
 * from that write's flush callback. The wrapper removes itself before
 * forwarding, so later writes go straight through. Does nothing outside a
 * handoff.
 */
export function armFirstFrameAck(stdout: NodeJS.WriteStream): void {
  if (state === undefined || state.adoption !== 'armed' || state.dead) return
  const original = stdout.write as (...args: unknown[]) => boolean
  type Callback = (error?: Error | null) => void
  const wrapper = function (this: NodeJS.WriteStream, ...args: unknown[]) {
    const adopted = state !== undefined && state.adoption === 'adopted'
    if (!adopted) {
      // Not mounted yet, so this is a probe or setup write, not a frame.
      return original.apply(stdout, args)
    }
    // Unwrap first so the callback chain and every later write use the original.
    try {
      stdout.write = original as typeof stdout.write
    } catch {
      // Read-only stream: the wrapper stays, and passes writes through once ready is sent.
    }
    const userCallback: Callback | undefined = typeof args[1] === 'function' ? args[1] as Callback : typeof args[2] === 'function' ? args[2] as Callback : undefined
    const chained: Callback = error => {
      markScreenReady()
      if (userCallback !== undefined) userCallback(error)
    }
    if (typeof args[1] === 'string') return original.call(stdout, args[0], args[1], chained)
    if (userCallback === undefined) return original.call(stdout, args[0], chained)
    return original.call(stdout, args[0], chained)
  }
  try {
    stdout.write = wrapper as unknown as typeof stdout.write
  } catch {
    // The flush cannot be observed: take the screen over now and stop ACKing,
    // so the old process falls back to its no-ready path.
    state.dead = true
    state.adoption = 'ready'
  }
}

/** Parse one ACK pipe line (old process side); null for anything else. */
export function parseHandoffAckLine(line: string): { kind: HandoffAckKind; attemptId: string } | null {
  const match = new RegExp('^' + ACK_PREFIX + ' (adopted|ready) (.*)$').exec(line.trim())
  if (match === null) return null
  return { kind: match[1] as HandoffAckKind, attemptId: match[2] }
}

/** Test hook: install a state directly. */
export function __setHandoffAckStateForTest(next: HandoffAckState | undefined): void {
  state = next
}

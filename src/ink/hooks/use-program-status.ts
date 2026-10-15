import { useContext, useEffect, useRef } from 'react'
import { TerminalWriteContext } from '../useTerminalNotification.js'
import {
  programStatus,
  type ProgramBlockedKind,
  type ProgramState,
} from '../termio/osc7501.js'

/** Stable program id the terminal groups/filters records by. */
export const PROGRAM_STATUS_APP = 'dsh-tui'

/**
 * A pending prompt that blocks the session. Both stores expose the same
 * shape, so the caller maps its snapshot to this narrow view.
 */
export type ProgramBlockedPrompt = {
  /** `permission` gates a tool; `question` awaits an answer; `auth` a login. */
  kind: ProgramBlockedKind
  /** One-line description shown to the user in the terminal's own UI. */
  message: string
}

/** What the caller knows about the session's current activity. */
export type ProgramStatusInput = {
  /** A turn is running. */
  working: boolean
  /** The pending ask, if any; outranks `working` (the turn is parked on it). */
  blocked: ProgramBlockedPrompt | null
  /** How the last turn ended, for the `done`/`error` record. */
  lastOutcome: 'completed' | 'interrupted' | 'error' | undefined
  /** Short session label used as the record title. */
  title: string
  /** Opt-out, and the hard TTY requirement. */
  enabled: boolean
  /**
   * Identity of the session these signals describe. Switching sessions in one
   * process does not remount the tree, so this is what tells the falling-edge
   * latch below that `lastOutcome` now belongs to a different session's past.
   */
  sessionId: string
}

/**
 * Report this TUI's lifecycle to the terminal via OSC 7501 (Program Status
 * Protocol), so terminals and agentic inboxes know when dsh-tui is working,
 * waiting on the user, or finished.
 *
 * Precedence mirrors the UI: a parked prompt is `blocked`, a running turn is
 * `working`, a turn that just ended is `done`/`error`, and otherwise `idle`.
 * Reports are deduplicated on the serialized sequence, so re-renders do not
 * spam the terminal.
 *
 * Two deliberate omissions, both from the spec and confirmed by the shipped
 * implementations (Gradle, Tuist, opentui, Reasonix):
 *
 * - No capability detection: unknown OSCs are ignored by well-behaved
 *   terminals, so reports are sent blind.
 * - No clear on exit: the terminal already drops `working`/`blocked` at
 *   process exit or the next shell prompt, while `done`/`error` must survive
 *   for the user to find. Clearing would erase exactly that.
 *
 * @param input - the current activity, already derived by the caller.
 */
export function useProgramStatus(input: ProgramStatusInput): void {
  const writeRaw = useContext(TerminalWriteContext)
  // Last sequence written, so an unchanged state writes nothing. Reset when
  // reporting turns off so a later re-enable re-establishes the record.
  const lastSequenceRef = useRef<string>('')
  // Whether a turn was observed running since the current session was adopted,
  // tagged with the session it belongs to. `turnUsage` is a persisted
  // projection: a resumed session can still carry its previous turn's outcome,
  // and reporting that as a fresh `done` would claim work the user has not
  // seen. Terminal states are therefore only reported on the falling edge of
  // `working`. The tag matters because switching sessions in one process does
  // not remount this tree, and the switch replays the target session's own
  // history — re-populating `turnUsage` from its last turn.end. A latch left
  // over from the previous session would report that as a brand-new `done`.
  const latchRef = useRef<{ sessionId: string; sawWorking: boolean }>({
    sessionId: input.sessionId,
    sawWorking: false,
  })

  const { working, blocked, lastOutcome, title, enabled, sessionId } = input

  useEffect(() => {
    if (!enabled || !writeRaw) return

    // Adopting a different session starts a fresh latch; `lastOutcome` now
    // describes that session's past, not work observed in this one.
    if (latchRef.current.sessionId !== sessionId) {
      latchRef.current = { sessionId, sawWorking: false }
    }

    const derive = (): { state: ProgramState; kind?: ProgramBlockedKind; msg?: string } => {
      if (blocked !== null) return { state: 'blocked', kind: blocked.kind, msg: blocked.message }
      if (working) return { state: 'working' }
      if (!latchRef.current.sawWorking) return { state: 'idle' }
      switch (lastOutcome) {
        case 'error':
          return { state: 'error' }
        case 'interrupted':
          // The user cancelled: back at rest, per the spec's "report idle
          // when the user interrupts".
          return { state: 'idle' }
        case 'completed':
          return { state: 'done' }
        default:
          return { state: 'idle' }
      }
    }

    const { state, kind, msg } = derive()
    if (working) latchRef.current.sawWorking = true
    const sequence = programStatus({
      state,
      app: PROGRAM_STATUS_APP,
      // Every report replaces its record, so app/title ride along each time.
      title,
      ...(kind === undefined ? {} : { kind }),
      ...(msg === undefined ? {} : { msg }),
    })
    if (sequence === '' || sequence === lastSequenceRef.current) return
    lastSequenceRef.current = sequence
    writeRaw(sequence)
  }, [enabled, working, blocked, lastOutcome, title, writeRaw, sessionId])
}

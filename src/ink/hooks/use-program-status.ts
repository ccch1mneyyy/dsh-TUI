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

/**
 * The channel facts this hook reports on, taken as ONE object so that the
 * hook — not its caller — decides which field carries which fact. `ChannelUi`
 * satisfies it structurally; the regression drives both the real projection
 * and its live batch router into a real mount.
 */
export type ProgramStatusChannel = {
  /** The backend can remain running after its replayed rows are settled. */
  status: 'starting' | 'idle' | 'running' | 'disposed'
  /** A turn is running. */
  working: boolean
  /**
   * How the most recently ended turn closed, projected from
   * `turn.end.reason` on every turn end. Deliberately NOT the outcome on the
   * usage ledger: a turn that measured nothing writes no ledger, so reading
   * that instead would report idle for a first failure and, after a
   * successful turn, report the previous `completed` as a fresh `done`.
   */
  turnOutcome: 'completed' | 'interrupted' | 'error' | 'stopped' | undefined
  /** Live ends from the channel router, including turns that started in replay. */
  liveTurnEnds: number
  /** Changes on a rebind even when the backend keeps the same session id. */
  agentBindingGeneration: number
  /** Short session label used as the record title. */
  sessionTitle: string
  /**
   * Identity of the session these facts describe. Switching sessions in one
   * process does not remount the tree, so this is what tells the falling-edge
   * latch below that the projected outcome now belongs to a different
   * session's past.
   */
  sessionId: string
}

/** What the caller knows beyond the channel's own projection. */
export type ProgramStatusInput = {
  /** The channel, or any structurally equal snapshot of it. */
  channel: ProgramStatusChannel
  /** The pending ask, if any; outranks `working` (the turn is parked on it). */
  blocked: ProgramBlockedPrompt | null
  /** Opt-out, and the hard TTY requirement. */
  enabled: boolean
}

/**
 * Report this TUI's lifecycle to the terminal via OSC 7501 (Program Status
 * Protocol), so terminals and agentic inboxes know when dsh-tui is working,
 * waiting on the user, or finished.
 *
 * Precedence mirrors the UI: a parked prompt is `blocked`, a running turn is
 * `working`, a turn that just ended is `done`/`error`, and otherwise `idle`.
 * Reports are deduplicated within the same live turn, so re-renders do not
 * spam the terminal or hide another turn with the same outcome.
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
 * @param input - the channel plus the ask/opt-out the channel cannot know.
 */
export function useProgramStatus(input: ProgramStatusInput): void {
  const writeRaw = useContext(TerminalWriteContext)
  // An unchanged render writes nothing; a new live end still gets a report.
  const lastReportRef = useRef<{ sequence: string; liveTurnEnds: number } | undefined>(undefined)
  // Whether a turn was observed running since the current session was adopted,
  // tagged with the session it belongs to. A projected outcome is PERSISTED
  // state: a resumed session can still carry its previous turn's outcome, and
  // reporting that as a fresh `done` would claim work the user has not seen.
  // Terminal states therefore need evidence of a live turn. The tag matters
  // because switching sessions in one process does
  // not remount this tree, and the switch replays the target session's own
  // history — re-populating the outcome from its last turn.end. A latch left
  // over from the previous session would report that as a brand-new `done`.
  const latchRef = useRef<{ sessionId: string; generation: number; sawWorking: boolean }>({
    sessionId: input.channel.sessionId,
    generation: input.channel.agentBindingGeneration,
    sawWorking: false,
  })

  const { channel, blocked, enabled } = input
  const { status, working, turnOutcome, liveTurnEnds, agentBindingGeneration, sessionTitle, sessionId } = channel

  useEffect(() => {
    if (!enabled || !writeRaw) return

    // Adopting a different session starts a fresh latch; the projected
    // outcome now describes that session's past, not work observed in this one.
    if (latchRef.current.sessionId !== sessionId || latchRef.current.generation !== agentBindingGeneration) {
      latchRef.current = { sessionId, generation: agentBindingGeneration, sawWorking: false }
      lastReportRef.current = undefined
    }
    // A synchronous start/end batch or a resumed running turn may finish
    // before `working=true` renders; live ends still differ from history.
    if (working || liveTurnEnds > 0) latchRef.current.sawWorking = true

    const derive = (): { state: ProgramState; kind?: ProgramBlockedKind; msg?: string } => {
      if (blocked !== null) return { state: 'blocked', kind: blocked.kind, msg: blocked.message }
      // Current backend activity does not authorize a historical outcome.
      if (working || status === 'running') return { state: 'working' }
      if (!latchRef.current.sawWorking) return { state: 'idle' }
      switch (turnOutcome) {
        case 'error':
          return { state: 'error' }
        case 'interrupted':
        case 'stopped':
          // The user cancelled or the backend disposed the session: back at
          // rest, per the spec's "report idle when the user interrupts".
          return { state: 'idle' }
        case 'completed':
          return { state: 'done' }
        default:
          return { state: 'idle' }
      }
    }

    const { state, kind, msg } = derive()
    const sequence = programStatus({
      state,
      app: PROGRAM_STATUS_APP,
      // Every report replaces its record, so app/title ride along each time.
      title: sessionTitle,
      ...(kind === undefined ? {} : { kind }),
      ...(msg === undefined ? {} : { msg }),
    })
    const lastReport = lastReportRef.current
    if (sequence === '' || (sequence === lastReport?.sequence && liveTurnEnds === lastReport?.liveTurnEnds)) return
    lastReportRef.current = { sequence, liveTurnEnds }
    writeRaw(sequence)
  }, [enabled, status, working, turnOutcome, liveTurnEnds, agentBindingGeneration, blocked, sessionTitle, writeRaw, sessionId])
}

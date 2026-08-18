import React from 'react'
import { t } from '../i18n.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { pickNotifyChannel, type NotifyMode } from '../notifications.js'

/** What the TUI is waiting on, as far as the notifier is concerned. */
export interface TurnNotificationState {
  /** True between turn/start and turn/end (the working spinner's own flag). */
  working: boolean
  /** True while a tool approval is parked on the panel. */
  awaitingApproval: boolean
  /** True while an `ask_user_question` batch is parked on the panel. */
  awaitingQuestion: boolean
  /** Session title, used as the notification body so a user with several
   *  windows open can tell which one finished. */
  title: string
}

/** Which of the three moments an alert is being raised for. */
type Alert = 'done' | 'approval' | 'question'

/**
 * Ask the terminal for the user's attention when a turn ends or the agent
 * blocks on the user, and mirror the working state into the terminal's
 * progress indicator.
 *
 * Alerts fire on state *edges* only, and the refs seed from the first
 * render's state so mounting into an already-running turn (`--resume` onto a
 * live agent) never opens with a notification for work the user did not
 * start. `unfocused` — the default — reads the DECSET 1004 focus state the
 * renderer already tracks, so a user watching the stream is never alerted
 * about something already on screen.
 *
 * Progress reporting is ambient rather than an alert, but `off` means off:
 * it is gated on the same mode and cleared on unmount, in addition to the
 * teardown sequence's own clear.
 *
 * @param mode - The user's notification preference.
 * @param state - What the TUI is currently waiting on.
 */
export function useTurnNotification(mode: NotifyMode, state: TurnNotificationState): void {
  const { working, awaitingApproval, awaitingQuestion, title } = state
  const focused = useTerminalFocus()
  const { notifyITerm2, notifyKitty, notifyGhostty, notifyBell, progress } = useTerminalNotification()

  // Read through refs inside the effects: `focused` and `title` must not
  // re-run an edge effect (a window regaining focus is not a turn ending),
  // and the notification id counter has to survive re-renders.
  const focusedRef = React.useRef(focused)
  focusedRef.current = focused
  const titleRef = React.useRef(title)
  titleRef.current = title
  const notifyIdRef = React.useRef(0)

  const alert = React.useCallback((kind: Alert) => {
    if (mode === 'off') return
    if (mode === 'unfocused' && focusedRef.current) return
    const message = t(
      kind === 'done'
        ? 'notify-turn-done'
        : kind === 'approval'
          ? 'notify-approval'
          : 'notify-question',
    )
    const body = titleRef.current.trim() === '' ? message : `${message} · ${titleRef.current}`
    switch (pickNotifyChannel()) {
      case 'iterm2':
        notifyITerm2({ message: body, title: 'dsh-tui' })
        break
      case 'kitty':
        notifyKitty({ message: body, title: 'dsh-tui', id: ++notifyIdRef.current })
        break
      case 'ghostty':
        notifyGhostty({ message: body, title: 'dsh-tui' })
        break
      case 'bell':
        notifyBell()
        break
    }
  }, [mode, notifyITerm2, notifyKitty, notifyGhostty, notifyBell])

  const wasWorking = React.useRef(working)
  React.useEffect(() => {
    const ended = wasWorking.current && !working
    wasWorking.current = working
    if (ended) alert('done')
  }, [working, alert])

  const wasAwaitingApproval = React.useRef(awaitingApproval)
  React.useEffect(() => {
    const opened = !wasAwaitingApproval.current && awaitingApproval
    wasAwaitingApproval.current = awaitingApproval
    if (opened) alert('approval')
  }, [awaitingApproval, alert])

  const wasAwaitingQuestion = React.useRef(awaitingQuestion)
  React.useEffect(() => {
    const opened = !wasAwaitingQuestion.current && awaitingQuestion
    wasAwaitingQuestion.current = awaitingQuestion
    if (opened) alert('question')
  }, [awaitingQuestion, alert])

  React.useEffect(() => {
    if (mode === 'off') return
    progress(working ? 'indeterminate' : null)
    return () => {
      progress(null)
    }
  }, [mode, working, progress])
}

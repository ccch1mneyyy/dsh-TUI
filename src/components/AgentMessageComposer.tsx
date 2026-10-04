import React from 'react'
import { Box, Text, useInput } from '../ui.js'
import { t } from '../i18n.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { agentMessageStateColor, agentMessageStateText, agentMessageViaText } from './messages/TranscriptLeaves.js'
import type {
  AgentComposeTarget,
  AgentMessageControl,
  AgentMessageState,
  AgentMessageSubmitResult,
  AgentMessageView,
} from './messages/agentTeam.js'

/** The stable §8 notice vocabulary this composer can show (the control's
 *  failure reasons, localized). */
type ComposerNoticeKey =
  | 'agent-message-unavailable'
  | 'agent-message-target-ambiguous'
  | 'agent-message-target-not-resumable'
  | 'agent-message-parent-unavailable'
  | 'agent-message-unauthorized'
  | 'agent-message-delivery-unavailable'
  | 'agent-message-dispatch-failed'
  | 'agent-message-parent-interrupted'

/** The control's stable failure reason → the notice word. */
const NOTICE_OF_REASON: Readonly<Record<Extract<AgentMessageSubmitResult, { ok: false }>['reason'], ComposerNoticeKey>> = {
  unavailable: 'agent-message-unavailable',
  'target-ambiguous': 'agent-message-target-ambiguous',
  'not-resumable': 'agent-message-target-not-resumable',
  'parent-unavailable': 'agent-message-parent-unavailable',
  unauthorized: 'agent-message-unauthorized',
  'delivery-unavailable': 'agent-message-delivery-unavailable',
  cancelled: 'agent-message-parent-interrupted',
  failed: 'agent-message-dispatch-failed',
}

/** Local submit record: what THIS composer sent and what the channel said.
 *  The durable feed (`messages`) may later advance the same intent — the
 *  status line prefers the newest channel fact and never upgrades a state
 *  on its own (design §5.1). */
interface SentIntent {
  readonly intentId: string
  readonly text: string
  state: AgentMessageState
}

export interface AgentMessageComposerProps {
  /** Resolved target: unique name, or the stable id when ambiguous. */
  readonly target: AgentComposeTarget
  /** The channel's message control (`subagentControl.message`); the wiring
   *  already proved the member exists. */
  readonly control: AgentMessageControl
  /** The durable feed for this child — later facts about our intents. */
  readonly messages: readonly AgentMessageView[]
  /** Keyboard focus; the scene yields plain typing here while true. */
  readonly focused: boolean
  onFocusChange(focused: boolean): void
}

/**
 * AgentMessageComposer — the user→child send box (design agent-team-full
 * §5.1): an INDEPENDENT draft owner, never the parent PromptInput. The
 * parent's draft, dock and queue are untouched by construction — this
 * component holds its own text and submits only through the channel's
 * AgentMessageControl (Claude parent mediation or DSH direct prompt). No
 * confirm dialog anywhere: failures keep the draft and say why in a notice.
 */
export function AgentMessageComposer({ target, control, messages, focused, onFocusChange }: AgentMessageComposerProps): React.ReactNode {
  const [text, setText] = React.useState('')
  const [caret, setCaret] = React.useState(0)
  const [sending, setSending] = React.useState(false)
  const [sent, setSent] = React.useState<SentIntent | null>(null)
  const [notice, setNotice] = React.useState<{ key: ComposerNoticeKey; failure?: boolean } | null>(null)

  // The display name: the unique name, the stable id when ambiguous, or the
  // short id when the backend reports no name at all.
  const shownName = target.ambiguous === true ? target.agentId.slice(0, 8) : target.name ?? target.agentId.slice(0, 8)
  const canSubmit = target.name !== undefined && !sending

  // Later channel facts about our newest intent advance the status line.
  const latestIntentState = React.useMemo<AgentMessageState | undefined>(() => {
    if (sent === null) return undefined
    const advance = [...messages].reverse().find(message => message.intentId === sent.intentId)
    return advance?.state ?? sent.state
  }, [messages, sent])

  const submit = (delivery: 'queue' | 'steer'): void => {
    if (!canSubmit || text.trim() === '') return
    setSending(true)
    setNotice(null)
    control.submit({
      targetId: target.agentId,
      ...(target.name === undefined ? {} : { targetName: target.name }),
      text,
      delivery,
    }).then(outcome => {
      setSending(false)
      if (outcome.ok) {
        // The channel mints the intent id; the receipt state is a FACT the
        // transport stated (an accepted inbox is 'queued', never more).
        setText('')
        setCaret(0)
        setSent({ intentId: outcome.intentId, text, state: outcome.state })
        return
      }
      // Failure keeps the draft verbatim (design §5.1) — the notice names
      // the stable reason (§8 vocabulary), never a raw provider error.
      setNotice({ key: NOTICE_OF_REASON[outcome.reason], failure: true })
    }, () => {
      setSending(false)
      setNotice({ key: 'agent-message-dispatch-failed', failure: true })
    })
  }

  useInput((input, key, event) => {
    if (!focused) return
    // Esc: the editor layer consumes it first — hand focus back to the scene
    // with the draft retained (the next Esc leaves the Agent View).
    if (key.escape) {
      event.stopImmediatePropagation()
      onFocusChange(false)
      return
    }
    if (isPlainReturnInput(input, key)) {
      event.stopImmediatePropagation()
      submit('queue')
      return
    }
    // Ctrl+Enter steers ONLY under an explicit capability; Claude mediation
    // keeps the followup placement (never interruptAndDeliver — §6.3).
    if (key.return && key.ctrl) {
      event.stopImmediatePropagation()
      submit(control.steer === true ? 'steer' : 'queue')
      return
    }
    if (key.backspace || key.delete) {
      event.stopImmediatePropagation()
      if (caret > 0) {
        setText(text.slice(0, caret - 1) + text.slice(caret))
        setCaret(caret - 1)
      }
      return
    }
    if (key.leftArrow) {
      event.stopImmediatePropagation()
      setCaret(Math.max(0, caret - 1))
      return
    }
    if (key.rightArrow) {
      event.stopImmediatePropagation()
      setCaret(Math.min(text.length, caret + 1))
      return
    }
    if (key.home || key.ctrl && input === 'a') {
      event.stopImmediatePropagation()
      setCaret(0)
      return
    }
    if (key.end || key.ctrl && input === 'e') {
      event.stopImmediatePropagation()
      setCaret(text.length)
      return
    }
    if (input !== '' && !key.ctrl && !key.meta) {
      event.stopImmediatePropagation()
      setText(text.slice(0, caret) + input + text.slice(caret))
      setCaret(caret + input.length)
      setNotice(null)
      return
    }
  }, { isActive: focused })

  const viaLabel = agentMessageViaText(control.via)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="accent">{'› '}</Text>
        <Text bold>{t('agent-message-compose-title', { name: shownName })}</Text>
        <Text dimColor>{` · ${viaLabel}`}</Text>
      </Box>
      {target.ambiguous === true && (
        <Text dimColor>{t('agent-message-target-ambiguous', { id: target.agentId.slice(0, 8) })}</Text>
      )}
      {target.name === undefined && (
        <Text color="warning">{t('agent-message-target-nameless')}</Text>
      )}
      <Box flexDirection="row">
        <Text>{text.slice(0, caret)}</Text>
        <Text inverse>{' '}</Text>
        <Text>{text.slice(caret)}</Text>
      </Box>
      {notice !== null && (
        <Text color={notice.failure === true ? 'error' : undefined}>{`${t(notice.key)}${notice.failure === true ? ` · ${t('agent-message-draft-retained')}` : ''}`}</Text>
      )}
      {latestIntentState !== undefined && sent !== null && (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{`${t('agent-message-submitted')}: `}</Text>
          <Text color={agentMessageStateColor(latestIntentState)}>{agentMessageStateText(latestIntentState)}</Text>
          <Text dimColor>{` · ${t('agent-message-inbox-note')}`}</Text>
        </Box>
      )}
      <Text dimColor>
        {canSubmit
          ? (control.steer === true
              ? t('agent-message-hint-queue-steer')
              : t('agent-message-hint-queue'))
          : t('agent-message-hint-nameless')}
      </Text>
    </Box>
  )
}

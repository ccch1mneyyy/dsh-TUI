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
  /** Side-panel form: the panel's own key handler forwards keys through
   *  this ref instead of the composer listening with useInput. The panel
   *  host swallows every plain key before a later-mounted listener sees it,
   *  so a direct listener would never get the typing, and one left active
   *  after focus moves back to chat would pick up the chat's keystrokes. */
  readonly keyHandlerRef?: React.MutableRefObject<ComposerKeyHandler | null>
}

/** Ink's key flags as the composer reads them (the panel dispatcher passes
 *  the same runtime object, with `return_` added). */
type ComposerKey = {
  readonly escape?: boolean
  readonly return?: boolean
  readonly return_?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
  readonly backspace?: boolean
  readonly delete?: boolean
  readonly leftArrow?: boolean
  readonly rightArrow?: boolean
  readonly home?: boolean
  readonly end?: boolean
}

/** true = the composer consumed the key. */
export type ComposerKeyHandler = (input: string, key: ComposerKey) => boolean

/** Caret steps over whole code points, so an emoji is never split. */
function previousCodePoint(text: string, caret: number): number {
  if (caret <= 0) return 0
  const low = text.charCodeAt(caret - 1)
  const high = caret >= 2 ? text.charCodeAt(caret - 2) : 0
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? caret - 2 : caret - 1
}

function nextCodePoint(text: string, caret: number): number {
  if (caret >= text.length) return text.length
  return (text.codePointAt(caret) ?? 0) > 0xffff ? caret + 2 : caret + 1
}

/**
 * AgentMessageComposer — the user→child send box (design agent-team-full
 * §5.1): an INDEPENDENT draft owner, never the parent PromptInput. The
 * parent's draft, dock and queue are untouched by construction — this
 * component holds its own text and submits only through the channel's
 * AgentMessageControl (Claude parent mediation or DSH direct prompt). No
 * confirm dialog anywhere: failures keep the draft and say why in a notice.
 */
export function AgentMessageComposer({ target, control, messages, focused, onFocusChange, keyHandlerRef }: AgentMessageComposerProps): React.ReactNode {
  // The draft lives in a ref as well as in state: keys can arrive faster
  // than React re-renders, and a handler reading a render-time copy would
  // overwrite the previous keystroke (or submit twice on a double Enter).
  const draftRef = React.useRef({ text: '', caret: 0 })
  const [draft, setDraftState] = React.useState(draftRef.current)
  const setDraft = (next: { text: string; caret: number }): void => {
    draftRef.current = next
    setDraftState(next)
  }
  const { text, caret } = draft
  const sendingRef = React.useRef(false)
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
    const submitted = draftRef.current.text
    if (target.name === undefined || sendingRef.current || submitted.trim() === '') return
    sendingRef.current = true
    setSending(true)
    setNotice(null)
    const settle = (): void => {
      sendingRef.current = false
      setSending(false)
    }
    control.submit({
      targetId: target.agentId,
      targetName: target.name,
      text: submitted,
      delivery,
    }).then(outcome => {
      settle()
      if (outcome.ok) {
        // The channel mints the intent id; the receipt state is a FACT the
        // transport stated (an accepted inbox is 'queued', never more).
        // Text typed while the submit was in flight stays in the box.
        if (draftRef.current.text === submitted) setDraft({ text: '', caret: 0 })
        setSent({ intentId: outcome.intentId, text: submitted, state: outcome.state })
        return
      }
      // Failure keeps the draft verbatim; the notice names the stable
      // reason, never a raw provider error.
      setNotice({ key: NOTICE_OF_REASON[outcome.reason], failure: true })
    }, () => {
      settle()
      setNotice({ key: 'agent-message-dispatch-failed', failure: true })
    })
  }

  const handleKey: ComposerKeyHandler = (input, key) => {
    // Esc: the editor layer consumes it first — hand focus back to the scene
    // with the draft retained (the next Esc leaves the Agent View).
    if (key.escape === true) {
      onFocusChange(false)
      return true
    }
    const returnKey = key.return === true || key.return_ === true
    if (isPlainReturnInput(input, { ...key, return: returnKey })) {
      submit('queue')
      return true
    }
    // Ctrl+Enter steers ONLY under an explicit capability; Claude mediation
    // keeps the followup placement (never interruptAndDeliver).
    if (returnKey && key.ctrl === true) {
      submit(control.steer === true ? 'steer' : 'queue')
      return true
    }
    const current = draftRef.current
    if (key.backspace === true || key.delete === true) {
      if (current.caret > 0) {
        const at = previousCodePoint(current.text, current.caret)
        setDraft({ text: current.text.slice(0, at) + current.text.slice(current.caret), caret: at })
      }
      return true
    }
    if (key.leftArrow === true) {
      setDraft({ ...current, caret: previousCodePoint(current.text, current.caret) })
      return true
    }
    if (key.rightArrow === true) {
      setDraft({ ...current, caret: nextCodePoint(current.text, current.caret) })
      return true
    }
    if (key.home === true || (key.ctrl === true && input === 'a')) {
      setDraft({ ...current, caret: 0 })
      return true
    }
    if (key.end === true || (key.ctrl === true && input === 'e')) {
      setDraft({ ...current, caret: current.text.length })
      return true
    }
    if (input !== '' && key.ctrl !== true && key.meta !== true) {
      setDraft({ text: current.text.slice(0, current.caret) + input + current.text.slice(current.caret), caret: current.caret + input.length })
      setNotice(null)
      return true
    }
    return false
  }
  if (keyHandlerRef !== undefined) keyHandlerRef.current = focused ? handleKey : null
  useInput((input, key, event) => {
    if (handleKey(input, key)) event.stopImmediatePropagation()
  }, { isActive: focused && keyHandlerRef === undefined })

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

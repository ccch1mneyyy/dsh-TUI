import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import type { SubagentState } from '../dsh-adapter/subagents.js'
import type { SubagentTranscriptView } from '../adapter/ports/channel-view.js'
import type { SubagentTranscriptWindow } from '../agent/capabilities.js'
import { AgentMessageLeafRow, AssistantTextLeafRow, ThinkingLeafRow, ToolLeafRow } from '../components/messages/TranscriptLeaves.js'
import {
  foldTranscriptLeaves,
  mergeLiveWindow,
  OUTPUT_WINDOW_CAP,
  prependOlderLeaves,
  TRANSCRIPT_OLDER_CHUNK,
  uniqueRenderKeys,
  type TranscriptLeaf,
  type TranscriptState,
} from '../components/messages/subagentTranscript.js'
import { AgentMessageComposer } from '../components/AgentMessageComposer.js'
import { ExitButton } from '../components/SubagentDashboard.js'
import { t } from '../i18n.js'
import type { AgentComposeTarget, AgentMessageControl, AgentMessageView, AgentViewSource } from '../components/messages/agentTeam.js'

const sourceLabel = (source: AgentViewSource): string =>
  source.kind === 'chat' ? t('agent-view-source-chat')
    : source.kind === 'agents-dashboard' ? t('agent-view-source-dashboard')
      : source.kind === 'agent-detail' ? t('agent-view-source-detail')
        : t('agent-view-source-card')

export interface AgentTranscriptSceneProps {
  /** The child this view reads. Readonly by contract — the scene never
   *  mutates the roster, the Channel or the parent's queues. */
  readonly subagent: SubagentState
  /** Where Esc returns to (design §4.1 source stack). */
  readonly source: AgentViewSource
  onExit(): void
  /** The child's full transcript source (`subagentControl.history`).
   *  Absent = no transcript data plane (DSH today): a bounded live tail plus
   *  its retained-range note — never a fabricated empty history. */
  loadTranscript?: (agentId: string, window?: SubagentTranscriptWindow) => Promise<SubagentTranscriptView | null>
  /** The durable agent↔agent feed for this child (newest last), if any. */
  readonly messages?: readonly AgentMessageView[]
  /** The channel's message control + resolved target (`subagentControl.message`);
   *  absent = no send path → no composer rendered (capability absence is
   *  absence). */
  readonly compose?: { readonly control: AgentMessageControl; readonly target: AgentComposeTarget }
}

/**
 * AgentTranscriptScene — the main-screen READ-ONLY agent view (design
 * agent-team-full §4): a scene layer over the mounted parent Chat, not a
 * second Channel. The parent's rows/draft/pending/usage keep living while
 * this scene borrows the screen; Esc pops the source stack (chat /
 * agents-dashboard / agent-detail / transcript-card). The body reuses the
 * F8 fold/page/merge pipeline so a child row reads exactly like a main
 * one, with the live SubagentState tail merged in and one settlement
 * reload — no Channel rebuild, no attach/resume side effects.
 */
export function AgentTranscriptScene({ subagent, source, onExit, loadTranscript, messages = [], compose }: AgentTranscriptSceneProps): React.ReactNode {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows, columns } = useTerminalSize()
  const isRunning = subagent.status === 'running' || subagent.status === 'starting'

  // ── history pages (same loader contract as the Detail transcript page) ──
  const [transcript, setTranscript] = React.useState<TranscriptState>({ status: 'idle' })
  const [expandedLeaf, setExpandedLeaf] = React.useState<string | null>(null)
  const loaderRef = React.useRef(loadTranscript)
  loaderRef.current = loadTranscript
  const messagesRef = React.useRef(messages)
  messagesRef.current = messages
  const agentId = subagent.agentId
  React.useEffect(() => {
    if (loaderRef.current === undefined) return
    const load = loaderRef.current
    let alive = true
    setExpandedLeaf(null)
    setTranscript(prev => prev.status === 'ready' && prev.agentId === agentId ? prev : { status: 'loading' })
    load(agentId).then(loaded => {
      if (!alive) return
      if (loaded === null) { setTranscript({ status: 'unavailable' }); return }
      const leaves: TranscriptLeaf[] = []
      foldTranscriptLeaves(loaded.events, leaves, messagesRef.current)
      setTranscript({ status: 'ready', agentId, leaves: uniqueRenderKeys(leaves), parentAgentId: loaded.parentAgentId, hasOlder: loaded.hasOlder, skippedFromStart: loaded.skippedFromStart, loadingOlder: false })
    }, () => { if (alive) setTranscript({ status: 'unavailable' }) })
    return () => { alive = false }
    // Settlement makes the disk copy final: the isRunning flip reloads once.
  }, [agentId, isRunning])

  const loadOlder = (): void => {
    if (transcript.status !== 'ready' || !transcript.hasOlder || transcript.loadingOlder || loaderRef.current === undefined) return
    const load = loaderRef.current
    const count = Math.min(TRANSCRIPT_OLDER_CHUNK, transcript.skippedFromStart)
    setTranscript({ ...transcript, loadingOlder: true })
    load(transcript.agentId, { count, skipFromStart: transcript.skippedFromStart }).then(older => {
      setTranscript(prev => {
        if (prev.status !== 'ready' || older === null) return older === null && prev.status === 'ready' ? { ...prev, loadingOlder: false } : prev
        const fresh: TranscriptLeaf[] = []
        foldTranscriptLeaves(older.events, fresh, messagesRef.current)
        return { ...prev, leaves: prependOlderLeaves(fresh, prev.leaves), hasOlder: older.hasOlder, skippedFromStart: older.skippedFromStart, loadingOlder: false }
      })
    }, () => {
      setTranscript(prev => prev.status === 'ready' ? { ...prev, loadingOlder: false } : prev)
    })
  }

  // ── keyboard: the scene owns the whole screen while open ────────────────
  const [composerFocused, setComposerFocused] = React.useState(true)
  useInput((input, key, event) => {
    // The composer editor layer owns plain typing while focused (§6.5: the
    // scene still takes the vertical arrows — transcript scrolling never
    // dies behind a focused editor).
    if (composerFocused && compose !== undefined) {
      if (key.pageUp || key.pageDown) {
        event.stopImmediatePropagation()
        scrollRef.current?.scrollBy(key.pageUp ? -8 : 8)
        return
      }
      if (key.upArrow || key.downArrow) {
        event.stopImmediatePropagation()
        scrollRef.current?.scrollBy(key.upArrow ? -3 : 3)
      }
      return
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      onExit()
      return
    }
    if (key.upArrow) {
      event.stopImmediatePropagation()
      scrollRef.current?.scrollBy(-3)
      return
    }
    if (key.downArrow) {
      event.stopImmediatePropagation()
      scrollRef.current?.scrollBy(3)
      return
    }
    if (key.pageUp || key.pageDown) {
      event.stopImmediatePropagation()
      scrollRef.current?.scrollBy(key.pageUp ? -8 : 8)
      return
    }
    if (input.toLowerCase() === 'o') {
      event.stopImmediatePropagation()
      loadOlder()
      return
    }
    if (input === '' && key.return && compose !== undefined) {
      event.stopImmediatePropagation()
      setComposerFocused(true)
      return
    }
    event.stopImmediatePropagation()
  }, { isActive: true })

  // tail -f while the child runs (the Detail transcript page's rhythm).
  const tailLength = subagent.outputEvents.length
  React.useEffect(() => {
    if (!isRunning) return
    scrollRef.current?.scrollToBottom()
  }, [isRunning, tailLength])

  const headerWidth = Math.max(20, columns - 8)
  const headerLabel = `${t('subagent-card-prefix')}${subagent.description}`
  // live/history 说的是数据面真相：无 history capability 时不自称 history
  // （只剩有界 tail，范围标注自己解释）。
  const liveBadge = isRunning ? t('agent-view-live') : loadTranscript === undefined ? '' : t('agent-view-history')
  const hasHistory = loadTranscript !== undefined && transcript.status === 'ready'
  const fallbackTail = subagent.outputEvents
  const retained = fallbackTail.length >= OUTPUT_WINDOW_CAP

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Header: identity + range + readonly (28/40-column safe: one
       *  truncating line, badges flexShrink=0). */}
      <Box flexDirection="row" gap={1}>
        <Text color="accent" bold>⤢</Text>
        <Text bold wrap="truncate-end">{headerLabel}</Text>
        <Box flexShrink={0}><Text dimColor>{liveBadge === '' ? ` · ${t('agent-view-readonly')} · id ${agentId.slice(0, 8)}` : ` · ${liveBadge} · ${t('agent-view-readonly')} · id ${agentId.slice(0, 8)}`}</Text></Box>
        <Box flexGrow={1} />
        <ExitButton onClick={onExit} />
      </Box>
      <Text dimColor wrap="truncate-end">{`${t('agent-view-title')} · ${sourceLabel(source)} · ${t('agent-view-back')}: Esc${headerWidth < 44 ? '' : ` · ↑/↓ ${t('subagent-hint-scroll')} · o ${t('subagent-transcript-load-older', { count: TRANSCRIPT_OLDER_CHUNK })}`}`}</Text>

      {/* Body */}
      <Box flexDirection="column" paddingX={1} maxHeight={Math.max(10, rows - (compose !== undefined ? 12 : 6))}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          {loadTranscript === undefined ? (
            <Box flexDirection="column">
              {/* No transcript data plane: the honest bounded tail + retained
               *  range note; no fake Transcript tab, no empty-history pose. */}
              <Text dimColor>{t('agent-view-no-transcript')}</Text>
              {retained && (
                <Text dimColor>{t('agent-view-retained-tail', { count: fallbackTail.length })}</Text>
              )}
              {fallbackTail.length === 0 && messages.length === 0 && (
                <Text dimColor>{t('subagent-no-output')}</Text>
              )}
              {fallbackTail.map((line, index) => (
                <Text
                  key={`tail-${index}`}
                  wrap="wrap"
                  dimColor={line.kind === 'thinking' || line.kind === 'system'}
                  italic={line.kind === 'thinking'}
                  color={line.kind === 'error' ? 'error' : undefined}
                >
                  {line.text}{!line.settled && isRunning ? ' ▍' : ''}
                </Text>
              ))}
              {messages.map(message => (
                <AgentMessageLeafRow key={`am-${message.messageId}`} message={message} selfAgentId={agentId} marginTopOnTurn />
              ))}
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text dimColor>{`${hasHistory ? t('agent-view-history') : t('agent-view-live')} · ${t('agent-view-readonly')}`}</Text>
              {transcript.status === 'ready' && transcript.parentAgentId !== null && (
                <Text dimColor>{t('subagent-transcript-parent', { id: transcript.parentAgentId.slice(0, 8) })}</Text>
              )}
              {transcript.status === 'ready' && transcript.parentAgentId === null && (subagent.depth ?? 1) >= 2 && (
                <Text dimColor>{t('subagent-transcript-old-format', { depth: subagent.depth ?? 2 })}</Text>
              )}
              {transcript.status === 'loading' && <Text dimColor>{`⏳ ${t('subagent-transcript-loading')}`}</Text>}
              {transcript.status === 'unavailable' && <Text color="error">{t('subagent-transcript-unavailable')}</Text>}
              {transcript.status === 'ready' && (() => {
                const merged = mergeLiveWindow(transcript.leaves, subagent, true)
                const liveStart = merged.findIndex(row => row.kind === 'live')
                if (merged.length === 0) return <Text dimColor>{t('subagent-transcript-empty')}</Text>
                return (
                  <>
                    {transcript.hasOlder && (
                      <Box onClick={loadOlder} marginTop={1}>
                        <Text color="accent">{transcript.loadingOlder
                          ? `⏳ ${t('subagent-transcript-loading')}`
                          : `▸ ${t('subagent-transcript-load-older', { count: Math.min(TRANSCRIPT_OLDER_CHUNK, transcript.skippedFromStart) })}`}</Text>
                      </Box>
                    )}
                    {merged.map((row, index) => {
                      const margin = index > 0
                      if (row.kind === 'live') {
                        const line = row.line
                        const unsettled = !line.settled && isRunning ? ' ▍' : ''
                        return (
                          <React.Fragment key={`live-${index}`}>
                            {index === liveStart && <Text dimColor>{`── ${t('subagent-transcript-live')} ──`}</Text>}
                            <Text
                              wrap="wrap"
                              dimColor={line.kind === 'thinking' || line.kind === 'system'}
                              italic={line.kind === 'thinking'}
                              color={line.kind === 'error' ? 'error' : undefined}
                            >
                              {line.text}{unsettled}
                            </Text>
                          </React.Fragment>
                        )
                      }
                      if (row.kind === 'thinking') {
                        return <ThinkingLeafRow key={`think-${row.key}`} thinking={row.text} marginTopOnTurn={margin} verbose={false} />
                      }
                      if (row.kind === 'thinking-unavailable') {
                        return (
                          <Box key={`ua-${row.key}`} marginTop={margin ? 1 : 0}>
                            <Text dimColor italic>{row.tokens !== undefined ? t('subagent-thinking-count-only', { tokens: row.tokens }) : t('subagent-thinking-unavailable')}</Text>
                          </Box>
                        )
                      }
                      if (row.kind === 'text') {
                        return <AssistantTextLeafRow key={`text-${row.key}`} text={row.text} marginTopOnTurn={margin} />
                      }
                      if (row.kind === 'agent-message') {
                        return <AgentMessageLeafRow key={`am-${row.key}`} message={row.message} selfAgentId={agentId} marginTopOnTurn={margin} />
                      }
                      return (
                        <ToolLeafRow
                          key={`tool-${row.key}`}
                          tool={row.tool}
                          marginTopOnTurn={margin}
                          verbose={expandedLeaf === row.key}
                          isExpanded={expandedLeaf === row.key}
                          onClick={() => setExpandedLeaf(prev => prev === row.key ? null : row.key)}
                        />
                      )
                    })}
                  </>
                )
              })()}
            </Box>
          )}
        </ScrollBox>
      </Box>

      {/* Composer: capability-driven; the scene yields plain typing to it. */}
      {compose !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          <AgentMessageComposer
            target={compose.target}
            control={compose.control}
            messages={messages}
            focused={composerFocused}
            onFocusChange={setComposerFocused}
          />
        </Box>
      )}
    </Box>
  )
}

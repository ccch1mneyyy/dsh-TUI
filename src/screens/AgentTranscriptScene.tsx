import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import type { SubagentState } from '../dsh-adapter/subagents.js'
import { AgentMessageLeafRow, AssistantTextLeafRow, ThinkingLeafRow, ToolLeafRow } from '../components/messages/TranscriptLeaves.js'
import {
  mergeLiveWindow,
  OUTPUT_WINDOW_CAP,
  TRANSCRIPT_OLDER_CHUNK,
  useSubagentTranscript,
  type TranscriptLoader,
} from '../components/messages/subagentTranscript.js'
import { AgentMessageComposer } from '../components/AgentMessageComposer.js'
import { ExitButton } from '../components/SubagentDashboard.js'
import { t } from '../i18n.js'
import type { AgentComposeTarget, AgentMessageControl, AgentMessageView, AgentViewSource } from '../components/messages/agentTeam.js'
import { agentNeighbourhood, type AgentParentFact } from '../components/messages/agentTeam.js'

/** The workbench side panel appears at all only on wide screens (design
 *  agent-team-panels §3 P3: the 28/40-column contracts of the P1 view are
 *  untouched — below the threshold the layout is byte-identical to P1). */
const WORKBENCH_MIN_COLUMNS = 96
const WORKBENCH_PANEL_COLUMNS = 30
const WORKBENCH_TOOL_ROWS = 5
const WORKBENCH_SIBLING_ROWS = 5

const panelStatusGlyph = (status: SubagentState['status']): { glyph: string; color?: 'warning' | 'success' | 'error' | 'subtle' } =>
  status === 'running' || status === 'starting' ? { glyph: '●', color: 'warning' }
    : status === 'failed' || status === 'cancelled' ? { glyph: '×', color: 'error' }
      : status === 'unknown' ? { glyph: '○', color: 'subtle' }
        : { glyph: '✓', color: 'success' }

const panelFormatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/** One switchable neighbourhood row (a sibling, or the parent when the
 *  roster still holds it): click or panel-Enter swaps the viewed agent in
 *  place — the source stack is NOT pushed (Esc still exits to the original
 *  entry point, never to the previously viewed agent). */
function AgentSwitchRow({ agent, selected, onSelect }: { readonly agent: SubagentState; readonly selected: boolean; onSelect(): void }): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  const { glyph, color } = panelStatusGlyph(agent.status)
  return (
    <Box
      onClick={onSelect}
      onMouseEnter={(): void => setHovered(true)}
      onMouseLeave={(): void => setHovered(false)}
      backgroundColor={hovered && !selected ? 'userMessageBackgroundHover' : undefined}
    >
      <Text color={selected ? 'accent' : undefined} wrap="truncate-end">{` ${selected ? '▸' : ' '} ${glyph} `}</Text>
      <Text color={selected ? 'accent' : color} wrap="truncate-end">{agent.description}</Text>
    </Box>
  )
}

/** The parent line: only facts (agent-team §2) — a named parent, the main
 *  loop (depth-1 proof), or an honest unknown. A parent the roster lost is
 *  named but not switchable. */
function AgentParentRow({ fact, rosterIds }: { readonly fact: AgentParentFact; readonly rosterIds: ReadonlySet<string> }): React.ReactNode {
  if (fact.kind === 'main') return <Text dimColor>{'  ' + t('agent-view-parent-main')}</Text>
  if (fact.kind === 'unknown') return <Text dimColor>{'  ' + t('agent-view-parent-unknown')}</Text>
  if (!rosterIds.has(fact.agentId)) return <Text dimColor wrap="truncate-end">{'  ' + t('agent-view-parent-not-in-roster', { id: fact.agentId.slice(0, 8) })}</Text>
  return <Text dimColor wrap="truncate-end">{'  ' + t('agent-view-parent-agent', { id: fact.agentId.slice(0, 8) })}</Text>
}

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
  loadTranscript?: TranscriptLoader
  /** The durable agent↔agent feed for this child (newest last), if any. */
  readonly messages?: readonly AgentMessageView[]
  /** The channel's message control + resolved target (`subagentControl.message`);
   *  absent = no send path → no composer rendered (capability absence is
   *  absence). */
  readonly compose?: { readonly control: AgentMessageControl; readonly target: AgentComposeTarget }
  /** The session roster (workbench P3): drives the right-side panel's
   *  metadata/tools/parent sections and the sibling switcher. Absent (or a
   *  narrow terminal) = the P1 single-column layout, byte-identical. */
  readonly roster?: readonly SubagentState[]
  /** Switch the viewed agent IN PLACE (sibling/parent navigation): the
   *  source stack is preserved — Esc still returns to the original entry
   *  point. Absent = the panel renders read-only rows without switching. */
  onSwitchAgent?: (agentId: string) => void
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
export function AgentTranscriptScene({ subagent, source, onExit, loadTranscript, messages = [], compose, roster, onSwitchAgent }: AgentTranscriptSceneProps): React.ReactNode {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows, columns } = useTerminalSize()
  const isRunning = subagent.status === 'running' || subagent.status === 'starting'

  // ── workbench side panel (P3): only on wide terminals, and only with a
  // roster. Everything below degrades to the P1 view when absent. ─────────
  const panelEnabled = roster !== undefined && columns >= WORKBENCH_MIN_COLUMNS
  const [panelFocused, setPanelFocused] = React.useState(false)
  const [siblingCursor, setSiblingCursor] = React.useState(0)

  // ── history pages (the same pager the Detail transcript page uses) ──
  const [expandedLeaf, setExpandedLeaf] = React.useState<string | null>(null)
  const agentId = subagent.agentId
  // Settlement makes the disk copy final: the isRunning flip reloads once.
  const { transcript, loadOlder } = useSubagentTranscript(loadTranscript, agentId, true, isRunning, messages)
  React.useEffect(() => { setExpandedLeaf(null) }, [agentId, isRunning])

  // ── workbench neighbourhood (P3): the transcript's own parent fact wins
  // once loaded (the durable disk copy); until then the roster's fields
  // speak (agentNeighbourhood's resolution order, W1-verified). ───────────
  const transcriptParent = transcript.status === 'ready' ? transcript.parentAgentId : undefined
  const neighbourhood = React.useMemo(
    () => roster === undefined ? { parent: { kind: 'unknown' } as const, siblings: [] as readonly SubagentState[] } : agentNeighbourhood(subagent, roster, transcriptParent),
    [roster, subagent, transcriptParent],
  )
  const rosterIds = React.useMemo(() => new Set((roster ?? []).map(row => row.agentId)), [roster])
  const parentFact = neighbourhood.parent
  const parentRow = parentFact.kind === 'agent'
    ? (roster ?? []).find(row => row.agentId === parentFact.agentId)
    : undefined
  // Switch targets in panel order: the parent (when still in the roster),
  // then the siblings — the keyboard cursor and clicks share this list.
  const switchTargets = React.useMemo(() => {
    const targets: SubagentState[] = []
    if (parentRow !== undefined) targets.push(parentRow)
    targets.push(...neighbourhood.siblings.slice(0, WORKBENCH_SIBLING_ROWS))
    return targets
  }, [neighbourhood, parentRow])
  const switchTo = (agentId: string): void => { onSwitchAgent?.(agentId) }
  // A switch re-targets the view: the transcript effect reloads per
  // agentId, and the sibling cursor + scroll origin reset so nothing from
  // the previously viewed agent lingers above the fold.
  React.useEffect(() => {
    setSiblingCursor(0)
    scrollRef.current?.scrollTo(0)
  }, [agentId])

  // ── keyboard: the scene owns the whole screen while open ────────────────
  const [composerFocused, setComposerFocused] = React.useState(true)
  useInput((input, key, event) => {
    // The workbench panel layer: while focused it owns every key — the
    // arrows walk the switch targets, Enter switches in place, Esc/Tab hand
    // focus back (Esc here deliberately does NOT exit the scene: the panel
    // is one focus layer inside it, §6's Esc ladder gets its exit only when
    // no inner layer holds focus).
    if (panelFocused && panelEnabled) {
      event.stopImmediatePropagation()
      if (key.escape || key.tab) {
        setPanelFocused(false)
        setComposerFocused(compose !== undefined)
        return
      }
      if (key.upArrow || key.downArrow) {
        setSiblingCursor(cursor => Math.max(0, Math.min(switchTargets.length - 1, cursor + (key.downArrow ? 1 : -1))))
        return
      }
      if (input === '' && key.return) {
        const target = switchTargets[siblingCursor]
        if (target !== undefined) switchTo(target.agentId)
        return
      }
      return
    }
    // Tab enters the workbench panel when it exists (the composer takes no
    // Tab — its editor has no tab stops), P1 layouts never see this branch.
    if (key.tab && panelEnabled) {
      event.stopImmediatePropagation()
      setPanelFocused(true)
      setComposerFocused(false)
      return
    }
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
  // Narrow terminals keep the agent's name: read-only and the short id are
  // repeated below the header, so they are the first to go.
  const headerBadges = headerWidth < 64
    ? (liveBadge === '' ? '' : ` · ${liveBadge}`)
    : `${liveBadge === '' ? '' : ` · ${liveBadge}`} · ${t('agent-view-readonly')} · id ${agentId.slice(0, 8)}`
  const fallbackTail = subagent.outputEvents
  const retained = fallbackTail.length >= OUTPUT_WINDOW_CAP

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Header: identity + range + readonly (28/40-column safe: one
       *  truncating line, badges flexShrink=0). */}
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0}><Text color="accent" bold>⤢</Text></Box>
        <Box flexShrink={1} minWidth={0}><Text bold wrap="truncate-end">{headerLabel}</Text></Box>
        <Box flexShrink={0}><Text dimColor>{headerBadges}</Text></Box>
        <Box flexGrow={1} />
        <Box flexShrink={0}><ExitButton onClick={onExit} /></Box>
      </Box>
      <Text dimColor wrap="truncate-end">{`${t('agent-view-title')} · ${sourceLabel(source)} · ${t('agent-view-back')}: Esc${headerWidth < 44 ? '' : ` · ↑/↓ ${t('subagent-hint-scroll')} · o ${t('subagent-transcript-load-older', { count: TRANSCRIPT_OLDER_CHUNK })}`}`}</Text>

      {/* Body: the transcript column, plus the workbench panel on wide
       * terminals (P3). The panel is a LEFT-bordered rail — it never
       * reflows the transcript's own wrapping, and below the width
       * threshold this whole row collapses to the P1 single column. */}
      <Box flexDirection="row" paddingX={1} maxHeight={Math.max(10, rows - (compose !== undefined ? 12 : 6))}>
        <Box flexDirection="column" flexGrow={1} minWidth={panelEnabled ? 44 : 0}>
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
        {panelEnabled && roster !== undefined && (
          <WorkbenchPanel
            subagent={subagent}
            parent={neighbourhood.parent}
            parentRow={parentRow}
            rosterIds={rosterIds}
            siblings={neighbourhood.siblings}
            switchTargets={switchTargets}
            cursor={siblingCursor}
            focused={panelFocused}
            onSwitch={switchTo}
          />
        )}
      </Box>

      {/* Composer: capability-driven; the scene yields plain typing to it.
       *  Keyed by the target agent: a sibling switch remounts the editor —
       *  the previous target's draft NEVER travels to the new target (the
       *  no-mixing rule of the P3 workbench). */}
      {compose !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          <AgentMessageComposer
            key={compose.target.agentId}
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

/** One label/value metadata line of the workbench panel. */
function PanelMetaRow({ label, value }: { readonly label: string; readonly value: string | undefined }): React.ReactNode {
  if (value === undefined || value === '') return null
  return (
    <Box>
      <Box flexShrink={0} width={9}><Text dimColor>{label}</Text></Box>
      <Text wrap="truncate-end">{value}</Text>
    </Box>
  )
}

/**
 * WorkbenchPanel - the right rail of the full workbench (design
 * agent-team-panels §3 P3): metadata, the tool records the roster kept
 * (with the backend's own report when it stated one), and the parent /
 * sibling neighbourhood. Switching happens IN PLACE through the caller's
 * onSwitch - the panel never mutates the roster, the Channel, or the
 * source stack, and facts that are absent render as absent (an unknown
 * parent stays unknown; no tree is inferred from depth).
 */
function WorkbenchPanel({ subagent, parent, parentRow, rosterIds, siblings, switchTargets, cursor, focused, onSwitch }: {
  readonly subagent: SubagentState
  readonly parent: AgentParentFact
  readonly parentRow: SubagentState | undefined
  readonly rosterIds: ReadonlySet<string>
  readonly siblings: readonly SubagentState[]
  readonly switchTargets: readonly SubagentState[]
  readonly cursor: number
  readonly focused: boolean
  onSwitch(agentId: string): void
}): React.ReactNode {
  const running = subagent.status === 'running' || subagent.status === 'starting'
  const elapsed = running
    ? Date.now() - subagent.startedAt
    : subagent.completedAt !== undefined ? subagent.completedAt - subagent.startedAt : undefined
  const shownDuration = subagent.reportedDurationMs ?? elapsed
  const toolsCount = subagent.reportedToolUses ?? subagent.toolCalls.length
  const keptTools = subagent.toolCalls.slice(-WORKBENCH_TOOL_ROWS)
  const hiddenTools = Math.max(0, subagent.toolCalls.length - keptTools.length)
  const shownSiblings = siblings.slice(0, WORKBENCH_SIBLING_ROWS)
  const hiddenSiblings = Math.max(0, siblings.length - shownSiblings.length)
  // The cursor indexes switchTargets (the parent first when it is still in
  // the roster, then the siblings); the rows below render in that same
  // order, so the marker lands on what Enter will switch to.
  const cursorOf = (agentId: string): boolean => focused && switchTargets[cursor]?.agentId === agentId
  return (
    <Box
      flexDirection="column"
      width={WORKBENCH_PANEL_COLUMNS}
      paddingLeft={1}
      borderStyle="single"
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor="inactive"
    >
      <Text bold color={focused ? 'accent' : undefined}>{t('agent-view-panel-title')}</Text>
      <Text dimColor>{' ' + t('agent-view-panel-metadata') + ' ─────'}</Text>
      <PanelMetaRow label={t('agent-view-field-status')} value={subagent.status} />
      <PanelMetaRow label={t('agent-view-field-mode')} value={subagent.mode} />
      <PanelMetaRow label={t('agent-view-field-model')} value={subagent.model ?? subagent.provider} />
      <PanelMetaRow label={t('agent-view-field-tokens')} value={subagent.tokens === undefined ? undefined : String(subagent.tokens.total ?? ((subagent.tokens.input ?? 0) + (subagent.tokens.output ?? 0)))} />
      <PanelMetaRow label={t('agent-view-field-duration')} value={shownDuration === undefined ? undefined : panelFormatDuration(shownDuration)} />
      <PanelMetaRow label={t('agent-view-field-run')} value={subagent.runId === undefined ? undefined : subagent.runId.slice(0, 8)} />
      <PanelMetaRow label={t('agent-view-field-session')} value={subagent.sessionId === undefined ? undefined : subagent.sessionId.slice(0, 8)} />
      <PanelMetaRow label={t('agent-view-field-depth')} value={subagent.depth === undefined ? undefined : String(subagent.depth)} />
      <Text dimColor>{' ' + t('agent-view-panel-tools') + ' ────────'}</Text>
      {subagent.toolCalls.length === 0 && subagent.reportedToolUses === undefined && (
        <Text dimColor>{'  ' + t('agent-view-tools-none')}</Text>
      )}
      {subagent.reportedToolUses !== undefined && subagent.reportedToolUses !== subagent.toolCalls.length && (
        <Text dimColor>{'  ' + t('agent-view-tools-reported', { reported: toolsCount, kept: subagent.toolCalls.length })}</Text>
      )}
      {keptTools.map(tool => (
        <Box key={tool.id ?? tool.name + tool.startedAt}>
          <Box flexShrink={0}><Text color={tool.status === 'failed' ? 'error' : tool.status === 'running' ? 'warning' : 'success'}>{tool.status === 'failed' ? '× ' : tool.status === 'running' ? '● ' : '✓ '}</Text></Box>
          <Text wrap="truncate-end" dimColor={tool.status === 'completed'}>{tool.name}</Text>
        </Box>
      ))}
      {hiddenTools > 0 && <Text dimColor>{'  ' + t('agent-view-tools-more', { count: hiddenTools })}</Text>}
      <Text dimColor>{' ' + t('agent-view-parent-context') + ' ──────'}</Text>
      {parentRow !== undefined
        ? <AgentSwitchRow agent={parentRow} selected={cursorOf(parentRow.agentId)} onSelect={(): void => onSwitch(parentRow.agentId)} />
        : <AgentParentRow fact={parent} rosterIds={rosterIds} />}
      {shownSiblings.map(agent => (
        <AgentSwitchRow key={agent.agentId} agent={agent} selected={cursorOf(agent.agentId)} onSelect={(): void => onSwitch(agent.agentId)} />
      ))}
      {hiddenSiblings > 0 && <Text dimColor>{'  ' + t('agent-view-siblings-more', { count: hiddenSiblings })}</Text>}
      {siblings.length === 0 && <Text dimColor>{'  ' + t('agent-view-siblings-none')}</Text>}
      <Box marginTop={1}>
        <Text dimColor>{focused ? t('agent-view-select-sibling-focused') : t('agent-view-select-sibling')}</Text>
      </Box>
    </Box>
  )
}

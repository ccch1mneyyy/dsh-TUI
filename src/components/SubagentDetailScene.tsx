import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import type { SubagentOutputLine, SubagentState } from '../dsh-adapter/subagents.js'
import { t } from '../i18n.js'
import { Divider } from './design-system/Divider.js'
import { ExitButton } from './SubagentDashboard.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { toolNameColor } from './messages/AssistantToolUseMessage.js'
import { Markdown } from './Markdown.js'
import { getCliHighlightPromise } from '../terminal-utils/cliHighlight.js'
import { isMinimalUiMode } from '../minimalUiMode.js'
import type { Theme } from '../theme.js'
import { THINKING_SETTLED_MARKER } from '../terminal-utils/figures.js'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return `${min}m${sec}s`
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

function statusGlyph(status: SubagentState['status']): { glyph: string; color: keyof Theme | undefined; label: string } {
  const minimalUi = isMinimalUiMode()
  if (status === 'completed') return { glyph: minimalUi ? '✓' : '🟢', color: minimalUi ? undefined : 'success', label: 'done' }
  if (status === 'failed') return { glyph: minimalUi ? '×' : '🔴', color: minimalUi ? undefined : 'error', label: 'failed' }
  if (status === 'cancelled') return { glyph: minimalUi ? '×' : '🔴', color: minimalUi ? undefined : 'error', label: 'cancelled' }
  if (status === 'unknown') return { glyph: minimalUi ? '·' : '⚪', color: minimalUi ? undefined : 'subtle', label: 'history' }
  return { glyph: minimalUi ? '·' : '🟡', color: minimalUi ? undefined : 'warning', label: 'running' }
}

const PAGES = ['summary', 'output', 'tools'] as const
type DetailPage = (typeof PAGES)[number]

/** One label/value row of the summary stats card. */
function StatRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <Box flexDirection="row">
      <Box width={14} flexShrink={0}><Text dimColor>{label}</Text></Box>
      <Box flexDirection="row" flexGrow={1}>{children}</Box>
    </Box>
  )
}

/** Two-column key/value stats grid (Kimi Code settled summary style). */
function StatGrid({ subagent, totalTokens, elapsed, statusLabel, statusColor }: {
  subagent: SubagentState
  totalTokens: number
  elapsed: number | undefined
  statusLabel: string
  statusColor: keyof Theme | undefined
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <StatRow label={t('subagent-status-label')}>
        <Text color={statusColor}>{statusLabel}</Text>
      </StatRow>
      <StatRow label={t('subagent-model')}>
        <Text>{subagent.model ?? subagent.provider ?? 'default'}</Text>
      </StatRow>
      <StatRow label={t('subagent-duration')}>
        <Text>{elapsed !== undefined ? formatDuration(elapsed) : '—'}</Text>
      </StatRow>
      <StatRow label="tokens">
        <Text>{totalTokens || '—'}{subagent.tokens?.input !== undefined ? ` (in ${subagent.tokens.input} · out ${subagent.tokens.output ?? 0})` : ''}</Text>
      </StatRow>
      <StatRow label={t('subagent-tools')}>
        <Text>{subagent.toolCalls.length}</Text>
      </StatRow>
      <StatRow label={t('subagent-started')}>
        <Text>{formatTimestamp(subagent.startedAt)}</Text>
      </StatRow>
      {subagent.completedAt !== undefined && (
        <StatRow label={t('subagent-completed')}>
          <Text>{formatTimestamp(subagent.completedAt)}</Text>
        </StatRow>
      )}
    </Box>
  )
}

/** Tool args line: JSON-looking args get cli-highlight syntax colors (loaded
 * lazily through the shared promise); anything else stays a dim flat line. */
function JsonArgsText({ raw }: { raw: string }): React.ReactNode {
  const flat = raw.replace(/\s+/g, ' ').trim()
  const json = flat.startsWith('{') || flat.startsWith('[')
  const [highlighted, setHighlighted] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!json) return
    let alive = true
    void getCliHighlightPromise().then(cli => {
      if (!alive || cli === null) return
      try {
        setHighlighted(cli.highlight(flat, { language: 'json' }))
      } catch {
        // Not parseable JSON after all — keep the dim fallback.
      }
    })
    return () => { alive = false }
  }, [flat, json])
  if (json && highlighted !== null) return <Text wrap="wrap">{highlighted}</Text>
  return <Text dimColor wrap="wrap">{flat}</Text>
}

/**
 * One rendered row of the output page: either a run of consecutive reasoning
 * rows (folded into the chat's thinking grammar, \`⚓ Thinking · 12s\`) or a
 * single event line. Folding by RUN keeps the transcript order intact while
 * stopping a long chain of thought from burying the answer.
 */
type DetailBlock =
  | { kind: 'thinking'; lines: SubagentOutputLine[] }
  | { kind: 'prose'; lines: SubagentOutputLine[] }
  | { kind: 'line'; line: SubagentOutputLine }

function groupOutputEvents(events: readonly SubagentOutputLine[]): DetailBlock[] {
  const blocks: DetailBlock[] = []
  for (const line of events) {
    if (line.kind === 'thinking') {
      const last = blocks[blocks.length - 1]
      if (last !== undefined && last.kind === 'thinking') last.lines.push(line)
      else blocks.push({ kind: 'thinking', lines: [line] })
      continue
    }
    // Consecutive prose lines are ONE markdown document: without the fold a
    // `**bold**` line, its list items and its paragraph break would render as
    // raw syntax separated by blank rows. Activity pointers and tool/error
    // rows stay independent single lines.
    if (line.kind === 'text' && !isActivityLine(line.text)) {
      const last = blocks[blocks.length - 1]
      if (last !== undefined && last.kind === 'prose') last.lines.push(line)
      else blocks.push({ kind: 'prose', lines: [line] })
      continue
    }
    blocks.push({ kind: 'line', line })
  }
  return blocks
}

/** The child's own status line reaches us as a text delta (\`⏵ reading …\`);
 *  it is activity, not prose, so it renders as a dim pointer row. */
const ACTIVITY_GLYPHS = ['⏵', '▶', '▸', '»']

function isActivityLine(text: string): boolean {
  return ACTIVITY_GLYPHS.includes(text.trimStart().slice(0, 1))
}

export interface SubagentDetailSceneProps {
  subagent: SubagentState
  onBack: () => void
  onInterrupt?: (agentId: string) => void
}

/**
 * SubagentDetailScene — full-screen paged detail view for one subagent.
 * Header block (identity + stats) stays fixed; the body pages through
 * 摘要 / 输出 / 工具 with ←/→. Follow-up delivery was removed: the official
 * seam only accepts continuable children, and one-shot spawn children are
 * disposed at settlement, so the affordance would be a dead control.
 */
export function SubagentDetailScene({
  subagent,
  onBack,
  onInterrupt,
}: SubagentDetailSceneProps): React.ReactNode {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows, columns } = useTerminalSize()
  const [page, setPage] = React.useState<DetailPage>('summary')

  const isRunning = subagent.status === 'running' || subagent.status === 'starting'
  // Only a live run ticks; discovered history (`unknown`) shows no duration.
  const elapsed = isRunning
    ? Date.now() - subagent.startedAt
    : subagent.completedAt !== undefined ? subagent.completedAt - subagent.startedAt : undefined
  const info = statusGlyph(subagent.status)
  const totalTokens = subagent.tokens?.total ?? ((subagent.tokens?.input ?? 0) + (subagent.tokens?.output ?? 0) || 0)
  const pageIndex = PAGES.indexOf(page)

  /** Folded reasoning runs (the transcript's thinking grammar). Enter flips
   *  every run at once so one key stays predictable across thought steps. */
  const [thinkingOpen, setThinkingOpen] = React.useState(false)
  const blocks = groupOutputEvents(subagent.outputEvents)
  const hasThinking = blocks.some(block => block.kind === 'thinking')
  const settled = !isRunning
  // The deliverable is the LAST prose block: a `── Conclusion ──` rule goes in
  // front of it once the run settles, so the answer is never the last line of
  // a wall of reasoning.
  const answerBlock = ((): number => {
    if (!settled) return -1
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]!
      if (block.kind === 'prose' && block.lines.some(p => p.text.trim() !== '')) return i
      if (block.kind === 'line' && block.line.kind === 'text' && block.line.text.trim() !== '') return i
    }
    return -1
  })()

  const turnPage = (delta: number): void => {
    const next = (pageIndex + delta + PAGES.length) % PAGES.length
    setPage(PAGES[next]!)
    scrollRef.current?.scrollTo?.(0)
  }

  // tail -f: while the subagent runs and the output page is showing, follow
  // the newest streamed line. Page switches or settlement stop the follow so
  // manual ↑ scrolling wins.
  // Expanding the reasoning grows the box past its viewport, and the renderer
  // then treats the growth as "was at bottom" (maxScroll was 0 while the folded
  // body fit) and re-pins the view to the bottom — pushing the fold header out
  // of sight. Re-anchor AFTER that frame: the first immediate lands behind the
  // renderer's own scheduling, and the second behind the re-pin frame it caused.
  React.useEffect(() => {
    if (page !== 'output') return
    const first = setImmediate(() => scrollRef.current?.scrollTo?.(0))
    return () => clearImmediate(first)
  }, [thinkingOpen, page])

  const outputLength = subagent.outputEvents.length
  React.useEffect(() => {
    if (page !== 'output' || !isRunning) return
    scrollRef.current?.scrollToBottom()
  }, [page, isRunning, outputLength])

  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      onBack()
      return
    }
    if (key.leftArrow) {
      event.stopImmediatePropagation()
      turnPage(-1)
      return
    }
    if (key.rightArrow) {
      event.stopImmediatePropagation()
      turnPage(1)
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
    if (input.toLowerCase() === 'x' && isRunning && onInterrupt) {
      event.stopImmediatePropagation()
      onInterrupt(subagent.agentId)
      return
    }
    if (isPlainReturnInput(input, key)) {
      event.stopImmediatePropagation()
      // Enter folds the reasoning while the output page is showing (the
      // transcript's ctrl+o equivalent). Elsewhere it keeps its "leave the
      // detail" meaning, which Esc and the ✕ button still provide.
      if (page === 'output' && hasThinking) setThinkingOpen(open => !open)
      else onBack()
      return
    }
    event.stopImmediatePropagation()
  })

  const tab = (name: DetailPage, label: string): React.ReactNode => {
    const active = page === name
    return (
      <React.Fragment key={name}>
        <Box
          onClick={() => setPage(name)}
          backgroundColor={!active ? 'userMessageBackgroundHover' : undefined}
        >
          <Text color={active ? 'accent' : undefined} bold={active} inverse={active}>
            {` ${label} `}
          </Text>
        </Box>
        <Text dimColor>{name === PAGES[PAGES.length - 1] ? '' : '│'}</Text>
      </React.Fragment>
    )
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Header: identity line, stats line, timing line */}
      <Box flexDirection="row" gap={1}>
        <Text color={info.color} bold>{info.glyph}</Text>
        <Text bold>{`${t('subagent-card-prefix')}${subagent.description}`}</Text>
        <Text dimColor>·</Text>
        <Text color={info.color}>{info.label}</Text>
        {subagent.mode === 'continuable' && <Text color="warning">{t('subagent-mode-continuable')}</Text>}
        {subagent.mode === 'one-shot' && <Text dimColor>{t('subagent-mode-one-shot')}</Text>}
        <Box flexGrow={1} />
        {/* 可点击退出（Esc/Enter 的鼠标等价），hover 提亮 */}
        <ExitButton onClick={onBack} />
      </Box>
      <Text>
        <Text>{subagent.model ?? subagent.provider ?? 'default'}</Text>
        <Text dimColor>{elapsed !== undefined ? ` · ${formatDuration(elapsed)} · ` : ' · '}{totalTokens || '—'} tok · {subagent.toolCalls.length} tools</Text>
      </Text>
      <Text dimColor>
        {`${t('subagent-started')} ${formatTimestamp(subagent.startedAt)}`
        + (subagent.completedAt ? ` · ${t('subagent-completed')} ${formatTimestamp(subagent.completedAt)}` : '')}
        {` · id ${subagent.agentId.slice(0, 8)}`}
      </Text>
      {subagent.error && (
        <Box marginTop={0}>
          <Text color="error" wrap="wrap">{`${t('subagent-error-label')}: ${subagent.error}`}</Text>
        </Box>
      )}

      {/* Tab bar with page indicator */}
      <Box flexDirection="row" gap={0} marginTop={1}>
        {tab('summary', t('subagent-tab-summary'))}
        {tab('output', subagent.outputEvents.length > 0 ? `${t('subagent-output-label')} ${subagent.outputEvents.length}` : t('subagent-output-label'))}
        {tab('tools', subagent.toolCalls.length > 0 ? `${t('subagent-tools')} ${subagent.toolCalls.length}` : t('subagent-tools'))}
        <Text dimColor>{`  ${pageIndex + 1}/${PAGES.length}`}</Text>
      </Box>
      <Text dimColor>{'─'.repeat(Math.max(20, Math.min(72, columns - 6)))}</Text>

      {/* Paged body */}
      <Box flexDirection="column" paddingX={1} maxHeight={Math.max(10, rows - 14)}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          {page === 'summary' && (
            <Box flexDirection="column">
              {/* Stats card: two-column key/value grid (Kimi Code settled
               * summary style) above the final answer. */}
              <StatGrid subagent={subagent} totalTokens={totalTokens} elapsed={elapsed} statusLabel={info.label} statusColor={info.color} />
              {subagent.summary && (
                <Box flexDirection="column" marginTop={1}>
                  <Text dimColor bold>{'─ summary '}</Text>
                  <Text wrap="wrap">{subagent.summary}</Text>
                </Box>
              )}
              {!subagent.summary && (
                <Text dimColor>{isRunning ? t('subagent-no-output') : t('subagent-no-summary')}</Text>
              )}
            </Box>
          )}
          {page === 'output' && (
            subagent.outputEvents.length === 0 && subagent.output.length === 0 ? (
              <Text dimColor>{t('subagent-no-output')}</Text>
            ) : (
              blocks.map((block, index) => {
                if (block.kind === 'thinking') {
                  const text = block.lines.map(line => line.text).join('\n')
                  const chars = text.replace(/\s+/g, '').length
                  const label = `${THINKING_SETTLED_MARKER} ${t('subagent-thinking-fold', { count: block.lines.length, chars })}`
                  const hint = thinkingOpen ? t('subagent-thinking-collapse') : t('subagent-thinking-expand')
                  return (
                    <Box key={`think-${index}`} flexDirection="column">
                      <Text italic dimColor>{`${label}  ·  ${hint}`}</Text>
                      {thinkingOpen ? (
                        <Box flexDirection="column" paddingLeft={2}>
                          {block.lines.map((line, i) => (
                            <Text key={i} dimColor italic wrap="wrap">{line.text}</Text>
                          ))}
                        </Box>
                      ) : (
                        <Text dimColor italic wrap="truncate-end">{`  ${block.lines[0]?.text.replace(/\s+/g, ' ').trim() ?? ''}`}</Text>
                      )}
                    </Box>
                  )
                }
                if (block.kind === 'prose') {
                  const proseText = block.lines.map(p => p.text).join('\n')
                  const proseUnsettled = isRunning && block.lines.some(p => p.settled === false)
                  const isProseAnswer = index === answerBlock
                  return (
                    <Box key={`prose-${index}`} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
                      {isProseAnswer && (
                        <Text dimColor>{`── ${t('subagent-conclusion')} ${'─'.repeat(Math.max(8, Math.min(60, columns - 16)))}`}</Text>
                      )}
                      <Markdown dimColor={false} cacheTokens>{proseText}</Markdown>
                      {proseUnsettled && <Text dimColor>{'▌'}</Text>}
                    </Box>
                  )
                }
                const line = block.line
                const unsettled = !line.settled && isRunning ? ' ▍' : ''
                if (line.kind === 'text' && isActivityLine(line.text)) {
                  return (
                    <Box key={`act-${index}`} flexDirection="row" gap={1}>
                      <Text color="accent">{'⏵'}</Text>
                      <Text dimColor wrap="truncate-end">{line.text.replace(/^[\s⏵▶▸»]+/, '')}{unsettled}</Text>
                    </Box>
                  )
                }
                const isAnswer = index === answerBlock
                // Tool / error / system rows get a leading row gap so a wall
                // of streamed rows stops reading as one cramped paragraph.
                const rowGap = line.kind === 'tool' || line.kind === 'error' || line.kind === 'system'
                return (
                  <Box key={`line-${index}`} flexDirection="column" marginTop={rowGap && index !== 0 ? 1 : 0}>
                    {isAnswer && (
                      <Text dimColor>{`── ${t('subagent-conclusion')} ${'─'.repeat(Math.max(8, Math.min(60, columns - 16)))}`}</Text>
                    )}
                    <Text
                      wrap="wrap"
                      bold={isAnswer}
                      dimColor={line.kind === 'system'}
                      color={line.kind === 'error' ? 'error' : line.kind === 'tool' ? 'accent' : undefined}
                    >
                      {line.kind === 'tool' ? `● ${line.text}` : line.text}{unsettled}
                    </Text>
                  </Box>
                )
              })
            )
          )}
          {page === 'tools' && (
            subagent.toolCalls.length === 0 ? (
              <Text dimColor>{t('subagent-no-tools')}</Text>
            ) : (
              subagent.toolCalls.map((tool, index) => (
                <Box key={tool.id ?? index} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
                  <Box flexDirection="row" gap={1}>
                    <Text color={tool.status === 'failed' ? 'error' : tool.status === 'running' ? 'warning' : 'success'}>
                      {tool.status === 'running' ? '·' : tool.status === 'failed' ? '×' : '✓'}
                    </Text>
                    <Text color={toolNameColor(tool.name)}>{tool.name}</Text>
                    {tool.endedAt && <Text dimColor>{formatDuration(tool.endedAt - tool.startedAt)}</Text>}
                  </Box>
                  {tool.argsPreview && (
                    <Box flexDirection="row" paddingLeft={2}>
                      <JsonArgsText raw={tool.argsPreview} />
                    </Box>
                  )}
                  {tool.resultPreview && (
                    <Box flexDirection="row" paddingLeft={2}>
                      <Text dimColor wrap="wrap">{`⎿ ${tool.resultPreview}`}</Text>
                    </Box>
                  )}
                  {tool.error && (
                    <Box flexDirection="row" paddingLeft={2}>
                      <Text color="error" wrap="wrap">{tool.error}</Text>
                    </Box>
                  )}
                </Box>
              ))
            )
          )}
        </ScrollBox>
      </Box>

      <Divider color="subtle" title="" />
      {/* Footer hint */}
      <Box marginTop={0} flexDirection="row">
        <Text dimColor>
          {`←/→ ${t('subagent-hint-page')} · ↑/↓ ${t('subagent-hint-scroll')}`
            + (page === 'output' && hasThinking ? ` · ${t('subagent-hint-fold')}` : '')}
        </Text>
        {isRunning && onInterrupt && (
          <>
            <Text dimColor>{' · '}</Text>
            <Box onClick={() => onInterrupt(subagent.agentId)}>
              <Text dimColor bold color="warning">X interrupt</Text>
            </Box>
          </>
        )}
        <Text dimColor>{` · Esc ${t('subagent-hint-back')}`}</Text>
      </Box>
    </Box>
  )
}

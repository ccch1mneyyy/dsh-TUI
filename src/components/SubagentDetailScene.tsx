import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import type { SubagentState } from '../dsh-adapter/subagents.js'
import { t } from '../i18n.js'
import { Divider } from './design-system/Divider.js'
import { ExitButton } from './SubagentDashboard.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { toolNameColor } from './messages/AssistantToolUseMessage.js'
import { getCliHighlightPromise } from '../cc/cliHighlight.js'
import { isMinimalMode } from '../minimalMode.js'
import type { Theme } from '../theme.js'

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
  const minimal = isMinimalMode()
  if (status === 'completed') return { glyph: minimal ? '✓' : '🟢', color: minimal ? undefined : 'success', label: 'done' }
  if (status === 'failed') return { glyph: minimal ? '×' : '🔴', color: minimal ? undefined : 'error', label: 'failed' }
  if (status === 'cancelled') return { glyph: minimal ? '×' : '🔴', color: minimal ? undefined : 'error', label: 'cancelled' }
  return { glyph: minimal ? '·' : '🟡', color: minimal ? undefined : 'warning', label: 'running' }
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
  elapsed: number
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
        <Text>{formatDuration(elapsed)}</Text>
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
  const elapsed = subagent.completedAt ? subagent.completedAt - subagent.startedAt : Date.now() - subagent.startedAt
  const info = statusGlyph(subagent.status)
  const totalTokens = subagent.tokens?.total ?? ((subagent.tokens?.input ?? 0) + (subagent.tokens?.output ?? 0) || 0)
  const pageIndex = PAGES.indexOf(page)

  const turnPage = (delta: number): void => {
    const next = (pageIndex + delta + PAGES.length) % PAGES.length
    setPage(PAGES[next]!)
    scrollRef.current?.scrollTo?.(0)
  }

  // tail -f: while the subagent runs and the output page is showing, follow
  // the newest streamed line. Page switches or settlement stop the follow so
  // manual ↑ scrolling wins.
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
      onBack()
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
          <Text color={active ? 'claude' : undefined} bold={active} inverse={active}>
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
        <Box flexGrow={1} />
        {/* 可点击退出（Esc/Enter 的鼠标等价），hover 提亮 */}
        <ExitButton onClick={onBack} />
      </Box>
      <Text>
        <Text>{subagent.model ?? subagent.provider ?? 'default'}</Text>
        <Text dimColor>{` · ${formatDuration(elapsed)} · ${totalTokens || '—'} tok · ${subagent.toolCalls.length} tools`}</Text>
      </Text>
      <Text dimColor>
        {`${t('subagent-started')} ${formatTimestamp(subagent.startedAt)}`
        + (subagent.completedAt ? ` · ${t('subagent-completed')} ${formatTimestamp(subagent.completedAt)}` : '')}
        {` · id ${subagent.agentId}`}
      </Text>
      {subagent.error && (
        <Box marginTop={0}>
          <Text color="error" wrap="wrap">{`${t('subagent-error-label')}: ${subagent.error}`}</Text>
        </Box>
      )}

      {/* Tab bar with page indicator */}
      <Box flexDirection="row" gap={0} marginTop={1}>
        {tab('summary', t('subagent-tab-summary'))}
        {tab('output', t('subagent-output-label'))}
        {tab('tools', t('subagent-tools'))}
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
              subagent.outputEvents.map((line, index) => (
                <Text
                  key={index}
                  wrap="wrap"
                  dimColor={line.kind === 'thinking' || line.kind === 'system'}
                  color={line.kind === 'error' ? 'error' : undefined}
                >
                  {line.kind === 'thinking' ? '  ⌁ ' : '  '}{line.text}{!line.settled && isRunning ? ' ▍' : ''}
                </Text>
              ))
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
          {`←/→ ${t('subagent-hint-page')} · ↑/↓ ${t('subagent-hint-scroll')}`}
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

import React from 'react'
import { Box, ScrollBox, Text, type ScrollBoxHandle, useInput, useTerminalSize } from '../ui.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { MessageList } from '../components/MessageList.js'
import { truncateWidth } from '../sessions/format.js'
import { stringWidth } from '../ink/stringWidth.js'
import { isPlainReturn } from '../utils/modifiers.js'
import { t } from '../i18n.js'
import type { Channel, ChatRow, SubagentListItem } from '../dsh-adapter/channel.js'

const EMPTY_EXPANDED_ROWS = new Set<number>()

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function idText(id: string): string {
  return id.slice(0, 12)
}

function fitHint(full: string, short: string, width: number): string {
  const visible = (text: string): string => text.replace(/\*\*/gu, '')
  if (stringWidth(visible(full)) <= width) return full
  if (stringWidth(visible(short)) <= width) return short
  return truncateWidth(visible(short), width)
}

function childAt(entries: readonly SubagentListItem[], index: number): Extract<SubagentListItem, { kind: 'child' }> | undefined {
  const entry = entries[index]
  return entry?.kind === 'child' ? entry : undefined
}

function seekChild(entries: readonly SubagentListItem[], from: number, by: 1 | -1): number {
  if (entries.length === 0) return -1
  let at = from
  for (let checked = 0; checked < entries.length; checked++) {
    at = (at + by + entries.length) % entries.length
    if (entries[at]?.kind === 'child') return at
  }
  return -1
}

function diagnosticText(entry: Extract<SubagentListItem, { kind: 'diagnostic' }>): string {
  const reason = entry.reason === 'corrupt'
    ? t('subagent-diagnostic-corrupt')
    : entry.reason === 'unsupported'
      ? t('subagent-diagnostic-unsupported')
      : t('subagent-diagnostic-unavailable')
  return `${idText(entry.id)} · ${reason}`
}

function ListRow({ entry, focused, width }: { entry: SubagentListItem; focused: boolean; width: number }): React.ReactNode {
  if (entry.kind === 'diagnostic') {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text color="warning">  ! {truncateWidth(diagnosticText(entry), Math.max(8, width - 4))}</Text>
        <Text dimColor>    {truncateWidth(t('subagent-diagnostic-hint'), Math.max(8, width - 4))}</Text>
      </Box>
    )
  }

  const title = entry.label?.trim() || idText(entry.id)
  const mode = entry.mode === 'continuable' ? t('subagent-resumable') : t('subagent-oneshot')
  const activity = entry.activity === 'running' ? t('subagent-running-short') : t('subagent-archived-short')
  const facts = [mode, activity, idText(entry.id)]
  if (entry.hasChildren) facts.push(t('subagent-has-children'))
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={focused ? 'suggestion' : undefined} bold={focused}>
        {focused ? '❯ ' : '  '}{truncateWidth(title, Math.max(8, width - 2))}
      </Text>
      <Text dimColor>  {truncateWidth(facts.join(' · '), Math.max(8, width - 2))}</Text>
    </Box>
  )
}

function Transcript({
  channel,
  entry,
  rows,
  loading,
  failure,
}: {
  channel: Channel
  entry: Extract<SubagentListItem, { kind: 'child' }>
  rows: readonly ChatRow[] | undefined
  loading: boolean
  failure: string | undefined
}): React.ReactNode {
  const { columns, rows: terminalRows } = useTerminalSize()
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const [expanded, setExpanded] = React.useState(false)

  useInput((input, key) => {
    if (key.upArrow) scrollRef.current?.scrollBy(-3)
    else if (key.downArrow) scrollRef.current?.scrollBy(3)
    else if (key.pageUp) scrollRef.current?.scrollBy(-Math.max(1, scrollRef.current.getViewportHeight() - 2))
    else if (key.pageDown) scrollRef.current?.scrollBy(Math.max(1, scrollRef.current.getViewportHeight() - 2))
    else if (input === 'g') scrollRef.current?.scrollTo(0)
    else if (input === 'G') scrollRef.current?.scrollToBottom()
    else if (key.ctrl && input === 'o') setExpanded(value => !value)
  })

  const title = entry.label?.trim() || idText(entry.id)
  const mode = entry.mode === 'continuable' ? t('subagent-resumable') : t('subagent-oneshot')
  const activity = entry.activity === 'running' ? t('subagent-running-short') : t('subagent-archived-short')
  return (
    <Box flexDirection="column" height={terminalRows} width="100%">
      <Box flexDirection="column" flexShrink={0}>
        <Text bold color="suggestion">{truncateWidth(title, columns)}</Text>
        <Text dimColor>{truncateWidth(`${mode} · ${activity} · ${t('subagent-read-only')} · ${entry.id}`, columns)}</Text>
        <Divider />
      </Box>
      {loading ? (
        <Box flexGrow={1} alignItems="center" justifyContent="center"><Text dimColor>{t('subagent-session-loading')}</Text></Box>
      ) : failure !== undefined ? (
        <Box flexGrow={1} alignItems="center" justifyContent="center"><Text color="error">{failure}</Text></Box>
      ) : rows === undefined || rows.length === 0 ? (
        <Box flexGrow={1} alignItems="center" justifyContent="center"><Text dimColor>{t('subagent-session-empty')}</Text></Box>
      ) : (
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1} flexShrink={1} stickyScroll>
          <MessageList
            rows={rows}
            expanded={expanded}
            expandedRows={EMPTY_EXPANDED_ROWS}
            selectedId={null}
            onToggleRow={() => {}}
            model={channel.model}
            showAll
            onToggleAll={() => {}}
          />
        </ScrollBox>
      )}
      <Box flexDirection="column" flexShrink={0}>
        <Divider />
        <Text dimColor italic>
          <HintLine text={fitHint(t('subagent-detail-hint'), t('subagent-detail-hint-short'), columns)} />
        </Text>
      </Box>
    </Box>
  )
}

/** Full-screen read-only child-session browser opened by `/agents`. */
export function SubagentScene({ channel, onClose }: { channel: Channel; onClose: () => void }): React.ReactNode {
  const { columns, rows: terminalRows } = useTerminalSize()
  const [entries, setEntries] = React.useState<readonly SubagentListItem[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const [listFailure, setListFailure] = React.useState<string | undefined>()
  const [serviceAvailable, setServiceAvailable] = React.useState(true)
  const [focus, setFocus] = React.useState(-1)
  const focusRef = React.useRef(-1)
  const [openEntry, setOpenEntry] = React.useState<Extract<SubagentListItem, { kind: 'child' }> | undefined>()
  const [transcriptRows, setTranscriptRows] = React.useState<readonly ChatRow[] | undefined>()
  const [transcriptLoading, setTranscriptLoading] = React.useState(false)
  const [transcriptFailure, setTranscriptFailure] = React.useState<string | undefined>()
  const requestRef = React.useRef(0)
  const pollTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  React.useEffect(() => () => {
    requestRef.current += 1
    if (pollTimerRef.current !== undefined) clearTimeout(pollTimerRef.current)
  }, [])

  React.useEffect(() => {
    let live = true
    void channel.listSubagents()
      .then(result => {
        if (!live) return
        if (result === undefined) {
          setServiceAvailable(false)
          setEntries([])
          return
        }
        setEntries(result)
        const first = result.findIndex(entry => entry.kind === 'child')
        focusRef.current = first
        setFocus(first)
      })
      .catch(error => {
        if (live) setListFailure(t('subagent-list-failed', { err: message(error) }))
      })
      .finally(() => {
        if (live) setLoaded(true)
      })
    return () => {
      live = false
    }
  }, [channel])

  const open = (entry: Extract<SubagentListItem, { kind: 'child' }>): void => {
    const request = ++requestRef.current
    if (pollTimerRef.current !== undefined) clearTimeout(pollTimerRef.current)
    setOpenEntry(entry)
    setTranscriptRows(undefined)
    setTranscriptFailure(undefined)
    setTranscriptLoading(true)
    const read = (initial: boolean): void => {
      void channel.readSubagentSession(entry.id)
        .then(result => {
          if (request !== requestRef.current) return
          if (result === undefined) {
            if (initial) setTranscriptFailure(t('subagent-session-unavailable'))
            return
          }
          setTranscriptRows(result.rows)
          setTranscriptFailure(undefined)
          if (entry.activity === 'running') {
            pollTimerRef.current = setTimeout(() => read(false), 750)
          }
        })
        .catch(error => {
          if (request === requestRef.current && initial) {
            setTranscriptFailure(t('subagent-session-failed', { err: message(error) }))
          }
          if (request === requestRef.current && entry.activity === 'running') {
            pollTimerRef.current = setTimeout(() => read(false), 750)
          }
        })
        .finally(() => {
          if (request === requestRef.current && initial) setTranscriptLoading(false)
        })
    }
    read(true)
  }

  useInput((_input, key) => {
    if (openEntry !== undefined) {
      if (key.escape) {
        requestRef.current += 1
        if (pollTimerRef.current !== undefined) clearTimeout(pollTimerRef.current)
        setOpenEntry(undefined)
        setTranscriptRows(undefined)
        setTranscriptFailure(undefined)
        setTranscriptLoading(false)
      }
      return
    }
    if (key.escape) {
      onClose()
      return
    }
    if (key.upArrow || key.downArrow) {
      const next = seekChild(entries, focusRef.current, key.downArrow ? 1 : -1)
      focusRef.current = next
      setFocus(next)
      return
    }
    if (isPlainReturn(key)) {
      const entry = childAt(entries, focusRef.current)
      if (entry !== undefined) open(entry)
    }
  })

  if (openEntry !== undefined) {
    return (
      <Transcript
        channel={channel}
        entry={openEntry}
        rows={transcriptRows}
        loading={transcriptLoading}
        failure={transcriptFailure}
      />
    )
  }

  const chromeRows = 5
  const visibleCount = Math.max(0, Math.floor((terminalRows - chromeRows) / 2))
  const top = focus < 0 || visibleCount === 0
    ? 0
    : Math.min(Math.max(0, focus - visibleCount + 1), Math.max(0, entries.length - visibleCount))
  const visible = entries.slice(top, top + visibleCount)
  const childCount = entries.filter(entry => entry.kind === 'child').length

  return (
    <Box flexDirection="column" height={terminalRows} width="100%">
      <Box justifyContent="space-between" flexShrink={0}>
        <Text bold color="suggestion">{t('subagent-title')}</Text>
        <Text dimColor>{loaded ? t('subagent-count', { n: childCount }) : t('subagent-list-loading')}</Text>
      </Box>
      <Text dimColor>{truncateWidth(t('subagent-list-subtitle'), columns)}</Text>
      <Divider />
      <Box flexDirection="column" flexGrow={1}>
        {!loaded ? (
          <Text dimColor>{t('subagent-list-loading')}</Text>
        ) : listFailure !== undefined ? (
          <Text color="error">{listFailure}</Text>
        ) : !serviceAvailable ? (
          <Text color="warning">{t('subagent-not-mounted')}</Text>
        ) : entries.length === 0 ? (
          <Text dimColor>{t('subagent-none')}</Text>
        ) : visible.map((entry, offset) => (
          <ListRow key={`${entry.kind}:${entry.id}`} entry={entry} focused={top + offset === focus} width={columns} />
        ))}
      </Box>
      <Divider />
      <Text dimColor italic>
        <HintLine text={fitHint(t('subagent-list-hint'), t('subagent-list-hint-short'), columns)} />
      </Text>
    </Box>
  )
}

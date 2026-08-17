import React from 'react'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { SessionListRow } from '../components/sessions/SessionListRow.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { spreadRow, truncateWidth } from '../sessions/format.js'
import { anchorTop, windowEnd, type BrowserRow } from '../sessions/view.js'
import { buildSessionTree } from '../sessions/tree.js'
import { t } from '../i18n.js'
import type { Channel } from '../dsh-adapter/channel.js'
import type { SessionSummary } from '../dsh-adapter/sessions/index.js'

export function SessionTree({
  channel,
  onClose,
}: {
  channel: Channel
  onClose: () => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const isTerminalFocused = useTerminalFocus()
  const [sessions, setSessions] = React.useState<readonly SessionSummary[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const [focusId, setFocusId] = React.useState(channel.agentId)
  const [notice, setNotice] = React.useState<string | undefined>()
  const topRef = React.useRef(0)
  const actionPendingRef = React.useRef(false)

  React.useEffect(() => {
    let live = true
    void channel.listSessions()
      .then(list => {
        if (live) setSessions(list)
      })
      .catch(error => {
        if (live) setNotice(t('session-list-failed', { err: error instanceof Error ? error.message : String(error) }))
      })
      .finally(() => {
        if (live) setLoaded(true)
      })
    return () => { live = false }
  }, [channel])

  const tree = React.useMemo(
    () => buildSessionTree(sessions, channel.agentId),
    [sessions, channel.agentId],
  )
  const focus = React.useMemo(() => {
    const index = tree.findIndex(row => row.session.id === focusId)
    return index >= 0 ? index : Math.max(0, tree.findIndex(row => row.current))
  }, [tree, focusId])
  const focusRef = React.useRef(focus)
  focusRef.current = focus

  const listHeight = Math.max(0, rows - 3 - (notice === undefined ? 0 : 1))
  const browserRows: BrowserRow[] = tree.map(row => ({
    kind: 'session',
    session: row.session,
    depth: row.depth,
  }))
  const windowTop = anchorTop(browserRows, focus, listHeight, topRef.current)
  topRef.current = windowTop
  const visibleEnd = windowEnd(browserRows, windowTop, listHeight)
  const visible = tree.slice(windowTop, visibleEnd)
  const now = Date.now()

  const move = (delta: 1 | -1): void => {
    if (tree.length === 0) return
    const next = (focusRef.current + delta + tree.length) % tree.length
    focusRef.current = next
    setFocusId(tree[next]!.session.id)
  }

  useInput((input, key) => {
    if (!isTerminalFocused || actionPendingRef.current) return
    if (key.escape) {
      onClose()
    } else if (key.upArrow) {
      move(-1)
    } else if (key.downArrow) {
      move(1)
    } else if (key.home && tree.length > 0) {
      focusRef.current = 0
      setFocusId(tree[0]!.session.id)
    } else if (key.end && tree.length > 0) {
      focusRef.current = tree.length - 1
      setFocusId(tree.at(-1)!.session.id)
    } else if (isPlainReturnInput(input, key)) {
      const selected = tree[focusRef.current]
      if (selected === undefined) return
      if (selected.current) {
        setNotice(t('session-tree-already-current'))
        return
      }
      actionPendingRef.current = true
      void channel.resumeTo(selected.session.id)
        .then(ok => {
          if (ok) onClose()
          else setNotice(t('session-tree-resume-refused'))
        })
        .catch(error => {
          setNotice(t('session-tree-resume-failed', { err: error instanceof Error ? error.message : String(error) }))
        })
        .finally(() => { actionPendingRef.current = false })
    }
  })

  const heading = spreadRow(
    ` ${t('session-tree-title')}`,
    loaded ? t('session-tree-count', { n: tree.length }) : '',
    Math.max(0, columns - 1),
  )
  const hint = truncateWidth(t('session-tree-hint'), Math.max(0, columns - 2))

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexShrink={0}>
        <Text color="remember" bold>{heading.left}</Text>
        <Text dimColor>{`${' '.repeat(heading.gap)}${heading.right}`}</Text>
      </Box>
      <Box flexShrink={0}><Divider width={columns} /></Box>
      <Box flexDirection="column" height={listHeight} flexShrink={0}>
        {!loaded && <Text dimColor italic>{` ${t('session-tree-loading')}`}</Text>}
        {loaded && tree.length === 0 && <Text dimColor italic>{` ${t('session-tree-empty')}`}</Text>}
        {visible.map((row, index) => (
          <SessionListRow
            key={row.session.id}
            session={row.session}
            width={columns}
            depth={row.depth}
            focused={windowTop + index === focus}
            current={row.current}
            now={now}
          />
        ))}
      </Box>
      {notice !== undefined && (
        <Box flexShrink={0}><Text color="warning">{` ${truncateWidth(notice, Math.max(0, columns - 2))}`}</Text></Box>
      )}
      <Box flexShrink={0}><Text dimColor italic><HintLine text={hint} /></Text></Box>
    </Box>
  )
}

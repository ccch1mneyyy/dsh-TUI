import React from 'react'
import { Box, Text, useTerminalSize } from '../ui.js'
import { t } from '../i18n.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { truncateWidth } from '../sessions/format.js'
import { stringWidth } from '../ink/stringWidth.js'
import {
  type FlatNode,
  type SessionTreeMeta,
  type TreeEntry,
  type TreeFilter,
} from '../dsh-adapter/sessionTree.js'

/**
 * The tree's confirm seat: `rewind` asks before forking at an entry (pi
 * semantics — a USER message drops its whole turn, anything else keeps
 * through its step/turn end); `adopt` asks before switching to the entry's
 * branch at its tip, keeping the branch's full content (ctrl+b).
 */
export interface TreeConfirmState {
  readonly mode: 'rewind' | 'adopt'
  /** Context row shown under the action lines (for adopt: any entry of the
   *  target branch — the one ctrl+b was pressed on). */
  readonly entry: TreeEntry
  /** rewind only: the dropped turn holds every own entry of its branch, so
   *  the fork shows none of the branch's own content (the "click the branch
   *  message → lose the whole branch" trap). */
  readonly dropsBranch?: boolean
  /** adopt only: the branch tip boundary (last turn/end seq). */
  readonly tipSeq?: number
}

/** Rows of the tree visible at once at most (the window scrolls with the
 *  cursor); the actual window shrinks to fit shorter terminals — see
 *  treeWindowRows. */
export const TREE_WINDOW = 14

/**
 * Window size for the current terminal height. The panel is mounted through
 * OverlayAbove, which top-clips whatever exceeds the space above the input —
 * a fixed 14-row window loses its TOP rows on short terminals, and a focused
 * row near the window's top clips off-screen with it (blind Enter). Chrome
 * rows besides the entry window: overlay reserve 8 (same as ModelPicker) +
 * Pane borders 2 + title 1 + title margin 1 + position-line margin+itself 2
 * + hints 1 = 15; an active search query adds its own line. Chat pages
 * PgUp/PgDn by this same size so a page never jumps past a visible row.
 */
export function treeWindowRows(terminalRows: number, searching: boolean): number {
  return Math.min(TREE_WINDOW, Math.max(terminalRows - 15 - (searching ? 1 : 0), 1))
}

/**
 * The double-Esc session tree (pi's Session Tree ported to the DSH family
 * model): one flattened, pre-filtered row list from sessionTree.ts — this
 * component only renders the cursor-centered window. Tree drawing is pi's
 * render loop: 3 cells per indent level, ancestor │ gutters at their
 * recorded positions, ├─/└─ connectors one level above the row's indent.
 */
export function SessionTreePanel({
  nodes,
  cursor,
  filter,
  query,
  activePath,
  truncated,
  loading,
  rewinding = false,
  confirm,
  sessions,
  sessionCount,
  currentSessionId,
}: {
  /** Pre-filtered, render-ready rows (filterTree output). */
  nodes: readonly FlatNode[]
  /** Focused row index into `nodes` (clamped by the caller). */
  cursor: number
  /** Active kind filter (drives the status label). */
  filter: TreeFilter
  /** Search text (empty = no search). */
  query: string
  /** Node ids on the path to the live tip — rendered with `•`. */
  activePath: ReadonlySet<string>
  /** Family exceeded a cap — distant branches were dropped. */
  truncated: boolean
  /** Tree data still being gathered. */
  loading: boolean
  /** A rewind is in flight — the seat stays up until the swap settles. */
  rewinding?: boolean
  /** Entry awaiting rewind confirmation (replaces the tree view). */
  confirm: TreeConfirmState | null
  /** Per-session display facts (branch-head suffixes). */
  sessions: ReadonlyMap<string, SessionTreeMeta>
  sessionCount: number
  currentSessionId: string
}): React.ReactNode {
  const { columns, rows: terminalRows } = useTerminalSize()

  if (loading || rewinding) {
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="remember" bold>
              {t('tree-title')}
            </Text>
          </Box>
          <ListItem isFocused={false}>
            {rewinding ? t('tree-rewinding') : t('tree-loading')}
          </ListItem>
        </Box>
      </Pane>
    )
  }

  if (confirm !== null) {
    const adopt = confirm.mode === 'adopt'
    const cross = confirm.entry.sessionId !== currentSessionId
    // The action line names what the pick actually does — pi's drop-the-turn
    // semantics for a user message surprise ("回退到此处" reads as "keep up
    // to here", but the picked message itself is dropped), so each kind
    // spells out its boundary; adopt states its keep-everything promise.
    const action = adopt
      ? t('tree-adopt-body')
      : confirm.entry.kind === 'user'
        ? t('tree-confirm-drop-turn')
        : confirm.entry.kind === 'compact'
          ? t('tree-confirm-here')
          : confirm.entry.kind === 'assistant' || confirm.entry.kind === 'tool'
            ? t('tree-confirm-keep-step')
            : t('tree-confirm-keep-turn')
    // compact's line already carries the "original stays a branch" promise.
    const keepsOriginalInline = !adopt && confirm.entry.kind === 'compact'
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            <Text color="remember" bold>
              {t(adopt ? 'tree-adopt-title' : 'tree-confirm-title')}
            </Text>
            <Text dimColor>{action}</Text>
            {cross && (
              <Text dimColor>
                {t('tree-confirm-cross', { id: confirm.entry.sessionId.slice(0, 8) })}
              </Text>
            )}
            {!keepsOriginalInline && <Text dimColor>{t('tree-confirm-keep-original')}</Text>}
            {confirm.dropsBranch === true && (
              <Text color="warning">{t('tree-confirm-drops-branch')}</Text>
            )}
          </Box>
          <ListItem isFocused={false} description={t(`tree-kind-${confirm.entry.kind}`)}>
            {truncateWidth(confirm.entry.text, Math.max(16, columns - 10))}
          </ListItem>
          <Text dimColor italic>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action={adopt ? 'switch' : 'rewind'} bold />
              <KeyboardShortcutHint shortcut="Esc" action="back" />
            </Byline>
          </Text>
        </Box>
      </Pane>
    )
  }

  // pi shifts roots left when several sessions became roots (deleted
  // parent); flatten/filter stamp the flag on every row of the pass.
  const multipleRoots = nodes[0]?.multipleRoots ?? false

  const windowRows = treeWindowRows(terminalRows, query !== '')
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(windowRows / 2), nodes.length - windowRows),
  )
  const visible = nodes.slice(start, start + windowRows)

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold wrap="truncate">
            {t('tree-title')}
          </Text>
          <Text dimColor wrap="truncate">
            {t('tree-subtitle', { sessions: sessionCount, filter: t(`tree-filter-${filter}`) })}
          </Text>
        </Box>
        {visible.length === 0 ? (
          <ListItem isFocused={false}>{t('tree-empty')}</ListItem>
        ) : (
          visible.map((flatNode, offset) => {
            const index = start + offset
            const focused = index === cursor
            return (
              <ListItem
                key={flatNode.node.id}
                isFocused={focused}
                styled={false}
                showScrollUp={offset === 0 && start > 0}
                showScrollDown={
                  offset === visible.length - 1 && start + windowRows < nodes.length
                }
              >
                <TreeRow
                  flatNode={flatNode}
                  multipleRoots={multipleRoots}
                  onActivePath={activePath.has(flatNode.node.id)}
                  focused={focused}
                  width={columns}
                  sessions={sessions}
                  currentSessionId={currentSessionId}
                />
              </ListItem>
            )
          })
        )}
        <Box marginTop={1}>
          <Text dimColor>
            {nodes.length === 0 ? '' : `(${cursor + 1}/${nodes.length}) `}
            {truncated ? t('tree-truncated') : ''}
          </Text>
        </Box>
        {query !== '' && (
          <Text dimColor>
            {t('tree-search', { query })}
          </Text>
        )}
      </Box>
      <Text dimColor italic>
        <Byline>
          <KeyboardShortcutHint shortcut="↑/↓" action="move" bold />
          <KeyboardShortcutHint shortcut="PgUp/PgDn ←/→" action="page" />
          <KeyboardShortcutHint shortcut="ctrl+o" action="filter" />
          <KeyboardShortcutHint shortcut="ctrl+b" action="switch to branch" />
          <KeyboardShortcutHint shortcut="Enter" action="select" />
          <KeyboardShortcutHint shortcut="Esc" action="close" />
        </Byline>
      </Text>
    </Pane>
  )
}

/** pi's prefix: gutters at recorded positions, connector at indent-1. */
function treePrefix(flatNode: FlatNode, multipleRoots: boolean): string {
  const displayIndent = multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent
  const hasConnector = flatNode.showConnector && !flatNode.isVirtualRootChild
  const connectorPosition = hasConnector ? displayIndent - 1 : -1
  const chars: string[] = []
  for (let i = 0; i < displayIndent * 3; i++) {
    const level = Math.floor(i / 3)
    const posInLevel = i % 3
    const gutter = flatNode.gutters.find(g => g.position === level)
    if (gutter !== undefined) {
      chars.push(posInLevel === 0 ? (gutter.show ? '│' : ' ') : ' ')
    } else if (level === connectorPosition) {
      if (posInLevel === 0) chars.push(flatNode.isLast ? '└' : '├')
      else if (posInLevel === 1) chars.push('─')
      else chars.push(' ')
    } else {
      chars.push(' ')
    }
  }
  return chars.join('')
}

/** Pane padding (2) + the ListItem pointer column (2). */
const ROW_CHROME = 4
/** Smallest prefix the clamp keeps: '…' + one connector glyph + tail. */
const MIN_PREFIX_CELLS = 3
/** Reserved body width so clamping never squeezes the text to zero. */
const MIN_BODY_CELLS = 8
/** Terminal cells of each fixed kind prefix rendered by KindPrefix. */
const KIND_PREFIX_CELLS: Record<TreeEntry['kind'], number> = {
  user: stringWidth('user: '),
  assistant: stringWidth('assistant: '),
  compact: stringWidth('[compact] '),
  tool: 0,
  interrupt: 0,
  notice: 0,
}
/** Plain-text form of each kind prefix, for the minimal-mode joined string. */
const KIND_PREFIX_TEXT: Record<TreeEntry['kind'], string> = {
  user: 'user: ',
  assistant: 'assistant: ',
  compact: '[compact] ',
  tool: '',
  interrupt: '',
  notice: '',
}

/**
 * Keep the LAST `budget` cells of `s`, prefixed by '…' when anything was
 * cut. Code points accumulate from the right so a wide glyph is never split
 * (the fixed run's glyphs are all single-cell, but labels can carry CJK).
 */
function tailCells(s: string, budget: number): string {
  if (budget <= 0) return ''
  if (stringWidth(s) <= budget) return s
  const inner = budget - 1
  if (inner <= 0) return '…'
  let width = 0
  let out = ''
  for (const ch of [...s].reverse()) {
    const w = stringWidth(ch)
    if (width + w > inner) break
    out = ch + out
    width += w
  }
  return '…' + out
}

function TreeRow({
  flatNode,
  multipleRoots,
  onActivePath,
  focused,
  width,
  sessions,
  currentSessionId,
}: {
  flatNode: FlatNode
  multipleRoots: boolean
  onActivePath: boolean
  focused: boolean
  width: number
  sessions: ReadonlyMap<string, SessionTreeMeta>
  currentSessionId: string
}): React.ReactNode {
  const { node } = flatNode
  const rawPrefix = treePrefix(flatNode, multipleRoots)
  const label = node.entry?.label

  const avail = Math.max(8, width - ROW_CHROME)
  const markerCells =
    (onActivePath ? 2 : 0) + (label !== undefined ? stringWidth(`[${label}] `) : 0)
  const kindCells = KIND_PREFIX_CELLS[node.entry?.kind ?? 'notice']

  // Extreme narrow (20-24 cols): even the clamped-to-minimum fixed run plus
  // a minimal body overflows — '• ' + '[aborted] ' + 'assistant: ' + a
  // 3-cell prefix is 26 cells against avail 16, and segmented rendering
  // would wrap the row no matter how the text truncates. Fall back to ONE
  // joined fixed string cut from the left (the tail — kind prefix — is what
  // identifies the row), rendered as a single dim Text, body still elastic.
  // The suffix is dropped outright; the row can never wrap.
  if (MIN_PREFIX_CELLS + markerCells + kindCells + MIN_BODY_CELLS > avail) {
    const fixedText =
      `${rawPrefix}${onActivePath ? '• ' : ''}` +
      `${label !== undefined ? `[${label}] ` : ''}${KIND_PREFIX_TEXT[node.entry?.kind ?? 'notice']}`
    const fixed = tailCells(fixedText, Math.max(0, avail - MIN_BODY_CELLS))
    return (
      <Box flexDirection="row">
        <Text dimColor>{fixed}</Text>
        <EntryBody
          node={node}
          focused={focused}
          sessions={sessions}
          budget={Math.max(1, avail - stringWidth(fixed))}
        />
      </Box>
    )
  }

  // Branch heads of OTHER sessions carry a session suffix (title or short id).
  let suffix = ''
  if (node.branchHead && node.sessionId !== currentSessionId) {
    const meta = sessions.get(node.sessionId)
    suffix = ` · ${truncateWidth(meta?.title ?? node.sessionId.slice(0, 8), 24)}`
  }

  // Width allocation. TraceView's flex-row (fixed segments flexShrink=0, the
  // entry text elastic with wrap="truncate") keeps long TEXTS on one line,
  // but a deep enough family makes the FIXED segments alone exceed the
  // viewport — a 23-session family produced 66-cell prefixes that wrapped a
  // logical row into two physical lines. So the fixed segments are clamped
  // here, with stringWidth (never UTF-16 length) for the CJK-carrying parts:
  // the suffix shrinks first, then the tree prefix collapses its leading
  // levels into a single '…' marker, keeping the connector end visible.
  // All prefix glyphs are single-cell box-drawing chars, so slice == cells.
  //
  // The row is FLAT text segments with the body pre-truncated to the
  // remaining budget — never a flexGrow wrapper around the body: a nested
  // layout Box measures as two physical lines (the elastic text reports its
  // pre-truncation height), so every row rendered double-height and the
  // OverlayAbove top-clip ate the window's top rows — the focused row
  // included. Pre-truncated segments never exceed their budget, so the
  // measured height stays 1 and wrap="truncate" is only paint-level safety.
  const maxSuffix = avail - markerCells - kindCells - MIN_PREFIX_CELLS - MIN_BODY_CELLS
  if (suffix !== '' && stringWidth(suffix) > maxSuffix) {
    suffix = maxSuffix >= 6 ? truncateWidth(suffix, maxSuffix) : ''
  }
  const maxPrefix = Math.max(
    MIN_PREFIX_CELLS,
    avail - markerCells - kindCells - stringWidth(suffix) - MIN_BODY_CELLS,
  )
  const prefix =
    rawPrefix.length > maxPrefix
      ? '…' + rawPrefix.slice(rawPrefix.length - (maxPrefix - 1))
      : rawPrefix
  const bodyBudget = Math.max(
    1,
    avail - markerCells - kindCells - stringWidth(prefix) - stringWidth(suffix),
  )

  return (
    <Box flexDirection="row">
      <Text dimColor>{prefix}</Text>
      {onActivePath && <Text color="suggestion">{'• '}</Text>}
      {label !== undefined && <Text color="warning">{`[${label}] `}</Text>}
      <KindPrefix entry={node.entry} />
      <EntryBody node={node} focused={focused} sessions={sessions} budget={bodyBudget} />
      {suffix !== '' && <Text dimColor>{suffix}</Text>}
    </Box>
  )
}

/** Fixed kind prefix (`user: ` etc.) — kept out of the elastic body so
 *  truncation only ever eats the entry text. */
function KindPrefix({ entry }: { entry: TreeEntry | null }): React.ReactNode {
  if (entry === null) return null
  switch (entry.kind) {
    case 'user':
      return <Text color="suggestion">{'user: '}</Text>
    case 'assistant':
      return <Text color="success">{'assistant: '}</Text>
    case 'compact':
      return <Text color="remember">{'[compact] '}</Text>
    default:
      return null
  }
}

/** Elastic entry body — pre-truncated to `budget` cells by the caller so the
 *  row measures exactly one line (wrap="truncate" stays as paint safety). */
function EntryBody({
  node,
  focused,
  sessions,
  budget,
}: {
  node: FlatNode['node']
  focused: boolean
  sessions: ReadonlyMap<string, SessionTreeMeta>
  /** Cell budget for the text — the caller subtracted every fixed segment. */
  budget: number
}): React.ReactNode {
  if (node.entry === null) {
    // Placeholder: session with no own entries (empty fork / unreadable log /
    // budget-unloaded), or a synthesized fork anchor that predates every
    // displayable entry.
    const meta = sessions.get(node.sessionId)
    const text =
      node.children.length > 0 && meta?.unreadable !== true && meta?.unloaded !== true
        ? t('tree-fork-point')
        : meta?.unloaded === true
          ? t('tree-unloaded')
          : meta?.unreadable === true
            ? t('tree-unreadable')
            : t('tree-empty-fork')
    return (
      <Text dimColor italic wrap="truncate">
        {truncateWidth(text, budget)}
      </Text>
    )
  }

  const entry = node.entry
  const text = truncateWidth(entry.text, budget)
  switch (entry.kind) {
    case 'user':
    case 'assistant':
      return (
        <Text wrap="truncate" color={focused ? 'suggestion' : undefined}>
          {text}
        </Text>
      )
    case 'tool':
      return (
        <Text
          wrap="truncate"
          dimColor={entry.toolStatus !== 'error'}
          color={entry.toolStatus === 'error' ? 'error' : undefined}
        >
          {text}
        </Text>
      )
    case 'compact':
    case 'interrupt':
    case 'notice':
      return (
        <Text wrap="truncate" dimColor>
          {text}
        </Text>
      )
  }
}

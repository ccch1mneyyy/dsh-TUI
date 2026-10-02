import React from 'react'
import { Box, Text } from '../../ui.js'
import type { WheelEvent } from '../../ink/events/wheel-event.js'
import { t } from '../../i18n.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { truncateWidth, spreadRow } from '../../sessions/format.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { normalizeWorkspaceCwd } from '../../sessions/view.js'
import type { TuiWorkspaceEntry } from '../../adapter/ports/channel-workspace.js'
import { useSidePanelChannel, useSidePanelFullscreen } from './SidePanelRuntimeContext.js'
import { usePanelInput } from './usePanelInput.js'
import type { PanelProps } from './types.js'

/**
 * 工作目录（工作区）面板：侧栏里的当前 cwd 概览 + 持久工作区账本
 * （channel.listWorkspaceRegistry()——整屏工作区主页左栏用的同一份数据，
 * 见 SessionSupervisor），同时是进入整屏「工作区主页」的入口
 * （Enter → openFullscreen('workspace')；⬢ 按钮由宿主 PanelBar 画）。
 *
 * 行契约：每行恒定 2 行（标题+会话数 / 路径+缺失标记），所有文本经
 * truncateWidth / spreadRow / elideMiddle 按列宽裁剪——28 列也不折行、
 * 不裸 slice。当前工作区行用 normalizeWorkspaceCwd 归一化后比较（与
 * /resume 的工作区分组同一口径，不自己写路径比较）。
 */

/** Each ledger row is exactly two terminal lines (selection math depends on it). */
const ROW_LINES = 2

/** Middle elision for one unbreakable path line: keep both ends, drop the
 * middle. Cheaper to scan than a two-line hanging indent and keeps the
 * drive prefix and the leaf directory visible at once. CJK-aware via
 * stringWidth; never a bare slice. */
function elideMiddle(text: string, maxWidth: number): string {
  if (maxWidth <= 1) return maxWidth <= 0 ? '' : '…'
  if (stringWidth(text) <= maxWidth) return text
  const chars = [...text]
  // Keep roughly 40% head / 60% tail (the leaf matters more than the root).
  const headRoom = Math.max(1, Math.floor((maxWidth - 1) * 0.4))
  let head = ''
  let headWidth = 0
  for (const char of chars) {
    const w = stringWidth(char)
    if (headWidth + w > headRoom) break
    head += char
    headWidth += w
  }
  let tail = ''
  let tailWidth = 0
  const tailRoom = maxWidth - 1 - headWidth
  for (let at = chars.length - 1; at >= 0; at -= 1) {
    const char = chars[at]!
    const w = stringWidth(char)
    if (tailWidth + w > tailRoom) break
    tail = char + tail
    tailWidth += w
  }
  return head + '…' + tail
}

export function WorkspacePanel({ width, height, focused, visible }: PanelProps): React.ReactNode {
  const channel = useSidePanelChannel()
  const openFullscreen = useSidePanelFullscreen()

  // ── 数据：只在首次 visible 时起第一次拉取（visible=false 不发请求）；
  //    'r' 手动重拉；nonce 过期或卸载后不落 state。 ───────────────────────
  const [entries, setEntries] = React.useState<readonly TuiWorkspaceEntry[] | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [fetchTick, setFetchTick] = React.useState(0)
  const startedRef = React.useRef(false)
  const nonceRef = React.useRef(0)
  React.useEffect(() => {
    if (visible === false || startedRef.current) return
    startedRef.current = true
    setFetchTick(tick => tick + 1)
  }, [visible])
  React.useEffect(() => {
    if (fetchTick === 0) return
    const nonce = nonceRef.current + 1
    nonceRef.current = nonce
    let live = true
    setLoadError(null)
    channel.listWorkspaceRegistry()
      .then(list => {
        if (!live || nonce !== nonceRef.current) return
        setEntries(list)
      })
      .catch((error: unknown) => {
        if (!live || nonceRef.current !== nonce) return
        setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => { live = false }
  }, [channel, fetchTick])

  // ── 选中 / hover / 自管窗口滚动 ──────────────────────────────────────────
  // 不用 ScrollBox：它的内容平移/裁剪会让滚动后的指针事件错位
  // （TrajectoryPanel 的 ledger 同样自己管窗口）。行恒定 2 行，
  // 窗口按面板高度算出，滚轮/↑↓/点击都在同一个 scrollTop 上收口。
  const [selected, setSelected] = React.useState(0)
  const [hovered, setHovered] = React.useState<number | null>(null)
  const [scrollTop, setScrollTop] = React.useState(0)
  const list = entries ?? []
  const listEmpty = entries !== null && entries.length === 0
  const currentKey = normalizeWorkspaceCwd(channel.cwd)
  const focus = list.length === 0 ? 0 : Math.min(selected, list.length - 1)

  const contentWidth = Math.max(4, width - 2)
  const branch = channel.gitBranch
  // header(1) + cwd(1) + branch(0/1) + margin(1) + list title(1) + hint(1)
  const chromeRows = 5 + (branch !== undefined && branch !== '' ? 1 : 0)
  const visibleRows = Math.max(1, Math.floor(Math.max(4, height - chromeRows) / ROW_LINES))
  const maxScroll = Math.max(0, list.length - visibleRows)
  const top = Math.min(scrollTop, maxScroll)
  const clampScroll = (next: number): number => Math.max(0, Math.min(maxScroll, next))
  // 选中跟随：↑/↓ 把窗口带过去。
  const bringIntoView = (index: number): void => {
    setScrollTop(current => {
      const base = Math.min(current, maxScroll)
      if (index < base) return index
      if (index >= base + visibleRows) return index - visibleRows + 1
      return current
    })
  }
  React.useEffect(() => { bringIntoView(focus) }, [focus]) // eslint-disable-line react-hooks/exhaustive-deps -- 窗口跟随只看选中位

  // ── 键盘（v2.1 分发器）：↑/↓ 移动选中、Enter 开整屏主页、r 重拉；
  //    Esc 返回 false 让宿主把焦点还回聊天。 ─────────────────────────────────────
  usePanelInput((input, key) => {
    if (key.escape === true) return false
    if (key.upArrow === true) {
      setSelected(i => Math.max(0, (list.length === 0 ? 0 : Math.min(i, list.length - 1)) - 1))
      return true
    }
    if (key.downArrow === true) {
      setSelected(i => list.length === 0 ? 0 : Math.min(list.length - 1, Math.min(i, list.length - 1) + 1))
      return true
    }
    if (key.return_ === true) {
      openFullscreen?.('workspace')
      return true
    }
    // ctrl/meta 修饰时不认（Ctrl+R 是输入历史搜索，落到面板会变成误重拉）。
    if (input === 'r' && !key.ctrl && !key.meta) {
      setFetchTick(tick => tick + 1)
      return true
    }
    return false
  }, { active: focused && visible })

  // ── 几何：只按面板自身的 width/height，不读终端尺寸 ─────────────────────────────
  const cwd = channel.displayCwd !== '' ? channel.displayCwd : channel.cwd
  const branchLabel = t('info-row-branch')

  return (
    <Box flexDirection="column" paddingX={1} width={width} height={height} overflow="hidden">
      {/* ── 当前工作区 ── */}
      <Box flexDirection="column" flexShrink={0} marginBottom={1}>
        <Text color="accent" bold>{t('panel-workspace-current')}</Text>
        <Box paddingLeft={1}>
          <Text color="inactive" wrap="truncate">{elideMiddle(cwd, contentWidth - 1)}</Text>
        </Box>
        {branch !== undefined && branch !== '' && (
          <Box paddingLeft={1} flexDirection="row" gap={1}>
            <Text color="inactive">{branchLabel}</Text>
            <Text wrap="truncate">{truncateWidth(branch, Math.max(1, contentWidth - stringWidth(branchLabel) - 3))}</Text>
          </Box>
        )}
      </Box>

      {/* ── 已登记工作区账本 ── */}
      <Box flexShrink={0}>
        <Text dimColor>{truncateWidth(t('panel-workspace-list', { n: list.length }), contentWidth)}</Text>
      </Box>
      {loadError !== null ? (
        <Box paddingLeft={1} marginTop={1}>
          <Text color="error" wrap="truncate">{truncateWidth(t('panel-workspace-failed', { err: loadError }), contentWidth - 1)}</Text>
        </Box>
      ) : entries === null ? (
        <Box paddingLeft={1} marginTop={1}>
          <Text dimColor>{truncateWidth(t('panel-workspace-loading'), contentWidth - 1)}</Text>
        </Box>
      ) : listEmpty ? (
        <Box paddingLeft={1} marginTop={1}>
          <Text dimColor wrap="truncate">{truncateWidth(t('panel-workspace-empty'), contentWidth - 1)}</Text>
        </Box>
      ) : (
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          overflow="hidden"
          onWheel={(event: WheelEvent) => {
            setScrollTop(current =>
              clampScroll(Math.min(current, maxScroll) + (event.deltaY > 0 ? 1 : event.deltaY < 0 ? -1 : 0)))
          }}
        >
          {list.slice(top, top + visibleRows).map((entry, offset) => {
            const index = top + offset
            return (
              <WorkspaceRow
                key={entry.id}
                index={index}
                entry={entry}
                current={normalizeWorkspaceCwd(entry.path) === currentKey}
                selected={index === focus}
                hovered={hovered === index}
                width={contentWidth}
                onSelect={() => { setSelected(index); setScrollTop(clampScroll(Math.min(top, maxScroll))); setHovered(index) }}
                onHoverChange={setHovered}
              />
            )
          })}
        </Box>
      )}

      <Box flexShrink={0}>
        <Text dimColor italic wrap="truncate">{truncateWidth(t('panel-workspace-hint'), contentWidth)}</Text>
      </Box>
    </Box>
  )
}

/** One registered-workspace ledger row: title + session count on line 1,
 * directory (dim) + missing marker on line 2. Exactly two lines, always —
 * spreadRow/truncateWidth everywhere, never a bare slice, never a fold. */
function WorkspaceRow({ entry, index, current, selected, hovered, width, onSelect, onHoverChange }: {
  entry: TuiWorkspaceEntry
  index: number
  current: boolean
  selected: boolean
  hovered: boolean
  width: number
  onSelect: () => void
  onHoverChange: React.Dispatch<React.SetStateAction<number | null>>
}): React.ReactNode {
  const body = Math.max(4, width - 2)
  const countLabel = t('panel-workspace-sessions', { n: entry.sessionCount })
  const head = spreadRow(entry.title, countLabel, body)
  const missingLabel = entry.present === false ? t('panel-workspace-missing') : ''
  const tail = spreadRow(entry.path, missingLabel, body)
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      onClick={(event: ClickEvent) => {
        event.stopImmediatePropagation()
        onSelect()
      }}
      onMouseEnter={(): void => onHoverChange(index)}
      onMouseLeave={(): void => onHoverChange(prev => (prev === index ? null : prev))}
    >
      <Box height={1} flexShrink={0} overflow="hidden">
        <Box width={2} flexShrink={0}>
          <Text color={selected || hovered ? 'accent' : undefined}>{selected || hovered ? '❯' : ' '}{current ? '●' : ' '}</Text>
        </Box>
        <Text bold={selected} color={selected || hovered ? 'accent' : undefined} wrap="truncate-end">
          {head.left + ' '.repeat(head.gap) + head.right}
        </Text>
      </Box>
      <Box height={1} paddingLeft={2} flexShrink={0} overflow="hidden">
        <Text dimColor wrap="truncate-end">{tail.left + ' '.repeat(tail.gap)}</Text>
        {tail.right !== '' && <Text color="warning">{tail.right}</Text>}
      </Box>
    </Box>
  )
}

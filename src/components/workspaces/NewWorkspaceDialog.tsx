import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useInput, useTerminalSize } from '../../ui.js'
import { t } from '../../i18n.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { SearchBox } from '../SearchBox.js'
import { HintLine } from '../design-system/HintLine.js'
import { PageInsetContext } from '../PageMargin.js'
import { useTerminalFocus } from '../../ink/hooks/use-terminal-focus.js'
import { homeDir } from '../../utils/paths.js'
import { expandUserPath, isRootPath, listDirectories, parentOf, type DirectoryEntry } from '../../utils/directoryBrowse.js'
import { truncateMiddle } from '../../utils/truncateMiddle.js'
import { truncateWidth } from '../../sessions/format.js'

/** Fixed chrome rows: path header, divider, hint, and the two nav rows. */
const CHROME_ROWS = 6
/**
 * Rows the picker shows before the directory list: the always-present
 * "add this directory" action, then the two navigation targets.
 */
const NAV_ROWS = 3
/** Index of the first folder row in the focus order. */
const FIRST_FOLDER = NAV_ROWS

type PickerMode = 'browse' | 'input'

/** One fixed navigation row with its click action. */
function NavRow({
  focused,
  label,
  detail,
  onClick,
}: {
  focused: boolean
  label: string
  detail?: string
  onClick(): void
}): React.ReactNode {
  return (
    <Box
      height={1}
      flexShrink={0}
      overflow="hidden"
      paddingX={1}
      onClick={(event: ClickEvent): void => {
        event.stopImmediatePropagation()
        onClick()
      }}
      backgroundColor={focused ? 'userMessageBackgroundHover' : undefined}
    >
      <Text color={focused ? 'suggestion' : 'subtle'}>{focused ? '❯ ' : '  '}</Text>
      <Text color={focused ? 'suggestion' : undefined} bold={focused} wrap="truncate-end">
        {label}
      </Text>
      {detail !== undefined && <Text dimColor>{`  ${detail}`}</Text>}
    </Box>
  )
}

/**
 * The "add workspace" directory picker.
 *
 * A GUI-style directory browser rendered with the TUI's own primitives: fixed
 * clickable action rows (add here / parent / home) above a clickable list of
 * the current directory's subdirectories, plus a keyboard path-input mode for
 * the cases the mouse cannot express (a path the user already has on the
 * clipboard).
 *
 * Why browse at all, when `/workspace open <path>` already accepts a typed
 * absolute path: the same reason the Web UI has a directory picker. Typing a
 * deep Windows path from memory is the slowest and most error-prone way to add
 * a workspace, and this screen's whole job is to make the workspace list
 * manageable by mouse.
 *
 * The registration itself is NOT done here: `onAdd` is the channel-facing
 * action, so the picker never touches the workspace ledger, and its only
 * filesystem access is a read-only directory listing.
 */
export function NewWorkspaceDialog({
  startPath,
  onAdd,
  onClose,
  onNotice,
}: {
  /** Directory the picker opens on (usually the selected workspace's path). */
  startPath: string
  /**
   * Register a directory as a workspace.
   * @returns True when the ledger accepted it (the dialog stays open on false
   *   so the user can pick again after the channel explained why).
   */
  onAdd(path: string): Promise<boolean>
  onClose(): void
  /** Report a failure on the home screen's own notice slot. */
  onNotice(text: string, tone: 'info' | 'error'): void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const inset = React.useContext(PageInsetContext)
  const isTerminalFocused = useTerminalFocus()
  const home = homeDir()

  const [cwd, setCwd] = useState(() => expandUserPath(startPath))
  const [entries, setEntries] = useState<readonly DirectoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [focus, setFocus] = useState(0)
  const [mode, setMode] = useState<PickerMode>('browse')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  /** Synchronous mirror: several keys from one stdin chunk arrive before React renders. */
  const focusRef = useRef(0)
  focusRef.current = focus
  const modeRef = useRef(mode)
  modeRef.current = mode

  const reload = useCallback((target: string): void => {
    setLoading(true)
    const resolved = expandUserPath(target)
    try {
      setEntries(listDirectories(resolved))
      setError(undefined)
    } catch (cause) {
      setEntries([])
      const reason = cause instanceof Error ? cause.message : String(cause)
      setError(reason)
      onNotice(t('home-picker-failed', { err: reason }), 'error')
    } finally {
      setCwd(resolved)
      setLoading(false)
      focusRef.current = 0
      setFocus(0)
    }
  }, [onNotice])

  useEffect(() => {
    reload(startPath)
  }, [reload, startPath])

  // Row budget: the dialog owns a fixed slice of the terminal so its list can
  // never push the hint line off screen. Every row here is one line.
  const dialogHeight = Math.max(CHROME_ROWS + 1, Math.min(rows - 2, 18))
  const listHeight = Math.max(0, dialogHeight - CHROME_ROWS)
  // Focus order: 0 add-here, 1 parent, 2 home, 3+ the folders of this
  // directory. The scroll window therefore starts at FIRST_FOLDER.
  const capacity = Math.max(0, listHeight)
  const focusedFolder = focusRef.current - FIRST_FOLDER
  let windowTop = Math.min(
    Math.max(0, focusedFolder - Math.floor(capacity / 2)),
    Math.max(0, entries.length - capacity),
  )
  if (focusedFolder >= 0) {
    if (focusedFolder < windowTop) windowTop = focusedFolder
    if (capacity > 0 && focusedFolder >= windowTop + capacity) windowTop = focusedFolder - capacity + 1
  }
  const visible = entries.slice(windowTop, windowTop + capacity)

  const move = useCallback((by: 1 | -1): void => {
    const total = entries.length + FIRST_FOLDER
    if (total === 0) return
    const next = (focusRef.current + by + total) % total
    focusRef.current = next
    setFocus(next)
  }, [entries.length])

  const setFocusIndex = useCallback((index: number): void => {
    focusRef.current = index
    setFocus(index)
  }, [])

  const openFolder = useCallback((entry: DirectoryEntry): void => {
    reload(entry.path)
  }, [reload])

  const goUp = useCallback((): void => {
    if (isRootPath(cwd)) return
    reload(parentOf(cwd))
  }, [cwd, reload])

  const goHome = useCallback((): void => {
    reload(home)
  }, [home, reload])

  const addCurrent = useCallback((): void => {
    if (busy) return
    setBusy(true)
    void onAdd(cwd)
      .then((ok) => {
        if (ok) {
          onClose()
          return
        }
        reload(cwd)
      })
      .finally(() => setBusy(false))
  }, [busy, cwd, onAdd, onClose, reload])

  const addEntry = useCallback((entry: DirectoryEntry): void => {
    if (busy) return
    setBusy(true)
    void onAdd(entry.path)
      .then((ok) => {
        if (ok) onClose()
      })
      .finally(() => setBusy(false))
  }, [busy, onAdd, onClose])

  const enterInput = useCallback((seed: string): void => {
    modeRef.current = 'input'
    setMode('input')
    setDraft(seed)
  }, [])

  useInput((input, key) => {
    if (modeRef.current === 'input') {
      if (key.escape) {
        modeRef.current = 'browse'
        setMode('browse')
        setDraft('')
        return
      }
      if (key.return) {
        const target = draft.trim()
        if (target === '') return
        modeRef.current = 'browse'
        setMode('browse')
        setDraft('')
        reload(target)
        return
      }
      if (key.backspace || key.delete) {
        setDraft(current => current.slice(0, -1))
        return
      }
      if (!key.ctrl && !key.meta && input) {
        const typed = input.replace(/[\r\n]+/gu, '')
        if (typed !== '') setDraft(current => current + typed)
      }
      return
    }

    if (key.escape) {
      onClose()
      return
    }
    if (key.upArrow || key.wheelUp) {
      move(-1)
      return
    }
    if (key.downArrow || key.wheelDown) {
      move(1)
      return
    }
    if (key.pageUp || key.pageDown) {
      move(key.pageDown ? 1 : -1)
      return
    }
    if (key.leftArrow) {
      goUp()
      return
    }
    if (key.tab) {
      // Tab adds what is on screen; Shift+Tab opens the path editor seeded
      // with the current directory (so the user appends rather than retypes).
      if (key.shift) enterInput(cwd)
      else addCurrent()
      return
    }
    if (key.return) {
      const focused = focusRef.current
      if (focused === 0) {
        addCurrent()
        return
      }
      if (focused === 1) {
        goUp()
        return
      }
      if (focused === 2) {
        goHome()
        return
      }
      const entry = entries[focused - FIRST_FOLDER]
      if (entry === undefined) {
        addCurrent()
        return
      }
      // Ctrl+Enter takes the folder itself; plain Enter walks into it, which
      // is what a directory browser is for.
      if (key.ctrl || key.meta) addEntry(entry)
      else openFolder(entry)
      return
    }
    if (input === '+') {
      addCurrent()
      return
    }
    if (input === '/') {
      enterInput('')
    }
  })

  const width = Math.max(24, Math.min(columns + 2 * inset.x, columns))
  const contentWidth = Math.max(8, width - 4)
  const header = truncateMiddle(cwd, Math.max(8, contentWidth - 12))
  // Vertically centred inside the content box, clamped so the dialog never
  // starts above the page inset (absolute boxes are content-relative, so the
  // inset is already accounted for by the parent's padding).
  const top = Math.max(0, Math.floor((rows - dialogHeight) / 2))

  return (
    <Box
      position="absolute"
      left={0}
      top={top}
      width={width}
      height={dialogHeight}
      flexDirection="column"
      flexShrink={0}
      borderStyle="round"
      borderColor="permission"
      backgroundColor="toolCardBackground"
    >
      <Box height={1} flexShrink={0} overflow="hidden" paddingX={1}>
        <Text color="remember" bold>{`＋ ${t('home-picker-title')}  `}</Text>
        <Text dimColor>{header}</Text>
      </Box>
      <Box height={1} flexShrink={0}>
        <Text dimColor>{'─'.repeat(contentWidth + 2)}</Text>
      </Box>

      <NavRow
        focused={focus === 0}
        label={busy ? t('home-picker-adding') : t('home-picker-add')}
        onClick={addCurrent}
      />
      <NavRow
        focused={focus === 1}
        label={`↑ ${t('home-picker-up')}`}
        detail={isRootPath(cwd) ? undefined : truncateMiddle(parentOf(cwd), Math.max(4, contentWidth - 20))}
        onClick={goUp}
      />
      <NavRow
        focused={focus === 2}
        label={`~ ${t('home-picker-home')}`}
        detail={truncateMiddle(home, Math.max(4, contentWidth - 20))}
        onClick={goHome}
      />

      <ink-box style={{ flexDirection: 'column', height: listHeight, flexShrink: 0, overflow: 'hidden', paddingX: 1 }}>
        {loading && <Text dimColor italic>{t('home-picker-loading')}</Text>}
        {!loading && error !== undefined && (
          <Text color="error" wrap="truncate-end">{truncateWidth(t('home-picker-failed', { err: error }), contentWidth)}</Text>
        )}
        {!loading && error === undefined && entries.length === 0 && (
          <Text dimColor italic>{t('home-picker-empty')}</Text>
        )}
        {!loading && visible.map((entry, index) => {
          const rowFocus = focus === windowTop + index + FIRST_FOLDER
          return (
            <Box
              key={entry.path}
              height={1}
              flexShrink={0}
              overflow="hidden"
              onClick={(event: ClickEvent): void => {
                event.stopImmediatePropagation()
                setFocusIndex(windowTop + index + FIRST_FOLDER)
                openFolder(entry)
              }}
              onContextMenu={(event): void => {
                event.stopImmediatePropagation()
                setFocusIndex(windowTop + index + FIRST_FOLDER)
                addEntry(entry)
              }}
              backgroundColor={rowFocus ? 'userMessageBackgroundHover' : undefined}
            >
              <Text color={rowFocus ? 'suggestion' : 'subtle'}>{rowFocus ? '❯ ' : '  '}</Text>
              <Text color={rowFocus ? 'suggestion' : undefined} bold={rowFocus} wrap="truncate-end">
                {`▸ ${entry.name}`}
              </Text>
            </Box>
          )
        })}
      </ink-box>

      <Box height={1} flexShrink={0} overflow="hidden" paddingX={1}>
        {mode === 'input' ? (
          <SearchBox
            query={truncateWidth(draft, contentWidth)}
            isFocused
            isTerminalFocused={isTerminalFocused}
            placeholder={t('home-picker-input-hint')}
            prefix="⌕"
            borderless
            width="100%"
          />
        ) : (
          <Text dimColor italic>
            <HintLine text={t('home-picker-hint')} />
          </Text>
        )}
      </Box>
    </Box>
  )
}

/**
 * Exported for the headless regression: how many directory rows the picker can
 * show at a given terminal height.
 */
export function pickerListHeight(rows: number): number {
  const dialogHeight = Math.max(CHROME_ROWS + 1, Math.min(rows - 2, 18))
  return Math.max(0, dialogHeight - CHROME_ROWS)
}

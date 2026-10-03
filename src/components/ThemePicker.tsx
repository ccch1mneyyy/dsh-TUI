import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import type { SelectOption } from './Select.js'
import { ListItem } from './design-system/ListItem.js'
import { listWindow } from './listWindow.js'
import { HintLine } from './design-system/HintLine.js'
import { ThemePreviewPane } from './ThemePreviewPane.js'
import { useOverlayListRows } from './OverlayAbove.js'
import { type Theme } from '../theme.js'
import { listThemeCatalog, type ThemeCatalogEntry } from '../themeCatalog.js'
import type { TuiThemeHost } from '../dsh-adapter/themes.js'
import { useRuntimeThemeSnapshot } from '../hooks/useRuntimeThemeSnapshot.js'
import type { Color } from '../ink/styles.js'

/** One double-block swatch character per preview key, in a row. */
const SWATCH = '██'

/** Theme keys previewed in the picker, chosen for visual contrast. */
const SWATCH_KEYS = ['accent', 'text', 'success'] as const

/**
 * 面板自占的行数（不含列表/预览本体）：Pane 的上边距 + 分隔线 2 行、标题 1 行、
 * 标题下边距 1 行、底部提示 1 行。用来把浮层高度预算换算成"内容可用行数"。
 */
const FRAME_ROWS = 5

/**
 * 并排布局的最小终端列数：Pane 左右各 2 列内边距后，列表列 ≥34 列、预览列
 * ≥34 列、中间 2 列间隔。更窄时预览改为堆叠在列表下方（见 ThemePicker）。
 */
const MIN_SIDE_BY_SIDE_COLUMNS = 76

/** 预览列宽度区间：最窄 34 列（代码行 + 2 列缩进放得下），最宽 48 列后不再长胖。 */
const PREVIEW_MIN_COLUMNS = 34
const PREVIEW_MAX_COLUMNS = 48

/** 预览少于这个行数就整块不画：画半张工具卡比不画更难看，还白占浮层高度。 */
const PREVIEW_MIN_ROWS = 5

/**
 * 堆叠布局为列表预留最多 12 行；ListItem 的标签与描述各占一行。
 */
const LIST_RESERVE_ROWS = 12

function swatches(theme: Theme): React.ReactNode {
  return (
    <>
      {SWATCH_KEYS.map(key => (
        <Text key={key} color={theme[key] as Color}>
          {SWATCH}
        </Text>
      ))}
    </>
  )
}

/** A picker row: display name + color swatches. */
function optionFor(name: string, displayName: string, theme: Theme, description: string): SelectOption {
  return {
    value: name,
    label: (
      <>
        {displayName}
        {'  '}
        {swatches(theme)}
      </>
    ),
    description,
  }
}

/** 目录条目 → 选择行。列表渲染与焦点预览读同一份条目，顺序不可能分叉。 */
function optionsFrom(entries: readonly ThemeCatalogEntry[]): SelectOption[] {
  return entries.map(item => {
    const base = item.base ?? 'dark'
    const description = item.source === 'auto'
      ? t('theme-auto-base')
      : item.source === 'builtin'
        ? t('theme-builtin-base', { base })
        : item.source === 'runtime'
          ? t('theme-plugin-base', { base, name: item.name })
          : t('theme-user-base', { base, name: item.name })
    return optionFor(item.name, item.displayName, item.theme, description)
  })
}

/**
 * Build the full selectable list from the shared catalog: `auto`, built-ins,
 * static JSON themes, and optional plugin themes. Shared by ThemePicker (render)
 * and the /theme command (focus index), so both always see the same ordering.
 */
export function getThemeOptions(themeHost?: TuiThemeHost): SelectOption[] {
  return optionsFrom(listThemeCatalog(themeHost))
}

/**
 * 并排时的列表列/预览列宽度。预览先按内容宽度的 45% 取（钳在 34–48 列），
 * 剩下的留给列表——列表永远比预览宽，且宽终端上 `auto` 那条最长的描述行
 * 仍能整行显示（100 列时列表 51 列，描述 47 列）。再宽预览也不再长胖，
 * 免得工具卡底色带拉成一条长横幅。
 */
function columnsFor(contentColumns: number): { list: number; preview: number } {
  const preview = Math.min(
    PREVIEW_MAX_COLUMNS,
    Math.max(PREVIEW_MIN_COLUMNS, Math.floor(contentColumns * 0.45)),
  )
  return { list: Math.max(contentColumns - preview - 2, PREVIEW_MIN_COLUMNS), preview }
}

/**
 * Color-theme picker in the ActivityPicker style: a permission-colored Pane
 * listing the `auto` pseudo-theme and built-in palettes first, followed by
 * static JSON and plugin themes — each row shows the display name, base and
 * three key color swatches; `❯` marks focus, `✓` the active theme. Enter
 * applies through the ThemeProvider setter (persists to ~/.dsh-tui/theme.json
 * and hot swaps), Esc cancels.
 *
 * 宽终端（≥ MIN_SIDE_BY_SIDE_COLUMNS 列）在列表右侧并排一列预览：用**焦点行**
 * 主题的调色板实渲染代码块 + 代码操作工具卡 + diff（见 ThemePreviewPane）。
 * 列表只有三个色块，挑主题时看不到语法色、diff 色与工具卡底色——预览让
 * 「移动光标」就等于「试主题」，不必先 Enter 应用再后悔。键位语义不变
 * （↑↓ 移焦点、Enter 应用、Esc 取消），预览只是同一焦点索引的另一种投影。
 *
 * 窄终端把预览堆叠在列表下方；高度预算不够时预览整块让位——浮层向上生长，
 * 探出帧顶的行会被裁掉，宁可少画预览，也不能把列表顶出可视区（见 OverlayAbove）。
 */
export function ThemePicker({
  focusIndex,
  currentTheme,
  themeHost,
  onPick,
}: {
  focusIndex: number
  currentTheme: string | undefined
  /** Optional runtime theme host; static themes work without it. */
  themeHost?: TuiThemeHost
  /** Mouse pick (fullscreen): clicked row's absolute index (Chat applies
   *  the same code path as the keyboard Enter). */
  onPick?: (index: number) => void
}): React.ReactNode {
  const runtimeThemeSnapshot = useRuntimeThemeSnapshot(themeHost)
  // 目录只读一次：列表行与预览抬头/调色板同源，焦点索引在两边的含义必然一致。
  const entries = React.useMemo(
    () => listThemeCatalog(themeHost),
    [runtimeThemeSnapshot, themeHost],
  )
  const options = React.useMemo(() => optionsFrom(entries), [entries])
  const { columns } = useTerminalSize()
  const contentColumns = Math.max(columns - 4, 1)
  const sideBySide = columns >= MIN_SIDE_BY_SIDE_COLUMNS
  const { list: listColumns, preview: previewColumns } = columnsFor(contentColumns)

  // 浮层给内容的总行数。并排时预览只占列表旁边的列，面板高度仍是
  // max(列表, 预览)——预览比列表矮就一分高度都不加，所以直接吃满预算；
  // 堆叠时预览是**加在列表下面**的净增量，必须先扣掉列表真实占的行数和
  // 那 1 行间隔，否则多出来的预览会把列表顶出浮层（溢出从顶部裁）。
  const contentRows = useOverlayListRows(FRAME_ROWS + 1)
  const reservedListRows = Math.min(LIST_RESERVE_ROWS, options.length * 2, contentRows)
  const previewRows = sideBySide ? contentRows : contentRows - reservedListRows - 1
  const focused = entries[focusIndex] ?? entries[0]
  const preview = focused !== undefined && previewRows >= PREVIEW_MIN_ROWS
    ? (
        <ThemePreviewPane
          entry={focused}
          rows={previewRows}
          width={sideBySide ? previewColumns : contentColumns}
        />
      )
    : undefined
  const listRows = !sideBySide && preview !== undefined ? reservedListRows : contentRows
  const { start, end } = listWindow(options.map(() => 2), focusIndex, listRows)

  return (
    <Pane color="permission">
      <Box flexDirection={sideBySide ? 'row' : 'column'}>
        <Box flexDirection="column" width={sideBySide ? listColumns : undefined}>
          <Box marginBottom={1}>
            <Text color="remember" bold>
              {t('picker-title-theme')}
            </Text>
          </Box>
          {options.slice(start, end).map((option, index) => {
            const absoluteIndex = start + index
            return (
              <ListItem
                key={option.value}
                isFocused={absoluteIndex === focusIndex}
                isSelected={option.value === currentTheme}
                description={option.description}
                showScrollUp={absoluteIndex === start && start > 0}
                showScrollDown={absoluteIndex === end - 1 && end < options.length}
                onClick={onPick ? () => onPick(absoluteIndex) : undefined}
              >
                {option.label}
              </ListItem>
            )
          })}
          <Text dimColor italic>
            <HintLine text={t('hint-confirm-exit')} />
          </Text>
        </Box>
        {sideBySide && preview !== undefined && (
          <Box flexDirection="column" marginLeft={2} width={previewColumns}>
            {preview}
          </Box>
        )}
      </Box>
      {!sideBySide && preview !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          {preview}
        </Box>
      )}
    </Pane>
  )
}

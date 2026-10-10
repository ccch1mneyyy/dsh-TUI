import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize } from '../ui.js'
import type { EffortOption, LlmModelInfo } from '../adapter/ports/channel-view.js'
import type { ModelGroupRow } from '../modelGroups.js'
import { RECENTS_GROUP_PROVIDER } from '../modelGroups.js'
import type { ModelCursorZone } from '../screens/chat/useModelPicker.js'
import { useDeclaredCursor, useNativeCursor } from '../ink/hooks/use-declared-cursor.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { listWindow } from './listWindow.js'
import { useOverlayListRows } from './OverlayAbove.js'

/**
 * Optional provider tabs, a windowed model list, and the focused model's effort draft.
 *
 * The native caret is parked on the region the user last touched
 * (`cursorZone`): the provider strip, the focused model row, or the effort
 * strip. Terminals with cursor animation or trail effects then glide the
 * caret from one region to the next. Static rendering keeps the painted
 * highlights (inverse tabs, ❯ pointer) as the fallback.
 */
export function ModelPicker({
  groups, provider, models, focusIndex, currentModel, loading,
  efforts, effortId, effortsLoading, effortError, levelsFallback,
  cursorZone = 'model',
  onProvider, onFocus, onEffort, onMove, onConfirm, onCancel,
}: {
  groups: readonly ModelGroupRow[]
  provider: string
  models: readonly LlmModelInfo[]
  focusIndex: number
  currentModel: string
  loading: boolean
  efforts: readonly EffortOption[]
  effortId: string | undefined
  effortsLoading: boolean
  effortError: boolean
  levelsFallback: boolean
  /** Region that owns the native caret; falls back to the model list when absent. */
  cursorZone?: ModelCursorZone
  onProvider(provider: string): void
  onFocus(index: number): void
  onEffort(index: number): void
  onMove(delta: 1 | -1): void
  onConfirm(): void
  onCancel(): void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const width = Math.max(1, columns - 4) // Pane's horizontal padding.
  const availableRows = useOverlayListRows(0)
  const showProviders = groups.length > 0
  const shortcuts = [
    ...(showProviders ? [{ text: t('hint-model-provider'), onPick: undefined }] : []),
    { text: t('hint-model-navigation'), onPick: undefined },
    { text: t('hint-model-select'), onPick: onConfirm },
    { text: t('hint-model-cancel'), onPick: onCancel },
  ]
  const shortcutRows: (typeof shortcuts)[] = []
  let usedWidth = 0
  for (const shortcut of shortcuts) {
    const cellWidth = stringWidth(shortcut.text.replaceAll('**', ''))
    if (shortcutRows.length === 0 || usedWidth + 3 + cellWidth > width) {
      shortcutRows.push([shortcut])
      usedWidth = cellWidth
    } else {
      shortcutRows.at(-1)!.push(shortcut)
      usedWidth += 3 + cellWidth
    }
  }
  const frameRows = showProviders ? 7 : 6
  const gaps = showProviders ? 3 : 2
  const compact = availableRows < frameRows + shortcutRows.length + gaps + 3
  const showHeaderHints = availableRows >= frameRows + shortcutRows.length + 2
  const description = efforts.find(effort => effort.id === effortId)?.description
    ?? (levelsFallback ? t('effort-fallback-tier-note') : undefined)
  const showDescription = !compact && description !== undefined
  const showEfforts = availableRows >= 3
  // Pane 2 + title 1 + optional tabs 1 + effort 2 + wrapper margin 1,
  // plus the width-aware header, section gaps and optional description.
  // Short anchors show just the focused name before effort and actions.
  // At two rows, omit effort too; only decorative headers may be clipped.
  const listRows = Math.max(1, availableRows - (showHeaderHints
    ? frameRows + shortcutRows.length + (compact ? 0 : gaps) + (showDescription ? 1 : 0)
    : frameRows - (showEfforts ? 0 : 1)))
  const showModelDescriptions = listRows >= 2
  const { start, end } = listWindow(models.map(model => showModelDescriptions && model.description ? 2 : 1), focusIndex, listRows)
  const providerFocus = groups.findIndex(group => group.provider === provider)
  const effortFocus = efforts.findIndex(effort => effort.id === effortId)
  const showEffortTabs = showEfforts && !effortsLoading && !effortError && efforts.length > 0
  // The caret follows the last-touched region, but only while that region is
  // rendered with a focused cell; otherwise it rests on the model list so it
  // can never be parked nowhere (which reads as a vanished caret).
  const caretZone: ModelCursorZone = cursorZone === 'provider' && showProviders && providerFocus >= 0 ? 'provider'
    : cursorZone === 'effort' && showEffortTabs && effortFocus >= 0 ? 'effort'
      : 'model'
  const shortcutBar = (
    <Box flexDirection="column">
      {(showHeaderHints ? shortcutRows : [shortcuts.slice(-2)]).map((row, rowIndex) => (
        <Box key={rowIndex} height={1} flexShrink={0} overflow="hidden" gap={1}>
          {row.map((shortcut, index) => (
            <React.Fragment key={shortcut.text}>
              {index > 0 ? <Text dimColor>·</Text> : null}
              <Box flexShrink={0} maxWidth={width} onClick={shortcut.onPick ? event => {
                event.stopImmediatePropagation()
                shortcut.onPick!()
              } : undefined}>
                <Text dimColor wrap="truncate"><HintLine text={shortcut.text} /></Text>
              </Box>
            </React.Fragment>
          ))}
        </Box>
      ))}
    </Box>
  )
  return (
    <Box flexDirection="column">
      <Pane color="permission">
        <Text color="remember" bold wrap="truncate">{t('picker-title-model')}</Text>
        {showHeaderHints ? shortcutBar : null}
        {showProviders ? <Box marginTop={compact ? 0 : 1} marginBottom={compact ? 0 : 1}>
          <PickerTabs
            labels={groups.map(group => group.provider === RECENTS_GROUP_PROVIDER ? t('picker-group-recent') : group.label)}
            focusIndex={providerFocus}
            width={width}
            cursor={caretZone === 'provider'}
            onPick={index => onProvider(groups[index]!.provider)}
          />
        </Box> : null}
        <Box flexDirection="column" marginTop={!showProviders && !compact ? 1 : 0} onWheel={event => {
          event.stopImmediatePropagation()
          if (event.deltaY !== 0) onMove(event.deltaY < 0 ? -1 : 1)
        }}>
          {models.length === 0 ? (
            <Text dimColor wrap="truncate">{t(loading ? 'model-loading' : provider === RECENTS_GROUP_PROVIDER ? 'picker-recents-empty' : 'picker-models-empty')}</Text>
          ) : models.slice(start, end).map((model, index) => {
            const absoluteIndex = start + index
            return (
              <ListItem
                key={`${model.provider}/${model.id}`}
                isFocused={absoluteIndex === focusIndex}
                isSelected={`${model.provider}/${model.id}` === currentModel}
                description={showModelDescriptions ? model.description : undefined}
                showScrollUp={absoluteIndex === start && start > 0}
                showScrollDown={absoluteIndex === end - 1 && end < models.length}
                declareCursor={caretZone === 'model'}
                nativeCursor
                onClick={event => { event.stopImmediatePropagation(); onFocus(absoluteIndex) }}
              >
                {provider === RECENTS_GROUP_PROVIDER ? `${model.provider} / ${model.name}` : model.name}
              </ListItem>
            )
          })}
        </Box>
        {showEfforts ? <Box marginTop={compact ? 0 : 1} flexDirection={showHeaderHints ? 'column' : 'row'}>
          <Box height={1} flexShrink={0} overflow="hidden">
            <Text color="remember" bold>{t('picker-title-effort')}{showHeaderHints ? '' : '  '}</Text>
            {showHeaderHints && !effortsLoading && !effortError && efforts.length > 1 ? (
              <Text dimColor>{'  '}<HintLine text={t('hint-model-effort')} /></Text>
            ) : null}
          </Box>
          <Box height={1} flexShrink={0} overflow="hidden">
            {effortsLoading || effortError || efforts.length === 0 ? (
              <Text dimColor wrap="truncate">
                {models.length === 0 ? '—' : t(effortsLoading ? 'picker-effort-loading' : effortError ? 'picker-effort-error' : 'picker-effort-unavailable')}
              </Text>
            ) : (
              <>
                {effortId === undefined ? <Text color="text">{t('picker-effort-default')}{'  '}</Text> : null}
                <PickerTabs
                  labels={efforts.map(effort => effort.name)}
                  focusIndex={effortFocus}
                  width={Math.max(1, width - (showHeaderHints ? 0 : stringWidth(t('picker-title-effort')) + 2)
                    - (effortId === undefined ? stringWidth(t('picker-effort-default')) + 2 : 0))}
                  muted={false}
                  cursor={caretZone === 'effort'}
                  onPick={onEffort}
                />
              </>
            )}
          </Box>
        </Box> : null}
        {showDescription ? <Text dimColor wrap="truncate">{description!.replace(/[\r\n]+/g, ' ')}</Text> : null}
        {!showHeaderHints ? shortcutBar : null}
      </Pane>
    </Box>
  )
}

/** Keep the active cell visible when a provider or effort strip exceeds its width. */
function PickerTabs({ labels, focusIndex, width, muted = true, cursor = false, onPick }: {
  labels: readonly string[]
  focusIndex: number
  width: number
  muted?: boolean
  /** This strip owns the native caret — its region was the last one used. */
  cursor?: boolean
  onPick(index: number): void
}): React.ReactNode {
  const singleLines = labels.map(label => label.replace(/[\r\n]+/g, ' '))
  const allFit = singleLines.reduce((sum, label) => sum + stringWidth(label) + 2, 0)
    + Math.max(0, labels.length - 1) <= width
  const cells = allFit ? singleLines : singleLines.map(singleLine => {
    const limit = Math.max(1, width - 6)
    return stringWidth(singleLine) > limit ? `${truncateToWidth(singleLine, limit - 1)}…` : singleLine
  })
  const { start, end } = allFit ? { start: 0, end: cells.length }
    : listWindow(cells.map(label => stringWidth(label) + 2), Math.max(0, focusIndex), Math.max(1, width - 4), 1)
  return (
    <Box height={1} flexShrink={0} overflow="hidden" gap={1}>
      {start > 0 ? <Box onClick={event => { event.stopImmediatePropagation(); onPick(start - 1) }}><Text dimColor>‹</Text></Box> : null}
      {cells.slice(start, end).map((label, index) => (
        <PickerTab
          key={start + index}
          label={label}
          isFocused={start + index === focusIndex}
          muted={muted}
          cursor={cursor}
          onPick={() => onPick(start + index)}
        />
      ))}
      {end < cells.length ? <Box onClick={event => { event.stopImmediatePropagation(); onPick(end) }}><Text dimColor>›</Text></Box> : null}
    </Box>
  )
}

/**
 * One tab cell. The focused tab declares the native caret when its strip owns
 * it (terminals animate the caret between providers/levels); a strip is
 * structural focus, so the parked caret is steady rather than blinking. The
 * inverse block stays painted either way so static rendering keeps a focus
 * mark.
 */
function PickerTab({ label, isFocused, muted, cursor, onPick }: {
  label: string
  isFocused: boolean
  muted: boolean
  cursor: boolean
  onPick(): void
}): React.ReactNode {
  const nativeCursor = useNativeCursor()
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: 0,
    active: isFocused && cursor,
    visible: nativeCursor,
    steady: true,
  })
  return (
    <Box ref={cursorRef} flexShrink={0} onClick={event => { event.stopImmediatePropagation(); onPick() }}>
      <Text color={isFocused ? 'remember' : muted ? undefined : 'text'} inverse={isFocused} bold={isFocused} dimColor={muted && !isFocused}>
        {` ${label} `}
      </Text>
    </Box>
  )
}

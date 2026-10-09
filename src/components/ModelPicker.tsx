import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize } from '../ui.js'
import type { EffortOption, LlmModelInfo } from '../adapter/ports/channel-view.js'
import type { ModelGroupRow } from '../modelGroups.js'
import { RECENTS_GROUP_PROVIDER } from '../modelGroups.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { listWindow } from './listWindow.js'
import { useOverlayListRows } from './OverlayAbove.js'

/** Provider tabs, a windowed model list, and the focused model's effort draft. */
export function ModelPicker({
  groups, provider, models, focusIndex, currentModel, loading,
  efforts, effortId, effortsLoading, effortError, levelsFallback,
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
  const compact = availableRows < 14
  const showNavigationHints = availableRows >= 11
  const description = efforts.find(effort => effort.id === effortId)?.description
    ?? (levelsFallback ? t('effort-fallback-tier-note') : undefined)
  const showDescription = !compact && description !== undefined
  // Pane 2 + title 1 + tabs 1 + effort 1 + hints 3 + wrapper margin 1;
  // the roomy layout adds two gaps and an optional effort description.
  // Tight anchors omit the two navigation hints so models, effort and the
  // confirmation row survive the overlay's top clipping.
  const listRows = useOverlayListRows(9 - (showNavigationHints ? 0 : 2)
    + (compact ? 0 : 2) + (showDescription ? 1 : 0))
  const { start, end } = listWindow(models.map(model => model.description ? 2 : 1), focusIndex, listRows)
  return (
    <Pane color="permission">
      <Text color="remember" bold wrap="truncate">{t('picker-title-model')}</Text>
      <Box marginBottom={compact ? 0 : 1}>
        <PickerTabs
          labels={groups.map(group => group.provider === RECENTS_GROUP_PROVIDER ? t('picker-group-recent') : group.label)}
          focusIndex={groups.findIndex(group => group.provider === provider)}
          width={width}
          onPick={index => onProvider(groups[index]!.provider)}
        />
      </Box>
      <Box flexDirection="column" onWheel={event => {
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
              description={model.description}
              showScrollUp={absoluteIndex === start && start > 0}
              showScrollDown={absoluteIndex === end - 1 && end < models.length}
              onClick={event => { event.stopImmediatePropagation(); onFocus(absoluteIndex) }}
            >
              {provider === RECENTS_GROUP_PROVIDER ? `${model.provider} / ${model.name}` : model.name}
            </ListItem>
          )
        })}
      </Box>
      <Box marginTop={compact ? 0 : 1} height={1} flexShrink={0} overflow="hidden">
        <Text dimColor>{t('picker-title-effort')}{'  '}</Text>
        {effortsLoading || effortError || efforts.length === 0 ? (
          <Text dimColor wrap="truncate">
            {models.length === 0 ? '—' : t(effortsLoading ? 'picker-effort-loading' : effortError ? 'picker-effort-error' : 'picker-effort-unavailable')}
          </Text>
        ) : (
          <>
            {effortId === undefined ? <Text dimColor>{t('picker-effort-default')}{'  '}</Text> : null}
            <PickerTabs
              labels={efforts.map(effort => effort.name)}
              focusIndex={efforts.findIndex(effort => effort.id === effortId)}
              width={Math.max(1, width - stringWidth(t('picker-title-effort')) - 2
                - (effortId === undefined ? stringWidth(t('picker-effort-default')) + 2 : 0))}
              onPick={onEffort}
            />
          </>
        )}
      </Box>
      {showDescription ? <Text dimColor wrap="truncate">{description!.replace(/[\r\n]+/g, ' ')}</Text> : null}
      {showNavigationHints ? <>
        <Text dimColor wrap="truncate"><HintLine text={t('hint-model-provider')} /></Text>
        <Text dimColor wrap="truncate"><HintLine text={t('hint-model-arrows')} /></Text>
      </> : null}
      <Box height={1} flexShrink={0} gap={1}>
        <Box onClick={event => { event.stopImmediatePropagation(); onConfirm() }}>
          <Text dimColor><HintLine text={t('hint-model-select')} /></Text>
        </Box>
        <Text dimColor>·</Text>
        <Box onClick={event => { event.stopImmediatePropagation(); onCancel() }}>
          <Text dimColor><HintLine text={t('hint-model-cancel')} /></Text>
        </Box>
      </Box>
    </Pane>
  )
}

/** Keep the active cell visible when a provider or effort strip exceeds its width. */
function PickerTabs({ labels, focusIndex, width, onPick }: {
  labels: readonly string[]
  focusIndex: number
  width: number
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
        <Box key={start + index} flexShrink={0} onClick={event => { event.stopImmediatePropagation(); onPick(start + index) }}>
          <Text color={start + index === focusIndex ? 'remember' : undefined} inverse={start + index === focusIndex} bold={start + index === focusIndex} dimColor={start + index !== focusIndex}>
            {` ${label} `}
          </Text>
        </Box>
      ))}
      {end < cells.length ? <Box onClick={event => { event.stopImmediatePropagation(); onPick(end) }}><Text dimColor>›</Text></Box> : null}
    </Box>
  )
}

import React from 'react'
import { Box, Text, useTerminalSize } from '../ui.js'
import { t } from '../i18n.js'
import type { Channel } from '../dsh-adapter/channel.js'
import { modeDisplayName } from '../sessionModes.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import { GROUP_RULE } from '../cc/figures.js'

type HudItem = {
  key: string
  /** Bright value; omitted for self-labelled chips like `vision`. */
  value?: string
  label?: string
  /** Whole chip text (`vision`); takes the value slot and skips a micro-label. */
  chip?: string
  /** Theme key for the value; labels always render in `subtle`. */
  valueColor?: 'text' | 'claude'
}

/** Brand tick: one cell, the HUD's identity mark (not the splash wordmark). */
const TICK = '▍ '

/**
 * Pinned one-line identity HUD above the scrolling transcript. Mounted by
 * Chat when `channel.cockpit` is on and minimal mode is off. Missing fields
 * are omitted; a missing llm modality table omits `io` rather than throwing.
 *
 * Values lead in `text`/`claude`, micro-labels trail in `subtle`, groups join
 * on a box-drawing rule. The io modality is a filled `claude` chip. A hairline
 * in `promptBorder` separates the strip from the splash. The model is the
 * only field that truncates. Built-in `full` is hidden — that label is the
 * daily-driver sandbox/approval policy, not a cycle overlay.
 */
export function CockpitHud({ channel }: { channel: Channel }): React.ReactNode {
  const { columns } = useTerminalSize()
  const items: HudItem[] = []
  if (channel.provider !== '') {
    items.push({
      key: 'prov',
      value: channel.provider,
      label: t('cockpit-label-prov'),
      valueColor: 'claude',
    })
  }
  if (channel.model !== '') {
    items.push({ key: 'model', value: channel.model, label: t('cockpit-label-model') })
  }
  if (channel.reasoningEffort !== undefined && channel.reasoningEffort !== '') {
    items.push({ key: 'eff', value: channel.reasoningEffort, label: t('cockpit-label-eff') })
  }
  if (channel.modeIndex > 0 && channel.mode.id !== 'full') {
    items.push({ key: 'mode', value: modeDisplayName(channel.mode), label: t('cockpit-label-mode') })
  }
  const io = ioChip(channel.inputModalities)
  if (io !== undefined) {
    items.push({ key: 'io', chip: `[${io}]` })
  }

  const shown = layoutHud(items, Math.max(0, columns - 2 - stringWidth(TICK)))

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box flexDirection="row" width="100%" height={1} paddingX={1} flexShrink={0} overflow="hidden">
        <Text color="claude">{TICK}</Text>
        {shown.map((item, index) => (
          <React.Fragment key={item.key}>
            {index > 0 ? <Text color="promptBorder">{SEP}</Text> : null}
            {item.chip !== undefined ? (
              <Text backgroundColor="claude" color="inverseText">{chipText(item.chip)}</Text>
            ) : (
              <>
                <Text color={item.valueColor ?? 'text'} bold={item.key === 'model'}>
                  {item.value}
                </Text>
                {item.label !== undefined ? <Text color="subtle" dimColor> {item.label}</Text> : null}
              </>
            )}
          </React.Fragment>
        ))}
      </Box>
      <Box width="100%" height={1} overflow="hidden" flexShrink={0}>
        <Text color="promptBorder" dimColor wrap="truncate">{'─'.repeat(Math.max(columns, 240))}</Text>
      </Box>
    </Box>
  )
}

/** `vision` when image is accepted, `text` when the table is known without image, omit when unknown. */
function ioChip(modalities: readonly string[] | undefined): string | undefined {
  if (modalities === undefined) return undefined
  return modalities.includes('image') ? t('cockpit-io-vision') : t('cockpit-io-text')
}

const SEP = `  ${GROUP_RULE}  `

function chipText(chip: string): string {
  return ` ${chip} `
}

/** Truncate only the model value so provider, effort, and the io chip stay intact. */
function layoutHud(items: readonly HudItem[], budget: number): HudItem[] {
  const widths = items.map(itemWidth)
  const seps = Math.max(0, items.length - 1) * stringWidth(SEP)
  const total = widths.reduce((sum, width) => sum + width, 0) + seps
  if (total <= budget) return [...items]

  const modelIndex = items.findIndex(item => item.key === 'model')
  if (modelIndex < 0) return [...items]

  const others = total - widths[modelIndex]!
  const modelLabel = items[modelIndex]!.label
  const labelWidth = modelLabel === undefined ? 0 : stringWidth(` ${modelLabel}`)
  const valueBudget = Math.max(1, budget - others - labelWidth)
  const raw = items[modelIndex]!.value ?? ''
  const truncated = stringWidth(raw) <= valueBudget
    ? raw
    : `${truncateToWidth(raw, Math.max(1, valueBudget - 1))}…`
  return items.map((item, index) =>
    index === modelIndex ? { ...item, value: truncated } : item,
  )
}

function itemWidth(item: HudItem): number {
  if (item.chip !== undefined) return stringWidth(chipText(item.chip))
  return stringWidth(item.value ?? '') + (item.label === undefined ? 0 : stringWidth(` ${item.label}`))
}

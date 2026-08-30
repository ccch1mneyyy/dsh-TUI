import React from 'react'
import { Box, Text, useTerminalSize } from '../ui.js'
import { t } from '../i18n.js'
import type { Channel } from '../dsh-adapter/channel.js'
import { modeDisplayName } from '../sessionModes.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import { GROUP_RULE } from '../cc/figures.js'
import { formatProject } from '../sessions/format.js'
import { homeDir } from '../utils/paths.js'

type HudItem = {
  key: string
  /** Bright value; omitted for self-labelled chips like `[vision]`. */
  value?: string
  label?: string
  /** Whole chip text (`[vision]`); takes the value slot and skips a micro-label. */
  chip?: string
  /** Theme key for the value; labels always render in `subtle`. */
  valueColor?: 'text' | 'claude' | 'ide' | 'inactive' | 'promptBorder'
}

/** Brand tick: one cell, the HUD's identity mark (not the splash wordmark). */
const TICK = '▍ '
const SEP = `  ${GROUP_RULE}  `

/**
 * Pinned modern identity & environment HUD above the scrolling transcript.
 * Mounted by Chat when `channel.cockpit` is on and minimal mode is off.
 *
 * Left group: Provider, Model, Reasoning Effort, Mode, and IO capability.
 * Right group: Git branch, workspace project, and session ID.
 * The model is the primary field that truncates under narrow widths.
 */
export function CockpitHud({ channel }: { channel: Channel }): React.ReactNode {
  const { columns } = useTerminalSize()

  // Left identity items
  const leftItems: HudItem[] = []
  if (channel.provider !== '') {
    leftItems.push({
      key: 'prov',
      value: channel.provider,
      label: t('cockpit-label-prov'),
      valueColor: 'claude',
    })
  }
  if (channel.model !== '') {
    leftItems.push({ key: 'model', value: channel.model, label: t('cockpit-label-model') })
  }
  if (
    channel.reasoningEffort !== undefined &&
    channel.reasoningEffort !== ''
  ) {
    leftItems.push({ key: 'eff', value: channel.reasoningEffort, label: t('cockpit-label-eff') })
  }
  if (channel.modeIndex > 0 && channel.mode.id !== 'full') {
    leftItems.push({ key: 'mode', value: modeDisplayName(channel.mode), label: t('cockpit-label-mode') })
  }
  const io = ioChip(channel.inputModalities)
  if (io !== undefined) {
    leftItems.push({ key: 'io', chip: io })
  }

  // Right environment items — progressive disclosure based on column budget
  const rightItems: HudItem[] = []
  if (columns >= 120 && channel.gitBranch && channel.gitBranch !== '') {
    rightItems.push({
      key: 'git',
      value: `⎇ ${channel.gitBranch}`,
      valueColor: 'ide',
    })
  }
  if (columns >= 145) {
    const project = formatProject(channel.displayCwd || channel.cwd, homeDir())
    if (project && project !== '') {
      rightItems.push({
        key: 'cwd',
        value: project,
        valueColor: 'inactive',
      })
    }
  }
  if (columns >= 160 && channel.agentId && channel.agentId !== '') {
    rightItems.push({
      key: 'session',
      value: `#${channel.agentId.slice(0, 8)}`,
      valueColor: 'inactive',
    })
  }

  // Calculate layout budget
  const rightWidth = calculateGroupWidth(rightItems)
  const availableLeftBudget = Math.max(
    0,
    columns - 2 - stringWidth(TICK) - (rightWidth > 0 ? rightWidth + stringWidth(SEP) : 0),
  )

  const shownLeft = layoutHud(leftItems, availableLeftBudget)
  const showRight = rightItems.length > 0

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box
        flexDirection="row"
        justifyContent="flex-end"
        width="100%"
        height={1}
        paddingX={1}
        flexShrink={0}
        overflow="hidden"
      >
        {/* Identity group (aligned right) */}
        <Box flexDirection="row" flexShrink={1} overflow="hidden">
          <Text color="claude">{TICK}</Text>
          {shownLeft.map((item, index) => (
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

        {/* Environment group */}
        {showRight && (
          <Box flexDirection="row" flexShrink={0} overflow="hidden" marginLeft={2}>
            {rightItems.map((item, index) => (
              <React.Fragment key={item.key}>
                {index > 0 ? <Text color="promptBorder">{SEP}</Text> : null}
                <Text color={item.valueColor ?? 'inactive'} dimColor={item.key !== 'git'}>
                  {item.value}
                </Text>
              </React.Fragment>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )
}

/** `vision` when image is accepted, `text` when the table is known without image, omit when unknown. */
function ioChip(modalities: readonly string[] | undefined): string | undefined {
  if (modalities === undefined) return undefined
  return modalities.includes('image') ? t('cockpit-io-vision') : t('cockpit-io-text')
}

function chipText(chip: string): string {
  return ` ${chip} `
}

function calculateGroupWidth(items: readonly HudItem[]): number {
  if (items.length === 0) return 0
  const widths = items.map(itemWidth)
  const seps = (items.length - 1) * stringWidth(SEP)
  return widths.reduce((sum, width) => sum + width, 0) + seps
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

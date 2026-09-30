import React from 'react'
import { Box, Text, useAnimationFrame } from '../../ui.js'
import type { JobGroupRow } from '../../adapter/ports/channel-view.js'
import { formatJobDuration } from '../../dsh-adapter/jobs.js'
import { t } from '../../i18n.js'
import { isMinimalUiMode } from '../../minimalUiMode.js'

/** One summary chip: the count text plus the color that carries its meaning. */
type Chip = { key: string; text: string; color: 'warning' | 'error' | 'success' | undefined }

/**
 * Header line of a consecutive-job group (`row.jobGroup`): the run summary
 * while the group is open, and the fold line once it is closed.
 *
 *   ▾ 后台任务 ×6 · 2 运行中 · 4 已完成 · 合计 12.3s
 *   ▸ 已折叠 6 个后台任务 · 4 已完成 · 2 失败 · 合计 12.3s · 点击展开
 *
 * The fold line keeps the header's row and glyph slot, so a settling group
 * reads as the SAME block tucking its body away (the thinking/compact fold
 * convention) instead of a new row appearing. The whole line is clickable
 * and brightens on hover — the same mouse gesture the job cards use — and
 * Ctrl+O expands every group at once.
 *
 * Failures stay LOUD while folded: the failed/killed counts are painted in
 * the error color, because folding must never bury a job that died.
 */
export function JobGroupHeader({ group, onToggle }: {
  group: JobGroupRow
  onToggle?(): void
}): React.ReactNode {
  const minimalUi = isMinimalUiMode()
  const [hovered, setHovered] = React.useState(false)
  // Only a LIVE group ticks: its elapsed keeps counting. A settled group's
  // duration is frozen, so it must not keep re-rendering the row.
  const [tickRef] = useAnimationFrame(group.running > 0 ? 1000 : null)
  const clickable = onToggle !== undefined
  const duration = formatJobDuration({
    startedAt: group.startedAt,
    ...(group.endedAt === undefined ? {} : { finishedAt: group.endedAt }),
  })
  const chipColor = (color: Chip['color']): Chip['color'] => minimalUi ? undefined : color

  const chips: Chip[] = []
  if (group.running > 0) chips.push({ key: 'running', text: t('jobs-group-running', { count: group.running }), color: chipColor('warning') })
  if (group.failed > 0) chips.push({ key: 'failed', text: t('jobs-group-failed', { count: group.failed }), color: chipColor('error') })
  if (group.killed > 0) chips.push({ key: 'killed', text: t('jobs-group-killed', { count: group.killed }), color: chipColor('error') })
  if (group.folded && group.running === 0 && group.failed === 0 && group.killed === 0) {
    // Folded and clean: "全部完成" says more than "6 已完成" — the group is
    // the unit being reported on now.
    chips.push({ key: 'all', text: t('jobs-group-all-completed'), color: chipColor('success') })
  } else if (group.completed > 0) {
    chips.push({ key: 'completed', text: t('jobs-group-completed', { count: group.completed }), color: undefined })
  }

  // The mouse affordance: a folded line always teaches the way back in; an
  // open group only says it while hovered (its ▾ already carries the hint).
  const hint = group.folded
    ? t('jobs-group-hint-expand')
    : hovered && clickable ? t('jobs-group-hint-fold') : undefined

  return (
    <Box
      flexDirection="row"
      gap={1}
      ref={tickRef}
      onClick={clickable ? onToggle : undefined}
      onMouseEnter={clickable ? (): void => setHovered(true) : undefined}
      onMouseLeave={clickable ? (): void => setHovered(false) : undefined}
    >
      <Text color={hovered && clickable && !minimalUi ? 'accent' : 'inactive'}>
        {group.folded ? '▸' : '▾'}
      </Text>
      <Text
        wrap="truncate-end"
        color={hovered && clickable ? 'text' : undefined}
        dimColor={!(hovered && clickable)}
      >
        {group.folded
          ? t('jobs-group-folded', { count: group.count })
          : t('jobs-group-title', { count: group.count })}
      </Text>
      {chips.map(chip => (
        <React.Fragment key={chip.key}>
          <Text color="inactive">·</Text>
          <Text color={chip.color} dimColor={chip.color === undefined}>{chip.text}</Text>
        </React.Fragment>
      ))}
      <Text color="inactive">·</Text>
      <Text dimColor>{t('jobs-group-elapsed', { duration })}</Text>
      {hint !== undefined && (
        <React.Fragment>
          <Text color="inactive">·</Text>
          <Text color={group.folded ? 'inactive' : 'accent'}>{hint}</Text>
        </React.Fragment>
      )}
    </Box>
  )
}

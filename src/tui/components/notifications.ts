/**
 * The notification toast stack: one row per channel notification, mounted in
 * the chat root between the editor slot and the status line (the position the
 * old React PromptInput rendered them).
 *
 * `Channel.notifications` was projected into `PromptProjection` from the
 * start but no component ever read it — every `commands.info.notify()` hint
 * (the Ctrl+C exit arm, model-switching, reload notices, …) was invisible
 * until this view became the sink. The chat screen pushes the live array in
 * through `update()`; colors follow `NotificationItem.color` onto the theme's
 * semantic palette (no color = dim).
 */
import chalk from 'chalk'
import { truncateToWidth, type Component } from '../public.js'
import type { NotificationItem } from '../../dsh-adapter/channel.js'
import { getActiveTheme, type Theme } from '../../theme.js'

/** Apply one Theme color value (`rgb(r,g,b)` / `#hex` / `ansi:<name>`). */
function paint(color: string, text: string): string {
  if (color.startsWith('#')) return chalk.hex(color)(text)
  const rgb = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/.exec(color)
  if (rgb !== null) return chalk.rgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]))(text)
  if (color.startsWith('ansi:')) {
    const named = (chalk as unknown as Record<string, unknown>)[color.slice('ansi:'.length)]
    if (typeof named === 'function') return (named as (value: string) => string)(text)
  }
  return text
}

function colorFor(color: NotificationItem['color'], theme: Theme): (text: string) => string {
  switch (color) {
    case 'error':
      return (text) => paint(theme.error, text)
    case 'warning':
      return (text) => paint(theme.warning, text)
    case 'success':
      return (text) => paint(theme.success, text)
    default:
      return (text) => chalk.dim(text)
  }
}

export class NotificationsView implements Component {
  private notifications: readonly NotificationItem[] = []

  update(notifications: readonly NotificationItem[]): void {
    this.notifications = notifications
  }

  invalidate(): void {
    // No cached state.
  }

  render(width: number): string[] {
    if (width <= 0 || this.notifications.length === 0) return []
    const theme = getActiveTheme()
    return this.notifications.map((notification) =>
      truncateToWidth(colorFor(notification.color, theme)(notification.text), width, ''))
  }
}

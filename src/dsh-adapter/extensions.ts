/**
 * The dsh-tui-extensions row: mounts every plugin-facing UI seam service in
 * one cordis plugin (one profile row, one patch-surface entry — see issue
 * #183 for the cost of row/code skew, and #242 for the entry-level-only
 * inject rule this row follows).
 *
 * Services mounted here (each documented in its own module):
 *
 * - `ctx.tuiDialogs`   — managed select/confirm/input dialogs
 * - `ctx.tuiStatus`    — keyed status-line contributions
 * - `ctx.tuiShortcuts` — keyboard shortcut registry
 * - `ctx.tuiRenderers` — custom session-entry text renderers
 *
 * The decision-point events (`tui/input`, `tui/rewind-prompt`, …) need no
 * service — they are fired by the channel and answered with `ctx.on`; their
 * types ride along in this module's public surface (`./extensions` export).
 *
 * Every consumer (`channel.ts`, `Chat.tsx`) reads these with `ctx.get`
 * softly: without this row the TUI degrades to no dialogs/status/shortcuts/
 * renderers, and plugin.ts logs the skew warning once for profile launches.
 */

import { Context } from '@deepseek-ai/cordis'
import TuiDialogRuntime from './dialogs.js'
import TuiStatusRuntime from './status.js'
import TuiShortcutRuntime from './shortcuts.js'
import TuiRendererRuntime from './renderers.js'

export const name = 'dsh-tui-extensions'

export function apply(ctx: Context): void {
  ctx.plugin(TuiDialogRuntime)
  ctx.plugin(TuiStatusRuntime)
  ctx.plugin(TuiShortcutRuntime)
  ctx.plugin(TuiRendererRuntime)
}

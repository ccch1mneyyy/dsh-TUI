/**
 * The dsh-tui-extensions row: mounts every plugin-facing UI seam service in
 * one cordis plugin (one profile row, one patch-surface entry — see issue
 * #183 for the cost of row/code skew, and #242 for the entry-level-only
 * inject rule this row follows).
 *
 * Services mounted here (each documented in its own module):
 *
 * - `ctx.tuiDialogs`   — managed select/confirm/input dialogs
 * - `ctx.tuiStatus`    — keyed text and bounded rich status contributions;
 *   `registerView()` returns `undefined` on refusal, otherwise its disposer
 * - `ctx.tuiShortcuts` — keyboard shortcut registry
 * - `ctx.tuiRenderers` — custom session-entry text renderers
 * - `ctx.tuiToast`     — transient fire-and-forget notifications
 * - `ctx.tuiThemes`    — runtime theme declarations (host-readable)
 *
 * The decision-point events (`tui/input`, `tui/rewind-prompt`, …) need no
 * separate service — they are fired by the channel and answered through the
 * host-mediated DecisionEvents registry; their types ride along in this
 * module's public surface (`./extensions` export). The Cordis `ctx.on` hook is
 * only a compatibility facade and cannot bypass admission, scope or grant
 * checks. Intercept-class events require an explicit grant in
 * `~/.dsh-tui/extension-grants.json`, default deny. The channel installs the
 * SAME hook (idempotent per cordis root, so exactly one installation lands):
 * this row covers profiles launching without the channel, and the channel
 * covers the skew path where THIS row is missing.
 *
 * Every consumer (`channel.ts`, `Chat.tsx`) reads these with `ctx.get`
 * softly: without this row the TUI degrades to no dialogs/status/shortcuts/
 * renderers/themes, and plugin.ts logs the skew warning once for profile
 * launches.
 */

import { Context } from '@deepseek-ai/cordis'
import TuiDialogRuntime from './dialogs.js'
import TuiStatusRuntime from './status.js'
import TuiShortcutRuntime from './shortcuts.js'
import TuiRendererRuntime from './renderers.js'
import TuiToastRuntime from './toast.js'
import TuiThemeRuntime from './themes.js'
import { installDecisionGuard } from './decision-guard.js'
import { readGrantStore } from './grants.js'

export const name = 'dsh-tui-extensions'

export function apply(ctx: Context): void {
  installDecisionGuard(ctx, readGrantStore())
  ctx.plugin(TuiDialogRuntime)
  ctx.plugin(TuiStatusRuntime)
  ctx.plugin(TuiShortcutRuntime)
  ctx.plugin(TuiRendererRuntime)
  ctx.plugin(TuiToastRuntime)
  ctx.plugin(TuiThemeRuntime)
}

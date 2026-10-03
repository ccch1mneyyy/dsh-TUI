/**
 * The backend-authored working-activity publishing point (the Claude
 * backend's counterpart of the DSH working-activity plugin's projection):
 * one subscription per bound session, attached when the session serves the
 * typed `workingActivity` capability (a DSH session publishes through the
 * projection instead and never lands here).
 *
 * Values are narrowed with `asActivityView` — the same defensive gate the
 * projection feed applies — so a malformed backend value is dropped instead
 * of reaching a renderer half-formed. Leaving a session (the next binding,
 * the channel's release) drops its value, so a stale done card can never
 * survive a rebind.
 *
 * @module dsh-tui/dsh-adapter/channel/session-activity
 */
import { asActivityView } from '../activity-store.js'
import type { CoreChannel } from './core/compose.js'
import type { ChannelLaunchOptions } from './state.js'

/**
 * Attach the per-binding wiring to a core whose sessions may serve the
 * `workingActivity` capability. Called inside `createChannel`'s
 * construction transaction, before the channel starts.
 */
export function attachSessionWorkingActivity(
  core: CoreChannel,
  options: Pick<ChannelLaunchOptions, 'publishActivity' | 'clearActivity'>,
): void {
  core.extend({
    bind: {
      onBind({ capture, register }) {
        const session = capture.session
        const subscribe = session.capabilities.workingActivity?.subscribe
        const publish = options.publishActivity
        if (subscribe === undefined || publish === undefined) return
        const sessionId = session.ref.sessionId
        register(subscribe(view => {
          const narrowed = asActivityView(view)
          if (narrowed !== undefined) publish(sessionId, narrowed)
        }))
        // The session went away: its line goes with it.
        register(() => { options.clearActivity?.(sessionId) })
      },
    },
  })
}

/** Internal command composition follows the same production UI dispatcher.
 * A bare createChannel embedder intentionally keeps its direct local API.
 */
import type { ChannelUi } from '../../adapter/channel/ui-policy.js'
import type { ChannelState } from './types.js'

const dispatchers = new WeakMap<ChannelState, ChannelUi>()

export function bindChannelCommands(state: ChannelState, commands: ChannelUi): void {
  dispatchers.set(state, commands)
  // Keep the revoked dispatcher installed: late async work must fail closed,
  // not revert to the bare-embedder path after production teardown.
}

export function channelCommands(state: ChannelState): ChannelUi | ChannelState {
  return dispatchers.get(state) ?? state
}

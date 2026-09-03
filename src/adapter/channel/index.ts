/**
 * Channel split surface (P4).
 *
 * The live legacy `src/dsh-adapter/channel.ts` remains the implementation
 * source, but the adapter-facing Channel behavior is decomposed here into
 * five small modules:
 *   projection / actions / state / plugins / transcript.
 *
 * This module re-exports the host-internal builder functions and the
 * composition-root registry.
 */

export { projectChannelRows, projectChannelSnapshot } from './projection.js'
export { projectChannelState } from './state.js'
export { createChannelActions } from './actions.js'
export { createChannelPlugins } from './plugins.js'
export { createChannelTranscript } from './transcript.js'
export { registerTuiChannel, onTuiChannelRegistered } from './host-registry.js'
export { CHANNEL_FEATURES, CHANNEL_PORT_METHOD_CAPABILITIES, CHANNEL_STANDARD_DECLARATIONS } from './features.js'
export { TUI_CHANNEL_WIRE_REVISION, type TuiChannelSnapshot } from '../spec/index.js'
export {
  createReplayChannelProvider,
  createReplayChannelProviderFromSnapshot,
  REPLAY_CHANNEL_WIRE_REVISION,
  type ChannelProvider,
  type ChannelProviderOpenInput,
  type ReplayChannelSnapshotSource,
} from './provider.js'
export {
  createChannelConsumer,
  type ChannelConsumer,
} from './consumer.js'

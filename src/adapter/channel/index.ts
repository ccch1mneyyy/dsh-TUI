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
export { registerTuiChannel, getRegisteredTuiChannel } from './host-registry.js'

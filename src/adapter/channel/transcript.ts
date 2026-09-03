/**
 * Channel transcript module (P4 channel split).
 *
 * Provides the durable transcript/event access half of the live Channel:
 * rendered rows plus the raw DSH session event log used by `/trace`.
 *
 * The internal `CHANNEL_SPLIT_TOKEN` is required so this split builder cannot
 * be invoked outside the Kernel/driver path and bypass the HostFacade shadow
 * gate.
 */

import type { Channel } from '../../dsh-adapter/channel.js'
import type { HostChannelTranscriptPort } from '../ports/channel.js'
import { projectChannelRows } from './projection.js'
import { CHANNEL_SPLIT_TOKEN } from './internal-token.js'

/** Build the host-internal transcript surface over one live Channel. */
export function createChannelTranscript(channel: Channel, token: symbol): HostChannelTranscriptPort {
  if (token !== CHANNEL_SPLIT_TOKEN) {
    throw new Error('dsh-tui: Channel split transcript requires the internal host token')
  }
  return Object.freeze({
    rows: () => projectChannelRows(channel.rows),
    traceEvents: () => channel.traceEvents(),
  })
}

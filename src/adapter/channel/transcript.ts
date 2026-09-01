/**
 * Channel transcript module (P4 channel split).
 *
 * Provides the durable transcript/event access half of the live Channel:
 * rendered rows plus the raw DSH session event log used by `/trace`.
 */

import type { Channel } from '../../dsh-adapter/channel.js'
import type { HostChannelTranscriptPort } from '../ports/channel.js'
import { projectChannelRows } from './projection.js'

/** Build the host-internal transcript surface over one live Channel. */
export function createChannelTranscript(channel: Channel): HostChannelTranscriptPort {
  return Object.freeze({
    rows: () => projectChannelRows(channel.rows),
    traceEvents: () => channel.traceEvents(),
    loadOlder: () => channel.loadOlder(),
  })
}

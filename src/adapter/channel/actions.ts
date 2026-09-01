/**
 * Channel actions module (P4 channel split).
 *
 * This is the action half of the live Channel: a thin adapter over the
 * public Channel mutation methods. The Kernel HostFacade wraps these methods
 * with the unified shadow-policy enforcement before any caller can invoke
 * them, so this module never performs its own shadow check.
 */

import type { Channel } from '../../dsh-adapter/channel.js'
import type { HostChannelActionsPort } from '../ports/channel.js'

/** Build the host-internal action surface over one live Channel. */
export function createChannelActions(channel: Channel): HostChannelActionsPort {
  return Object.freeze({
    submit: text => channel.submit(text),
    steer: text => channel.steer(text),
    cancel: () => channel.cancel(),
    interruptAndDeliver: texts => channel.interruptAndDeliver(texts),
    clear: () => channel.clear(),
    loadOlder: () => channel.loadOlder(),
    notify: (text, options) => channel.notify(text, options),
  })
}

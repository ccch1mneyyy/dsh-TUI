import { channelDriver } from '../../upstream/channel-driver.js'
import { CHANNEL_FEATURES } from '../../channel/features.js'
import type { KernelSlice } from './types.js'

export const channelSlice: KernelSlice = Object.freeze({
  id: 'channel',
  capability: 'host.channel',
  driver: channelDriver,
  standardDeclarations: Object.freeze([...CHANNEL_FEATURES]),
})

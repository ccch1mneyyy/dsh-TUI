import { channelDriver } from '../../upstream/channel-driver.js'
import type { KernelSlice } from './types.js'

export const channelSlice: KernelSlice = Object.freeze({
  id: 'channel',
  capability: 'host.channel',
  driver: channelDriver,
  standardDeclarations: Object.freeze([
    'host.channel.projection.snapshot',
    'host.channel.projection.subscribe',
    'host.channel.state.snapshot',
    'host.channel.transcript.rows',
    'host.channel.transcript.trace-events',
    'host.channel.actions.submit',
    'host.channel.actions.steer',
    'host.channel.actions.cancel',
    'host.channel.actions.clear',
    'host.channel.plugins.run-external-command',
    'host.channel.plugins.open-scene',
    'host.channel.plugins.settings-sections',
  ]),
})

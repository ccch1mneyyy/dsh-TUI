import { settingsDriver } from '../../upstream/settings-driver.js'
import type { KernelSlice } from './types.js'

export const settingsSlice: KernelSlice = Object.freeze({
  id: 'settings',
  capability: 'host.settings',
  driver: settingsDriver,
  standardDeclarations: Object.freeze([
    'host.settings.register',
    'host.settings.list',
    'host.settings.section',
    'host.settings.subscribe',
  ]),
})

import { panelsDriver } from '../../upstream/panels-driver.js'
import type { KernelSlice } from './types.js'

export const panelsSlice: KernelSlice = Object.freeze({
  id: 'panels',
  capability: 'host.panels',
  driver: panelsDriver,
  standardDeclarations: Object.freeze([
    'host.panels.register',
    'host.panels.list',
    'host.panels.open',
    'host.panels.close',
    'host.panels.badge',
    'host.panels.subscribe',
  ]),
})

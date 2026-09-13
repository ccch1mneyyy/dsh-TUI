import { scenesDriver } from '../../upstream/scenes-driver.js'
import type { KernelSlice } from './types.js'

export const scenesSlice: KernelSlice = Object.freeze({
  id: 'scenes',
  capability: 'host.scenes',
  driver: scenesDriver,
  standardDeclarations: Object.freeze([
    'host.scenes.register',
    'host.scenes.list',
    'host.scenes.open',
    'host.scenes.close',
    'host.scenes.active',
    'host.scenes.subscribe',
  ]),
})

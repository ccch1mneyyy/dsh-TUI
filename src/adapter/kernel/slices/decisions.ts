import { decisionsDriver } from '../../upstream/decisions-driver.js'
import type { KernelSlice } from './types.js'

export const decisionsSlice: KernelSlice = Object.freeze({
  id: 'decisions',
  capability: 'host.decisions',
  driver: decisionsDriver,
  standardDeclarations: Object.freeze([
    'host.decision.subscribe',
    'host.decision.probe',
  ]),
})

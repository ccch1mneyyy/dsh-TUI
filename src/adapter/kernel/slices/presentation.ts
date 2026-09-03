import { presentationDriver } from '../../upstream/presentation-driver.js'
import type { KernelSlice } from './types.js'

export const presentationSlice: KernelSlice = Object.freeze({
  id: 'presentation',
  capability: 'host.presentation',
  driver: presentationDriver,
  standardDeclarations: Object.freeze([
    'host.presentation.ask',
    'host.presentation.approve',
    'host.presentation.dialog',
    'host.dialogs.select',
    'host.dialogs.confirm',
    'host.dialogs.input',
  ]),
})

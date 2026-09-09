/**
 * Kernel slice registry.
 *
 * Each slice composes one upstream driver with the Standard/effect
 * capability declarations it governs. The Kernel runtime can consume this
 * list for composition and diagnostics; it does not turn slices into
 * business logic.
 */

export type { KernelSlice } from './types.js'
export { presentationSlice } from './presentation.js'
export { workspaceSlice } from './workspace.js'
export { scenesSlice } from './scenes.js'
export { settingsSlice } from './settings.js'
export { channelSlice } from './channel.js'
export {
  statusSlice,
  shortcutsSlice,
  renderersSlice,
  themesSlice,
  toastSlice,
  commandTreesSlice,
} from './extensions.js'
export { decisionsSlice } from './decisions.js'

import type { KernelSlice } from './types.js'
import { presentationSlice } from './presentation.js'
import { workspaceSlice } from './workspace.js'
import { scenesSlice } from './scenes.js'
import { settingsSlice } from './settings.js'
import { channelSlice } from './channel.js'
import {
  statusSlice,
  shortcutsSlice,
  renderersSlice,
  themesSlice,
  toastSlice,
  commandTreesSlice,
} from './extensions.js'
import { decisionsSlice } from './decisions.js'

export const ADAPTER_KERNEL_SLICES: readonly KernelSlice[] = Object.freeze([
  presentationSlice,
  workspaceSlice,
  scenesSlice,
  settingsSlice,
  channelSlice,
  statusSlice,
  shortcutsSlice,
  renderersSlice,
  themesSlice,
  toastSlice,
  commandTreesSlice,
  decisionsSlice,
])

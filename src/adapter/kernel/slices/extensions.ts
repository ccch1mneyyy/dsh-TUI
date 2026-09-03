import type { UpstreamDriver } from '../../upstream/driver.js'
import {
  statusDriver,
  shortcutsDriver,
  renderersDriver,
  themesDriver,
  toastDriver,
  commandTreesDriver,
} from '../../upstream/extensions-driver.js'
import type { KernelSlice } from './types.js'

const statusDeclarations = Object.freeze([
  'host.status.set',
  'host.status.snapshot',
  'host.status.subscribe',
])
const shortcutsDeclarations = Object.freeze([
  'host.shortcuts.register',
  'host.shortcuts.list',
  'host.shortcuts.dispatch',
])
const renderersDeclarations = Object.freeze([
  'host.renderers.register',
  'host.renderers.render',
])
const themesDeclarations = Object.freeze([
  'host.themes.register',
  'host.themes.snapshot',
  'host.themes.resolver',
  'host.themes.subscribe',
])
const toastDeclarations = Object.freeze([
  'host.toast.show',
])
const commandTreesDeclarations = Object.freeze([
  'host.command-trees.register',
  'host.command-trees.children',
  'host.command-trees.descriptions',
])

function extensionSlice(id: string, capability: string, driver: UpstreamDriver, standardDeclarations: readonly string[]): KernelSlice {
  return Object.freeze({
    id,
    capability,
    driver,
    standardDeclarations,
  })
}

export const statusSlice = extensionSlice('status', 'host.status', statusDriver, statusDeclarations)
export const shortcutsSlice = extensionSlice('shortcuts', 'host.shortcuts', shortcutsDriver, shortcutsDeclarations)
export const renderersSlice = extensionSlice('renderers', 'host.renderers', renderersDriver, renderersDeclarations)
export const themesSlice = extensionSlice('themes', 'host.themes', themesDriver, themesDeclarations)
export const toastSlice = extensionSlice('toast', 'host.toast', toastDriver, toastDeclarations)
export const commandTreesSlice = extensionSlice('command-trees', 'host.command-trees', commandTreesDriver, commandTreesDeclarations)

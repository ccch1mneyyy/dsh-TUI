import { workspaceDriver } from '../../upstream/workspace-driver.js'
import type { KernelSlice } from './types.js'

export const workspaceSlice: KernelSlice = Object.freeze({
  id: 'workspace',
  capability: 'host.workspaces',
  driver: workspaceDriver,
  standardDeclarations: Object.freeze([
    'host.workspaces.list',
    'host.workspaces.resolve',
    'host.workspaces.describe',
    'host.workspaces.commandShell',
    'host.workspaces.rename',
    'host.workspaces.commands',
    'host.workspaces.runCommand',
  ]),
})

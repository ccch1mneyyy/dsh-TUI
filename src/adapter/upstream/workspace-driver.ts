/**
 * Upstream driver for the TUI workspace capability.
 *
 * This driver detects the `tuiWorkspaces` service and its host-only facade,
 * performs real read-only enumeration/resolution probes in `verifyLive`, and
 * mounts a thin Host Workspace Port over the same legacy host facade. It
 * deliberately does not import Standard/Spec and does not define protocol
 * semantics.
 *
 * Publication is feature-level: only the methods actually verified by a
 * read-only/reversible probe are promoted to live. Mutating methods
 * (rename/runCommand) and command-shell execution remain degraded in P3
 * because they cannot be safely auto-reversed on a real host.
 */

import type { Context } from '../../dsh-adapter/types.js'
import type { HostWorkspacePort, HostWorkspaceTarget } from '../ports/workspace.js'
import type { CapabilityLifecycle } from '../kernel/lifecycle.js'
import { lifecycleFromDetection } from '../kernel/lifecycle.js'
import type { Detection, DetectionEvidence } from './detection.js'
import type { UpstreamDriver, UpstreamDriverMount } from './driver.js'
import { getHostWorkspaceRuntime, type TuiWorkspaceHost } from '../../dsh-adapter/workspaces.js'

const CAPABILITY = 'host.workspaces'
const WORKSPACE_FEATURES = Object.freeze([
  'host.workspaces.list',
  'host.workspaces.resolve',
  'host.workspaces.describe',
  'host.workspaces.commands',
  'host.workspaces.commandShell',
  'host.workspaces.rename',
  'host.workspaces.runCommand',
] as const)

function serviceEvidence(id: string): DetectionEvidence {
  return { kind: 'service', id }
}

function methodEvidence(service: string, method: string): DetectionEvidence {
  return { kind: 'method', id: `${service}:${method}` }
}

function probeEvidence(id: string, detail: string): DetectionEvidence {
  return { kind: 'probe', id, detail }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type HostContext = Pick<Context, 'get'>
type WorkspaceService = { readonly [key: string]: unknown }

function workspaceHost(ctx: unknown): TuiWorkspaceHost | undefined {
  const service = (ctx as HostContext | undefined)?.get?.('tuiWorkspaces') as WorkspaceService | undefined
  if (service === undefined) return undefined
  try {
    return getHostWorkspaceRuntime(service as never)
  } catch {
    return undefined
  }
}

function degradedFeature(capability: string, evidence: DetectionEvidence[], missing: string): CapabilityLifecycle {
  return lifecycleFromDetection(capability, {
    state: 'degraded',
    missing: [missing],
    evidence,
  })
}

function liveFeature(capability: string, evidence: DetectionEvidence[]): CapabilityLifecycle {
  return lifecycleFromDetection(capability, {
    state: 'supported',
    evidence,
  })
}

export function detectWorkspaceCapability(ctx: unknown): Detection {
  const service = (ctx as HostContext | undefined)?.get?.('tuiWorkspaces')
  if (service === undefined) {
    return { state: 'unsupported', reason: 'tuiWorkspaces service is not mounted' }
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiWorkspaces')]
  const host = workspaceHost(ctx)
  if (host === undefined) {
    return { state: 'degraded', missing: ['tuiWorkspaces host facade'], evidence }
  }
  for (const method of ['list', 'resolve', 'describe', 'commands'] as const) {
    if (typeof (host as unknown as Record<string, unknown>)[method] === 'function') {
      evidence.push(methodEvidence('tuiWorkspaces', method))
    } else {
      return { state: 'degraded', missing: [`tuiWorkspaces.${method}()`], evidence }
    }
  }
  return {
    state: 'supported',
    evidence: [...evidence, probeEvidence('tuiWorkspaces.host()', 'host workspace facade is present')],
  }
}

async function verifyWorkspaceLive(ctx: unknown): Promise<CapabilityLifecycle[]> {
  const host = workspaceHost(ctx)
  const baseEvidence: DetectionEvidence[] = [serviceEvidence('tuiWorkspaces')]
  if (host === undefined) {
    return WORKSPACE_FEATURES.map(feature => degradedFeature(feature, baseEvidence, `${feature}.live-probe`))
  }
  const out: CapabilityLifecycle[] = []
  const cwd = process.cwd()
  const probeSignal = (): AbortSignal => AbortSignal.timeout(2_000)

  try {
    const list = await host.list(cwd, probeSignal())
    if (Array.isArray(list)) {
      out.push(liveFeature('host.workspaces.list', [
        serviceEvidence('tuiWorkspaces'),
        methodEvidence('tuiWorkspaces', 'list'),
        probeEvidence('tuiWorkspaces.list()', `enumerated ${list.length} workspace target(s)`),
      ]))
    } else {
      out.push(degradedFeature('host.workspaces.list', [serviceEvidence('tuiWorkspaces'), methodEvidence('tuiWorkspaces', 'list')], 'tuiWorkspaces.list() returned no array'))
    }
  } catch (error) {
    out.push(degradedFeature('host.workspaces.list', [serviceEvidence('tuiWorkspaces'), probeEvidence('tuiWorkspaces.list()', errorText(error))], 'tuiWorkspaces.list() live-probe'))
  }

  try {
    const resolved = await host.resolve(cwd, cwd, probeSignal())
    if (resolved !== undefined && typeof resolved.cwd === 'string') {
      out.push(liveFeature('host.workspaces.resolve', [
        serviceEvidence('tuiWorkspaces'),
        methodEvidence('tuiWorkspaces', 'resolve'),
        probeEvidence('tuiWorkspaces.resolve()', `resolved ${resolved.uri}`),
      ]))
    } else {
      out.push(degradedFeature('host.workspaces.resolve', [serviceEvidence('tuiWorkspaces'), methodEvidence('tuiWorkspaces', 'resolve')], 'tuiWorkspaces.resolve() returned no target'))
    }
  } catch (error) {
    out.push(degradedFeature('host.workspaces.resolve', [serviceEvidence('tuiWorkspaces'), probeEvidence('tuiWorkspaces.resolve()', errorText(error))], 'tuiWorkspaces.resolve() live-probe'))
  }

  try {
    const describe = host.describe(cwd)
    if (describe !== undefined && typeof describe.cwd === 'string') {
      out.push(liveFeature('host.workspaces.describe', [
        serviceEvidence('tuiWorkspaces'),
        methodEvidence('tuiWorkspaces', 'describe'),
        probeEvidence('tuiWorkspaces.describe()', `resolved current workspace ${describe.uri}`),
      ]))
    } else {
      out.push(degradedFeature('host.workspaces.describe', [serviceEvidence('tuiWorkspaces'), methodEvidence('tuiWorkspaces', 'describe')], 'tuiWorkspaces.describe()'))
    }
  } catch (error) {
    out.push(degradedFeature('host.workspaces.describe', [serviceEvidence('tuiWorkspaces'), probeEvidence('tuiWorkspaces.describe()', errorText(error))], 'tuiWorkspaces.describe() live-probe'))
  }

  try {
    const commands = host.commands()
    if (Array.isArray(commands)) {
      out.push(liveFeature('host.workspaces.commands', [
        serviceEvidence('tuiWorkspaces'),
        methodEvidence('tuiWorkspaces', 'commands'),
        probeEvidence('tuiWorkspaces.commands()', `enumerated ${commands.length} workspace command(s)`),
      ]))
    } else {
      out.push(degradedFeature('host.workspaces.commands', [serviceEvidence('tuiWorkspaces'), methodEvidence('tuiWorkspaces', 'commands')], 'tuiWorkspaces.commands()'))
    }
  } catch (error) {
    out.push(degradedFeature('host.workspaces.commands', [serviceEvidence('tuiWorkspaces'), probeEvidence('tuiWorkspaces.commands()', errorText(error))], 'tuiWorkspaces.commands() live-probe'))
  }

  // No safe auto-reversible P3 probe for command-shell execution, renaming,
  // or provider command execution. These stay feature-degraded.
  for (const feature of ['host.workspaces.commandShell', 'host.workspaces.rename', 'host.workspaces.runCommand'] as const) {
    out.push(degradedFeature(feature, [serviceEvidence('tuiWorkspaces')], `${feature}.live-probe`))
  }

  return out
}

/** Thin Host Workspace Port over the legacy host-only facade. */
function createWorkspacePort(host: TuiWorkspaceHost): HostWorkspacePort {
  return Object.freeze({
    list: (currentCwd, signal) => host.list(currentCwd, signal),
    resolve: (reference, currentCwd, signal) => host.resolve(reference, currentCwd, signal),
    describe: cwd => host.describe(cwd),
    commandShell: cwd => host.commandShell(cwd),
    rename: (cwd, title) => host.rename(cwd, title),
    commands: () => host.commands(),
    runCommand: (name, input, cwd, signal) => host.runCommand(name, input, cwd, signal),
  })
}

export const workspaceDriver: UpstreamDriver = {
  id: 'dsh-tui-workspace',
  upstreamFamily: 'dsh-tui',
  capability: 'host.workspaces',
  mountEffectClass: 'mutate',
  detect: detectWorkspaceCapability,
  verifyLive: verifyWorkspaceLive,
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    const host = workspaceHost(context)
    const ports = host === undefined ? undefined : { workspace: createWorkspacePort(host) }
    return { disposer: () => undefined, ...(ports === undefined ? {} : { ports }) }
  },
}

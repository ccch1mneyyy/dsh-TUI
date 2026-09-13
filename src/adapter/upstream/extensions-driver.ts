/**
 * Upstream drivers for the TUI extension seams.
 *
 * Each driver is a per-capability adapter over a legacy host-only facade:
 * status, shortcuts, renderers, themes, toast, and command trees. All
 * register/subscribe probes use a unique temporary id, verify visibility,
 * dispose, then prove the same id is again available (no residue). Read-only
 * drivers only issue host-internal reads.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '../../dsh-adapter/types.js'
import type {
  HostStatusPort,
  HostShortcutsPort,
  HostRenderersPort,
  HostThemesPort,
  HostToastPort,
  HostCommandTreesPort,
  HostStatusEntry,
} from '../ports/extensions.js'
import type { CapabilityLifecycle } from '../kernel/lifecycle.js'
import { lifecycleFromDetection } from '../kernel/lifecycle.js'
import type { Detection, DetectionEvidence } from './detection.js'
import type { UpstreamDriver, UpstreamDriverMount } from './driver.js'
import { getHostStatusStore } from '../../dsh-adapter/status.js'
import { getHostShortcuts, type TuiShortcutHost } from '../../dsh-adapter/shortcuts.js'
import { getHostRenderers, type TuiRendererHost } from '../../dsh-adapter/renderers.js'
import { getHostThemes, type TuiThemeHost } from '../../dsh-adapter/themes.js'
import { getHostToastStore } from '../../dsh-adapter/toast.js'
import { getHostCommandTrees, type TuiCommandTreeHost } from '../../dsh-adapter/command-trees.js'

type HostContext = Pick<Context, 'get'>

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

function degraded(capability: string, service: string, missing: readonly string[], evidence: DetectionEvidence[] = []): CapabilityLifecycle[] {
  return [lifecycleFromDetection(capability, { state: 'degraded', missing: [...missing], evidence })]
}

function degradedFeature(capability: string, evidence: DetectionEvidence[], missing: string): CapabilityLifecycle {
  return lifecycleFromDetection(capability, { state: 'degraded', missing: [missing], evidence })
}

function liveFeature(capability: string, evidence: DetectionEvidence[]): CapabilityLifecycle {
  return lifecycleFromDetection(capability, { state: 'supported', evidence })
}

// ── status ────────────────────────────────────────────────────────────────

export function detectStatusCapability(ctx: unknown): Detection {
  const service = (ctx as HostContext | undefined)?.get?.('tuiStatus')
  if (service === undefined) return { state: 'unsupported', reason: 'tuiStatus service is not mounted' }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiStatus')]
  let store: ReturnType<typeof getHostStatusStore> | undefined
  try {
    store = getHostStatusStore(service as never)
  } catch {
    store = undefined
  }
  if (store === undefined) return { state: 'degraded', missing: ['tuiStatus host store'], evidence }
  for (const method of ['set', 'getSnapshot', 'subscribe'] as const) {
    if (typeof (store as unknown as Record<string, unknown>)[method] !== 'function') {
      return { state: 'degraded', missing: [`tuiStatus.${method}()`], evidence }
    }
  }
  return { state: 'supported', evidence }
}

async function verifyStatusLive(ctx: unknown): Promise<CapabilityLifecycle[]> {
  const service = (ctx as HostContext | undefined)?.get?.('tuiStatus')
  const store = service === undefined ? undefined : (() => {
    try {
      return getHostStatusStore(service as never)
    } catch {
      return undefined
    }
  })()
  const baseEvidence: DetectionEvidence[] = [serviceEvidence('tuiStatus')]
  if (store === undefined) {
    return [
      degradedFeature('host.status.set', baseEvidence, 'tuiStatus host store'),
      degradedFeature('host.status.snapshot', baseEvidence, 'tuiStatus host store'),
      degradedFeature('host.status.subscribe', baseEvidence, 'tuiStatus host store'),
    ]
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiStatus')]
  const key = `dsh_tui_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const token = Math.floor(Math.random() * 0x7fffffff)
  let setLive = false
  try {
    store.set(key, 'ok', token)
    const snapshot = store.getSnapshot() as readonly HostStatusEntry[]
    if (!snapshot.some(entry => entry.key === key)) {
      throw new Error('temporary status was not visible')
    }
    evidence.push(probeEvidence(`tuiStatus.set+clear(${key})`, 'temporary status set and visible'))
    const cleared = store.clearIf(key, token)
    if (cleared !== true) {
      throw new Error('temporary status clearIf returned false')
    }
    const after = store.getSnapshot() as readonly HostStatusEntry[]
    if (after.some(entry => entry.key === key)) {
      throw new Error('temporary status left residue after clear')
    }
    evidence.push(probeEvidence('tuiStatus.clear()', 'temporary status removed and no residue remains'))
    setLive = true
  } catch (error) {
    try {
      store.clearIf(key, token)
    } catch {
      // Best-effort cleanup.
    }
    evidence.push(probeEvidence('tuiStatus.reversible-live-probe', errorText(error)))
  }
  const out: CapabilityLifecycle[] = []
  out.push(setLive
    ? liveFeature('host.status.set', evidence)
    : degradedFeature('host.status.set', evidence, 'tuiStatus.reversible-live-probe'))
  out.push(setLive
    ? liveFeature('host.status.snapshot', [
        serviceEvidence('tuiStatus'),
        probeEvidence('tuiStatus.snapshot()', 'temporary status visible and removed in snapshot'),
      ])
    : degradedFeature('host.status.snapshot', [serviceEvidence('tuiStatus')], 'tuiStatus.snapshot() live-probe'))
  out.push(degradedFeature('host.status.subscribe', [serviceEvidence('tuiStatus')], 'host.status.subscribe.live-probe'))
  return out
}

function createStatusPort(store: NonNullable<ReturnType<typeof getHostStatusStore>>): HostStatusPort {
  let tokenSeq = 1
  return Object.freeze({
    set(key, text) {
      const token = tokenSeq++
      store.set(key, text === undefined ? undefined : String(text), token)
      return () => {
        store.clearIf(key, token)
      }
    },
    snapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
  })
}

// ── shortcuts ─────────────────────────────────────────────────────────────

export function detectShortcutsCapability(ctx: unknown): Detection {
  const service = (ctx as HostContext | undefined)?.get?.('tuiShortcuts')
  if (service === undefined) return { state: 'unsupported', reason: 'tuiShortcuts service is not mounted' }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiShortcuts')]
  let host: TuiShortcutHost | undefined
  try {
    host = getHostShortcuts(service as never)
  } catch {
    host = undefined
  }
  if (host === undefined) return { state: 'degraded', missing: ['tuiShortcuts host facade'], evidence }
  for (const method of ['register', 'list', 'dispatch'] as const) {
    if (typeof (host as unknown as Record<string, unknown>)[method] !== 'function') {
      return { state: 'degraded', missing: [`tuiShortcuts.${method}()`], evidence }
    }
  }
  return { state: 'supported', evidence }
}

async function verifyShortcutsLive(ctx: unknown): Promise<CapabilityLifecycle[]> {
  const service = (ctx as HostContext | undefined)?.get?.('tuiShortcuts')
  const host = service === undefined ? undefined : (() => {
    try {
      return getHostShortcuts(service as never)
    } catch {
      return undefined
    }
  })()
  const baseEvidence: DetectionEvidence[] = [serviceEvidence('tuiShortcuts')]
  if (host === undefined) {
    return [
      degradedFeature('host.shortcuts.register', baseEvidence, 'tuiShortcuts host facade'),
      degradedFeature('host.shortcuts.list', baseEvidence, 'tuiShortcuts host facade'),
      degradedFeature('host.shortcuts.dispatch', baseEvidence, 'tuiShortcuts host facade'),
    ]
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiShortcuts')]
  const shortcutKeys = ['9', '0', 'u', 'i', 'o', 'p', 'h', 'j', 'k', 'l', 'b', 'n', 'm']
  const combo = `ctrl+alt+shift+${shortcutKeys[Math.floor(Math.random() * shortcutKeys.length)]}`
  const options = { description: 'dsh-tui reversible shortcut probe', handler: () => undefined }
  let activeCombo = combo
  let dispose: (() => void) | undefined
  let observed = false
  let registerLive = false
  try {
    dispose = host.register(combo, options)
    const listed = host.list()
    observed = Array.isArray(listed) && listed.some(entry => entry.combo === combo)
    if (!observed) {
      for (const candidate of shortcutKeys) {
        const candidateCombo = `ctrl+alt+shift+${candidate}`
        dispose?.()
        dispose = undefined
        dispose = host.register(candidateCombo, options)
        const candidateList = host.list()
        if (Array.isArray(candidateList) && candidateList.some(entry => entry.combo === candidateCombo)) {
          activeCombo = candidateCombo
          observed = true
          break
        }
      }
      if (!observed) throw new Error('temporary shortcut was not visible')
    }
    evidence.push(probeEvidence(`tuiShortcuts.register+list(${activeCombo})`, 'temporary shortcut registered and listed'))
    dispose()
    dispose = undefined
    const second = host.register(activeCombo, options)
    second()
    evidence.push(probeEvidence(`tuiShortcuts.dispose(${activeCombo})`, 'temporary shortcut removed; same combo re-register succeeded'))
    registerLive = true
  } catch (error) {
    try {
      dispose?.()
    } catch {
      // ignore
    }
    evidence.push(probeEvidence('tuiShortcuts.reversible-live-probe', errorText(error)))
  }
  const out: CapabilityLifecycle[] = []
  out.push(registerLive
    ? liveFeature('host.shortcuts.register', evidence)
    : degradedFeature('host.shortcuts.register', evidence, 'tuiShortcuts.reversible-live-probe'))
  out.push(registerLive
    ? liveFeature('host.shortcuts.list', [
        serviceEvidence('tuiShortcuts'),
        methodEvidence('tuiShortcuts', 'list'),
        probeEvidence('tuiShortcuts.list()', 'temporary shortcut visible through list()'),
      ])
    : degradedFeature('host.shortcuts.list', [serviceEvidence('tuiShortcuts'), methodEvidence('tuiShortcuts', 'list')], 'tuiShortcuts.list() live-probe'))
  out.push(degradedFeature('host.shortcuts.dispatch', [serviceEvidence('tuiShortcuts'), methodEvidence('tuiShortcuts', 'dispatch')], 'host.shortcuts.dispatch.live-probe'))
  return out
}

function createShortcutsPort(host: TuiShortcutHost): HostShortcutsPort {
  return Object.freeze({
    register: (combo, options) => host.register(combo, options),
    list: () => host.list(),
    dispatch: (input, key) => host.dispatch(input, key),
  })
}

// ── renderers ─────────────────────────────────────────────────────────────

export function detectRenderersCapability(ctx: unknown): Detection {
  const service = (ctx as HostContext | undefined)?.get?.('tuiRenderers')
  if (service === undefined) return { state: 'unsupported', reason: 'tuiRenderers service is not mounted' }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiRenderers')]
  let host: TuiRendererHost | undefined
  try {
    host = getHostRenderers(service as never)
  } catch {
    host = undefined
  }
  if (host === undefined) return { state: 'degraded', missing: ['tuiRenderers host facade'], evidence }
  for (const method of ['register', 'render'] as const) {
    if (typeof (host as unknown as Record<string, unknown>)[method] !== 'function') {
      return { state: 'degraded', missing: [`tuiRenderers.${method}()`], evidence }
    }
  }
  return { state: 'supported', evidence }
}

async function verifyRenderersLive(ctx: unknown): Promise<CapabilityLifecycle[]> {
  const service = (ctx as HostContext | undefined)?.get?.('tuiRenderers')
  const host = service === undefined ? undefined : (() => {
    try {
      return getHostRenderers(service as never)
    } catch {
      return undefined
    }
  })()
  const baseEvidence: DetectionEvidence[] = [serviceEvidence('tuiRenderers')]
  if (host === undefined) {
    return [
      degradedFeature('host.renderers.register', baseEvidence, 'tuiRenderers host facade'),
      degradedFeature('host.renderers.render', baseEvidence, 'tuiRenderers host facade'),
    ]
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiRenderers')]
  const type = `dsh-tui/probe-${randomUUID().replace(/-/g, '').slice(0, 8)}`
  let dispose: (() => void) | undefined
  let registerLive = false
  try {
    dispose = host.register(type, payload => ({ lines: ['probe-ok', typeof payload] }))
    const result = host.render(type, 'x')
    if (result === undefined || !Array.isArray(result.lines)) {
      throw new Error('temporary renderer did not produce output')
    }
    evidence.push(probeEvidence(`tuiRenderers.register+render(${type})`, 'temporary renderer registered and rendered'))
    dispose()
    dispose = undefined
    if (host.render(type, 'x') !== undefined) {
      throw new Error('temporary renderer left residue after dispose')
    }
    evidence.push(probeEvidence(`tuiRenderers.dispose(${type})`, 'temporary renderer removed; render(disposed) returned undefined'))
    registerLive = true
  } catch (error) {
    try {
      dispose?.()
    } catch {
      // ignore
    }
    evidence.push(probeEvidence('tuiRenderers.reversible-live-probe', errorText(error)))
  }
  const out: CapabilityLifecycle[] = []
  out.push(registerLive
    ? liveFeature('host.renderers.register', evidence)
    : degradedFeature('host.renderers.register', evidence, 'tuiRenderers.reversible-live-probe'))
  out.push(registerLive
    ? liveFeature('host.renderers.render', [
        serviceEvidence('tuiRenderers'),
        methodEvidence('tuiRenderers', 'render'),
        probeEvidence('tuiRenderers.render()', 'temporary renderer produced output and disposed cleanly'),
      ])
    : degradedFeature('host.renderers.render', [serviceEvidence('tuiRenderers'), methodEvidence('tuiRenderers', 'render')], 'tuiRenderers.render() live-probe'))
  return out
}

function createRenderersPort(host: TuiRendererHost): HostRenderersPort {
  return Object.freeze({
    register: (type, renderer) => host.register(type, renderer),
    render: (type, payload) => host.render(type, payload),
  })
}

// ── themes ────────────────────────────────────────────────────────────────

export function detectThemesCapability(ctx: unknown): Detection {
  const service = (ctx as HostContext | undefined)?.get?.('tuiThemes')
  if (service === undefined) return { state: 'unsupported', reason: 'tuiThemes service is not mounted' }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiThemes')]
  let host: TuiThemeHost | undefined
  try {
    host = getHostThemes(service as never)
  } catch {
    host = undefined
  }
  if (host === undefined) return { state: 'degraded', missing: ['tuiThemes host facade'], evidence }
  for (const method of ['register', 'getSnapshot', 'resolve'] as const) {
    if (typeof (host as unknown as Record<string, unknown>)[method] !== 'function') {
      return { state: 'degraded', missing: [`tuiThemes.${method}()`], evidence }
    }
  }
  return { state: 'supported', evidence }
}

async function verifyThemesLive(ctx: unknown): Promise<CapabilityLifecycle[]> {
  const service = (ctx as HostContext | undefined)?.get?.('tuiThemes')
  const host = service === undefined ? undefined : (() => {
    try {
      return getHostThemes(service as never)
    } catch {
      return undefined
    }
  })()
  const baseEvidence: DetectionEvidence[] = [serviceEvidence('tuiThemes')]
  if (host === undefined) {
    return [
      degradedFeature('host.themes.register', baseEvidence, 'tuiThemes host facade'),
      degradedFeature('host.themes.snapshot', baseEvidence, 'tuiThemes host facade'),
      degradedFeature('host.themes.resolver', baseEvidence, 'tuiThemes host facade'),
      degradedFeature('host.themes.subscribe', baseEvidence, 'tuiThemes host facade'),
    ]
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiThemes')]
  const name = `dshtuiprobe${randomUUID().replace(/-/g, '').slice(0, 8)}`
  let dispose: (() => void) | undefined
  let registerLive = false
  try {
    dispose = host.register({ name, displayName: 'dsh-tui probe', base: 'dark', colors: {} })
    const snapshot = host.getSnapshot()
    if (!snapshot.some(entry => entry.name === name)) {
      throw new Error('temporary theme was not visible')
    }
    if (host.resolve(name) === undefined) {
      throw new Error('temporary theme did not resolve')
    }
    evidence.push(probeEvidence(`tuiThemes.register+resolve(${name})`, 'temporary theme registered and resolved'))
    dispose()
    dispose = undefined
    if (host.resolve(name) !== undefined) {
      throw new Error('temporary theme left residue after dispose')
    }
    evidence.push(probeEvidence(`tuiThemes.dispose(${name})`, 'temporary theme removed; resolve(disposed) returned undefined'))
    registerLive = true
  } catch (error) {
    try {
      dispose?.()
    } catch {
      // ignore
    }
    evidence.push(probeEvidence('tuiThemes.reversible-live-probe', errorText(error)))
  }
  const out: CapabilityLifecycle[] = []
  out.push(registerLive
    ? liveFeature('host.themes.register', evidence)
    : degradedFeature('host.themes.register', evidence, 'tuiThemes.reversible-live-probe'))
  out.push(registerLive
    ? liveFeature('host.themes.snapshot', [
        serviceEvidence('tuiThemes'),
        methodEvidence('tuiThemes', 'getSnapshot'),
        probeEvidence('tuiThemes.snapshot()', 'temporary theme visible in snapshot'),
      ])
    : degradedFeature('host.themes.snapshot', [serviceEvidence('tuiThemes')], 'tuiThemes.snapshot() live-probe'))
  out.push(registerLive
    ? liveFeature('host.themes.resolver', [
        serviceEvidence('tuiThemes'),
        methodEvidence('tuiThemes', 'resolve'),
        probeEvidence('tuiThemes.resolve()', 'temporary theme resolved and removed cleanly'),
      ])
    : degradedFeature('host.themes.resolver', [serviceEvidence('tuiThemes'), methodEvidence('tuiThemes', 'resolve')], 'tuiThemes.resolve() live-probe'))
  out.push(degradedFeature('host.themes.subscribe', [serviceEvidence('tuiThemes')], 'host.themes.subscribe.live-probe'))
  return out
}

function createThemesPort(host: TuiThemeHost): HostThemesPort {
  return Object.freeze({
    register: descriptor => host.register(descriptor as never),
    snapshot: () => host.getSnapshot() as never,
    resolve: name => host.resolve(name),
    subscribe: listener => host.subscribe(listener),
  })
}

// ── toast ─────────────────────────────────────────────────────────────────

export function detectToastCapability(ctx: unknown): Detection {
  const service = (ctx as HostContext | undefined)?.get?.('tuiToast')
  if (service === undefined) return { state: 'unsupported', reason: 'tuiToast service is not mounted' }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiToast')]
  let store: ReturnType<typeof getHostToastStore> | undefined
  try {
    store = getHostToastStore(service as never)
  } catch {
    store = undefined
  }
  if (store === undefined) return { state: 'degraded', missing: ['tuiToast host store'], evidence }
  if (typeof store.addProbeSink !== 'function' || typeof store.deliverProbe !== 'function') {
    return { state: 'degraded', missing: ['tuiToast store probe methods'], evidence }
  }
  return { state: 'supported', evidence }
}

async function verifyToastLive(ctx: unknown): Promise<CapabilityLifecycle[]> {
  const service = (ctx as HostContext | undefined)?.get?.('tuiToast')
  const store = service === undefined ? undefined : (() => {
    try {
      return getHostToastStore(service as never)
    } catch {
      return undefined
    }
  })()
  const baseEvidence: DetectionEvidence[] = [serviceEvidence('tuiToast')]
  if (store === undefined) {
    return [degradedFeature('host.toast.show', baseEvidence, 'tuiToast host store')]
  }
  const evidence: DetectionEvidence[] = [
    serviceEvidence('tuiToast'),
    methodEvidence('tuiToast', 'deliver'),
  ]
  // `deliverProbe()` proves only that a probe-only channel works; it does NOT
  // prove the real production `deliver()` path (channel.notify / UI sink) is
  // wired and non-disruptively reachable. Without a non-disruptive real
  // production-delivery probe, `host.toast.show` must remain degraded.
  evidence.push(probeEvidence(
    'tuiToast.hasSink()',
    typeof store.hasSink === 'function' && store.hasSink()
      ? 'production toast sink is present, but real delivery path is not verified by a non-disruptive probe'
      : 'production toast sink is absent',
  ))
  return [degradedFeature(
    'host.toast.show',
    evidence,
    'host.toast.show.real-production-delivery-not-verified',
  )]
}

function createToastPort(store: NonNullable<ReturnType<typeof getHostToastStore>>): HostToastPort {
  return Object.freeze({
    show: delivery => store.deliver(delivery),
  })
}

// ── command trees ─────────────────────────────────────────────────────────

export function detectCommandTreesCapability(ctx: unknown): Detection {
  const service = (ctx as HostContext | undefined)?.get?.('tuiCommandTrees')
  if (service === undefined) return { state: 'unsupported', reason: 'tuiCommandTrees service is not mounted' }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiCommandTrees')]
  let host: TuiCommandTreeHost | undefined
  try {
    host = getHostCommandTrees(service as never)
  } catch {
    host = undefined
  }
  if (host === undefined) return { state: 'degraded', missing: ['tuiCommandTrees host facade'], evidence }
  for (const method of ['register', 'children', 'descriptions'] as const) {
    if (typeof (host as unknown as Record<string, unknown>)[method] !== 'function') {
      return { state: 'degraded', missing: [`tuiCommandTrees.${method}()`], evidence }
    }
  }
  return { state: 'supported', evidence }
}

async function verifyCommandTreesLive(ctx: unknown): Promise<CapabilityLifecycle[]> {
  const service = (ctx as HostContext | undefined)?.get?.('tuiCommandTrees')
  const host = service === undefined ? undefined : (() => {
    try {
      return getHostCommandTrees(service as never)
    } catch {
      return undefined
    }
  })()
  const baseEvidence: DetectionEvidence[] = [serviceEvidence('tuiCommandTrees')]
  if (host === undefined) {
    return [
      degradedFeature('host.command-trees.register', baseEvidence, 'tuiCommandTrees host facade'),
      degradedFeature('host.command-trees.children', baseEvidence, 'tuiCommandTrees host facade'),
      degradedFeature('host.command-trees.descriptions', baseEvidence, 'tuiCommandTrees host facade'),
    ]
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiCommandTrees')]
  const root = `dshtuiprobe${randomUUID().replace(/-/g, '').slice(0, 8)}`
  let dispose: (() => void) | undefined
  let registerLive = false
  try {
    dispose = host.register({ root, children: () => [{ value: 'child' }] } as never)
    const children = host.children([root])
    if (!Array.isArray(children) || children.length === 0) {
      throw new Error('temporary command tree did not resolve children')
    }
    evidence.push(probeEvidence(`tuiCommandTrees.register+children(${root})`, 'temporary command tree registered and resolved'))
    dispose()
    dispose = undefined
    if (host.children([root]).length !== 0) {
      throw new Error('temporary command tree left residue after dispose')
    }
    evidence.push(probeEvidence(`tuiCommandTrees.dispose(${root})`, 'temporary command tree removed; children(disposed) returned empty'))
    registerLive = true
  } catch (error) {
    try {
      dispose?.()
    } catch {
      // ignore
    }
    evidence.push(probeEvidence('tuiCommandTrees.reversible-live-probe', errorText(error)))
  }
  const out: CapabilityLifecycle[] = []
  out.push(registerLive
    ? liveFeature('host.command-trees.register', evidence)
    : degradedFeature('host.command-trees.register', evidence, 'tuiCommandTrees.reversible-live-probe'))
  out.push(registerLive
    ? liveFeature('host.command-trees.children', [
        serviceEvidence('tuiCommandTrees'),
        methodEvidence('tuiCommandTrees', 'children'),
        probeEvidence('tuiCommandTrees.children()', 'temporary command tree resolved children and cleaned up'),
      ])
    : degradedFeature('host.command-trees.children', [serviceEvidence('tuiCommandTrees'), methodEvidence('tuiCommandTrees', 'children')], 'tuiCommandTrees.children() live-probe'))
  out.push(degradedFeature('host.command-trees.descriptions', [serviceEvidence('tuiCommandTrees'), methodEvidence('tuiCommandTrees', 'descriptions')], 'host.command-trees.descriptions.live-probe'))
  return out
}

function createCommandTreesPort(host: TuiCommandTreeHost): HostCommandTreesPort {
  return Object.freeze({
    register: provider => host.register(provider as never),
    children: path => host.children(path),
    descriptions: root => host.descriptions(root) as never,
  })
}

// ── driver objects ────────────────────────────────────────────────────────

export const statusDriver: UpstreamDriver = {
  id: 'dsh-tui-status',
  upstreamFamily: 'dsh-tui',
  capability: 'host.status',
  mountEffectClass: 'mutate',
  detect: detectStatusCapability,
  verifyLive: verifyStatusLive,
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    const service = (context as HostContext | undefined)?.get?.('tuiStatus')
    const store = service === undefined ? undefined : (() => {
      try {
        return getHostStatusStore(service as never)
      } catch {
        return undefined
      }
    })()
    const ports = store === undefined ? undefined : { status: createStatusPort(store) }
    return { disposer: () => undefined, ...(ports === undefined ? {} : { ports }) }
  },
}

export const shortcutsDriver: UpstreamDriver = {
  id: 'dsh-tui-shortcuts',
  upstreamFamily: 'dsh-tui',
  capability: 'host.shortcuts',
  mountEffectClass: 'register',
  detect: detectShortcutsCapability,
  verifyLive: verifyShortcutsLive,
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    const service = (context as HostContext | undefined)?.get?.('tuiShortcuts')
    const host = service === undefined ? undefined : (() => {
      try {
        return getHostShortcuts(service as never)
      } catch {
        return undefined
      }
    })()
    const ports = host === undefined ? undefined : { shortcuts: createShortcutsPort(host) }
    return { disposer: () => undefined, ...(ports === undefined ? {} : { ports }) }
  },
}

export const renderersDriver: UpstreamDriver = {
  id: 'dsh-tui-renderers',
  upstreamFamily: 'dsh-tui',
  capability: 'host.renderers',
  mountEffectClass: 'register',
  detect: detectRenderersCapability,
  verifyLive: verifyRenderersLive,
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    const service = (context as HostContext | undefined)?.get?.('tuiRenderers')
    const host = service === undefined ? undefined : (() => {
      try {
        return getHostRenderers(service as never)
      } catch {
        return undefined
      }
    })()
    const ports = host === undefined ? undefined : { renderers: createRenderersPort(host) }
    return { disposer: () => undefined, ...(ports === undefined ? {} : { ports }) }
  },
}

export const themesDriver: UpstreamDriver = {
  id: 'dsh-tui-themes',
  upstreamFamily: 'dsh-tui',
  capability: 'host.themes',
  mountEffectClass: 'register',
  detect: detectThemesCapability,
  verifyLive: verifyThemesLive,
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    const service = (context as HostContext | undefined)?.get?.('tuiThemes')
    const host = service === undefined ? undefined : (() => {
      try {
        return getHostThemes(service as never)
      } catch {
        return undefined
      }
    })()
    const ports = host === undefined ? undefined : { themes: createThemesPort(host) }
    return { disposer: () => undefined, ...(ports === undefined ? {} : { ports }) }
  },
}

export const toastDriver: UpstreamDriver = {
  id: 'dsh-tui-toast',
  upstreamFamily: 'dsh-tui',
  capability: 'host.toast',
  mountEffectClass: 'mutate',
  detect: detectToastCapability,
  verifyLive: verifyToastLive,
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    const service = (context as HostContext | undefined)?.get?.('tuiToast')
    const store = service === undefined ? undefined : (() => {
      try {
        return getHostToastStore(service as never)
      } catch {
        return undefined
      }
    })()
    const ports = store === undefined ? undefined : { toast: createToastPort(store) }
    return { disposer: () => undefined, ...(ports === undefined ? {} : { ports }) }
  },
}

export const commandTreesDriver: UpstreamDriver = {
  id: 'dsh-tui-command-trees',
  upstreamFamily: 'dsh-tui',
  capability: 'host.command-trees',
  mountEffectClass: 'register',
  detect: detectCommandTreesCapability,
  verifyLive: verifyCommandTreesLive,
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    const service = (context as HostContext | undefined)?.get?.('tuiCommandTrees')
    const host = service === undefined ? undefined : (() => {
      try {
        return getHostCommandTrees(service as never)
      } catch {
        return undefined
      }
    })()
    const ports = host === undefined ? undefined : { commandTrees: createCommandTreesPort(host) }
    return { disposer: () => undefined, ...(ports === undefined ? {} : { ports }) }
  },
}

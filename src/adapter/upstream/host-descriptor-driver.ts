/**
 * Minimal real upstream driver for the Host Descriptor / diagnostics slice.
 *
 * The driver never treats "the npm package is installed" or "the service key
 * exists" as live support. It distinguishes:
 *   - service present       -> evidence.kind = 'service'
 *   - method/capability     -> evidence.kind = 'method'
 *   - a read-only probe     -> evidence.kind = 'probe'
 *
 * A lifecycle becomes `live` only when `verifyAndPromote()` sees at least one
 * `probe` evidence item. Method/source presence alone keeps the capability
 * `staged` or `degraded`.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '../../dsh-adapter/types.js'
import { KERNEL_HOST_SUPPORTED_CONTRACTS, KERNEL_TUI_DECISION_EVENT_NAMES } from '../kernel/contract-catalog.js'
import type { ContractCoordinate } from '../kernel/driver-types.js'
import type { CapabilityLifecycle } from '../kernel/lifecycle.js'
import { lifecycleFromDetection } from '../kernel/lifecycle.js'
import {
  hasCommandLiveProbe,
  hasMessageLiveProbe,
  hasStorageLiveProbe,
  runCommandLiveProbe,
  runMessageLiveProbe,
  runStorageLiveProbe,
} from '../kernel/host-probe-access.js'
import type { Detection, DetectionEvidence } from './detection.js'
import type { UpstreamDriver, UpstreamDriverMount } from './driver.js'

type HostContext = Pick<Context, 'get'>

interface ProbeResult {
  readonly evidence: readonly DetectionEvidence[]
  readonly missing: readonly string[]
  readonly liveFeatures?: readonly string[]
}

function serviceEvidence(id: string): DetectionEvidence {
  return { kind: 'service', id }
}

function methodEvidence(service: string, method: string): DetectionEvidence {
  return { kind: 'method', id: `${service}:${method}` }
}

function probeEvidence(id: string, detail: string): DetectionEvidence {
  return { kind: 'probe', id, detail }
}

function hasFunction(value: unknown, name: string): boolean {
  return typeof (value as Record<string, unknown> | null | undefined)?.[name] === 'function'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Structured detection for the complete host descriptor capability.
 *
 * Supported only when the host service is present, its descriptor methods are
 * present, AND a read-only `describe()` probe actually returns a valid build.
 */
export function detectHostDescriptorCapability(ctx: unknown): Detection {
  const host = (ctx as HostContext | undefined)?.get?.('tuiPluginHost')
  if (host === undefined) {
    return { state: 'unsupported', reason: 'tuiPluginHost service is not mounted' }
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiPluginHost')]
  const missing: string[] = []
  if (!hasFunction(host, 'hostDescriptor')) missing.push('hostDescriptor()')
  else evidence.push(methodEvidence('tuiPluginHost', 'hostDescriptor'))
  if (!hasFunction(host, 'describe')) missing.push('describe()')
  else evidence.push(methodEvidence('tuiPluginHost', 'describe'))
  if (missing.length > 0) {
    return { state: 'degraded', missing, evidence }
  }
  try {
    const build = (host as { describe(): { descriptor?: unknown } }).describe()
    if (build?.descriptor === undefined || typeof build.descriptor !== 'object') {
      return {
        state: 'degraded',
        missing: ['descriptor-build'],
        evidence: [...evidence, probeEvidence('describe()', 'method returned no descriptor object')],
      }
    }
    return {
      state: 'supported',
      evidence: [
        ...evidence,
        probeEvidence('describe()', 'read-only descriptor build probe succeeded'),
      ],
    }
  } catch (error) {
    return {
      state: 'degraded',
      missing: ['descriptor-build'],
      evidence: [
        ...evidence,
        probeEvidence('describe()', errorText(error)),
      ],
    }
  }
}

function contractServiceName(coordinate: ContractCoordinate): string {
  switch (coordinate.kind) {
    case 'Command': return 'commands'
    case 'LocalStorage': return 'tuiPluginStorage'
    case 'MessageObserver': return 'tuiMessageObserver'
    case 'DecisionEvents': return 'tuiPluginHost'
    default: return ''
  }
}

/** Read-only Command catalog probe. It verifies the host can enumerate the
 * effective command catalog without registering or executing anything, but
 * it does NOT verify a real command invocation. Because the v0.15 Command
 * protocol has no feature-granular support spec, this probe must not cross
 * the publication barrier: the contract remains staged/degraded until a real
 * execution probe exists. */
function probeCommand(service: unknown): ProbeResult {
  if (!hasFunction(service, 'list')) {
    return { evidence: [], missing: ['commands.list()'] }
  }
  try {
    const list = (service as { list(agent: unknown): readonly unknown[] }).list(undefined)
    if (!Array.isArray(list)) throw new Error('commands.list() did not return an array')
    return {
      evidence: [{ kind: 'method', id: 'commands.list(undefined)', detail: 'read-only command catalog probe; invocation is not verified' }],
      missing: ['commands.execute(undefined)'],
    }
  } catch (error) {
    return {
      evidence: [{ kind: 'method', id: 'commands.list(undefined)', detail: errorText(error) }],
      missing: ['commands.list()', 'commands.execute(undefined)'],
    }
  }
}

/** Storage capability probe. The only current `probeDiagnostic()` confirms the
 * runtime is mounted; it does not verify a real no-side-effect storage read or
 * write. Until such a probe exists, storage must remain staged/degraded and
 * must not be published as live. */
function probeStorage(service: unknown): ProbeResult {
  if (!hasFunction(service, 'probeDiagnostic')) {
    return { evidence: [], missing: ['tuiPluginStorage.probeDiagnostic()'] }
  }
  try {
    const result = (service as { probeDiagnostic(): { ok: true } }).probeDiagnostic()
    if (result?.ok !== true) throw new Error('storage probe did not acknowledge the mounted runtime')
    return {
      evidence: [{ kind: 'method', id: 'tuiPluginStorage.probeDiagnostic()', detail: 'mounted-runtime diagnostic only; no real storage I/O probe' }],
      missing: ['real-read-only-storage-probe'],
    }
  } catch (error) {
    return {
      evidence: [{ kind: 'method', id: 'tuiPluginStorage.probeDiagnostic()', detail: errorText(error) }],
      missing: ['real-read-only-storage-probe'],
    }
  }
}

/** Message observer capability probe. The only current `probeDiagnostic()`
 * confirms the mounted broker; it does not verify a real no-side-effect
 * subscription/delivery path. Until such a probe exists, the contract must
 * remain staged/degraded and must not be published as live. */
function probeMessageObserver(service: unknown): ProbeResult {
  if (!hasFunction(service, 'probeDiagnostic')) {
    return { evidence: [], missing: ['tuiMessageObserver.probeDiagnostic()'] }
  }
  try {
    const result = (service as { probeDiagnostic(): { ok: true } }).probeDiagnostic()
    if (result?.ok !== true) throw new Error('message observer probe did not acknowledge the mounted runtime')
    return {
      evidence: [{ kind: 'method', id: 'tuiMessageObserver.probeDiagnostic()', detail: 'mounted-runtime diagnostic only; no real observer I/O probe' }],
      missing: ['real-read-only-observer-probe'],
    }
  } catch (error) {
    return {
      evidence: [{ kind: 'method', id: 'tuiMessageObserver.probeDiagnostic()', detail: errorText(error) }],
      missing: ['real-read-only-observer-probe'],
    }
  }
}

/** DecisionEvents are enumerated through the host's installed decision guard
 * AND a real channel/dispatch topology probe. The host's probe returns event
 * names only when a real dispatch source exists; guard installation alone is
 * never enough. Only those returned names are treated as verified features. */
function probeDecisionEvents(service: unknown): ProbeResult {
  if (!hasFunction(service, 'probeDecisionEvents')) {
    return { evidence: [], missing: ['tuiPluginHost.probeDecisionEvents()'] }
  }
  // A real dispatch topology probe is only publication evidence when the
  // mediated subscription entry actually exists. If the method is missing,
  // keep the whole capability degraded and never publish DecisionEvents even
  // when a channel/probe is otherwise present.
  if (!hasFunction(service, 'subscribeDecision')) {
    return {
      evidence: [],
      missing: ['tuiPluginHost.subscribeDecision()'],
      liveFeatures: Object.freeze([]),
    }
  }
  try {
    const available = (service as { probeDecisionEvents(): readonly string[] }).probeDecisionEvents()
    if (!Array.isArray(available)) throw new Error('probeDecisionEvents() did not return an array')
    const verified = KERNEL_TUI_DECISION_EVENT_NAMES.filter(event => available.includes(event))
    const missing = KERNEL_TUI_DECISION_EVENT_NAMES
      .filter(event => !verified.includes(event))
      .map(event => `decision-event:${event}`)
    return {
      evidence: [
        probeEvidence('tuiPluginHost.probeDecisionEvents()', `verified ${verified.length}/${KERNEL_TUI_DECISION_EVENT_NAMES.length} decision events`),
      ],
      missing,
      liveFeatures: Object.freeze([...verified].sort()),
    }
  } catch (error) {
    return {
      evidence: [probeEvidence('tuiPluginHost.probeDecisionEvents()', errorText(error))],
      missing: ['tuiPluginHost.probeDecisionEvents()'],
      liveFeatures: Object.freeze([]),
    }
  }
}

/** Reversible Command live probe.
 *
 * This runs only outside passive/replay production modes (the Kernel skips it),
 * and only on an isolated/real-but-cleanable context:
 * - register one unique no-op command,
 * - resolve it through find/list,
 * - execute it against an in-memory fake agent whose session is a local event
 *   collector (no durable DSH session log is touched),
 * - unregister in `finally`.
 *
 * Side-effect boundary: the temporary registration is in-memory and removed
 * before this function returns; the fake session never reaches DSH persistence.
 * The only observable transient is a commands/change notification from the
 * in-process registry while the probe is registered.
 */
async function probeCommandLive(service: unknown): Promise<ProbeResult> {
  if (!hasFunction(service, 'register') || !hasFunction(service, 'list') || !hasFunction(service, 'find')) {
    return { evidence: [], missing: ['commands.register()', 'commands.list()', 'commands.find()'] }
  }
  const name = `dsh_tui_live_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const definition = {
    name,
    description: 'dsh-tui adapter reversible live probe',
    handler: () => ({ kind: 'success' as const, text: 'ok' }),
  }
  let dispose: (() => void) | undefined
  let lifecycleAppends = 0
  try {
    dispose = (service as { register(definition: unknown): () => void }).register(definition)
    const found = (service as { find(agent: unknown, name: string): unknown }).find(undefined, name)
    if (found === undefined) throw new Error('temporary command was not resolvable through find()')
    const list = (service as { list(agent: unknown): readonly { name?: unknown }[] }).list(undefined)
    if (!Array.isArray(list) || !list.some(entry => entry?.name === name)) {
      throw new Error('temporary command was not visible through list()')
    }
    if (!hasFunction(service, 'execute')) {
      return { evidence: [], missing: ['commands.execute()'] }
    }
    const events: Array<[string, unknown]> = []
    const session = {
      append(type: string, data: unknown): boolean {
        events.push([type, data])
        return true
      },
    }
    const fakeAgent = { session } as never
    const COMMAND_PROBE_TIMEOUT_MS = 2_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const abortController = new AbortController()
    const executePromise = (service as {
      execute(agent: unknown, line: string, images: readonly unknown[], signal: AbortSignal): Promise<{ result?: { kind?: unknown } } | undefined>
    }).execute(fakeAgent, `/${name}`, [], abortController.signal)
    // A timeout/short-circuit must not leave a late rejection from execute as
    // an unhandled rejection, and must abort the underlying command execution
    // when the probe gives up.
    void executePromise.catch(() => undefined)
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          abortController.abort()
          reject(new Error(`command live probe timed out after ${COMMAND_PROBE_TIMEOUT_MS}ms`))
        },
        COMMAND_PROBE_TIMEOUT_MS,
      )
    })
    let result: { result?: { kind?: unknown } } | undefined
    try {
      result = await Promise.race([executePromise, timeout])
    } catch (error) {
      abortController.abort()
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (result === undefined || result.result?.kind !== 'success') {
      throw new Error('temporary command execute did not settle as success')
    }
    lifecycleAppends = events.length
    return {
      evidence: [
        probeEvidence(
          `commands.register+execute(${name})`,
          `reversible no-op command lifecycle: register -> find -> list -> execute (${lifecycleAppends} in-memory lifecycle appends); unregistered in finally`,
        ),
      ],
      missing: [],
    }
  } catch (error) {
    return {
      evidence: [probeEvidence(`commands.register+execute(${name})`, errorText(error))],
      missing: ['commands.reversible-live-probe'],
    }
  } finally {
    try {
      dispose?.()
    } catch {
      // Cleanup is best-effort; the in-memory registration is also owned by the
      // commands service context and will not survive a teardown.
    }
  }
}

/** Command live probe via the host-only probe accessor. */
async function probeCommandViaHost(service: unknown): Promise<ProbeResult> {
  if (!hasCommandLiveProbe(service)) {
    return { evidence: [], missing: ['tuiPluginHost.probeCommandReversible()'] }
  }
  try {
    const result = await runCommandLiveProbe(service)
    if (result?.ok !== true) throw new Error('command host reversible probe did not acknowledge success')
    return {
      evidence: [
        probeEvidence(
          `commands.register+execute(${result.name})`,
          `host-mediated reversible command lifecycle: register -> find -> list -> execute (${result.lifecycleAppends} in-memory lifecycle appends); unregistered in finally`,
        ),
      ],
      missing: [],
    }
  } catch (error) {
    return {
      evidence: [probeEvidence('commands.register+execute(host-probe)', errorText(error))],
      missing: ['commands.reversible-live-probe'],
    }
  }
}

/** Reversible LocalStorage live probe. It delegates to the storage service's
 * own host-internal `probeReversible()`, which writes one temporary namespace
 * file, reads it back, deletes it, and removes the file in a `finally`. */
async function probeStorageLive(service: unknown): Promise<ProbeResult> {
  if (!hasStorageLiveProbe(service)) {
    return { evidence: [], missing: ['tuiPluginStorage.probeReversible()'] }
  }
  try {
    const result = await runStorageLiveProbe(service)
    if (result?.ok !== true) throw new Error('storage reversible probe did not acknowledge success')
    return {
      evidence: [
        probeEvidence(
          'tuiPluginStorage.probeReversible()',
          `temporary namespace ${result.tempNamespace ?? '?'}: ${(result.operations ?? []).join(' -> ')}; cleanup enforced`,
        ),
      ],
      missing: [],
    }
  } catch (error) {
    return {
      evidence: [probeEvidence('tuiPluginStorage.probeReversible()', errorText(error))],
      missing: ['tuiPluginStorage.probeReversible()'],
    }
  }
}

/** Reversible MessageObserver live probe. It registers one temporary
 * subscription through the production broker, delivers one synthetic
 * envelope, verifies the listener, and unregisters it. */
async function probeMessageLive(service: unknown): Promise<ProbeResult> {
  if (!hasMessageLiveProbe(service)) {
    return { evidence: [], missing: ['tuiMessageObserver.probeReversible()'] }
  }
  try {
    const result = await runMessageLiveProbe(service)
    if (result?.ok !== true || result.after !== result.before || result.delivered !== 1) {
      throw new Error(`message observer reversible probe failed (before ${result.before}, delivered ${result.delivered}, after ${result.after})`)
    }
    return {
      evidence: [
        probeEvidence(
          'tuiMessageObserver.probeReversible()',
          `temporary subscription added, delivered one real envelope, and removed (${result.before} -> ${result.during} -> ${result.after})`,
        ),
      ],
      missing: [],
    }
  } catch (error) {
    return {
      evidence: [probeEvidence('tuiMessageObserver.probeReversible()', errorText(error))],
      missing: ['tuiMessageObserver.probeReversible()'],
    }
  }
}

function probeForCoordinate(service: unknown, coordinate: ContractCoordinate): ProbeResult {
  switch (coordinate.kind) {
    case 'Command': return probeCommand(service)
    case 'LocalStorage': return probeStorage(service)
    case 'MessageObserver': return probeMessageObserver(service)
    case 'DecisionEvents': return probeDecisionEvents(service)
    default: return { evidence: [], missing: [] }
  }
}

function contractDetection(ctx: HostContext, coordinate: ContractCoordinate): Detection {
  const serviceName = contractServiceName(coordinate)
  if (serviceName === '') return { state: 'unsupported', reason: `unknown coordinate ${coordinate.apiVersion}#${coordinate.kind}` }
  const service = ctx.get?.(serviceName)
  if (service === undefined) {
    return { state: 'unsupported', reason: `${serviceName} service is not mounted` }
  }
  const evidence: DetectionEvidence[] = [serviceEvidence(serviceName)]
  const missing: string[] = []
  switch (coordinate.kind) {
    case 'Command':
      if (!hasFunction(service, 'register')) missing.push('commands.register()')
      else evidence.push(methodEvidence(serviceName, 'register'))
      if (!hasFunction(service, 'list')) missing.push('commands.list()')
      else evidence.push(methodEvidence(serviceName, 'list'))
      if (!hasFunction(service, 'find')) missing.push('commands.find()')
      else evidence.push(methodEvidence(serviceName, 'find'))
      if (!hasFunction(service, 'execute')) missing.push('commands.execute()')
      else evidence.push(methodEvidence(serviceName, 'execute'))
      break
    case 'LocalStorage':
      if (!hasFunction(service, 'open')) missing.push('tuiPluginStorage.open()')
      else evidence.push(methodEvidence(serviceName, 'open'))
      if (hasStorageLiveProbe(service)) evidence.push(methodEvidence(serviceName, 'probeReversible'))
      break
    case 'MessageObserver':
      if (!hasFunction(service, 'subscribe')) missing.push('tuiMessageObserver.subscribe()')
      else evidence.push(methodEvidence(serviceName, 'subscribe'))
      if (hasMessageLiveProbe(service)) evidence.push(methodEvidence(serviceName, 'probeReversible'))
      break
    case 'DecisionEvents':
      if (!hasFunction(service, 'subscribeDecision')) missing.push('tuiPluginHost.subscribeDecision()')
      else evidence.push(methodEvidence(serviceName, 'subscribeDecision'))
      break
  }
  const probe = probeForCoordinate(service, coordinate)
  evidence.push(...probe.evidence)
  missing.push(...probe.missing)
  if (missing.length > 0) {
    return { state: 'degraded', missing, evidence }
  }
  return { state: 'supported', evidence }
}

/** Build DecisionEvents lifecycle with per-event live features. */
function decisionLifecycle(
  host: HostContext,
  coordinate: ContractCoordinate,
): CapabilityLifecycle | undefined {
  const key = `${coordinate.apiVersion}#${coordinate.kind}`
  const detection = contractDetection(host, coordinate)
  if (detection.state === 'unsupported') return undefined
  const probe = probeForCoordinate(host.get?.('tuiPluginHost'), coordinate)
  const missing = detection.state === 'degraded' ? detection.missing : []
  const criticalMissing = missing.some(item => item.includes('subscribeDecision'))
  const evidence = detection.evidence ?? []
  const hasSubscribeMethod = evidence.some(item =>
    item.kind === 'method' && item.id.includes('subscribeDecision'))
  const liveFeatures = !criticalMissing && hasSubscribeMethod
    ? (probe.liveFeatures ?? [])
    : []
  const lifecycle = lifecycleFromDetection(key, detection, coordinate)
  if (liveFeatures.length > 0) {
    return { ...lifecycle, liveFeatures: Object.freeze([...liveFeatures]) }
  }
  return lifecycle
}

/**
 * Build the per-contract lifecycle list from the live host services.
 *
 * All returned lifecycles are `staged`; the caller must call
 * `verifyAndPromote()` before using them as live publication evidence.
 * Service/method evidence alone cannot cross the verifier; a real probe is
 * required.
 */
export function buildHostCapabilityLifecycles(ctx: unknown): CapabilityLifecycle[] {
  const host = ctx as HostContext
  const lifecycles: CapabilityLifecycle[] = []
  for (const coordinate of KERNEL_HOST_SUPPORTED_CONTRACTS) {
    const key = `${coordinate.apiVersion}#${coordinate.kind}`
    if (coordinate.kind === 'DecisionEvents') {
      const lifecycle = decisionLifecycle(host, coordinate)
      if (lifecycle !== undefined) lifecycles.push(lifecycle)
      continue
    }
    const detection = contractDetection(host, coordinate)
    if (detection.state === 'unsupported') continue
    lifecycles.push(lifecycleFromDetection(key, detection, coordinate))
  }
  return lifecycles
}

/**
 * Run the full async live-verification path for the host descriptor slice.
 *
 * This is the production driver method behind `KernelRuntime.refresh()` in
 * legacy/new modes. It performs the real reversible probes and returns
 * capability lifecycles that already carry `probe` evidence. In passive/replay
 * production modes the Kernel must not call this on a real host context; the
 * replay harness may call it on an isolated mock context.
 */
export async function refreshHostCapabilityLifecycles(ctx: unknown): Promise<CapabilityLifecycle[]> {
  const host = ctx as HostContext
  const lifecycles: CapabilityLifecycle[] = []
  for (const coordinate of KERNEL_HOST_SUPPORTED_CONTRACTS) {
    const serviceName = contractServiceName(coordinate)
    if (serviceName === '') continue
    const service = host.get?.(serviceName)
    if (service === undefined) continue
    const key = `${coordinate.apiVersion}#${coordinate.kind}`
    if (coordinate.kind === 'DecisionEvents') {
      const lifecycle = decisionLifecycle(host, coordinate)
      if (lifecycle !== undefined) lifecycles.push(lifecycle)
      continue
    }
    const evidence: DetectionEvidence[] = [serviceEvidence(serviceName)]
    const missing: string[] = []
    switch (coordinate.kind) {
      case 'Command':
        if (!hasFunction(service, 'register')) missing.push('commands.register()')
        else evidence.push(methodEvidence(serviceName, 'register'))
        if (!hasFunction(service, 'list')) missing.push('commands.list()')
        else evidence.push(methodEvidence(serviceName, 'list'))
        if (!hasFunction(service, 'find')) missing.push('commands.find()')
        else evidence.push(methodEvidence(serviceName, 'find'))
        if (!hasFunction(service, 'execute')) missing.push('commands.execute()')
        else evidence.push(methodEvidence(serviceName, 'execute'))
        {
          const hostService = host.get?.('tuiPluginHost')
          const probe = hasCommandLiveProbe(hostService)
            ? await probeCommandViaHost(hostService)
            : await probeCommandLive(service)
          evidence.push(...probe.evidence)
          missing.push(...probe.missing)
        }
        break
      case 'LocalStorage':
        if (!hasFunction(service, 'open')) missing.push('tuiPluginStorage.open()')
        else evidence.push(methodEvidence(serviceName, 'open'))
        if (hasStorageLiveProbe(service)) evidence.push(methodEvidence(serviceName, 'probeReversible'))
        {
          const probe = await probeStorageLive(service)
          evidence.push(...probe.evidence)
          missing.push(...probe.missing)
        }
        break
      case 'MessageObserver':
        if (!hasFunction(service, 'subscribe')) missing.push('tuiMessageObserver.subscribe()')
        else evidence.push(methodEvidence(serviceName, 'subscribe'))
        if (hasMessageLiveProbe(service)) evidence.push(methodEvidence(serviceName, 'probeReversible'))
        {
          const probe = await probeMessageLive(service)
          evidence.push(...probe.evidence)
          missing.push(...probe.missing)
        }
        break
      default:
        break
    }
    const detection: Detection = missing.length > 0
      ? { state: 'degraded', missing, evidence }
      : { state: 'supported', evidence }
    lifecycles.push(lifecycleFromDetection(key, detection, coordinate))
  }
  return lifecycles
}

/** The driver object for future kernel composition. */
export const hostDescriptorDriver: UpstreamDriver = {
  id: 'dsh-tui-host-descriptor',
  upstreamFamily: 'dsh-tui',
  capability: 'host.descriptor',
  mountEffectClass: 'read-only',
  detect: detectHostDescriptorCapability,
  lifecycles: context => buildHostCapabilityLifecycles(context),
  verifyLive: context => refreshHostCapabilityLifecycles(context),
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    // This driver is currently a pure detection/translation driver. It mounts
    // no resources; the disposer is a no-op until a mounted port needs cleanup.
    void context
    return { disposer: () => undefined }
  },
}

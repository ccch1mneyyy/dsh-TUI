/**
 * The dsh-tui-plugin-host row: the plugin-interop anchor every later
 * contract surface hangs off (storage.local, messages.observe, effect
 * ledger — each lands as a sibling service mounted by THIS row's apply, so
 * the patch surface changed exactly once for the whole v0.15 alignment).
 *
 * What it provides on `ctx.tuiPluginHost`:
 *
 * - `generationId` — the runtime generation id (C-050), a fresh UUID per
 *   row activation; ledger records and the Host Descriptor stamp it so
 *   effects from different process generations can never be confused.
 * - `grants` — the unified 8-permission live GrantStore
 *   (`../adapter/standard/grants.js`).
 * - `hostDescriptor()` — the C-010 Host Descriptor
 *   (`../adapter/standard/descriptor.js`), built lazily and cached; drifted
 *   contracts are dropped fail-closed.
 * - `selfCheck()` — vendored registry + contract-profile violations
 *   (definition/profile drift, ten-point incompleteness, parity mismatches).
 * - `registerCommand(pluginCtx, definition)` — the MEDIATED command
 *   registration surface (C-041 attribution): stamps each command with the
 *   verified Component identity so the invoke checkpoint can enforce per-owner
 *   denies (./command-attribution.js). Direct `ctx.get('commands')`
 *   registrations stay unattributed — the documented C-070 boundary.
 *
 * Discipline notes:
 *
 * - #183: consumers NEVER get this service via inject — always
 *   `ctx.get('tuiPluginHost', false)` soft probing, with the skew warning in
 *   plugin.ts covering profile launches on a stale patch.
 * - The D-7 decision gate does NOT depend on this row: the extensions row
 *   and the channel each install it with their own GrantStore read, so a
 *   missing plugin-host row never relaxes interception gating.
 * - Boot-time self-check failures are logged once here (fail closed happens
 *   per-contract at descriptor build time; boot must not die on drifted
 *   vendored data).
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { parseManifest, projectManifest } from '../adapter/standard/protocols.js'
import type { HostDescriptor } from '../adapter/standard/types.js'
import { loadSpecData, verifyContractProfiles, verifyRegistry } from '../adapter/standard/registry.js'
import { createContractIndex, validatePlugin, negotiate } from '../adapter/standard/admission.js'
import { readGrantStore, type GrantStore } from '../adapter/standard/grants.js'
import { facadeFromLegacy } from '../adapter/kernel/legacy-facade.js'
import { createShadowGuardedHostFacade } from '../adapter/kernel/host-facade.js'
import { KernelRuntime } from '../adapter/kernel/kernel-runtime.js'
import { ADAPTER_KERNEL_SLICES } from '../adapter/kernel/slices/index.js'
import {
  assertCapabilityShadowPolicy,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import { hostDescriptorDriver } from '../adapter/upstream/host-descriptor-driver.js'
import { buildHostDescriptor, buildLegacyHostDescriptor, HOST_SUPPORTED_CONTRACTS, type HostDescriptorBuild } from '../adapter/standard/descriptor.js'
import { TuiEffectLedgerRuntime } from './effect-ledger.js'
import { TuiPluginStorageRuntime } from './plugin-storage.js'
import { TuiMessageObserverRuntime } from './message-observer.js'
import { stampCommandOwner, unstampCommandOwner } from './command-attribution.js'
import { hasCommandErrorCode, mapCommandError } from './command-errors.js'
import {
  installDecisionGuard,
  decisionHandlerMetadataOf,
  probeDecisionEventFeatures,
  registerDecisionHandler,
  withDecisionRegistration,
  type DecisionRegistrationOptions,
} from './decision-guard.js'
import {
  bindComponentIdentity,
  declaresCommand,
  requiresDecisionEvents,
  requiresContract,
  requireComponentIdentity,
  type VerifiedComponentIdentity,
} from './component-identity.js'
import { activationContext, activationFiber, assertCallerContext, bindCallerEffect, compositionRoot, concreteService, withHostRootCapability } from './host-access.js'
import { bindHostGrantStore } from './host-grants.js'
import { registerCommandLiveProbe } from '../adapter/kernel/host-probe-access.js'

/** Caller-safe grant facade exposed through `ctx.tuiPluginHost.grants`.
 * Unlike the internal full-parameter GrantStore, this facade derives the
 * principal from the calling activation and never accepts a caller-supplied
 * component/activation identity. The legacy `.corrupt` boolean is
 * deliberately not exposed here; use `selfCheck()` / `/doctor` or host-side
 * diagnostics for grant-file health. */
export interface HostGrantFacade {
  /** Evaluate a grant for the calling activation, not an arbitrary principal. */
  allows(pluginCtx: Context, permission: string, scope: string): boolean
  defaultOf(permission: string): 'allow' | 'deny'
  knownPermissions(): readonly string[]
  /**
   * File-change watch, used by grant-owned effects to release promptly.
   *
   * This is a subscribe-class adapter capability. The caller activation is
   * required both for shadow-policy enforcement and for lifecycle binding:
   * the returned watcher (and the underlying file poller's registration) is
   * owned by the calling Cordis activation, so unloading that activation
   * cannot leave the listener or the poller behind.
   */
  onChange(pluginCtx: Context, listener: () => void): (() => void) | undefined
}

/** Public, mediated plugin-host capability. Loader-only admission remains
 * behind getHostAdmission(), which is deliberately omitted from the package
 * export surface. */
export interface TuiPluginHost {
  readonly generationId: string
  readonly grants: HostGrantFacade
  hostDescriptor(): HostDescriptor
  describe(): HostDescriptorBuild
  subscribeDecision(
    pluginCtx: Context,
    event: string,
    listener: (payload: Record<string, unknown>) => unknown,
    options?: { scope?: string; order?: string },
  ): () => boolean
  registerCommand(pluginCtx: Context, definition: CommandDefinition): () => void
  registerCommand(pluginCtx: Context, contributionId: string, definition: CommandDefinition): () => void
  selfCheck(): string[]
  /** Read-only DecisionEvents feature probe (host/driver diagnostics). */
  probeDecisionEvents(): readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiPluginHost: TuiPluginHost
  }
}

/** `ctx.tuiPluginHost` — plugin-interop anchor (generation, grants, descriptor). */
export class TuiPluginHostRuntime extends Service implements TuiPluginHost {
  /** Runtime generation id (C-050): fresh per activation of this row. */
  get generationId(): string { return hostStateFor(this).generationId }
  /** Caller-safe grant facade; the internal full-parameter store stays
   * host-only (see getHostGrantStore in ./host-grants.js). */
  get grants(): HostGrantFacade {
    const raw = hostStateFor(this).grants
    const runtime = this
    return Object.freeze({
      allows(pluginCtx: Context, permission: string, scope: string): boolean {
        const host = hostContextFor(runtime)
        const caller = assertActivationContext(host, pluginCtx)
        const identity = requireComponentIdentity(caller)
        return raw.allows(
          { componentId: identity.componentId, activationId: identity.activationId },
          permission,
          scope,
        )
      },
      defaultOf: permission => raw.defaultOf(permission),
      knownPermissions: () => raw.knownPermissions(),
      onChange(pluginCtx: Context, listener: () => void): (() => void) | undefined {
        // Guard before any side effect: in passive/replay shadow this
        // subscribe-class watcher must be refused before the file poller is
        // started or the listener is retained.
        runtime.assertEffect('host.grants.subscribe')
        const host = hostContextFor(runtime)
        const caller = assertActivationContext(host, pluginCtx)
        requireComponentIdentity(caller)
        const stop = raw.onChange?.(listener)
        if (stop !== undefined) bindCallerEffect(caller, stop)
        return stop
      },
    })
  }

  /** Read-only DecisionEvents feature probe. Returns only the event names
   * whose guard is installed in this composition. */
  probeDecisionEvents(): readonly string[] {
    this.assertEffect('host.decision.probe')
    return probeDecisionEventFeatures(hostContextFor(this))
  }

  constructor(ctx: Context) {
    super(ctx, 'tuiPluginHost')
    const runtime = adapterRuntimeFor(ctx)
    const rawGrants = Object.freeze(readGrantStore(undefined, undefined, runtime))
    const state: HostState = {
      hostContext: compositionRoot(ctx),
      generationId: randomUUID(),
      grants: rawGrants,
      runtime,
      descriptorBuild: undefined,
      descriptorTopology: undefined,
      kernelRuntime: undefined,
      descriptorBuildInProgress: false,
      kernelStarted: false,
    }
    hostStates.set(this, state)
    registerCommandLiveProbe(this, () => this.#runReversibleCommandProbe())
    // Legacy mode is intentionally inert: the new KernelRuntime (and therefore
    // any real reversible probe / registration / temporary storage) is only
    // created for explicit non-legacy modes. New mode runs the real live
    // refresh; passive/replay production modes stay read-only/diagnostic.
    if (state.runtime.mode !== 'legacy') {
      const kernelRuntime = new KernelRuntime({
        context: state.hostContext,
        mode: state.runtime.mode,
        slices: state.runtime.slices,
        generationId: state.generationId,
        kernelSlices: ADAPTER_KERNEL_SLICES,
        drivers: [hostDescriptorDriver],
      })
      state.kernelRuntime = kernelRuntime
      // Defer until after the apply() body has mounted storage/observer
      // siblings, so the live refresh observes the complete production
      // topology.
      setTimeout(() => this.startKernelRuntime(), 0)
    }
    bindHostGrantStore(concreteService(this), rawGrants)
    // The host row may be mounted without the extensions row or a channel;
    // decision registration must remain mediated in that degraded topology.
    installDecisionGuard(ctx, rawGrants)
    const violations = this.selfCheck()
    if (violations.length > 0) {
      ctx.logger.warn(
        `dsh-tui: vendored adapter registry failed self-check (${violations.length} violation(s)); ` +
        `affected contracts are dropped from the Host Descriptor fail-closed: ${violations.join(' | ')}`,
      )
    }
  }

  /** @internal Start the Kernel after the whole plugin-host row (including
   * sibling storage/observer services) is mounted. Called from `apply()`; not
   * part of the public plugin surface. */
  startKernelRuntime(): void {
    const state = hostStateFor(this)
    const kernelRuntime = state.kernelRuntime
    if (kernelRuntime === undefined || state.kernelStarted) return
    state.kernelStarted = true
    // The kernel refresh/mount runs in the host root capability, never in a
    // plugin activation. This lets reversible probes use the real commands
    // service (which may register root-scoped effects during execution)
    // without being denied by the plugin/root boundary.
    withHostRootCapability(() => {
      if (state.runtime.mode !== 'passive-shadow' && state.runtime.mode !== 'replay-shadow') {
        void kernelRuntime.refresh()
          .then(() => {
            state.descriptorBuild = undefined
            state.descriptorTopology = undefined
          })
          .catch((error) => {
            this.ctx.logger.warn(`dsh-tui: kernel live refresh failed: ${error instanceof Error ? error.message : String(error)}`)
            state.descriptorBuild = undefined
            state.descriptorTopology = undefined
          })
      }
      // Production mount/dispose closure: mount the kernel drivers now and
      // dispose them when the plugin-host service's owning fiber unloads.
      void kernelRuntime.mount().catch((error) => {
        this.ctx.logger.warn(`dsh-tui: kernel driver mount failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      this.ctx.effect(() => () => {
        kernelRuntime.dispose()
        const current = hostStateFor(this)
        if (current.kernelRuntime === kernelRuntime) current.kernelRuntime = undefined
      })
    })
  }

  private assertEffect(capability: string): void {
    const runtime = hostStateFor(this).runtime
    assertCapabilityShadowPolicy(capability, runtime.mode, runtime.slices)
  }

  /**
   * The C-010 Host Descriptor, built lazily and cached while the
   * runtime-dependent commands capability remains unchanged.
   */
  hostDescriptor(): HostDescriptor {
    this.assertEffect('host.descriptor')
    return this.build().descriptor
  }

  /** The full build result (descriptor + dropped coordinates + warnings). */
  describe(): HostDescriptorBuild {
    this.assertEffect('host.descriptor')
    return this.build()
  }

  private build(): HostDescriptorBuild {
    const state = hostStateFor(this)
    if (state.descriptorBuildInProgress) {
      // Reentrant read from kernel detect/driver.detect(); return a
      // fail-closed but schema-valid build to break the cycle.
      return state.descriptorBuild ?? buildHostDescriptor({ generationId: state.generationId })
    }
    state.descriptorBuildInProgress = true
    try {
      return this.buildUnsafe()
    } finally {
      state.descriptorBuildInProgress = false
    }
  }

  private buildUnsafe(): HostDescriptorBuild {
    const state = hostStateFor(this)
    const host = state.hostContext
    const kernel = state.kernelRuntime
    if (kernel !== undefined && state.kernelStarted && kernel.isRefreshCompleted()) {
      // Always refresh the sync topology first; the Kernel preserves already
      // live capabilities as long as their critical method evidence remains,
      // so this does not regress a completed live refresh back to staged while
      // still picking up dynamic mounts/markers (e.g. DecisionEvents).
      kernel.detect()
      const build = kernel.descriptorBuild()
      if (host.get('commands') === undefined) {
        host.logger.warn(
          'dsh-tui: host descriptor: commands.dsh/v1alpha1#Command excluded — the commands service is not mounted on this context',
        )
      }
      if (host.get('tuiPluginStorage') === undefined) {
        host.logger.warn(
          'dsh-tui: host descriptor: storage.dsh/v1alpha1#LocalStorage excluded — the tuiPluginStorage service is not mounted on this context',
        )
      }
      if (host.get('tuiMessageObserver') === undefined) {
        host.logger.warn(
          'dsh-tui: host descriptor: messages.dsh/v1alpha1#MessageObserver excluded — the tuiMessageObserver service is not mounted on this context',
        )
      }
      for (const warning of build.warnings) {
        host.logger.warn(`dsh-tui: host descriptor: ${warning}`)
      }
      return build
    }
    // Only an explicitly legacy composition may publish mounted-service
    // compatibility claims. Shadow, pending, failed and disposed Kernels have
    // no completed live evidence and must never fall through to that path.
    if (state.runtime.mode !== 'legacy') {
      return buildHostDescriptor({ generationId: state.generationId })
    }
    // This is the explicit legacy-compatibility path: the old mounted-service
    // topology is declared with `buildLegacyHostDescriptor`, which is separate
    // from the live-only new-Kernel descriptor and does not run any reversible
    // probe or load the new Kernel.
    const commandsMounted = host.get('commands') !== undefined
    const storageMounted = host.get('tuiPluginStorage') !== undefined
    const observerMounted = host.get('tuiMessageObserver') !== undefined
    const decisionEventsMounted = probeDecisionEventFeatures(host).length > 0
    const topology = `${Number(commandsMounted)}:${Number(storageMounted)}:${Number(observerMounted)}:${Number(decisionEventsMounted)}`
    if (state.descriptorBuild === undefined || state.descriptorTopology !== topology) {
      const supported = HOST_SUPPORTED_CONTRACTS.filter(contract => {
        if (contract.kind === 'Command') return commandsMounted
        if (contract.kind === 'LocalStorage') return storageMounted
        if (contract.kind === 'MessageObserver') return observerMounted
        if (contract.kind === 'DecisionEvents') return decisionEventsMounted
        return false
      })
      state.descriptorBuild = buildLegacyHostDescriptor({
        generationId: state.generationId,
        headless: false,
        supported,
        decisionFeatures: probeDecisionEventFeatures(host),
      })
      state.descriptorTopology = topology
      for (const warning of state.descriptorBuild.warnings) {
        host.logger.warn(`dsh-tui: host descriptor: ${warning}`)
      }
    }
    if (host.get('commands') === undefined) {
      host.logger.warn('dsh-tui: host descriptor: commands.dsh/v1alpha1#Command excluded — the commands service is not mounted on this context')
    }
    if (host.get('tuiPluginStorage') === undefined) {
      host.logger.warn('dsh-tui: host descriptor: storage.dsh/v1alpha1#LocalStorage excluded — the tuiPluginStorage service is not mounted on this context')
    }
    if (host.get('tuiMessageObserver') === undefined) {
      host.logger.warn('dsh-tui: host descriptor: messages.dsh/v1alpha1#MessageObserver excluded — the tuiMessageObserver service is not mounted on this context')
    }
    return state.descriptorBuild
  }

  /**
   * Parse, project, validate, negotiate, and bind one activation's Component
   * identity before any mediated runtime capability can be used.
   */
  admit(
    pluginCtx: Context,
    source: string,
    options: { source?: string } = {},
  ): VerifiedComponentIdentity {
    // Admission binds an untrusted manifest to a privileged activation.  A
    // plugin-facing service proxy must not be able to choose another
    // component's id and inherit its grants, so the loader uses the
    // host-only accessor below instead of this public compatibility method.
    void pluginCtx
    void source
    void options
    throw new Error(
      'dsh-tui: admission is host-owned; the loader must use its admission capability',
    )
  }

  /** @internal Host loader entry; the unexported production token prevents
   * proxy calls. The test token is only reachable from the test-only adapter
   * helper, never from the package's production admission accessor. */
  admitInternal(
    pluginCtx: Context,
    source: string,
    options: { source?: string; activationId?: string } = {},
    token?: symbol,
  ): VerifiedComponentIdentity {
    if (token !== HOST_ADMISSION_TOKEN && token !== HOST_ADMISSION_TEST_TOKEN) {
      throw new Error('dsh-tui: admission capability is host-owned')
    }
    this.assertEffect('host.admission')
    const host = hostContextFor(this)
    const caller = assertActivationContext(host, pluginCtx)
    const callerFiber = activationFiber(caller)
    if (callerFiber === undefined) {
      throw new Error('dsh-tui: admission requires an owning Cordis activation fiber')
    }
    const manifest = parseManifest(source, { source: options.source })
    // The host (not the caller) owns the activation instance identity.
    // Production admission derives a stable opaque id from the Cordis
    // activation fiber. The explicit test token is the only path that can
    // supply a deterministic id, and it is never exported from the package
    // production surface.
    const activationId = token === HOST_ADMISSION_TEST_TOKEN
      && typeof options.activationId === 'string'
      ? options.activationId
      : issueActivationId(callerFiber)
    const data = loadSpecData()
    if (data === undefined) throw new Error('dsh-tui: admission profile is unavailable')
    const specViolations = [...verifyRegistry(data), ...verifyContractProfiles(data)]
    if (specViolations.length > 0) {
      throw new Error(`dsh-tui: admission profile self-check failed: ${specViolations.join(' | ')}`)
    }
    const index = createContractIndex(data.registry, data.permissions)
    validatePlugin(index, manifest)
    const projection = projectManifest(manifest)
    const grants = manifest.permissions
      .map(request => ({
        name: request.name,
        scope: request.scope,
        granted: hostStateFor(this).grants.allows(
          { componentId: manifest.id, activationId },
          request.name,
          request.scope,
        ),
      }))
    // Admission and public publication use the same descriptor used by the
    // active runtime path. In new/non-legacy modes that is the live-only
    // Kernel descriptor; in the default legacy mode it is the explicit
    // legacy-compatibility mounted-service descriptor, so existing plugins
    // required against Command/LocalStorage/MessageObserver are not rejected
    // simply because the default mode does not start the new Kernel.
    const state = hostStateFor(this)
    // Only use the Kernel descriptor after the Kernel has actually started
    // and completed its initial live refresh. Before that point the Kernel's
    // descriptor is intentionally empty (lifecycle probes have not run yet);
    // using it would falsely reject plugins that require Command/
    // LocalStorage/MessageObserver. Fall back to the legacy mounted-service
    // descriptor until the first refresh has completed.
    const kernelReady = state.kernelRuntime !== undefined
      && state.kernelStarted
      && state.kernelRuntime.isRefreshCompleted()
    const admissionHost = kernelReady
      ? state.kernelRuntime!.descriptorBuild().descriptor
      : this.build().descriptor
    const decision = negotiate(index, manifest, admissionHost, grants)
    if (decision.decision !== 'compatible' && decision.decision !== 'compatible_degraded') {
      const missing = 'missingRequired' in decision && decision.missingRequired !== undefined
        ? ` (${decision.missingRequired.join(', ')})`
        : ''
      throw new Error(`dsh-tui: Component ${manifest.id} admission ${decision.decision}: ${'reasonCode' in decision ? decision.reasonCode : 'incompatible'}${missing}`)
    }
    return bindComponentIdentity(caller, manifest, projection, activationId)
  }

  /**
   * Host-mediated DecisionEvents activation surface.  A plugin cannot use a
   * raw `ctx.on` for these points: the verified Component identity, static
   * requirement, scope and current grant are all checked before insertion in
   * the registry.  The returned disposer is idempotent and is also owned by
   * the activation so deactivation cannot leave an effect behind.
   */
  subscribeDecision(
    pluginCtx: Context,
    event: string,
    listener: (payload: Record<string, unknown>) => unknown,
    options: DecisionRegistrationOptions = {},
  ): () => boolean {
    this.assertEffect('host.decision.subscribe')
    const host = hostContextFor(this)
    const caller = assertActivationContext(host, pluginCtx)
    assertCallerContext(this.ctx, caller, 'DecisionEvents.subscribe', this)
    const identity = requireComponentIdentity(caller)
    if (!requiresDecisionEvents(identity)) {
      throw new Error(
        `dsh-tui: Component "${identity.componentId}" must require tui.dsh/v1alpha1#DecisionEvents before subscribing`,
      )
    }
    const previousMetadata = decisionHandlerMetadataOf(listener)
    const release = withDecisionRegistration(caller, () => registerDecisionHandler(
      caller,
      identity,
      event,
      listener,
      options,
      () => {
        host.get('tuiEffectLedger')?.record(
          { operation: 'release', resource: { kind: 'decision-handler', id: `${identity.componentId}:${event}` }, result: 'applied' },
          caller,
        )
      },
    ))
    // A missing live grant is represented by a no-op disposer rather than an
    // exception. Do not write a successful bind record for that path; the
    // ledger must describe effects that actually entered the registry.
    const metadata = decisionHandlerMetadataOf(listener)
    const registered = metadata !== previousMetadata
      && metadata?.componentId === identity.componentId
      && metadata.activationId === identity.activationId
      && metadata.event === event
    if (!registered) {
      host.get('tuiEffectLedger')?.record(
        {
          operation: 'bind',
          resource: { kind: 'permission', id: `${event}` },
          result: 'failed',
          errorCode: 'PERMISSION_NOT_GRANTED',
        },
        caller,
      )
      return () => false
    }
    host.get('tuiEffectLedger')?.record(
      { operation: 'bind', resource: { kind: 'decision-handler', id: `${identity.componentId}:${event}` }, result: 'applied' },
      caller,
    )
    return release
  }

  /**
   * Mediated command registration (C-041 attribution): registers through
   * the commands service and, on success, stamps the command's owner as
   * the verified Component identity — so the channel's invoke checkpoint
   * can enforce per-owner `commands.invoke` denies on the host-mediated
   * path. Mirrors the honest-identity pattern of storage.open /
   * messages.observe subscribe: there is no parameter to impersonate
   * another plugin. The returned disposer unregisters AND lifts the stamp
   * (idempotent). Duplicates throw the mapped DUPLICATE_CONTRIBUTION_ID
   * error; a missing commands service fails loud (the descriptor's
   * Command contract is excluded in that situation anyway).
  */
  registerCommand(pluginCtx: Context, definition: CommandDefinition): () => void
  registerCommand(pluginCtx: Context, contributionId: string, definition: CommandDefinition): () => void
  registerCommand(
    pluginCtx: Context,
    contributionOrDefinition: string | CommandDefinition,
    explicitDefinition?: CommandDefinition,
  ): () => void {
    this.assertEffect('host.commands.register')
    const host = hostContextFor(this)
    const caller = assertActivationContext(host, pluginCtx)
    assertCallerContext(this.ctx, caller, 'commands.register', this)
    // Resolve through the registrant context so dsh-commands attaches the
    // registration to that agent's scoped layer rather than the host-global
    // layer. Its traceable service proxy carries this context into register().
    const commands = caller.get('commands')
    if (commands === undefined) {
      throw new Error('dsh-tui: registerCommand unavailable — the commands service is not mounted on this context')
    }
    const identity = requireComponentIdentity(caller)
    if (!requiresContract(identity, 'commands.dsh/v1alpha1', 'Command')) {
      throw new Error(
        `dsh-tui: Component "${identity.componentId}" must require commands.dsh/v1alpha1#Command before registering commands`,
      )
    }
    const definition = typeof contributionOrDefinition === 'string' ? explicitDefinition : contributionOrDefinition
    if (definition === undefined) throw new TypeError('dsh-tui: registerCommand requires a command definition')
    const name = typeof definition.name === 'string' ? definition.name : 'unknown'
    const inferred = identity.manifest.contributes.commands.filter(command =>
      command.id === name || command.id.endsWith(`.${name}`))
    const contributionId = typeof contributionOrDefinition === 'string'
      ? contributionOrDefinition
      : inferred.length === 1 ? inferred[0]!.id : ''
    if (contributionId === '' || !declaresCommand(identity, contributionId)) {
      throw new TypeError(`dsh-tui: command "${name}" is not bound to a declared contribution id`)
    }
    // dsh-commands normalizes into a fresh definition and intentionally drops
    // unknown fields. A per-registration handler wrapper survives that copy,
    // giving the invoke checkpoint a collision-free identity for the actual
    // resolved definition (including agent-scoped shadows).
    const handler: unknown = definition?.handler
    const attributedDefinition: CommandDefinition = typeof handler === 'function'
      ? {
          ...definition,
          handler: function (this: unknown, invocation) {
            return handler.call(this, invocation)
          },
        }
      : definition
    let dispose: () => void
    try {
      dispose = commands.register(attributedDefinition)
    } catch (error) {
      const mapped = mapCommandError(error)
      host.get('tuiEffectLedger')?.record(
        {
          operation: 'create',
          resource: { kind: 'command', id: contributionId },
          result: 'failed',
          errorCode: hasCommandErrorCode(mapped, 'DUPLICATE_CONTRIBUTION_ID') ? 'DUPLICATE_CONTRIBUTION_ID' : 'COMMAND_FAILED',
        },
        caller,
      )
      throw mapped
    }
    stampCommandOwner(host, attributedDefinition, identity, contributionId)
    host.get('tuiEffectLedger')?.record(
      { operation: 'create', resource: { kind: 'command', id: contributionId }, result: 'applied' },
      caller,
    )
    let released = false
    const release = () => {
      if (released) return
      released = true
      unstampCommandOwner(host, attributedDefinition, identity.activationId)
      host.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'command', id: contributionId }, result: 'applied' },
      caller,
      )
    }
    // commands.register() already belongs to pluginCtx and therefore removes
    // the definition on fiber teardown. Keep the attribution in that same
    // lifecycle even when the caller never invokes our returned wrapper.
    bindCallerEffect(caller, release)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      try {
        dispose()
      } finally {
        release()
      }
    }
  }

  /**
   * Host-internal reversible Command live probe.
   *
   * This is the production host-side probe used by the Kernel driver. It
   * registers a unique no-op command through the real dsh-commands service,
   * resolves it, executes it against an in-memory fake session, and
   * unregisters it in `finally`. It does not go through the public
   * plugin-facing `registerCommand()` (which requires a verified Component
   * activation), but it exercises the same contribution/invocation path that
   * production commands use.
   *
   * This is an ECMAScript private method. It is reachable only through the
   * host-only probe accessor registered in the constructor.
   */
  async #runReversibleCommandProbe(): Promise<{
    ok: true
    name: string
    lifecycleAppends: number
  }> {
    this.assertEffect('host.commands.liveProbe')
    const host = hostContextFor(this)
    const commands = host.get('commands')
    if (commands === undefined || typeof (commands as unknown as Record<string, unknown>).register !== 'function') {
      throw new Error('commands service is not mounted for reversible command probe')
    }
    const service = commands as {
      register(definition: unknown): () => void
      find(agent: unknown, name: string): unknown
      list(agent: unknown): readonly { name?: unknown }[]
      execute(
        agent: unknown,
        line: string,
        images: readonly unknown[],
        signal: AbortSignal,
      ): Promise<{ result?: { kind?: unknown } } | undefined>
    }
    const name = `dsh_tui_live_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const definition = {
      name,
      description: 'dsh-tui adapter reversible live probe',
      handler: () => ({ kind: 'success' as const, text: 'ok' }),
    }
    let dispose: (() => void) | undefined
    const events: Array<[string, unknown]> = []
    try {
      dispose = service.register(definition)
      if (service.find(undefined, name) === undefined) {
        throw new Error('temporary command was not resolvable through find()')
      }
      const list = service.list(undefined)
      if (!Array.isArray(list) || !list.some(entry => entry?.name === name)) {
        throw new Error('temporary command was not visible through list()')
      }
      const fakeAgent = {
        session: {
          append(type: string, data: unknown): boolean {
            events.push([type, data])
            return true
          },
        },
      } as never
      const COMMAND_PROBE_TIMEOUT_MS = 2_000
      let timer: ReturnType<typeof setTimeout> | undefined
      const abortController = new AbortController()
      const execute = Promise.resolve().then(() =>
        service.execute(fakeAgent, `/${name}`, [], abortController.signal))
      // A timeout or early rejection must not leave a late rejection from
      // execute as an unhandled rejection, and must abort the underlying
      // command execution when the probe gives up.
      void execute.catch(() => undefined)
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
        result = await Promise.race([execute, timeout])
      } catch (error) {
        abortController.abort()
        throw error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (result === undefined || result.result?.kind !== 'success') {
        throw new Error('temporary command execute did not settle as success')
      }
      return Object.freeze({ ok: true, name, lifecycleAppends: events.length })
    } finally {
      try {
        dispose?.()
      } catch {
        // Cleanup is best-effort; the commands service owns its registration.
      }
    }
  }

  /**
   * Vendored registry + contract-profile self-check (C-020 definition/profile
   * pins, C-040 ten-point completeness, coordinate/permission parity). Empty =
   * clean; violations are strings, never thrown.
   */
  selfCheck(): string[] {
    this.assertEffect('host.diagnostics')
    const data = loadSpecData()
    if (data === undefined) return ['vendored spec data unavailable (dsh-ecosystem-spec/)']
    return [...verifyRegistry(data), ...verifyContractProfiles(data)]
  }
}

const HOST_ADMISSION_TOKEN = Symbol('dsh-tui.host-admission')
const HOST_ADMISSION_TEST_TOKEN = Symbol('dsh-tui.host-admission-test')

interface HostState {
  readonly hostContext: Context
  readonly generationId: string
  readonly grants: GrantStore
  readonly runtime: AdapterRuntimeOptions
  descriptorBuild: HostDescriptorBuild | undefined
  descriptorTopology: string | undefined
  kernelRuntime: KernelRuntime | undefined
  descriptorBuildInProgress: boolean
  kernelStarted: boolean
}


/** Per-activation fiber -> host-issued opaque activation id (Cordis activation scope). */
const activationFiberIds = new WeakMap<object, string>()

function issueActivationId(fiber: object): string {
  let id = activationFiberIds.get(fiber)
  if (id === undefined) {
    id = randomUUID()
    activationFiberIds.set(fiber, id)
  }
  return id
}

const hostStates = new WeakMap<TuiPluginHostRuntime, HostState>()

function hostStateFor(runtime: TuiPluginHostRuntime): HostState {
  const state = hostStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiPluginHost host state is unavailable')
  return state
}

function hostContextFor(runtime: TuiPluginHostRuntime): Context {
  return hostStateFor(runtime).hostContext
}

/**
 * Loader-only admission capability.  It is intentionally omitted from the
 * package `plugin-host` export; tests and the in-process loader can obtain it
 * from this adapter module, while a plugin calling the public service proxy
 * receives a deterministic denial instead of being able to impersonate a
 * different manifest identity.
 */
export interface HostAdmission {
  admit(
    pluginCtx: Context,
    source: string,
    options?: { source?: string },
  ): VerifiedComponentIdentity
}

/** Test-only admission accessor. Kept separate from the production
 * `getHostAdmission` so the test-utils injection of a deterministic
 * activationId can never be reached by production host loaders. */
export interface HostAdmissionForTest extends HostAdmission {
  admit(
    pluginCtx: Context,
    source: string,
    options?: { source?: string; activationId?: string },
  ): VerifiedComponentIdentity
}

export function getHostAdmissionForTest(
  runtime: TuiPluginHost | TuiPluginHostRuntime | undefined,
): HostAdmissionForTest | undefined {
  if (runtime === undefined) return undefined
  try {
    const concrete = concreteService(runtime) as TuiPluginHostRuntime
    return {
      admit: (pluginCtx, source, options = {}) => concrete.admitInternal(pluginCtx, source, options, HOST_ADMISSION_TEST_TOKEN),
    }
  } catch {
    return undefined
  }
}

export function getHostAdmission(runtime: TuiPluginHost | TuiPluginHostRuntime | undefined): HostAdmission | undefined {
  if (runtime === undefined) return undefined
  try {
    const concrete = concreteService(runtime) as TuiPluginHostRuntime
    return {
      admit: (pluginCtx, source, options = {}) => concrete.admitInternal(pluginCtx, source, options, HOST_ADMISSION_TOKEN),
    }
  } catch {
    return undefined
  }
}

/**
 * Host-only accessor for the new Kernel HostFacade. Deliberately omitted from
 * the public plugin-host export: HostFacade is an internal composition entry,
 * not an external plugin API.
 *
 * @internal P2: the facade is now backed by the KernelRuntime's unified
 * evidence snapshot (driver detect + live verification), not by a legacy
 * describe() wrapper. It remains read-only and shadow-guarded.
 */
export function getHostFacade(runtime: TuiPluginHost | TuiPluginHostRuntime | undefined) {
  if (runtime === undefined) return undefined
  try {
    const concrete = concreteService(runtime) as TuiPluginHostRuntime
    const state = hostStateFor(concrete)
    if (state.kernelRuntime !== undefined) {
      return state.kernelRuntime.facade()
    }
    // Legacy fallback for bare/test compositions without a KernelRuntime.
    const legacyFacade = facadeFromLegacy({
      generationId: state.generationId,
      describe: () => concrete.describe(),
    })
    return createShadowGuardedHostFacade({ descriptor: legacyFacade.descriptor }, state.runtime.mode)
  } catch {
    return undefined
  }
}

/** A mediated capability must be bound to a live non-root activation in the
 * same Cordis composition as the host row. In particular, accepting
 * `ctx.root` would leave identity, commands, or handlers alive after the
 * plugin fiber unloads. */
function assertActivationContext(hostCtx: Context, pluginCtx: Context): Context {
  try {
    const root = compositionRoot(hostCtx)
    const caller = Context.is(pluginCtx) ? activationContext(pluginCtx) : undefined
    const rootFiber = activationFiber(root)
    const callerFiber = caller === undefined ? undefined : activationFiber(caller)
    if (caller === undefined
      || compositionRoot(caller) !== root
      || caller === root
      || callerFiber === undefined
      || callerFiber === rootFiber) {
      throw new Error('dsh-tui: mediated capability requires a non-root activation context from the host composition')
    }
    return caller
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('dsh-tui:')) throw error
    throw new Error('dsh-tui: mediated capability requires a live activation context')
  }
}

export const name = 'dsh-tui-plugin-host'

export function apply(ctx: Context): void {
  // The plugin-host service first — the contract surfaces mounted below
  // read its grant store (they fall back to a private read only when mounted
  // standalone, e.g. in tests).
  ctx.plugin(TuiPluginHostRuntime)
  // Effect ledger (C-060): mounted before the surfaces below so they can
  // soft-probe it at construction; generation comes from the host service.
  ctx.plugin(TuiEffectLedgerRuntime)
  // storage.local (C-040): per-plugin private persistence.
  ctx.plugin(TuiPluginStorageRuntime)
  // messages.observe (C-042): the grant-gated observation broker the
  // channel publishes mapped session events into.
  ctx.plugin(TuiMessageObserverRuntime)
  // All sibling services are mounted now; start the kernel live refresh /
  // driver mount so probes observe the complete production topology.
  const host = ctx.get('tuiPluginHost') as unknown as TuiPluginHostRuntime | undefined
  host?.startKernelRuntime()
}

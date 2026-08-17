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
 * - `grants` — the unified 8-permission live GrantStore (./grants.js).
 * - `hostDescriptor()` — the C-010 Host Descriptor (./host-descriptor.js),
 *   built lazily and cached; drifted contracts are dropped fail-closed.
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
import { parseManifest, projectManifest } from '@dsh-std/manifest'
import type { HostDescriptor } from '../plugin-spec/types.js'
import { loadSpecData, verifyContractProfiles, verifyRegistry } from '../plugin-spec/registry.js'
import { createContractIndex, validatePlugin } from '../plugin-spec/validate.js'
import { negotiate } from '../plugin-spec/negotiate.js'
import { readGrantStore, type GrantStore } from './grants.js'
import { buildHostDescriptor, HOST_SUPPORTED_CONTRACTS, type HostDescriptorBuild } from './host-descriptor.js'
import { TuiEffectLedgerRuntime } from './effect-ledger.js'
import { TuiPluginStorageRuntime } from './plugin-storage.js'
import { TuiMessageObserverRuntime } from './message-observer.js'
import { stampCommandOwner, unstampCommandOwner } from './command-attribution.js'
import { hasCommandErrorCode, mapCommandError } from './command-errors.js'
import {
  installDecisionGuard,
  decisionHandlerMetadataOf,
  registerDecisionHandler,
  withDecisionRegistration,
  type DecisionRegistrationOptions,
} from './decision-guard.js'
import {
  bindComponentIdentity,
  declaresCommand,
  requiresDecisionEvents,
  requireComponentIdentity,
  type VerifiedComponentIdentity,
} from './component-identity.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiPluginHost: TuiPluginHostRuntime
  }
}

/** `ctx.tuiPluginHost` — plugin-interop anchor (generation, grants, descriptor). */
export class TuiPluginHostRuntime extends Service {
  /** Runtime generation id (C-050): fresh per activation of this row. */
  readonly generationId = randomUUID()
  /** Live scoped grant store; every operation observes the current file. */
  readonly grants: GrantStore

  private descriptorBuild: HostDescriptorBuild | undefined
  private descriptorCommandsMounted: boolean | undefined

  constructor(ctx: Context) {
    super(ctx, 'tuiPluginHost')
    this.grants = readGrantStore()
    // The host row may be mounted without the extensions row or a channel;
    // decision registration must remain mediated in that degraded topology.
    installDecisionGuard(ctx, this.grants)
    const violations = this.selfCheck()
    if (violations.length > 0) {
      ctx.logger.warn(
        `dsh-tui: vendored plugin-spec registry failed self-check (${violations.length} violation(s)); ` +
        `affected contracts are dropped from the Host Descriptor fail-closed: ${violations.join(' | ')}`,
      )
    }
  }

  /**
   * The C-010 Host Descriptor, built lazily and cached while the
   * runtime-dependent commands capability remains unchanged.
   */
  hostDescriptor(): HostDescriptor {
    return this.build().descriptor
  }

  /** The full build result (descriptor + dropped coordinates + warnings). */
  describe(): HostDescriptorBuild {
    return this.build()
  }

  private build(): HostDescriptorBuild {
    // C-010 honesty: advertise Command only when the commands service is
    // actually mounted — a bare/embedded context without dsh-commands must
    // not negotiate `compatible` for a capability plugins will never get.
    // Probed on every descriptor request: the service can mount or unmount
    // after the first lazy build.
    const commandsMounted = this.ctx.get('commands') !== undefined
    if (this.descriptorBuild === undefined || this.descriptorCommandsMounted !== commandsMounted) {
      const supported = HOST_SUPPORTED_CONTRACTS.filter(contract => contract.kind !== 'Command' || commandsMounted)
      this.descriptorBuild = buildHostDescriptor({ generationId: this.generationId, supported })
      this.descriptorCommandsMounted = commandsMounted
      if (!commandsMounted) {
        this.ctx.logger.warn(
          'dsh-tui: host descriptor: commands.dsh/v1alpha1#Command excluded — the commands service is not mounted on this context',
        )
      }
      for (const warning of this.descriptorBuild.warnings) {
        this.ctx.logger.warn(`dsh-tui: host descriptor: ${warning}`)
      }
    }
    return this.descriptorBuild
  }

  /**
   * Parse, project, validate, negotiate, and bind one activation's Component
   * identity before any mediated runtime capability can be used.
   */
  admit(
    pluginCtx: Context,
    source: string,
    options: { source?: string; activationId?: string } = {},
  ): VerifiedComponentIdentity {
    const manifest = parseManifest(source, { source: options.source })
    // The host owns the activation instance identity. Embedders may provide a
    // pre-issued id when policy has an activation-scoped grant; otherwise a
    // fresh opaque id is generated once and bound to this Cordis activation.
    const activationId = options.activationId ?? randomUUID()
    const data = loadSpecData()
    if (data === undefined) throw new Error('dsh-tui: admission profile is unavailable')
    const index = createContractIndex(data.registry, data.permissions)
    validatePlugin(index, manifest)
    const projection = projectManifest(manifest)
    const grants = manifest.permissions
      .map(request => ({
        name: request.name,
        scope: request.scope,
        granted: this.grants.allows(
          { componentId: manifest.id, activationId },
          request.name,
          request.scope,
        ),
      }))
    const decision = negotiate(index, manifest, this.hostDescriptor(), grants)
    if (decision.decision !== 'compatible' && decision.decision !== 'compatible_degraded') {
      throw new Error(`dsh-tui: Component ${manifest.id} admission ${decision.decision}: ${'reasonCode' in decision ? decision.reasonCode : 'incompatible'}`)
    }
    return bindComponentIdentity(pluginCtx, manifest, projection, activationId)
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
    const identity = requireComponentIdentity(pluginCtx)
    if (!requiresDecisionEvents(identity)) {
      throw new Error(
        `dsh-tui: Component "${identity.componentId}" must require x-ccch1mneyyy.tui/v1alpha1#DecisionEvents before subscribing`,
      )
    }
    const previousMetadata = decisionHandlerMetadataOf(listener)
    const release = withDecisionRegistration(pluginCtx, () => registerDecisionHandler(
      pluginCtx,
      identity,
      event,
      listener,
      options,
      () => {
        this.ctx.get('tuiEffectLedger')?.record(
          { operation: 'release', resource: { kind: 'decision-handler', id: `${identity.componentId}:${event}` }, result: 'applied' },
          pluginCtx,
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
      this.ctx.get('tuiEffectLedger')?.record(
        {
          operation: 'bind',
          resource: { kind: 'permission', id: `${event}` },
          result: 'failed',
          errorCode: 'PERMISSION_NOT_GRANTED',
        },
        pluginCtx,
      )
      return () => false
    }
    this.ctx.get('tuiEffectLedger')?.record(
      { operation: 'bind', resource: { kind: 'decision-handler', id: `${identity.componentId}:${event}` }, result: 'applied' },
      pluginCtx,
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
    // Resolve through the registrant context so dsh-commands attaches the
    // registration to that agent's scoped layer rather than the host-global
    // layer. Its traceable service proxy carries this context into register().
    const commands = pluginCtx.get('commands')
    if (commands === undefined) {
      throw new Error('dsh-tui: registerCommand unavailable — the commands service is not mounted on this context')
    }
    const identity = requireComponentIdentity(pluginCtx)
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
      this.ctx.get('tuiEffectLedger')?.record(
        {
          operation: 'create',
          resource: { kind: 'command', id: contributionId },
          result: 'failed',
          errorCode: hasCommandErrorCode(mapped, 'DUPLICATE_CONTRIBUTION_ID') ? 'DUPLICATE_CONTRIBUTION_ID' : 'COMMAND_FAILED',
        },
        pluginCtx,
      )
      throw mapped
    }
    stampCommandOwner(this.ctx, attributedDefinition, identity, contributionId)
    this.ctx.get('tuiEffectLedger')?.record(
      { operation: 'create', resource: { kind: 'command', id: contributionId }, result: 'applied' },
      pluginCtx,
    )
    let released = false
    const release = () => {
      if (released) return
      released = true
      unstampCommandOwner(this.ctx, attributedDefinition, identity.activationId)
      this.ctx.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'command', id: contributionId }, result: 'applied' },
        pluginCtx,
      )
    }
    // commands.register() already belongs to pluginCtx and therefore removes
    // the definition on fiber teardown. Keep the attribution in that same
    // lifecycle even when the caller never invokes our returned wrapper.
    try {
      pluginCtx.effect(() => release)
    } catch {
      // Degraded contexts retain the wrapper-only cleanup path below.
    }
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
   * Vendored registry + contract-profile self-check (C-020 definition/profile
   * pins, C-040 ten-point completeness, coordinate/permission parity). Empty =
   * clean; violations are strings, never thrown.
   */
  selfCheck(): string[] {
    const data = loadSpecData()
    if (data === undefined) return ['vendored spec data unavailable (ecosystem-spec/)']
    return [...verifyRegistry(data), ...verifyContractProfiles(data)]
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
}

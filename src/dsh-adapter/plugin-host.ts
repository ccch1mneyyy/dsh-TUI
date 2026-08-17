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
 * - `grants` — the unified 8-permission GrantStore (./grants.js), read once
 *   from `~/.dsh-tui/extension-grants.json`.
 * - `hostDescriptor()` — the C-010 Host Descriptor (./host-descriptor.js),
 *   built lazily and cached; drifted contracts are dropped fail-closed.
 * - `selfCheck()` — vendored registry + contract-profile violations
 *   (schemaHash drift, ten-point incompleteness, parity mismatches).
 * - `registerCommand(pluginCtx, definition)` — the MEDIATED command
 *   registration surface (C-041 attribution): stamps each command with the
 *   caller's fiber.name so the invoke checkpoint can enforce per-owner
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
import type { HostDescriptor } from '../plugin-spec/types.js'
import { loadSpecData, verifyContractProfiles, verifyRegistry } from '../plugin-spec/registry.js'
import { readGrantStore, type GrantStore } from './grants.js'
import { buildHostDescriptor, HOST_SUPPORTED_CONTRACTS, type HostDescriptorBuild } from './host-descriptor.js'
import { TuiEffectLedgerRuntime } from './effect-ledger.js'
import { TuiPluginStorageRuntime } from './plugin-storage.js'
import { TuiMessageObserverRuntime } from './message-observer.js'
import { fiberNameOf, stampCommandOwner, unstampCommandOwner } from './command-attribution.js'
import { hasCommandErrorCode, mapCommandError } from './command-errors.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiPluginHost: TuiPluginHostRuntime
  }
}

/** `ctx.tuiPluginHost` — plugin-interop anchor (generation, grants, descriptor). */
export class TuiPluginHostRuntime extends Service {
  /** Runtime generation id (C-050): fresh per activation of this row. */
  readonly generationId = randomUUID()
  /** The unified grant store, read once at mount (revocation = restart). */
  readonly grants: GrantStore

  private descriptorBuild: HostDescriptorBuild | undefined

  constructor(ctx: Context) {
    super(ctx, 'tuiPluginHost')
    this.grants = readGrantStore()
    const violations = this.selfCheck()
    if (violations.length > 0) {
      ctx.logger.warn(
        `dsh-tui: vendored plugin-spec registry failed self-check (${violations.length} violation(s)); ` +
        `affected contracts are dropped from the Host Descriptor fail-closed: ${violations.join(' | ')}`,
      )
    }
  }

  /**
   * The C-010 Host Descriptor, built lazily and cached (the vendored files
   * are read-only at runtime, so one build per generation is exact).
   */
  hostDescriptor(): HostDescriptor {
    return this.build().descriptor
  }

  /** The full build result (descriptor + dropped coordinates + warnings). */
  describe(): HostDescriptorBuild {
    return this.build()
  }

  private build(): HostDescriptorBuild {
    if (this.descriptorBuild === undefined) {
      // C-010 honesty: advertise Command only when the commands service is
      // actually mounted — a bare/embedded context without dsh-commands must
      // not negotiate `compatible` for a capability plugins will never get.
      // Probed here (first build is lazy), not in the constructor: sibling
      // services mounted later by the same apply() are invisible to
      // constructors (cordis).
      const commandsMounted = this.ctx.get('commands') !== undefined
      const supported = HOST_SUPPORTED_CONTRACTS.filter(contract => contract.kind !== 'Command' || commandsMounted)
      this.descriptorBuild = buildHostDescriptor({ generationId: this.generationId, supported })
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
   * Mediated command registration (C-041 attribution): registers through
   * the commands service and, on success, stamps the command's owner as
   * the PASSED context's fiber.name — so the channel's invoke checkpoint
   * can enforce per-owner `commands.invoke` denies on the host-mediated
   * path. Mirrors the honest-identity pattern of storage.open /
   * messages.observe subscribe: there is no parameter to impersonate
   * another plugin. The returned disposer unregisters AND lifts the stamp
   * (idempotent). Duplicates throw the mapped DUPLICATE_CONTRIBUTION_ID
   * error; a missing commands service fails loud (the descriptor's
   * Command contract is excluded in that situation anyway).
   */
  registerCommand(pluginCtx: Context, definition: CommandDefinition): () => void {
    const commands = this.ctx.get('commands')
    if (commands === undefined) {
      throw new Error('dsh-tui: registerCommand unavailable — the commands service is not mounted on this context')
    }
    const owner = fiberNameOf(pluginCtx)
    const name = typeof definition?.name === 'string' ? definition.name : 'unknown'
    let dispose: () => void
    try {
      dispose = commands.register(definition)
    } catch (error) {
      const mapped = mapCommandError(error)
      this.ctx.get('tuiEffectLedger')?.record(
        {
          operation: 'create',
          resource: { kind: 'command', id: name },
          result: 'failed',
          errorCode: hasCommandErrorCode(mapped, 'DUPLICATE_CONTRIBUTION_ID') ? 'DUPLICATE_CONTRIBUTION_ID' : 'COMMAND_FAILED',
        },
        pluginCtx,
      )
      throw mapped
    }
    stampCommandOwner(this.ctx, name, owner)
    this.ctx.get('tuiEffectLedger')?.record(
      { operation: 'create', resource: { kind: 'command', id: name }, result: 'applied' },
      pluginCtx,
    )
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      dispose()
      unstampCommandOwner(this.ctx, name, owner)
      this.ctx.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'command', id: name }, result: 'applied' },
        pluginCtx,
      )
    }
  }

  /**
   * Vendored registry + contract-profile self-check (C-020 schemaHash pins,
   * C-040 ten-point completeness, coordinate/permission parity). Empty =
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

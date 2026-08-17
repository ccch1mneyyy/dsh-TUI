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
import type { HostDescriptor } from '../plugin-spec/types.js'
import { loadSpecData, verifyContractProfiles, verifyRegistry } from '../plugin-spec/registry.js'
import { readGrantStore, type GrantStore } from './grants.js'
import { buildHostDescriptor, type HostDescriptorBuild } from './host-descriptor.js'

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
      this.descriptorBuild = buildHostDescriptor({ generationId: this.generationId })
      for (const warning of this.descriptorBuild.warnings) {
        this.ctx.logger.warn(`dsh-tui: host descriptor: ${warning}`)
      }
    }
    return this.descriptorBuild
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
  ctx.plugin(TuiPluginHostRuntime)
}

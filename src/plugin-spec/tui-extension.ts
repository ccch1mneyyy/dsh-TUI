/**
 * TUI host-extension admission overlay (the P2-11 fix): the vendored
 * community registry/schemas cover the CROSS-host core only — the dsh-TUI
 * decision events (`tui/input`, `tui/rewind-prompt`, `tui/rewind-done`,
 * `tui/session-switch`, `tui/session-switched`, `tui/compact`) and their
 * four `session.*.intercept` permissions are HOST-LOCAL extensions. The
 * vendored permission registry already carries the eight permission names
 * (grants answer for them), but:
 *
 * - `dsh-plugin.schema.json`'s permission-name enum lists only the four
 *   core permissions → a manifest declaring an intercept permission fails
 *   the schema stage;
 * - `registry-0.15.json` has no `tui/*` event entries → a manifest
 *   subscribing to a decision event fails semantic validation
 *   ("unknown subscription reference");
 * - the Host Descriptor advertises no contract carrying the intercept
 *   permissions → negotiation would answer waiting_authorization even for
 *   a granted plugin (host-declared is a precondition there).
 *
 * The overlay closes exactly those three gaps, in memory, for the
 * /plugins admission pipeline ONLY: it is never persisted, never shipped
 * into the vendored data, and the base pipeline always runs first — the
 * extension is tried only after a base-stage failure, and the report says
 * when the verdict relied on it.
 *
 * Honesty notes:
 *
 * - TUI entries carry `schema: ''` / `schemaHash: ''` — there is no
 *   vendored schema to pin. They never enter verifyRegistry (which walks
 *   the vendored file, not this overlay), and negotiation's
 *   hash-equality rule compares '' === '' for them.
 * - The extended Host Descriptor is a negotiation artifact; it does NOT
 *   round-trip the host-descriptor schema (schemaHash would fail its
 *   pattern) and is never used where that schema is enforced.
 */

import type { ContractRegistry, HostDescriptor, RegistryEntry } from './types.js'

/** The host-local apiVersion group for TUI decision/observe events. */
export const TUI_EXTENSION_API_VERSION = 'tui.dsh/v1alpha1'

/**
 * The six TUI events as registry entries. `name` is the flat subscription
 * name plugins use; `coordinates.kind` is the decision payload name from
 * docs/plugins.md. Decision events carry their intercept permission;
 * observe-class events (rewind-done, session-switched) carry none.
 */
export const TUI_EXTENSION_ENTRIES: readonly RegistryEntry[] = [
  {
    name: 'tui/input',
    coordinates: { apiVersion: TUI_EXTENSION_API_VERSION, kind: 'InputDecision' },
    kind: 'event',
    version: '0.1.0',
    schema: '',
    schemaHash: '',
    permissions: ['session.input.intercept'],
    requiredHostBehavior: [],
  },
  {
    name: 'tui/rewind-prompt',
    coordinates: { apiVersion: TUI_EXTENSION_API_VERSION, kind: 'RewindPromptDecision' },
    kind: 'event',
    version: '0.1.0',
    schema: '',
    schemaHash: '',
    permissions: ['session.rewind.intercept'],
    requiredHostBehavior: [],
  },
  {
    name: 'tui/rewind-done',
    coordinates: { apiVersion: TUI_EXTENSION_API_VERSION, kind: 'RewindDoneNotice' },
    kind: 'event',
    version: '0.1.0',
    schema: '',
    schemaHash: '',
    permissions: [],
    requiredHostBehavior: [],
  },
  {
    name: 'tui/session-switch',
    coordinates: { apiVersion: TUI_EXTENSION_API_VERSION, kind: 'SessionSwitchDecision' },
    kind: 'event',
    version: '0.1.0',
    schema: '',
    schemaHash: '',
    permissions: ['session.switch.intercept'],
    requiredHostBehavior: [],
  },
  {
    name: 'tui/session-switched',
    coordinates: { apiVersion: TUI_EXTENSION_API_VERSION, kind: 'SessionSwitchedNotice' },
    kind: 'event',
    version: '0.1.0',
    schema: '',
    schemaHash: '',
    permissions: [],
    requiredHostBehavior: [],
  },
  {
    name: 'tui/compact',
    coordinates: { apiVersion: TUI_EXTENSION_API_VERSION, kind: 'CompactDecision' },
    kind: 'event',
    version: '0.1.0',
    schema: '',
    schemaHash: '',
    permissions: ['session.compact.intercept'],
    requiredHostBehavior: [],
  },
]

/** The intercept permission names the overlay adds to the schema enum. */
export const TUI_EXTENSION_PERMISSION_NAMES: readonly string[] = [
  'session.input.intercept',
  'session.rewind.intercept',
  'session.switch.intercept',
  'session.compact.intercept',
]

/**
 * Clone the vendored dsh-plugin schema with the permission-name enum
 * extended by the four intercept names. Returns undefined when the enum
 * is not where the vendored schema keeps it (`$defs.permission.properties
 * .name.enum`) — the caller then skips the extension retry and reports the
 * base-stage error (never invent a schema we cannot verify).
 */
export function extendPluginSchemaForTui(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
  const nameSchema = (clone.$defs as Record<string, unknown> | undefined)
    ?.permission as Record<string, unknown> | undefined
  const nameProperty = (nameSchema?.properties as Record<string, unknown> | undefined)
    ?.name as Record<string, unknown> | undefined
  if (!Array.isArray(nameProperty?.enum)) return undefined
  const extended = new Set([...(nameProperty.enum as unknown[]), ...TUI_EXTENSION_PERMISSION_NAMES])
  nameProperty.enum = [...extended]
  return clone
}

/**
 * Clone the vendored registry with the six TUI event entries appended.
 * Idempotent BY NAME: a future vendored registry that natively carries a
 * `tui/*` entry wins and the overlay entry is skipped (no duplicates).
 */
export function extendRegistryForTui(registry: ContractRegistry): ContractRegistry {
  const known = new Set(registry.entries.map(entry => entry.name))
  const additions = TUI_EXTENSION_ENTRIES.filter(entry => !known.has(entry.name))
  if (additions.length === 0) return registry
  return { ...registry, entries: [...registry.entries, ...additions] }
}

/**
 * The negotiation-time Host Descriptor overlay: the six TUI event entries
 * advertised as host contracts so their intercept permissions become
 * host-declared (negotiation's grant satisfiability precondition).
 * schemaHash '' matches the overlay registry entries (see module doc).
 */
export function extendHostDescriptorForTui(descriptor: HostDescriptor): HostDescriptor {
  const known = new Set(descriptor.contracts.map(contract => `${contract.apiVersion}#${contract.kind}`))
  const additions = TUI_EXTENSION_ENTRIES
    .filter(entry => !known.has(`${entry.coordinates.apiVersion}#${entry.coordinates.kind}`))
    .map(entry => ({
      apiVersion: entry.coordinates.apiVersion,
      kind: entry.coordinates.kind,
      version: entry.version,
      schemaHash: entry.schemaHash,
      permissions: [...entry.permissions],
    }))
  if (additions.length === 0) return descriptor
  return { ...descriptor, contracts: [...descriptor.contracts, ...additions] }
}

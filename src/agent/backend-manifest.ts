/**
 * A backend's static description — the runtime form of the `manifest.ts` that
 * every `src/backends/<id>/` directory ships (roadmap Stage A / P0).
 *
 * It is **pure data**: the build-time index (`scripts/gen-backend-index.mjs`)
 * imports each manifest statically, so a manifest may import nothing at all
 * except types, plus the single allowlisted version constant inside its own
 * backend (the Claude SDK pin — see `scripts/verify-backend-registry.ts`).
 * The backend implementation stays behind the registry's lazy `load()`.
 *
 * This module sits in the neutral domain layer (`src/agent/**`) on purpose: the
 * host registry, the boundary gate and the UI all need these shapes, and none
 * of them may import a concrete backend.
 */
import type { BackendInstallRecipe } from './backend.js'

/**
 * How a backend is named in the kernel picker (`backend-registry` D2).
 *
 * `key` is the host vocabulary (`t(key)`) and is reserved for the backends that
 * ship inside this package (`inTree`): a plugin writing
 * `{ kind: 'key', key: 'kernel-label-dsh' }` would otherwise be able to claim a
 * first-party name, so `registerBackend()` rejects that combination outright.
 *
 * `literal` is external text: it is rendered as-is, **never** through `t()` and
 * never into the message catalog, and it is treated as untrusted input (width
 * truncation with the repo's terminal helpers, no template expansion).
 */
export type KernelLabel =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'literal'; readonly text: string }

/** One backend's static facts. See the P0 checklist §3 for the field rationale. */
export interface BackendManifest {
  readonly id: string
  /** Full name: picker rows (`KernelPicker`) — `key` for in-tree, `literal` for plugins. */
  readonly label: KernelLabel
  /** Short brand name (the launchpad corner plate, the handoff notices): never
   *  localized, and short enough for a narrow terminal (the full name is 40
   *  columns wide and would push the cwd plate off the bottom edge). */
  readonly shortLabel: string
  /** Product a version belongs to (`claude-code v2.1.0`); absent = bare version. */
  readonly product?: string
  /** Ships inside this package (dsh / claude / codex): the only source allowed
   *  to use `label.kind === 'key'` and a `native.<key>` channel. */
  readonly inTree: boolean
  /** Always selectable and not an `AgentBackend` at all (only `dsh` today:
   *  `buildKernelCatalog`'s `selectable` and the dsh version row need it).
   *  Distinct from `inTree` — claude and codex are in-tree but optional. */
  readonly alwaysAvailable?: true
  /** Module export holding the `AgentBackend` (default `backend`; claude's
   *  barrel exports `claudeBackend`). Absent = this entry has no `load`. */
  readonly backendExport?: string
  /**
   * Module export closing this backend's **module-level / process-wide**
   * resource pool (codex: `closeAllCodexHubs`). Session-scoped resources
   * (child processes, transcript handles) belong to `session.dispose()`, which
   * the fiber owns — never here.
   *
   * The registry only remembers the hook of an entry it actually loaded, so
   * "never loaded" also means "never imported" and "never closed" (D4).
   */
  readonly unloadExport?: string
  /** Gate derivation only (backend scope, `verify-adapter-boundary`): vendor
   *  package prefixes this backend may import (claude: `@anthropic-ai/`). */
  readonly vendorPackages?: readonly string[]
  /** Gate derivation only: the `native.<key>` slot this backend owns. **Absent
   *  means "this backend does not use a native channel"** — claude must stay
   *  absent (its channel is not declared today, and deriving one would widen
   *  the boundary gate). */
  readonly nativeKey?: string
  /**
   * The session capabilities this backend's handler actually serves, in the
   * `SessionCapabilities` vocabulary (`src/agent/capabilities.ts` —
   * `BackendHost`-visible subset; `src/adapter/spec/backend-capabilities.ts` is
   * the spec-plane copy the admission compares against). Declaring it is how a
   * backend says "these are the optional surfaces I answer to" *before* it runs;
   * a name this host does not know degrades the admission (`compatible_degraded`)
   * rather than refusing it (§0 D-3).
   *
   * The declaration must **cover** what the session actually serves (the set the
   * runtime hands back is a subset of this list), and the conformance fixture
   * checks the other direction at the seam: its `open()` must not answer with a
   * capability key outside what it declared
   * (`scripts/verify-backend-contribution.ts`). Absent = "nothing declared", which
   * the projection turns into the empty list.
   */
  readonly capabilities?: readonly string[]
  /**
   * The host permissions this backend asks for, by the host's own vocabulary
   * (`registry/permissions-0.1.json`). Today every in-tree backend declares
   * `[]`: none of the eight existing permission names describes what a backend
   * actually needs (spawning a child process, reading its own prefs, network) —
   * those are optional host capabilities on `BackendHost`, feature-detected, not
   * grants (D-3). A name with no grant lands the entry in `waiting_authorization`,
   * an unknown name degrades it; neither is a silent "usable".
   */
  readonly grants?: readonly string[]
  /**
   * What the host's install wizard would install, and with which of the host's
   * executors (§6 item 12). Declaring it is how a backend says "there is
   * something to install for me": no backend id is privileged any longer, and
   * codex's "there is nothing to install, the user's own binary is the
   * dependency" is the absent case — still a first-class row (a hint, no fake
   * button).
   *
   * Whether the named `executor` is one *this* host implements is a runtime
   * question the registry answers by table lookup; an unknown value means "no
   * install surface", never a failed registration.
   */
  readonly install?: BackendInstallRecipe
}

/**
 * One registry record: the manifest plus the lazy loader of its **module
 * namespace** — not of the `AgentBackend` itself, because the registry resolves
 * both `backendExport` and `unloadExport` from it (D4). `dsh` has no loader: it
 * is not an `AgentBackend` (see `src/dsh-adapter/backend/session.ts`).
 */
export interface BackendEntry {
  readonly manifest: BackendManifest
  readonly load?: () => Promise<Record<string, unknown>>
}

/**
 * The syntax every backend id must match: readable, sortable, usable as a file
 * name. `:` is deliberately excluded — a plugin id could otherwise not become
 * `~/.dsh-tui/backends/<id>/` on Windows (drive letters / alternate data
 * streams), and `AgentSessionRef` disambiguation would need the full id set,
 * which is exactly what a plugin registry cannot enumerate (P0 §5).
 *
 * Mirrored in `bin/dsh-tui.js`, which must work without compiled modules.
 */
export const BACKEND_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u

declare const validatedBackendId: unique symbol

/**
 * A backend id that passed the syntax gate. The brand is what keeps an
 * *unvalidated* string out of `backendId:sessionId` references and
 * `~/.dsh-tui/backends/<id>/` paths at compile time — the whole point of R11.
 *
 * It means "validated input", not "installed": membership is a runtime question
 * the registry answers (`parseBackendChoice`), and every caller that only has the
 * syntax half (`kernelPrefs`' `parseBackendId`, the launcher's mirror) still gets
 * the same protection for refs and paths, which is the part that matters there.
 */
export type BackendId = string & { readonly [validatedBackendId]: true }

/** Whether an untrusted value may pass into a session ref, a path or a log. */
export function isBackendIdSyntax(value: unknown): value is BackendId {
  return typeof value === 'string' && BACKEND_ID_PATTERN.test(value)
}

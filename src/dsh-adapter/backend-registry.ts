/**
 * The runtime backend registry (roadmap Stage A / P0).
 *
 * Before this module, "which backends exist" was a hand-written closed set
 * spread over `kernelPrefs.ts`, this adapter, the launcher copy and the boundary
 * gate: every new backend had to be copied into all of them (codex did exactly
 * that, #1352). Now the set is the built-in seed plus whatever the build-time
 * index found under `src/backends/*​/manifest.ts` — adding a backend is a new
 * directory, nothing else.
 *
 * Three properties this file must keep (they are what a fourth backend would
 * otherwise break):
 *
 *  - **Lazy**: an entry that is never loaded is never imported. `probeKernels`
 *    is the only path that loads everything, and it is opt-in.
 *  - **Booked pooling** (D4): `unloadExport` is remembered when — and only when —
 *    the entry's module was actually imported, so a DSH-only boot does not pay a
 *    module import (let alone a child process) just to close a pool it never
 *    opened. The one exit funnel (`plugin.ts`'s `disposeRootAndThen`) calls
 *    {@link unloadBackends} after the fiber is disposed and stays otherwise
 *    untouched.
 *  - **Membership is the second half of the parse** (D1): a syntactically valid
 *    but unregistered id must behave exactly like an unknown value everywhere
 *    (dsh + a warning, never a crashed boot). See {@link parseBackendChoice}.
 */
import type { AgentBackend } from '../agent/backend.js'
import { isBackendIdSyntax, type BackendEntry, type BackendManifest } from '../agent/backend-manifest.js'
import { BACKEND_CAPABILITY_NAMES } from '../adapter/spec/backend-capabilities.js'
import { EXPECTED_PERMISSIONS } from '../adapter/spec/protocol-constants.js'
import { validateBackendSpec } from '../adapter/spec/tui-contributions.js'
import { cleanRenderText } from '../channel/sanitize.js'
import { BUILTIN_BACKEND_IDS, type KernelBackendId } from '../kernelPrefs.js'
import { logForDebugging } from '../utils/debug.js'
import { backendAdmission, type BackendAdmission } from './backend-admission.js'
import { backendContributionOf } from './backend-contribution.js'
import { GENERATED_BACKENDS } from './backends.generated.js'
import { installExecutor } from './install/executors.js'

export { isBackendIdSyntax }

/**
 * The DSH kernel. In-tree and always available, but **not** an `AgentBackend`:
 * its session is built by `createDshSession()` from the DSH agent, and P0 does
 * not force it into the backend contract just for symmetry (roadmap §7.3).
 * Seeded first, so the picker order stays `dsh, claude, codex, …`.
 */
const DSH_MANIFEST: BackendManifest = {
  id: 'dsh',
  label: { kind: 'key', key: 'kernel-label-dsh' },
  shortLabel: 'DSH',
  product: 'dsh-core',
  inTree: true,
  alwaysAvailable: true,
  // Not an `AgentBackend`, so it has no optional session surface to declare —
  // stated explicitly rather than left to the projection's default (B-2).
  capabilities: [],
  grants: [],
}

/**
 * What replaced Stage A's `HOST_INSTALLABLE_BACKEND_ID = 'claude'`: a manifest
 * now *names an executor* (`BackendManifest.install.executor`) and the registry
 * looks the name up in the host's table (`src/dsh-adapter/install/`). An entry is
 * installable exactly when that lookup finds something, so the row that opens a
 * wizard is the row whose own recipe names an executor this host runs — not the
 * row that happens to wear the privileged id.
 *
 * A table rather than a static import of one backend's installer, because the
 * discovery this has to survive is the post-mount one: Stage C reads a bundle's
 * contribution after the plugin is mounted (§4.4), and a link-time constant could
 * not be consulted then.
 *
 * An unknown executor is **not** a registration error (§6 item 12): the entry
 * registers with no install surface, and its "not installed" row degrades to
 * detection's own hint instead of growing a button that cannot work. The recipe
 * is therefore validated for *shape* here, never for whether this host likes its
 * value. The strings a plugin declares are also the wizard's render path and (on
 * Windows) a `pnpm add` argument, so admitting a third-party recipe is Stage C/D
 * work — until then a plugin may name only a value of this closed table.
 */
const installableOf = (manifest: BackendManifest): boolean =>
  manifest.install !== undefined && installExecutor(manifest.install.executor) !== undefined

/**
 * One registered backend: the manifest, its id as a validated {@link KernelBackendId}
 * (the cast below is reached only after the syntax gate), the lazy loader, and the
 * one fact the registry derives from the manifest.
 *
 * `installable` is derived, not declared: the old `installable` field was a
 * boolean that the registration gate forced to equal "declares install data", so
 * it carried no information of its own — and the half that *is* a runtime
 * question (`does this host run that executor?`) could not be written in a
 * manifest at all. Picker rows read it from here, and `installSurfaceFor(id)`
 * answers the same question with the actions attached.
 */
export interface RegisteredBackend {
  readonly id: KernelBackendId
  readonly manifest: BackendManifest
  readonly installable: boolean
  /**
   * What the admission decided about this entry (B-2). `compatible_degraded`
   * carries the names the host does not implement, `waiting_authorization` the
   * permissions nobody granted; `rejected` and `unknown` never become an entry
   * (registration throws on them). Every in-tree backend is `compatible` today.
   */
  readonly admission: BackendAdmission
  readonly load?: () => Promise<Record<string, unknown>>
}

/** Registration order = picker order (`listBackends`). */
const entries = new Map<string, RegisteredBackend>()

/**
 * Cell budget for a plugin-declared name. The picker pane is at most ~72 cells
 * wide and the launchpad plate far narrower, so this only bounds what a
 * misbehaving manifest can put on the render path (and in the notices written to
 * stdout) — layout truncation stays the renderer's job.
 */
const LABEL_MAX_CELLS = 48

/** Close hooks of the entries whose module was actually imported (D4). */
const loadedUnloads = new Map<string, () => Promise<void>>()

/**
 * What this host knows when admitting a backend declaration (B-2). The
 * vocabularies come from the spec plane (`src/adapter/spec/**`), the granted set
 * is empty until a backend grant flow exists (C stage) — which is why every
 * in-tree manifest declares `grants: []` rather than a permission nobody could
 * grant (D-3).
 */
const HOST_ADMISSION_FACTS = {
  reservedIds: new Set<string>(BUILTIN_BACKEND_IDS),
  capabilityNames: new Set<string>(BACKEND_CAPABILITY_NAMES),
  permissionNames: new Set<string>(EXPECTED_PERMISSIONS.map(permission => permission.name)),
  granted: new Set<string>(),
} as const

/**
 * The same facts for **this host's own seed**: a built-in manifest legitimately
 * wears a built-in id, so the reserved set is the one rule that flips. Everything
 * else (the capability and permission vocabularies) applies to a seed exactly as
 * it does to a contribution — and the admission verdict is still recorded, which
 * is what makes the dogfood check in `verify-backend-contribution.ts` meaningful.
 */
const SEED_ADMISSION_FACTS = { ...HOST_ADMISSION_FACTS, reservedIds: new Set<string>() } as const

const admissionFactsFor = (manifest: BackendManifest): typeof HOST_ADMISSION_FACTS | typeof SEED_ADMISSION_FACTS =>
  manifest.inTree ? SEED_ADMISSION_FACTS : HOST_ADMISSION_FACTS

/**
 * Add one entry. The built-in seeds register themselves below; the plugin
 * discovery of Stage C is the intended second caller, which is why the checks
 * are loud rather than lenient: a bad manifest must fail at registration, not
 * paint a wrong row.
 */
export function registerBackend(entry: BackendEntry): void {
  const { manifest } = entry
  const where = `dsh-tui: backend "${manifest.id}"`
  if (!isBackendIdSyntax(manifest.id)) {
    throw new Error(`${where} has an invalid id (lowercase letters, digits and dashes, at most 32 characters)`)
  }
  if (entries.has(manifest.id)) throw new Error(`${where} is already registered`)
  if (!manifest.inTree && (BUILTIN_BACKEND_IDS as readonly string[]).includes(manifest.id)) {
    // `dsh` refs serialize without a prefix (`formatSessionRef`), so a plugin
    // wearing that id would collide with first-party references.
    throw new Error(`${where} is a reserved built-in id`)
  }
  if (!manifest.inTree && manifest.label.kind === 'key') {
    // Otherwise a plugin could claim a first-party name: `t()` returns the text
    // of an existing key (`src/i18n.ts`), so the row would read "DeepSeek Harness".
    throw new Error(`${where} is not in-tree and may not use a host label key; declare { kind: 'literal', text }`)
  }
  if (!manifest.inTree && manifest.alwaysAvailable === true) {
    throw new Error(`${where} is not in-tree and may not be always-available`)
  }
  if (!manifest.inTree && manifest.nativeKey !== undefined) {
    throw new Error(`${where} is not in-tree and may not declare a native channel`)
  }
  if (manifest.alwaysAvailable === true && entry.load !== undefined) {
    throw new Error(`${where} is always-available and must not have a loader (it is not an AgentBackend)`)
  }
  // Shape only: what the recipe names is the host's business, and a value it does
  // not implement means "no install surface", never a refused registration.
  const install = manifest.install
  if (install !== undefined && ![install.executor, install.specifier, install.version].every(field => typeof field === 'string' && field !== '')) {
    throw new Error(`${where} declares an install recipe without a non-empty executor, specifier and version`)
  }
  // The contribution family gate (B-2). Order matters: project the in-tree
  // superset down to the public declaration, validate that declaration against the
  // family's own definition (the same validator every other host of this protocol
  // runs), then decide the half only this host can answer — capability and
  // permission vocabularies. A refusal here is a build-time error and must be
  // loud; a `waiting_authorization` entry registers, because the id does exist and
  // the boot, the warnings and the session refs must know it, but it is not
  // offered (see {@link listOfferedBackends}).
  const contribution = validateBackendSpec(backendContributionOf(manifest))
  const verdict = backendAdmission(contribution, admissionFactsFor(manifest))
  if (verdict.decision === 'rejected' || verdict.decision === 'unknown') {
    throw new Error(`${where} was refused at admission: ${verdict.reasonCode}`)
  }
  const admission: BackendAdmission = verdict
  // Plugin-declared names are external input: flatten control/escape sequences
  // and cap the width here, once, so the picker, the launchpad plate and the
  // handoff notices all render the same sanitized text (in-tree names are this
  // package's own strings and stay verbatim; `label.key` must stay a raw key).
  const registered: RegisteredBackend = {
    // The one place that may mint a KernelBackendId: the syntax gate above has
    // already run, and membership is this very map.
    id: manifest.id as KernelBackendId,
    manifest: manifest.inTree ? manifest : {
      ...manifest,
      label: manifest.label.kind === 'literal' ? { kind: 'literal', text: cleanRenderText(manifest.label.text, LABEL_MAX_CELLS) } : manifest.label,
      shortLabel: cleanRenderText(manifest.shortLabel, LABEL_MAX_CELLS),
    },
    installable: installableOf(manifest),
    admission,
    ...(entry.load === undefined ? {} : { load: entry.load }),
  }
  entries.set(manifest.id, registered)
}

// The built-in seed: dsh first, then the generated index in directory-name
// order (claude, codex, …).
registerBackend({ manifest: DSH_MANIFEST })
for (const entry of GENERATED_BACKENDS) registerBackend(entry)

/** Every registered backend, in declaration order (= picker order). */
export function listBackends(): readonly RegisteredBackend[] {
  return [...entries.values()]
}

/**
 * The entries a picker may offer (B-2). A `waiting_authorization` entry is
 * registered — its id exists, the boot's two-stage parse must find it, and its
 * session refs must resolve — but it is not offered: nothing has granted what it
 * declares, so selecting it would open a backend the host cannot describe. Today
 * no entry is in that state (every in-tree manifest declares `grants: []`); the
 * shape exists so the C stage's grant flow has somewhere to land.
 */
export function listOfferedBackends(): readonly RegisteredBackend[] {
  return listBackends().filter(entry => entry.admission.decision !== 'waiting_authorization')
}

/**
 * What the backend admission machine reports when asked whether it is mounted
 * and can admit a *contribution* (W-2).
 */
export interface BackendAdmissionProbe {
  /** Entries the registry holds: the built-in seed plus every registration. */
  readonly registered: number
  /** How many of them a picker may offer (not `waiting_authorization`). */
  readonly offered: number
  /** What a synthetic third-party declaration was admitted as. A machine that
   *  could not answer `compatible` would refuse every contribution, so this is
   *  the one verdict the probe accepts. */
  readonly verdict: 'compatible'
}

/**
 * Read-only probe behind the host descriptor's `Backend` contract (W-2): is the
 * backend admission machine mounted, and does it answer for a *contribution*?
 *
 * The descriptor publishes `tui.dsh/v1alpha1#Backend` only on real probe evidence
 * (`hasVerificationEvidence`, descriptor publication barrier), and "a service row
 * exists" is deliberately not evidence. So this probe walks the same path a
 * third-party declaration takes — build a declaration no host owns, run it
 * through the family validator, then through the host's admission facts — and
 * reports what came back. It registers nothing, imports nothing and writes
 * nothing: an entry that was never loaded is still never loaded.
 */
export function probeBackendAdmission(): BackendAdmissionProbe {
  const entries = listBackends()
  const offered = listOfferedBackends().length
  // A declaration with no reserved id, no capabilities and no grants — the shape
  // the profile's own CLI-shaped fixture uses, so the verdict cannot depend on
  // anything this host happens to have registered.
  const declaration = validateBackendSpec({
    id: 'admission-probe',
    label: { text: 'Admission probe' },
    shortLabel: 'Admission probe',
    capabilities: [],
    grants: [],
  })
  const verdict = backendAdmission(declaration, HOST_ADMISSION_FACTS)
  if (verdict.decision !== 'compatible') {
    throw new Error(`dsh-tui: backend admission machine answered ${verdict.decision}; it cannot admit a contribution`)
  }
  return Object.freeze({ registered: entries.length, offered, verdict: 'compatible' as const })
}

/** One backend, or undefined when no such backend is registered. */
export function getBackend(id: string): RegisteredBackend | undefined {
  return entries.get(id)
}

/** Whether an untrusted value names a backend this process can actually run.
 *  This is the second half of the parse (D1) and the only way to obtain a
 *  {@link KernelBackendId} outside `kernelPrefs`' own syntax gate. */
export function isRegisteredBackend(value: unknown): value is KernelBackendId {
  return isBackendIdSyntax(value) && entries.has(value)
}

/**
 * The backend a configured / remembered value names: trimmed, lowercased, and
 * **registered**. Anything else is undefined, which every caller already treats
 * as "no choice made" (dsh + a warning) — the semantics an unknown value had
 * before the set was open (D1).
 */
export function parseBackendChoice(value: unknown): KernelBackendId | undefined {
  if (typeof value !== 'string') return undefined
  const id = value.trim().toLowerCase()
  return isRegisteredBackend(id) ? id : undefined
}

/** The display name of a backend id: its manifest's short brand name, else the
 *  id itself (a session from an uninstalled plugin must still render as
 *  something). */
export function backendLabel(id: string): string {
  return getBackend(id)?.manifest.shortLabel ?? id
}

/**
 * Import one registered backend's implementation and book its pool hook.
 *
 * The two failure messages stay distinct (D1): "not registered" means the id was
 * never a choice, "has no loader" means the id names the host's own kernel.
 */
export async function loadBackend(id: KernelBackendId): Promise<AgentBackend> {
  const entry: RegisteredBackend | undefined = entries.get(id)
  if (entry === undefined) throw new Error(`dsh-tui: backend "${id}" is not registered`)
  if (entry.load === undefined) throw new Error(`dsh-tui: backend "${id}" has no loader (only the DSH kernel is not an AgentBackend)`)
  const module = await entry.load()
  const { backendExport, unloadExport } = entry.manifest
  if (unloadExport !== undefined) {
    const unload = module[unloadExport]
    if (typeof unload !== 'function') {
      throw new Error(`dsh-tui: backend "${id}" declares unloadExport "${unloadExport}", but its module does not export it`)
    }
    // Overwriting is fine: the same module instance hands back the same hook.
    loadedUnloads.set(id, unload as () => Promise<void>)
  }
  const exportName = backendExport ?? 'backend'
  const backend = module[exportName]
  if (backend === undefined) throw new Error(`dsh-tui: backend "${id}" does not export "${exportName}"`)
  return backend as AgentBackend
}

/**
 * Close the pooled, process-wide resources of every backend this process
 * actually loaded, in load order, then forget them (idempotent).
 *
 * Called once from the exit funnel *after* `ctx.root.fiber.dispose()`: closing a
 * pool first would break the in-flight sessions whose calls still hold it
 * (D4-P3). A failing or hanging hook must not block the exit — failures only
 * reach the debug log, and a stuck one is caught by the funnel's existing 5s
 * bound (P4).
 */
export async function unloadBackends(): Promise<void> {
  for (const [id, unload] of loadedUnloads) {
    try {
      await unload()
    } catch (error) {
      logForDebugging(`dsh-tui: backend "${id}" unload failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  loadedUnloads.clear()
}

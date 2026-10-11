/**
 * A third-party-looking backend declaration (F-1 fixture, B-2).
 *
 * Real files rather than a string template, so the gate drives the *same* code
 * path a bundle would: `registerBackend({ manifest, load })`, the lazy loader, the
 * pool ledger, the install surface. It sits under `scripts/` on purpose — the
 * build-time index only scans `src/backends/<dir>/manifest.ts`, so this can never
 * be picked up into `GENERATED_BACKENDS` and never reaches a user's picker
 * (D-2/F-1). The price is that `tsc` does not check it, exactly like every other
 * gate script in this repository.
 *
 * Zero vendor imports: it declares what any third-party backend would declare and
 * nothing about which SDK it drives.
 */
import type { BackendManifest } from '../../../src/agent/backend-manifest.js'

/** The capability names this probe declares — and, on purpose, the whole set it
 *  serves: `open()` must not hand back a session surface outside this list. */
export const PROBE_DECLARED_CAPABILITIES: readonly string[] = Object.freeze([])

/** The id every probe entry uses; the gate registers it once. */
export const PROBE_BACKEND_ID = 'probe-backend'

/** What the probe's install recipe names — its own specifier, never a host one. */
export const PROBE_INSTALL_SPECIFIER = '@example/probe-agent@0.1.0'

/** The declared shape: a plugin manifest with a literal label (a host key is
 *  refused for anything not in-tree) and an install recipe whose executor the host
 *  implements (`pnpm-profile-add`). */
export const manifest: BackendManifest = {
  id: PROBE_BACKEND_ID,
  label: { kind: 'literal', text: 'Probe Backend' },
  shortLabel: 'Probe',
  product: 'probe-cli',
  inTree: false,
  backendExport: 'probeBackend',
  unloadExport: 'closeProbePool',
  capabilities: [...PROBE_DECLARED_CAPABILITIES],
  grants: [],
  install: { executor: 'pnpm-profile-add', specifier: PROBE_INSTALL_SPECIFIER, version: '0.1.0' },
}

/**
 * The same declaration with **no install recipe** — codex's shape ("the user's own
 * binary is the dependency"). Declaring it is how a backend says "there is nothing
 * for the host to add"; the picker then shows a hint instead of a button (§6 item
 * 12), and `installable` is false.
 *
 * It keeps `unloadExport` on purpose: codex's real combination is "no install recipe
 * **and** a process-level pool" (its manifest names `closeAllCodexHubs`), so the
 * fixture has to carry both or that combination is never exercised — and "nothing to
 * install" must not be read as "nothing to close".
 */
export const manifestWithoutInstall: BackendManifest = {
  id: 'probe-backend-bare',
  label: { kind: 'literal', text: 'Probe Backend (bare)' },
  shortLabel: 'Probe bare',
  inTree: false,
  backendExport: 'probeBackend',
  unloadExport: 'closeProbePool',
  capabilities: [...PROBE_DECLARED_CAPABILITIES],
  grants: [],
}

/**
 * Static description of the Claude Agent backend (P0 manifest; see
 * `src/agent/backend-manifest.ts` for the field semantics).
 *
 * Pure data: the single runtime import is the version contract's constant — the
 * one allowlisted exception to "a manifest imports nothing" (the SDK pin is a
 * value, and duplicating the literal would let it drift from
 * `contract.ts`/`package.json`). It must never import the host's executor table
 * or `index.ts`: the build-time index imports this module statically on every
 * boot, DSH-only ones included, and the executor pulls in `update.ts`. The
 * executor name is therefore spelled as the literal the host looks up — the
 * registry reads a *value*, and `verify-backend-registry` pins that this literal
 * is the one the host implements.
 *
 * `nativeKey` is deliberately absent: this backend does not read a
 * `native.<key>` channel, and deriving one from a stray declaration would
 * *widen* the boundary gate (P0 §6).
 */
import type { BackendManifest } from '../../agent/backend-manifest.js'
import { CLAUDE_SDK_SPECIFIER, VALIDATED_SDK_VERSION } from './contract.js'

export const manifest: BackendManifest = {
  id: 'claude',
  label: { kind: 'key', key: 'kernel-label-claude' },
  shortLabel: 'Claude',
  product: 'claude-code',
  inTree: true,
  backendExport: 'claudeBackend',
  vendorPackages: ['@anthropic-ai/'],
  install: { executor: 'pnpm-profile-add', specifier: CLAUDE_SDK_SPECIFIER, version: VALIDATED_SDK_VERSION },
}

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
  // The optional session surfaces this backend serves (B-2 dogfood): the union
  // of what `session/lifecycle.ts` assembles — its own literal capabilities plus
  // the ones spread in from `controls.ts`, `store.ts` and `subagents.ts`.
  // Declaring a surface is not promising it is available (`capabilities?` is
  // optional per member; `channels`/`auth` depend on the login in use). The host
  // reads the declaration as "may answer to", which is what admission needs to
  // state before anything runs.
  capabilities: [
    'native', 'permissions', 'questions', 'models', 'effort', 'modes', 'channels',
    'init', 'compact', 'commands', 'mcp', 'context', 'fork', 'rewind', 'rename',
    'subagents', 'tasks', 'sideQuery', 'images', 'color', 'transcript', 'account',
    'auth', 'workingActivity', 'diagnostics',
  ],
  // Empty on purpose: nothing in the host's permission vocabulary describes what a
  // backend actually needs (spawning a child process, reading its own prefs, the
  // network). Those are optional `BackendHost` capabilities, feature-detected —
  // not grants (D-3). Declared rather than omitted, so the fact is stated.
  grants: [],
}

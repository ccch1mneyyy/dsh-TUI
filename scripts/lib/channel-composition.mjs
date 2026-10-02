/**
 * The channel's composition roots, as the structural gates read them (Phase
 * 4a, docs/agent-backend-design.md §3.5): `src/dsh-adapter/channel.ts` (the
 * entry: core + DSH extensions), `channel/core/compose.ts` (the backend-
 * neutral core) and `channel/extensions.ts` (the DSH specialists' wiring).
 * Before Phase 4a all three were one file, `channel.ts`; a gate that pins
 * "the root composes X / does not retain Y" reads their concatenation.
 */
import { readFileSync } from 'node:fs'

export const COMPOSITION_ROOTS = Object.freeze([
  'dsh-adapter/channel.ts',
  'dsh-adapter/channel/core/compose.ts',
  'dsh-adapter/channel/extensions.ts',
])

/** The concatenated source of every composition root. */
export function compositionSource() {
  return COMPOSITION_ROOTS
    .map(path => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8'))
    .join('\n')
}

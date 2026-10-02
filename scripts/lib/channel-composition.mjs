/**
 * The channel's composition roots, as the structural gates read them (Phase
 * 4a, docs/agent-backend-design.md §3.5): `src/dsh-adapter/channel.ts` (the
 * entry: core + DSH extensions), `channel/core/compose.ts` (the backend-
 * neutral core) and `channel/extensions.ts` (the DSH specialists' wiring).
 * Before Phase 4a all three were one file, `channel.ts`; a gate that pins
 * "the root composes X / does not retain Y" reads their concatenation.
 */
import { readdirSync, readFileSync } from 'node:fs'

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

/**
 * The composition roots plus every module of the channel core
 * (`channel/core/*.ts`): what a NEGATIVE fence ("the composition never
 * mutates raw state", "never resolves command ownership itself") must read
 * since Phase 4a moved composition code into the core modules. Positive
 * "the root composes X" gates keep reading {@link compositionSource}.
 */
export function compositionAndCoreSource() {
  const coreDir = new URL('../../src/dsh-adapter/channel/core/', import.meta.url)
  const core = readdirSync(coreDir)
    .filter(name => name.endsWith('.ts'))
    .sort()
    .map(name => readFileSync(new URL(name, coreDir), 'utf8'))
  return [compositionSource(), ...core].join('\n')
}

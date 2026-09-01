/**
 * COMPAT shim discipline gate.
 *
 * Every compatibility shim must carry the four mandatory markers:
 *   // COMPAT(<tracker>): <reason>
 *   // UNTIL: <machine-readable removal condition>
 *   // OWNER: <module>
 *   // TEST: <gate/script>
 *
 * Machine-readable UNTIL protocol (v1):
 *   - `adapter-v2-p0` ... `adapter-v2-p6` — the adapter-v2 roadmap stage after
 *     which the shim is allowed to be removed. The current branch phase is
 *     declared below (`ADAPTER_V2_PHASE`); removing a shim while the current
 *     phase is before its UNTIL stage is rejected.
 *   - `issue:<tracker-id>` — an external issue is the removal condition.
 *
 * This gate does NOT claim to infer semantic completion from arbitrary prose.
 * The only condition metadata it requires is the machine token above plus,
 * for the special admission-compat shims, an explicit `REMOVAL_CONDITION:`
 * line describing the functional gate that must be complete first.
 *
 * Run via `node --import tsx/esm scripts/verify-compat-removal.ts`.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

/** Current adapter-v2 branch phase. This is the phase the working tree is
 * actually at; update it as the roadmap advances. It is used only to reject
 * premature removal, not to auto-delete shims. */
const ADAPTER_V2_PHASE = 'P3'
const PHASE_ORDER = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const

const SHIMS = [
  'plugin-spec/types.ts',
  'plugin-spec/schema-check.ts',
  'plugin-spec/registry.ts',
  'plugin-spec/validate.ts',
  'plugin-spec/negotiate.ts',
  'plugin-spec/permission-scope.ts',
  'plugin-spec/tui-extension.ts',
  'dsh-adapter/grants.ts',
  'dsh-adapter/host-descriptor.ts',
  'dsh-adapter/plugin-host.ts',
  'adapter/standard/descriptor.ts',
  'plugin-host.ts',
]

const REQUIRED = [
  ['COMPAT(', 'COMPAT marker'],
  ['UNTIL:', 'UNTIL marker'],
  ['OWNER:', 'OWNER marker'],
  ['TEST:', 'TEST marker'],
] as const

/** Extra metadata required for the admission-compat shims: the functional
 * removal condition must be written down explicitly, not only a phase. */
const REQUIRED_METADATA: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'adapter/standard/descriptor.ts': Object.freeze(['REMOVAL_CONDITION:']),
  'dsh-adapter/plugin-host.ts': Object.freeze(['REMOVAL_CONDITION:']),
})

/** Removal phase for each tracked shim. Kept out-of-line so a missing file is
 * still checked against the phase it was supposed to wait for. */
const REMOVAL_PHASE: Readonly<Record<string, string>> = Object.freeze({
  'plugin-spec/types.ts': 'P6',
  'plugin-spec/schema-check.ts': 'P6',
  'plugin-spec/registry.ts': 'P6',
  'plugin-spec/validate.ts': 'P6',
  'plugin-spec/negotiate.ts': 'P6',
  'plugin-spec/permission-scope.ts': 'P6',
  'plugin-spec/tui-extension.ts': 'P6',
  'dsh-adapter/grants.ts': 'P6',
  'dsh-adapter/host-descriptor.ts': 'P6',
  'dsh-adapter/plugin-host.ts': 'P6',
  'adapter/standard/descriptor.ts': 'P6',
  'plugin-host.ts': 'P6',
})

const failures: string[] = []

function phaseIndex(phase: string): number {
  const index = PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number])
  return index === -1 ? -1 : index
}

function resolveUntilToken(raw: string): string | undefined {
  const compact = raw.replace(/\s+/g, ' ').trim().toLowerCase()
  const p6 = /adapter-v2[ -]*p6/
  const p0To5 = /adapter-v2[ -]*p([0-5])/
  if (p6.test(compact)) return 'adapter-v2-p6'
  const match = compact.match(p0To5)
  if (match !== null) return `adapter-v2-p${match[1]}`
  const issue = compact.match(/issue[#:/ ]+([a-z0-9-]+)/u)
  if (issue !== null) return `issue:${issue[1]}`
  return undefined
}

function untilPhase(token: string): string | undefined {
  const match = token.match(/^adapter-v2-p([0-6])$/)
  return match === null ? undefined : `P${match[1]}`
}

function readShim(relative: string): string | undefined {
  try {
    return readFileSync(join(SRC, relative), 'utf8')
  } catch {
    return undefined
  }
}

for (const relative of SHIMS) {
  const source = readShim(relative)
  if (source === undefined) {
    // A removed shim is only acceptable after the current branch has reached
    // the UNTIL phase. Because we cannot read its old UNTIL here, each shim is
    // paired with the removal phase table above; missing while current phase
    // is before that stage is a hard failure.
    const guard = REMOVAL_PHASE[relative]
    if (guard !== undefined && phaseIndex(ADAPTER_V2_PHASE) < phaseIndex(guard)) {
      failures.push(`${relative}: shim removed before ${guard} (current adapter-v2 phase ${ADAPTER_V2_PHASE})`)
    }
    continue
  }
  for (const [needle, label] of REQUIRED) {
    if (!source.includes(needle)) {
      failures.push(`${relative}: missing ${label}`)
    }
  }
  const untilMatch = source.match(/UNTIL:\s*([^\n]+)/u)
  const untilRaw = untilMatch?.[1] ?? ''
  const token = resolveUntilToken(untilRaw)
  if (token === undefined) {
    failures.push(`${relative}: UNTIL is not machine-readable (expected adapter-v2-p0..p6 or issue:<id>)`)
  } else if (token.startsWith('adapter-v2-')) {
    const phase = untilPhase(token)
    if (phase === undefined || phaseIndex(phase) < 0) {
      failures.push(`${relative}: invalid adapter-v2 UNTIL token ${token}`)
    }
  }
  const metadataRequired = REQUIRED_METADATA[relative]
  if (metadataRequired !== undefined) {
    for (const marker of metadataRequired) {
      if (!source.includes(marker)) {
        failures.push(`${relative}: missing ${marker}`)
      }
    }
  }
}

if (failures.length > 0) {
  console.error('verify:compat-removal FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`verify:compat-removal OK (${SHIMS.length} shims inspected; current adapter-v2 phase ${ADAPTER_V2_PHASE})`)

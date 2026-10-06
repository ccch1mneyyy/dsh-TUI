/**
 * Version contract of the Codex backend (docs/codex-backend-design.md D3).
 * There is no npm dependency: the backend drives the user's own `codex`
 * binary over `codex app-server`, and the protocol types under
 * `protocol/generated/` are that binary's generator output, vendored by
 * `scripts/codex-protocol-sync.mjs`. `verify:codex-contract` checks the
 * digest below against the tree and every protocol name the backend handles
 * against the generated unions.
 *
 * Version policy: a binary on the same minor line as a validated version and
 * not older than it is compatible (`0.160.x` ≥ `0.160.1`); anything else on
 * or above {@link MIN_CODEX_VERSION} runs with a drift notice; below it the
 * backend reports itself not installed, with an upgrade hint.
 */

/** Backend id of the Codex backend (`AgentSessionRef.backendId`). */
export const CODEX_BACKEND_ID = 'codex'

/** User-facing backend name. */
export const CODEX_BACKEND_LABEL = 'Codex'

/** How a user re-enters a Codex thread from a shell. */
export function codexResumeCommand(threadId: string): string {
  return `dsh-tui --backend codex --resume ${threadId}`
}

/** The `codex-cli` versions the backend is validated against. */
export const VALIDATED_CODEX_VERSIONS: readonly string[] = ['0.160.1']

/** The oldest `codex-cli` the backend starts on (C0 V16). */
export const MIN_CODEX_VERSION = '0.160.0'

/** The `codex-cli` version `protocol/generated/` was generated from. */
export const PROTOCOL_VERSION = '0.160.1'

/** Digest of `protocol/generated/` (scripts/lib/codex-protocol-digest.mjs). */
export const PROTOCOL_DIGEST = 'sha256:3843848c108242f7364b986c80fefd6cd37aec4ab2863b0e2b6fb7bc86feb6f7'

/** `X.Y.Z` (with an optional pre-release tail) from `codex --version`
 *  output (`codex-cli 0.160.1`), else undefined. */
export function parseCodexVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(text)?.[1]
}

/** Numeric `[major, minor, patch]` of a version, else undefined. */
function triple(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Compare two versions by their numeric triple (pre-release tails ignored);
 *  undefined when either does not parse. */
export function compareCodexVersions(a: string, b: string): number | undefined {
  const left = triple(a)
  const right = triple(b)
  if (left === undefined || right === undefined) return undefined
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!
  }
  return 0
}

/** Whether a version is at least {@link MIN_CODEX_VERSION} (an unreadable
 *  version is given the benefit of the doubt: drift, never a refusal). */
export function codexVersionSupported(version: string | undefined): boolean {
  if (version === undefined) return true
  const order = compareCodexVersions(version, MIN_CODEX_VERSION)
  return order === undefined || order >= 0
}

/** The version when it is outside the validated range, else undefined. */
export function codexVersionDrift(version: string | undefined): string | undefined {
  if (version === undefined || version === '') return undefined
  const own = triple(version)
  if (own === undefined) return version
  const compatible = VALIDATED_CODEX_VERSIONS.some(validated => {
    const line = triple(validated)
    return line !== undefined && line[0] === own[0] && line[1] === own[1] && own[2] >= line[2]
  })
  return compatible ? undefined : version
}

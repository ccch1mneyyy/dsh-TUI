/**
 * Stable dispatch runtime — the package facade's brain (deploy-transition
 * S04, G0-gated).
 *
 * One process, ONE runtime root. The first resolution in a process freezes
 * the choice for every later dispatch through this module (a globalThis-
 * keyed pin), so the whole host boot stays on a single generation even if
 * deploy/active.json is atomically repointed mid-boot.
 *
 * Modes, in resolution order:
 *
 *  - "source"     The package directory's realpath carries development
 *                 markers ("src/" + "tsconfig.json" — both deliberately
 *                 absent from package.json "files", so an installed copy
 *                 can never classify as source). This is the Junction dev
 *                 track: it runs the tree's own compiled "lib/" and NEVER
 *                 consults deploy/active.json — a manifest must not
 *                 silently switch a developer's checkout. The best-effort
 *                 git HEAD fingerprint is recorded for diagnostics; a
 *                 dirty or unreadable tree degrades to "source-unknown",
 *                 never to a fake release id.
 *  - "generation" deploy/active.json (schemaVersion 1) names an immutable
 *                 generation directory. READY.json's bytes must hash to the
 *                 manifest's readySha256 (fail closed on ANY mismatch — a
 *                 corrupt manifest must not fall back to silently running
 *                 an unverified tree). A lease file is written BEFORE the
 *                 generation module is imported, so a running process is
 *                 always GC-visible.
 *  - "legacy"     No active.json: this package's own canonical content IS
 *                 the runtime (the pre-deploy world, byte-identical
 *                 behavior). A present-but-invalid manifest THROWS instead
 *                 (fail closed; see the design's manifest property matrix).
 *
 * Zero dependencies by contract: this module evaluates before the package's
 * dependency closure is guaranteed to resolve, and the thin bin launcher
 * loads it by absolute path (migrate subcommand) without any lib/ present.
 */
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const ACTIVE_SCHEMA_VERSION = 1
export const READY_SCHEMA_VERSION = 1
export const LEASE_SCHEMA_VERSION = 1
/** generation-id charset per the design: [A-Za-z0-9._-], no leading dot. */
const GENERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const PIN_KEY = Symbol.for("dsh-tui.dispatch-pin")
/** Lease refresh cadence; GC treats a lease as fresh for 3x this window. */
export const LEASE_HEARTBEAT_MS = 20000

/** True when "id" is a safe single path segment for a generation dir. */
export function isValidGenerationId(id) {
  return typeof id === "string" && GENERATION_ID_RE.test(id)
}

/**
 * Parse + validate an active.json payload. Throws a descriptive error on
 * every malformed shape (truncated JSON, unknown schema, bad id/hash) — the
 * caller fail-closes; it must NOT silently fall back to the canonical tree.
 * @param {string} text - raw manifest bytes.
 * @param {string} origin - path for error messages.
 * @returns {{schemaVersion: number, generationId: string, readySha256: string, activatedAt: string, previousGenerationId?: string}} frozen manifest.
 */
export function parseActiveManifest(text, origin) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error("active manifest at " + origin + " is not valid JSON: " + error.message)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("active manifest at " + origin + " is not an object")
  }
  if (parsed.schemaVersion !== ACTIVE_SCHEMA_VERSION) {
    throw new Error("active manifest at " + origin + " has unsupported schemaVersion " + JSON.stringify(parsed.schemaVersion) + " (expected " + ACTIVE_SCHEMA_VERSION + ")")
  }
  if (!isValidGenerationId(parsed.generationId)) {
    throw new Error("active manifest at " + origin + " has invalid generationId " + JSON.stringify(parsed.generationId))
  }
  if (typeof parsed.readySha256 !== "string" || !SHA256_RE.test(parsed.readySha256)) {
    throw new Error("active manifest at " + origin + " has invalid readySha256")
  }
  if (typeof parsed.activatedAt !== "string" || parsed.activatedAt === "") {
    throw new Error("active manifest at " + origin + " has invalid activatedAt")
  }
  if (parsed.previousGenerationId !== undefined && !isValidGenerationId(parsed.previousGenerationId)) {
    throw new Error("active manifest at " + origin + " has invalid previousGenerationId")
  }
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    generationId: parsed.generationId,
    readySha256: parsed.readySha256,
    activatedAt: parsed.activatedAt,
    ...(parsed.previousGenerationId === undefined ? {} : { previousGenerationId: parsed.previousGenerationId }),
  })
}

/** Parse + validate a generation's READY.json (the internal commit mark). */
export function parseReadyManifest(text, origin) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error("READY manifest at " + origin + " is not valid JSON: " + error.message)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("READY manifest at " + origin + " is not an object")
  if (parsed.schemaVersion !== READY_SCHEMA_VERSION) {
    throw new Error("READY manifest at " + origin + " has unsupported schemaVersion " + JSON.stringify(parsed.schemaVersion) + " (expected " + READY_SCHEMA_VERSION + ")")
  }
  if (!isValidGenerationId(parsed.generationId)) throw new Error("READY manifest at " + origin + " has invalid generationId")
  if (typeof parsed.packageVersion !== "string" || parsed.packageVersion === "") {
    throw new Error("READY manifest at " + origin + " has invalid packageVersion")
  }
  if (typeof parsed.packageTreeSha256 !== "string" || !SHA256_RE.test(parsed.packageTreeSha256)) {
    throw new Error("READY manifest at " + origin + " has invalid packageTreeSha256")
  }
  return parsed
}

/**
 * Locate the deploy root for a package directory: the nearest ancestor that
 * carries ".dsh-tui/deploy". Resolution walks the REAL path (junctions
 * collapsed), matching how profile node_modules layouts anchor the package
 * (npm-flat or pnpm virtual store — both end at the profile root). Never
 * hardcodes a user directory; DSH_TUI_DEPLOY_ROOT is an explicit operator
 * override (tests, unusual layouts).
 */
export function findDeployRoot(packageDir) {
  const override = process.env.DSH_TUI_DEPLOY_ROOT
  if (override !== undefined && override !== "") {
    if (!existsSync(override)) return undefined
    return realpathSync(override)
  }
  let current = realpathSync(packageDir)
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(current, ".dsh-tui", "deploy")
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** Development-checkout markers; never present in an installed package. */
export function isSourceTree(packageDir) {
  return existsSync(join(packageDir, "tsconfig.json")) && existsSync(join(packageDir, "src"))
}

/** Best-effort git HEAD sha for source-mode diagnostics (no git binary). */
function sourceFingerprint(packageDir) {
  try {
    const dotGit = join(packageDir, ".git")
    const stat = lstatSync(dotGit)
    const gitDir = stat.isDirectory() ? dotGit : readFileSync(dotGit, "utf8").trim().replace(/^gitdir:\s*/, "")
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim()
    if (/^[0-9a-f]{40,64}$/i.test(head)) return head.slice(0, 12)
    const ref = head.replace(/^ref:\s*/, "")
    const sha = readFileSync(join(gitDir, ref), "utf8").trim()
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha.slice(0, 12) : "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * Write the process's lease for a generation and keep it fresh. The lease is
 * the GC visibility contract: it exists BEFORE the generation module is
 * imported, heartbeats while the process lives, and is removed best-effort
 * on normal exit (a crashed process leaves a stale lease for the GC's
 * liveness probe — it never deletes a generation on a maybe).
 * @returns {{path: string, nonce: string, release: () => void, heartbeat: () => void}}
 */
export function acquireLease(deployRoot, generationId, mode = "generation") {
  const leaseDir = join(deployRoot, "leases", generationId)
  mkdirSync(leaseDir, { recursive: true })
  const startedAt = Date.now()
  const nonce = Math.random().toString(16).slice(2, 10) + process.pid.toString(16)
  const leasePath = join(leaseDir, process.pid + "-" + nonce + ".json")
  const payload = () => JSON.stringify({
    schemaVersion: LEASE_SCHEMA_VERSION,
    generationId,
    mode,
    pid: process.pid,
    nonce,
    startedAt,
    heartbeatAt: Date.now(),
    nodeMajor: Number(process.versions.node.split(".")[0]),
  })
  writeFileSync(leasePath, payload(), { flag: "wx" })
  const heartbeat = () => {
    try {
      writeFileSync(leasePath, payload())
    } catch {
      // Diagnosis-only: a failed heartbeat must never kill the TUI. The GC
      // treats a stale-but-pid-alive lease as ambiguous and keeps the gen.
    }
  }
  const timer = setInterval(heartbeat, LEASE_HEARTBEAT_MS)
  timer.unref()
  const release = () => {
    clearInterval(timer)
    try {
      unlinkSync(leasePath)
    } catch {
      // Best effort (crash cleanup is the GC's job).
    }
  }
  process.once("exit", release)
  return { path: leasePath, nonce, release, heartbeat }
}

/**
 * Resolve THIS process's runtime root. Idempotent per package instance: the
 * first call wins and is cached on globalThis, so a mid-boot active.json
 * repoint cannot split one process across generations. The result is a
 * promise so validation failures surface as rejections to every waiter.
 * @param {string} dispatchModuleUrl - import.meta.url of the calling forwarder.
 */
export function resolveTuiRuntime(dispatchModuleUrl) {
  const dispatchDir = dirname(fileURLToPath(dispatchModuleUrl))
  const cacheKey = realpathSync(dirname(dispatchDir))
  const store = (globalThis[PIN_KEY] ??= new Map())
  const cached = store.get(cacheKey)
  if (cached !== undefined) return cached
  const promise = Promise.resolve().then(() => computePin(dirname(dispatchDir)))
  store.set(cacheKey, promise)
  return promise
}

function computePin(packageDirInput) {
  const packageDir = realpathSync(packageDirInput)
  const base = { packageDir, canonicalRoot: pathToFileURL(packageDir + "/").href }
  if (isSourceTree(packageDir)) {
    return {
      ...base,
      mode: "source",
      generationId: "source-" + sourceFingerprint(packageDir),
      reason: "development tree (src/ + tsconfig.json present on the real path)",
    }
  }
  const deployRoot = findDeployRoot(packageDir)
  if (deployRoot === undefined) {
    return { ...base, mode: "legacy", generationId: legacyId(packageDir), reason: "no deploy root above this package" }
  }
  const activePath = join(deployRoot, "active.json")
  if (!existsSync(activePath)) {
    return { ...base, mode: "legacy", deployRoot, generationId: legacyId(packageDir), reason: "deploy root has no active.json" }
  }
  // Present-but-invalid manifests fail closed with the path in the message —
  // never a silent canonical fallback (design §S04 manifest matrix).
  const manifest = parseActiveManifest(readFileSync(activePath, "utf8"), activePath)
  const generationDir = join(deployRoot, "generations", manifest.generationId)
  const genStat = lstatSync(generationDir) // throws ENOENT → fail closed
  if (!genStat.isDirectory() || genStat.isSymbolicLink()) {
    throw new Error("generation " + manifest.generationId + " at " + generationDir + " is not a plain directory")
  }
  const readyPath = join(generationDir, "READY.json")
  const readyBytes = readFileSync(readyPath) // throws → fail closed
  const readySha256 = createHash("sha256").update(readyBytes).digest("hex")
  if (readySha256 !== manifest.readySha256) {
    throw new Error("generation " + manifest.generationId + " READY hash mismatch (manifest " + manifest.readySha256.slice(0, 12) + ", actual " + readySha256.slice(0, 12) + ") — refusing to run an unverified generation")
  }
  const ready = parseReadyManifest(readyBytes.toString("utf8"), readyPath)
  if (ready.generationId !== manifest.generationId) {
    throw new Error("generation " + manifest.generationId + " READY names a different generation (" + ready.generationId + ")")
  }
  const packageRoot = join(generationDir, "package")
  if (!statSync(packageRoot).isDirectory()) {
    throw new Error("generation " + manifest.generationId + " has no package/ directory")
  }
  const lease = acquireLease(deployRoot, manifest.generationId, "generation")
  return {
    ...base,
    mode: "generation",
    deployRoot,
    generationId: manifest.generationId,
    ready,
    readySha256,
    lease,
    packageRoot,
    packageRootUrl: pathToFileURL(packageRoot + "/").href,
    reason: "pinned from deploy/active.json",
  }
}

function legacyId(packageDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"))
    return typeof pkg.version === "string" ? "legacy-" + pkg.version : "legacy-unknown"
  } catch {
    return "legacy-unknown"
  }
}

/**
 * Resolve + import a package entry through the process pin. Generation mode
 * maps the package-relative entry onto the pinned generation's package
 * tree; source/legacy modes import the canonical file next to dispatch/.
 * The generation entry's existence is checked BEFORE import so a partially
 * deleted generation produces an actionable error instead of a bare
 * ERR_MODULE_NOT_FOUND deep in module resolution.
 * @param {string} dispatchModuleUrl - import.meta.url of the forwarder.
 * @param {string} packageRelative - entry path relative to the package root
 *        ("lib/types/index.js" for the main facade).
 */
export async function resolveTuiEntry(dispatchModuleUrl, packageRelative) {
  const pin = await resolveTuiRuntime(dispatchModuleUrl)
  if (pin.mode !== "generation") {
    // canonicalRoot is a DIRECTORY URL (trailing slash): resolve the
    // package-relative entry directly against it — a "../" prefix would
    // escape one level ABOVE the package.
    const canonical = new URL(packageRelative, pin.canonicalRoot).href
    return import(canonical)
  }
  const target = new URL(packageRelative, pin.packageRootUrl)
  const targetPath = fileURLToPath(target)
  if (!existsSync(targetPath)) {
    throw new Error("pinned generation " + pin.generationId + " is missing its " + packageRelative + " entry (" + targetPath + ") — the deployment is incomplete; run the deploy tool's status command or roll back")
  }
  return import(target.href)
}

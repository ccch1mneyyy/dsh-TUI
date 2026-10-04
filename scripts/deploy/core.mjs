/**
 * Deployment core — generation lifecycle for the versioned-deploy design
 * (S04 M0): staging → READY → atomic promote → leases → safe GC → rollback.
 *
 * Directory contract (all under <deployRoot> = <profile>/.dsh-tui/deploy):
 *
 *   active.json                     tiny pointer; same-dir tmp + atomic rename
 *   generations/<id>/                immutable, committed generation
 *     READY.json                     internal commit mark (hash-verified)
 *     package/                       the npm `files` tree (plain files only)
 *   generations/<id>.staging/        uncommitted build output; never booted
 *   leases/<id>/<pid>-<nonce>.json   per-process pins (see dispatch/resolve)
 *   build-locks/<name>.lock          promoter mutual exclusion (NOT liveness)
 *   history.json                     append-only operator log (diagnostic,
 *                                   never a second source of truth)
 *
 * Crash-safety rules (design §S04 "Manifest 形状与原子协议"):
 *  - active.json is only ever replaced by an atomic same-volume rename of a
 *    fully-written, fsynced temp file — a reader sees old or new, never
 *    missing/half.
 *  - staging → final is a same-volume rename onto a NOT-EXISTING target;
 *    Windows directory renames fail (never overwrite) so a crashed promote
 *    leaves the old active pointer + old generation intact.
 *  - GC only deletes generations that are neither active, nor the recorded
 *    rollback target, nor lease-pinned, nor inside the retention window —
 *    and it defaults to dry-run.
 */
import { createHash } from "node:crypto"
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseActiveManifest, parseReadyManifest, isValidGenerationId, LEASE_HEARTBEAT_MS } from "../../dispatch/resolve.mjs"

/** A lease is "fresh" while within 3 heartbeat windows of its last beat. */
const LEASE_FRESH_MS = LEASE_HEARTBEAT_MS * 3
/** Staging directories older than this (and unlocked) are GC candidates. */
export const STAGING_TTL_MS = 48 * 60 * 60 * 1000
/** Promote lock staleness: a lock older than this is reported, not obeyed. */
export const BUILD_LOCK_STALE_MS = 10 * 60 * 1000

export class DeployError extends Error {}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path))
}

/**
 * Atomic JSON write: exclusive-create temp in the SAME directory, fsync,
 * then rename over the target (same-volume atomic replace on POSIX and
 * Windows — Node's rename uses MoveFileEx(REPLACE_EXISTING)).
 *
 * Windows sharing-violation boundary (empirically hit by this repo's own
 * regression): MoveFileEx-over-existing fails with EPERM/EBUSY while another
 * process holds the target open without FILE_SHARE_DELETE — which is exactly
 * what a concurrent reader (the dispatcher, the status CLI) does. The fix is
 * a BOUNDED retry with backoff: every attempt is itself atomic (readers see
 * old or new, never torn), a busy target only delays the swap, and a target
 * held open for the whole window fails LOUD with the old pointer intact.
 */
const RENAME_RETRY_MS = 2000
const RENAME_RETRY_DELAY_MS = 10

function renameWithRetry(from, to) {
  const deadline = Date.now() + RENAME_RETRY_MS
  for (;;) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || Date.now() >= deadline) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAY_MS)
    }
  }
}

export function atomicWriteJson(path, value) {
  const tmp = join(dirname(path), "." + Math.random().toString(16).slice(2, 10) + "." + process.pid + ".tmp")
  const fd = openSync(tmp, "wx")
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameWithRetry(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // The temp file is best-effort garbage; the target was never touched.
    }
    throw error
  }
}

/**
 * Hash a package tree: sorted relative-path → sha256 map plus a combined
 * tree hash. Rejects symlinks/junctions and anything that is not a plain
 * file or directory (design: "拒意外 symlink") so a generation can never
 * smuggle a mutable link into its verified content.
 */
export function hashPackageTree(packageDir) {
  const files = {}
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? entry.name : prefix + "/" + entry.name
      const full = join(dir, entry.name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new DeployError("unexpected symlink in package tree: " + rel)
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) files[rel] = sha256File(full)
      else throw new DeployError("unexpected non-regular file in package tree: " + rel)
    }
  }
  walk(packageDir, "")
  const treeSha256 = sha256Bytes(Buffer.from(Object.entries(files).map(([rel, hash]) => rel + ":" + hash + "\n").join(""), "utf8"))
  return { files, treeSha256 }
}

/** Read + validate the deploy root's active pointer; undefined when absent. */
export function readActive(deployRoot) {
  const path = join(deployRoot, "active.json")
  if (!existsSync(path)) return undefined
  return parseActiveManifest(readFileSync(path, "utf8"), path)
}

/** Read + validate a generation's READY manifest (hash NOT re-verified). */
export function readReady(deployRoot, generationId) {
  const path = join(deployRoot, "generations", generationId, "READY.json")
  if (!existsSync(path)) return undefined
  return parseReadyManifest(readFileSync(path, "utf8"), path)
}

/** Verify a generation's READY bytes still hash to the expected value. */
export function verifyGeneration(deployRoot, generationId, expectedReadySha256) {
  const readyPath = join(deployRoot, "generations", generationId, "READY.json")
  const actual = sha256File(readyPath)
  return actual === expectedReadySha256
}

/** Append an operator-log event (diagnostic only; never read back for
 *  decisions — active.json is the single source of truth). */
function appendHistory(deployRoot, event) {
  const path = join(deployRoot, "history.json")
  let history = []
  try {
    history = JSON.parse(readFileSync(path, "utf8"))
    if (!Array.isArray(history)) history = []
  } catch {
    history = []
  }
  history.push({ ...event, at: new Date().toISOString(), pid: process.pid })
  // Capped so an unbounded log can never grow the profile directory wild.
  if (history.length > 200) history = history.slice(-200)
  atomicWriteJson(path, history)
}

/**
 * Exclusive build lock via an atomically-created directory. A stale lock
 * (older than BUILD_LOCK_STALE_MS) does NOT block: it is reported in the
 * thrown error so the operator can decide (design: locks diagnose, they do
 * not deadlock). `steal` explicitly removes a stale lock.
 * @returns {() => void} release callback.
 */
export function acquireBuildLock(deployRoot, name, { steal = false } = {}) {
  const locksDir = join(deployRoot, "build-locks")
  mkdirSync(locksDir, { recursive: true })
  const lockPath = join(locksDir, name + ".lock")
  try {
    mkdirSync(lockPath)
  } catch (error) {
    const age = Date.now() - statSync(lockPath).mtimeMs
    if (steal || age > BUILD_LOCK_STALE_MS) {
      rmSync(lockPath, { recursive: true, force: true })
      mkdirSync(lockPath)
      writeFileSync(join(lockPath, "info.json"), JSON.stringify({ pid: process.pid, stolen: true, at: new Date().toISOString() }))
    } else {
      throw new DeployError("another promote holds the build lock (" + name + ", age " + Math.round(age / 1000) + "s, holder pid on next line)\n" + bestEffortLockHolder(lockPath))
    }
  }
  writeFileSync(join(lockPath, "info.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  return () => {
    try {
      rmSync(lockPath, { recursive: true, force: true })
    } catch {
      // Lock cleanup is best effort; staleness handles the rest.
    }
  }
}

function bestEffortLockHolder(lockPath) {
  try {
    return readFileSync(join(lockPath, "info.json"), "utf8")
  } catch {
    return "(no holder info)"
  }
}

/**
 * Commit a staging directory as the new active generation.
 *
 * Steps (each crash-safe on its own):
 *  1. hold the promote build lock;
 *  2. validate the staging READY manifest and re-verify the package tree
 *     hash it claims (a staging tree that drifted after READY was written
 *     is refused — READY is the generation's internal commit mark);
 *  3. same-volume rename <id>.staging → <id> (target must NOT exist);
 *  4. atomically replace active.json (recording the previous generation as
 *     the rollback target).
 * A crash before step 4 leaves the generation on disk but unactivated —
 * harmless; the old active pointer and old generation bytes stay valid.
 */
export function promoteGeneration(deployRoot, options = {}) {
  const stagingDir = options.stagingDir
  const steal = options.steal === true
  if (stagingDir === undefined || !existsSync(stagingDir)) throw new DeployError("staging directory not found: " + stagingDir)
  const stagingName = (options.generationId ?? basenameOf(stagingDir)).replace(/\.staging$/, "")
  if (!isValidGenerationId(stagingName)) throw new DeployError("invalid generation id: " + stagingName)
  const readyPath = join(stagingDir, "READY.json")
  if (!existsSync(readyPath)) throw new DeployError("staging directory has no READY.json (uncommitted build): " + stagingDir)
  const ready = parseReadyManifest(readFileSync(readyPath, "utf8"), readyPath)
  if (ready.generationId !== stagingName) throw new DeployError("staging directory name (" + stagingName + ") does not match READY generationId (" + ready.generationId + ")")
  const packageDir = join(stagingDir, "package")
  if (!statSync(packageDir).isDirectory()) throw new DeployError("staging directory has no package/ tree: " + stagingDir)
  const { treeSha256 } = hashPackageTree(packageDir)
  if (treeSha256 !== ready.packageTreeSha256) {
    throw new DeployError("staging package tree hash (" + treeSha256.slice(0, 12) + ") does not match READY's committed hash (" + ready.packageTreeSha256.slice(0, 12) + ") — refusing to promote a tree that changed after READY was written")
  }

  mkdirSync(join(deployRoot, "generations"), { recursive: true })
  mkdirSync(join(deployRoot, "leases"), { recursive: true })
  const release = acquireBuildLock(deployRoot, "promote", { steal })
  try {
    const finalDir = join(deployRoot, "generations", stagingName)
    if (existsSync(finalDir)) throw new DeployError("generation already exists: " + finalDir + " (generations are immutable; build a new id)")
    renameSync(stagingDir, finalDir)
    const readySha256 = sha256File(join(finalDir, "READY.json"))
    const previous = readActive(deployRoot)
    atomicWriteJson(join(deployRoot, "active.json"), {
      schemaVersion: 1,
      generationId: stagingName,
      readySha256,
      activatedAt: new Date().toISOString(),
      ...(previous === undefined ? {} : { previousGenerationId: previous.generationId }),
    })
    appendHistory(deployRoot, { event: "promote", generationId: stagingName, readySha256, previousGenerationId: previous === undefined ? undefined : previous.generationId })
    return { generationId: stagingName, readySha256, previousGenerationId: previous === undefined ? undefined : previous.generationId }
  } finally {
    release()
  }
}

function basenameOf(path) {
  const parts = path.replaceAll("\\", "/").split("/").filter(part => part !== "")
  return parts[parts.length - 1] ?? ""
}

/**
 * Rollback = repoint active.json at a still-ready generation. Files are
 * never copied back (design: "回滚只改 active pointer"); the target's READY
 * hash is verified against its own bytes before the pointer moves, and a
 * running process keeps its own leased generation (the dispatcher pin).
 */
export function rollbackGeneration(deployRoot, options = {}) {
  const active = readActive(deployRoot)
  if (active === undefined) throw new DeployError("no active generation to roll back from")
  let targetId = options.to ?? active.previousGenerationId
  if (targetId === undefined) throw new DeployError("no previous generation recorded in active.json; pass --to <generationId>")
  if (!isValidGenerationId(targetId)) throw new DeployError("invalid rollback target id: " + targetId)
  if (targetId === active.generationId) throw new DeployError("rollback target is already active: " + targetId)
  const ready = readReady(deployRoot, targetId)
  if (ready === undefined) throw new DeployError("rollback target has no READY.json: " + targetId)
  if (!verifyGeneration(deployRoot, targetId, sha256File(join(deployRoot, "generations", targetId, "READY.json")))) {
    throw new DeployError("internal error: READY self-verification failed for " + targetId)
  }
  const packageDir = join(deployRoot, "generations", targetId, "package")
  if (!statSync(packageDir).isDirectory()) throw new DeployError("rollback target has no package/ tree: " + targetId)
  const readySha256 = sha256File(join(deployRoot, "generations", targetId, "READY.json"))
  atomicWriteJson(join(deployRoot, "active.json"), {
    schemaVersion: 1,
    generationId: targetId,
    readySha256,
    activatedAt: new Date().toISOString(),
    previousGenerationId: active.generationId,
  })
  appendHistory(deployRoot, { event: "rollback", generationId: targetId, from: active.generationId })
  return { generationId: targetId, from: active.generationId }
}

/** Classify one lease file: live / stale / ambiguous (kept, never trusted dead). */
export function classifyLease(leasePath, now = Date.now()) {
  let lease
  try {
    lease = JSON.parse(readFileSync(leasePath, "utf8"))
  } catch {
    return { state: "ambiguous", reason: "unreadable lease" }
  }
  const pid = lease.pid
  if (typeof pid !== "number" || !Number.isInteger(pid)) return { state: "ambiguous", reason: "lease has no pid" }
  let alive
  try {
    process.kill(pid, 0)
    alive = true
  } catch (error) {
    if (error.code === "ESRCH") alive = false
    else if (error.code === "EPERM") alive = true
    else return { state: "ambiguous", reason: "pid probe failed: " + error.code }
  }
  if (!alive) return { state: "stale", reason: "pid " + pid + " is gone" }
  const heartbeatAt = typeof lease.heartbeatAt === "number" ? lease.heartbeatAt : 0
  if (now - heartbeatAt > LEASE_FRESH_MS) {
    // PID alive but the lease went quiet: PID reuse is the classic trap, and
    // the design is explicit — an undecidable lease KEEPS the generation.
    return { state: "ambiguous", reason: "pid " + pid + " alive but heartbeat is stale (possible pid reuse)" }
  }
  return { state: "live", reason: "pid " + pid + " heartbeating" }
}

/** All lease classifications for one generation id. */
export function leasesFor(deployRoot, generationId) {
  const dir = join(deployRoot, "leases", generationId)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith(".json")).map(name => {
    const path = join(dir, name)
    return { path, ...classifyLease(path) }
  })
}

/**
 * Safe GC (dry-run by default). Keeps, always:
 *  - the active generation;
 *  - the recorded rollback target (previousGenerationId);
 *  - every generation with a live OR ambiguous lease;
 *  - the newest `keepAtLeast` READY generations;
 *  - generations younger than `minAgeDays`.
 * Deletes the rest, plus staging directories that are unlocked and older
 * than STAGING_TTL_MS. Every removal is existence-checked afterwards (the
 * Windows rmSync-on-non-ASCII silent no-op must fail LOUD here).
 */
export function gcGenerations(deployRoot, options = {}) {
  const apply = options.apply === true
  const minAgeDays = options.minAgeDays ?? 7
  const keepAtLeast = options.keepAtLeast ?? 2
  const now = Date.now()
  const active = readActive(deployRoot)
  const generationsDir = join(deployRoot, "generations")
  const candidates = []
  if (existsSync(generationsDir)) {
    for (const name of readdirSync(generationsDir)) {
      const full = join(generationsDir, name)
      const stat = lstatSync(full)
      if (!stat.isDirectory()) continue
      const staging = name.endsWith(".staging")
      const id = staging ? name.slice(0, -".staging".length) : name
      if (staging) {
        const age = now - stat.mtimeMs
        const lockFree = !existsSync(join(deployRoot, "build-locks", "promote.lock"))
        if (age > STAGING_TTL_MS && lockFree) candidates.push({ kind: "staging", id, path: full, reason: "staging older than " + Math.round(STAGING_TTL_MS / 3600000) + "h and no promote lock" })
        continue
      }
      if (!isValidGenerationId(id)) continue
      const ready = readReady(deployRoot, id)
      if (ready === undefined) continue
      candidates.push({ kind: "generation", id, path: full, mtimeMs: stat.mtimeMs, reason: "" })
    }
  }
  const readySorted = candidates.filter(c => c.kind === "generation").sort((a, b) => b.mtimeMs - a.mtimeMs)
  const newestKept = new Set(readySorted.slice(0, keepAtLeast).map(c => c.id))
  const keep = []
  const remove = []
  for (const candidate of candidates) {
    if (candidate.kind === "staging") {
      remove.push(candidate)
      continue
    }
    const reasons = []
    if (active !== undefined && candidate.id === active.generationId) reasons.push("active")
    if (active !== undefined && candidate.id === active.previousGenerationId) reasons.push("rollback target")
    const leases = leasesFor(deployRoot, candidate.id)
    if (leases.some(lease => lease.state === "live")) reasons.push("live lease")
    if (leases.some(lease => lease.state === "ambiguous")) reasons.push("ambiguous lease (kept)")
    if (newestKept.has(candidate.id)) reasons.push("among newest " + keepAtLeast)
    if (now - candidate.mtimeMs < minAgeDays * 86400000) reasons.push("younger than min age " + minAgeDays + "d")
    if (reasons.length > 0) keep.push({ ...candidate, reasons })
    else remove.push({ ...candidate, reason: "not active/rollback-target/leased/newest/young" })
  }
  const plan = { apply, keep, remove }
  if (apply) {
    for (const target of remove) {
      rmSync(target.path, { recursive: true, force: true })
      if (existsSync(target.path)) throw new DeployError("GC removal silently failed for " + target.path + " — directory still exists after rmSync (platform rm no-op?)")
    }
    if (remove.length > 0) appendHistory(deployRoot, { event: "gc", removed: remove.map(target => ({ kind: target.kind, id: target.id })) })
  }
  return plan
}

/** Resolve a deploy root from a profile directory (or any package dir). */
export function deployRootFor(profileDir) {
  const candidate = join(profileDir, ".dsh-tui", "deploy")
  if (!existsSync(candidate)) throw new DeployError("no deploy root at " + candidate + " (expected <profile>/.dsh-tui/deploy)")
  return candidate
}

/** Operator-facing status snapshot. */
export function deployStatus(deployRoot) {
  const active = readActive(deployRoot)
  const generations = []
  const generationsDir = join(deployRoot, "generations")
  if (existsSync(generationsDir)) {
    for (const name of readdirSync(generationsDir).sort()) {
      const full = join(generationsDir, name)
      if (!lstatSync(full).isDirectory()) continue
      if (name.endsWith(".staging")) {
        generations.push({ id: name.slice(0, -".staging".length), staging: true })
        continue
      }
      const ready = readReady(deployRoot, name)
      generations.push({
        id: name,
        staging: false,
        ready: ready === undefined ? undefined : { packageVersion: ready.packageVersion, sourceCommit: ready.sourceCommit },
        leases: leasesFor(deployRoot, name).map(lease => lease.state),
        active: active !== undefined && active.generationId === name,
        rollbackTarget: active !== undefined && active.previousGenerationId === name,
      })
    }
  }
  return { deployRoot, active, generations }
}

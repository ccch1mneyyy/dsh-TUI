#!/usr/bin/env node
/**
 * verify-deploy-lease-liveness.mjs — lease 强判活回归（deploy-transition
 * 设计 §S04 M1③："清理器通过平台进程创建时间核活"，PID 不够判活）。
 *
 * 覆盖：
 *   - processStartIdentity：本进程身份形状正确（linux＝boot 相对 tick，
 *     其余平台＝wall-clock start，量级与 Date.now()-uptime 一致）；
 *   - matchProcessStartIdentity 矩阵：linux tick 精确等/不等（不等＝可证
 *     复用）；wall-clock 容差内＝same process、容差外＝inconclusive
 *     （时钟步进可造成假差，绝不单凭它判死）；kind 不一致＝inconclusive；
 *   - 真·子进程判活：活 pid＋匹配创建时间＋**过期心跳** → live(strong)
 *     （心跳写失败不再误判 ambiguous——强判活的正向收益）；pid 死 → stale；
 *   - linux 专属：pid 活但 tick 不匹配 → stale(strong)（PID 复用被证死，
 *     可回收）；win32 对应形状降级为心跳回退（fail-safe，不误删）；
 *   - 向后兼容：无 processStartIdentity 的 M0 lease 沿用心跳三态；
 *   - acquireLease 落盘带身份；GC 只回收 stale lease 文件（dry-run 只报
 *     告、apply 才删；ambiguous/live 文件不动）。
 *
 * 平台：全平台（linux 分支自动生效；win32 走 CIM 探针，一次批查询）。
 * 运行：node scripts/verify-deploy-lease-liveness.mjs（隔离 tmp fixture）。
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classifyLease, gcGenerations, leasesFor, promoteGeneration, hashPackageTree } from "./deploy/core.mjs"
import {
  LEASE_HEARTBEAT_MS,
  acquireLease,
  currentProcessStartIdentity,
  matchProcessStartIdentity,
  processStartIdentity,
} from "../dispatch/resolve.mjs"

let failures = 0
let skips = 0
function check(name, ok, detail = "") {
  console.log((ok ? "PASS" : "FAIL") + ": " + name + (detail === "" ? "" : "  (" + detail + ")"))
  if (!ok) failures += 1
}
function skip(name, reason) {
  console.log("SKIP: " + name + "  (" + reason + ")")
  skips += 1
}

// ── identity shape ────────────────────────────────────────────────────────
{
  const identity = processStartIdentity()
  const expectedKind = process.platform === "linux" ? "linux-starttime-ticks" : "wall-start-ms"
  check("identity: this process records the platform kind", identity.kind === expectedKind, JSON.stringify(identity))
  if (identity.kind === "linux-starttime-ticks") {
    check("identity: linux ticks are a positive integer", Number.isInteger(identity.ticks) && identity.ticks > 0)
  } else {
    const wallNow = Date.now() - Math.round(process.uptime() * 1000)
    check("identity: wall start is within 5s of Date.now()-uptime", Math.abs(identity.wallMs - wallNow) <= 5000)
  }
}

// ── match matrix (pure) ───────────────────────────────────────────────────
{
  check("match: linux tick equality is the same process", matchProcessStartIdentity(
    { kind: "linux-starttime-ticks", ticks: 12345 }, { kind: "linux-starttime-ticks", ticks: 12345 }) === true)
  check("match: linux tick difference PROVES reuse", matchProcessStartIdentity(
    { kind: "linux-starttime-ticks", ticks: 12345 }, { kind: "linux-starttime-ticks", ticks: 99999 }) === false)
  check("match: wall clock within tolerance is the same process", matchProcessStartIdentity(
    { kind: "wall-start-ms", wallMs: 1000000 }, { kind: "wall-start-ms", wallMs: 1002000 }) === true)
  check("match: wall clock far apart stays inconclusive (clock-step fail-safe)", matchProcessStartIdentity(
    { kind: "wall-start-ms", wallMs: 1000000 }, { kind: "wall-start-ms", wallMs: 999999000 }) === undefined)
  check("match: kind mismatch is incomparable", matchProcessStartIdentity(
    { kind: "wall-start-ms", wallMs: 1 }, { kind: "linux-starttime-ticks", ticks: 2 }) === undefined)
  check("match: missing side is incomparable", matchProcessStartIdentity(undefined, { kind: "wall-start-ms", wallMs: 1 }) === undefined
    && matchProcessStartIdentity({ kind: "wall-start-ms", wallMs: 1 }, undefined) === undefined)
}

// ── fixture root + lease writer ───────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "verify-lease-"))
const leaseDir = join(tmp, "leases", "gen-x")
mkdirSync(leaseDir, { recursive: true })
function writeLease(name, payload) {
  const path = join(leaseDir, name)
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, generationId: "gen-x", mode: "generation", ...payload }))
  return path
}

// ── real child: strong live despite a stale heartbeat ─────────────────────
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" })
await new Promise(resolve => child.once("spawn", resolve))
const childIdentity = currentProcessStartIdentity(child.pid)
if (childIdentity === undefined) {
  skip("real child: platform probe unavailable", "classify falls back to heartbeat semantics")
} else {
  const staleHeartbeat = Date.now() - LEASE_HEARTBEAT_MS * 20
  const leasePath = writeLease(child.pid + "-probe.json", {
    pid: child.pid, nonce: "probe", startedAt: staleHeartbeat, heartbeatAt: staleHeartbeat,
    processStartIdentity: childIdentity,
  })
  const live = classifyLease(leasePath)
  check("real child: matching creation time upgrades a stale heartbeat to live(strong)",
    live.state === "live" && live.strong === true, live.reason)

  // PID-reuse proof per platform.
  if (process.platform === "linux") {
    const wrongTicks = childIdentity.ticks + 424242
    const reusePath = writeLease(child.pid + "-reuse.json", {
      pid: child.pid, nonce: "reuse", startedAt: Date.now(), heartbeatAt: Date.now(),
      processStartIdentity: { kind: "linux-starttime-ticks", ticks: wrongTicks },
    })
    const reused = classifyLease(reusePath)
    check("real child(linux): tick mismatch classifies reuse as stale(strong)",
      reused.state === "stale" && reused.strong === true, reused.reason)
  } else {
    const farOff = writeLease(child.pid + "-faroff.json", {
      pid: child.pid, nonce: "faroff", startedAt: Date.now(), heartbeatAt: Date.now(),
      processStartIdentity: { kind: "wall-start-ms", wallMs: Date.now() - 90 * 24 * 3600 * 1000 },
    })
    const fallback = classifyLease(farOff)
    check("real child(non-linux): wall-clock mismatch alone never proves reuse (fresh heartbeat → live)",
      fallback.state === "live" && fallback.strong !== true, fallback.reason)
    const quiet = writeLease(child.pid + "-quiet.json", {
      pid: child.pid, nonce: "quiet", startedAt: Date.now(), heartbeatAt: Date.now() - LEASE_HEARTBEAT_MS * 20,
      processStartIdentity: { kind: "wall-start-ms", wallMs: Date.now() - 90 * 24 * 3600 * 1000 },
    })
    const ambiguous = classifyLease(quiet)
    check("real child(non-linux): mismatch + stale heartbeat stays ambiguous (kept, not deleted)",
      ambiguous.state === "ambiguous", ambiguous.reason)
  }
}

// ── dead pid: stale regardless of identity ────────────────────────────────
{
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"])
  await new Promise(resolve => dead.once("exit", resolve))
  const leasePath = writeLease(dead.pid + "-dead.json", {
    pid: dead.pid, nonce: "dead", startedAt: Date.now(), heartbeatAt: Date.now(),
    processStartIdentity: processStartIdentity(),
  })
  const classified = classifyLease(leasePath)
  check("dead pid: classified stale (ESRCH beats any recorded identity)", classified.state === "stale", classified.reason)
}

// ── backward compatibility: M0 leases without an identity ─────────────────
{
  const child2 = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" })
  await new Promise(resolve => child2.once("spawn", resolve))
  const fresh = writeLease(child2.pid + "-m0-fresh.json", {
    pid: child2.pid, nonce: "m0f", startedAt: Date.now(), heartbeatAt: Date.now(),
  })
  const quiet = writeLease(child2.pid + "-m0-quiet.json", {
    pid: child2.pid, nonce: "m0q", startedAt: Date.now(), heartbeatAt: Date.now() - LEASE_HEARTBEAT_MS * 20,
  })
  check("M0 lease without identity: fresh heartbeat still live", classifyLease(fresh).state === "live")
  check("M0 lease without identity: stale heartbeat still ambiguous", classifyLease(quiet).state === "ambiguous")
  child2.kill()
  await new Promise(resolve => child2.once("exit", resolve))
}

// ── acquireLease writes the identity; GC reclaims only stale files ────────
{
  const deployRoot = join(tmp, "deploy")
  mkdirSync(join(deployRoot, "generations"), { recursive: true })
  mkdirSync(join(deployRoot, "leases"), { recursive: true })
  const lease = acquireLease(deployRoot, "self", "generation")
  const payload = JSON.parse(readFileSync(lease.path, "utf8"))
  check("acquireLease: lease file carries processStartIdentity", payload.processStartIdentity?.kind === processStartIdentity().kind)
  check("acquireLease: lease pid is this process", payload.pid === process.pid)
  check("acquireLease: classify sees this live process as live(strong)",
    classifyLease(lease.path).state === "live" && classifyLease(lease.path).strong === true)

  // A tiny generation so gcGenerations can scan it, plus a dead lease on it.
  const staging = join(deployRoot, "generations", "g1.staging")
  mkdirSync(join(staging, "package"), { recursive: true })
  writeFileSync(join(staging, "package", "index.js"), "export const generation = 'g1'\n")
  const { treeSha256 } = hashPackageTree(join(staging, "package"))
  writeFileSync(join(staging, "READY.json"), JSON.stringify({
    schemaVersion: 1, generationId: "g1", packageVersion: "9.9.9", sourceCommit: "fixture",
    nodeMajor: 24, packageTreeSha256: treeSha256, files: {},
  }))
  promoteGeneration(deployRoot, { stagingDir: staging })
  mkdirSync(join(deployRoot, "leases", "g1"), { recursive: true })
  const deadPid = 0x7fffffff - ((Date.now() / 1000) | 0) // a pid nothing owns
  const staleLease = join(deployRoot, "leases", "g1", deadPid + "-dead.json")
  writeFileSync(staleLease, JSON.stringify({
    schemaVersion: 1, generationId: "g1", mode: "generation", pid: deadPid, nonce: "x",
    startedAt: Date.now(), heartbeatAt: Date.now(), processStartIdentity: processStartIdentity(),
  }))
  const ambiguousLease = join(deployRoot, "leases", "g1", child.pid + "-amb.json")
  writeFileSync(ambiguousLease, JSON.stringify({
    schemaVersion: 1, generationId: "g1", mode: "generation", pid: child.pid, nonce: "amb",
    startedAt: Date.now(), heartbeatAt: Date.now(), processStartIdentity: { kind: "wall-start-ms", wallMs: 1 },
  }))

  const dry = gcGenerations(deployRoot, { apply: false })
  check("gc dry-run: reports the stale lease for reclamation",
    dry.reclaimLeases.some(entry => entry.path === staleLease), JSON.stringify(dry.reclaimLeases))
  check("gc dry-run: does not delete anything", existsSync(staleLease) && existsSync(ambiguousLease))
  const applied = gcGenerations(deployRoot, { apply: true })
  check("gc apply: reclaims the stale lease file", !existsSync(staleLease))
  check("gc apply: ambiguous lease file survives (kept, not deleted)", existsSync(ambiguousLease))
  check("gc apply: this process's live lease survives", existsSync(lease.path))
  check("gc apply: the active generation survives (live lease)", existsSync(join(deployRoot, "generations", "g1")))
  void applied
  lease.release()
}

child.kill()
await new Promise(resolve => child.once("exit", resolve))
rmSync(tmp, { recursive: true, force: true })

console.log(failures === 0 ? "\nALL PASS" + (skips === 0 ? "" : " (" + skips + " skipped)") : "\n" + failures + " FAILURES")
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * verify-deploy-generations.mjs — versioned-deploy M0 回归（设计 §S04
 * "回归与验证形状" 的 M0 子集）。
 *
 * 覆盖：
 *   - manifest 解析矩阵：合法形状通过；截断 JSON / 未知 schemaVersion /
 *     越权 generationId（../、路径分隔、空）/ 坏 readySha256 全部 fail
 *     closed（抛错，而不是静默回 canonical）；
 *   - promote：staging→final 改名（目标已存在＝不可变冲突拒绝）、READY
 *     树哈希漂移拒绝、previousGenerationId 链、build-lock 互斥、过期
 *     锁不死锁；
 *   - active.json 原子性：并发读者子进程在 N 轮指针替换期间只能看到
 *     旧值或新值，绝不缺文件/半写（Windows rename 边界按设计验证）；
 *   - 启动 pin（dispatch/resolve）：generation 模式先写 lease 再解析、
 *     同进程内翻转指针不换代、legacy/source/fail-closed 三态、
 *     Junction 开发轨标记（src/ + tsconfig.json）优先于 manifest；
 *   - lease 分类与生命周期：live（活 pid+新心跳）/ stale（死 pid）/
 *     ambiguous（活 pid+旧心跳＝疑似 PID 复用；保留不删）/ 结构损坏；
 *   - GC：dry-run 默认；active/rollback 目标/live lease/最新 N 代/保留
 *     窗内一律保留；仅无 lease 旧代与过期 staging 被清；删除后存在性
 *     复核（Windows rmSync 静默 no-op 必须炸响）；
 *   - 回滚＝只改指针：目标代文件不动、坏目标拒绝、自指拒绝；
 *   - 包树哈希：内嵌 symlink 拒绝（无权限环境显式 SKIP）。
 *
 * 平台：全平台。运行：node scripts/verify-deploy-generations.mjs
 * （隔离 tmp fixture，不触碰真实 HOME/DSH_HOME/profile）。
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  STAGING_TTL_MS,
  atomicWriteJson,
  classifyLease,
  gcGenerations,
  hashPackageTree,
  leasesFor,
  promoteGeneration,
  readActive,
  rollbackGeneration,
} from "./deploy/core.mjs"
import { acquireLease, isValidGenerationId, parseActiveManifest, parseReadyManifest, resolveTuiRuntime } from "../dispatch/resolve.mjs"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
// 子进程用例不能直接 import 仓库里的 dispatch/resolve.mjs：仓库根自带
// src/ + tsconfig.json（开发标记），resolveTuiRuntime 会按 source 模式
// 走。复制到中立的 tmp 包目录再解析，等价于安装副本。
const harnessPkg = join(tmpdir(), "verify-deploy-harness-" + process.pid.toString(16) + "-" + Math.random().toString(16).slice(2, 8))
const resolveMjsPath = join(harnessPkg, "dispatch", "resolve.mjs")
mkdirSync(join(harnessPkg, "dispatch"), { recursive: true })
cpSync(join(repoRoot, "dispatch", "resolve.mjs"), resolveMjsPath)

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
function throws(name, fn, needle = "") {
  let message = ""
  try {
    fn()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check(name, message !== "" && (needle === "" || message.includes(needle)), message)
}
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

// ── manifest parser matrix ────────────────────────────────────────────────
{
  const valid = JSON.stringify({ schemaVersion: 1, generationId: "0.12.0-c1187eb0-abcd", readySha256: "a".repeat(64), activatedAt: "2026-10-03T00:00:00.000Z" })
  check("parse: valid active manifest", parseActiveManifest(valid, "t.json").generationId === "0.12.0-c1187eb0-abcd")
  throws("parse: truncated JSON fails closed", () => parseActiveManifest(valid.slice(0, 40), "t.json"))
  throws("parse: unknown schemaVersion fails closed", () => parseActiveManifest(JSON.stringify({ schemaVersion: 2, generationId: "a", readySha256: "a".repeat(64), activatedAt: "x" }), "t.json"))
  for (const bad of ["../escape", "a/b", "", ".hidden", "a\\b", "x:y"]) {
    throws("parse: traversal/separator generationId rejected (" + JSON.stringify(bad) + ")", () => parseActiveManifest(JSON.stringify({ schemaVersion: 1, generationId: bad, readySha256: "a".repeat(64), activatedAt: "x" }), "t.json"))
  }
  throws("parse: bad readySha256 rejected", () => parseActiveManifest(JSON.stringify({ schemaVersion: 1, generationId: "g", readySha256: "nothex", activatedAt: "x" }), "t.json"))
  check("parse: charset whitelist", ["a", "0.12.0-x_y.z", "A-9"].every(id => isValidGenerationId(id)) && !["/x", "..", "a b"].some(id => isValidGenerationId(id)))
  const ready = JSON.stringify({ schemaVersion: 1, generationId: "g", packageVersion: "0.12.0", packageTreeSha256: "b".repeat(64), files: {} })
  check("parse: valid READY manifest", parseReadyManifest(ready, "r.json").packageVersion === "0.12.0")
  throws("parse: READY with bad tree hash rejected", () => parseReadyManifest(JSON.stringify({ schemaVersion: 1, generationId: "g", packageVersion: "1", packageTreeSha256: "zz" }), "r.json"))
}

// ── fixture helpers ───────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "verify-deploy-"))
const deployRoot = join(tmp, "profile", ".dsh-tui", "deploy")
mkdirSync(join(deployRoot, "generations"), { recursive: true })
mkdirSync(join(deployRoot, "leases"), { recursive: true })

function buildStaging(id, { mutateAfterReady = false } = {}) {
  const stagingDir = join(deployRoot, "generations", id + ".staging")
  const packageDir = join(stagingDir, "package", "lib", "types")
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, "index.js"), "export const generation = " + JSON.stringify(id) + "\n")
  writeFileSync(join(stagingDir, "package", "assets.txt"), "assets of " + id + "\n")
  const { treeSha256 } = hashPackageTree(join(stagingDir, "package"))
  writeFileSync(join(stagingDir, "READY.json"), JSON.stringify({
    schemaVersion: 1,
    generationId: id,
    packageVersion: "9.9.9-" + id,
    sourceCommit: "fixture",
    nodeMajor: Number(process.versions.node.split(".")[0]),
    packageTreeSha256: treeSha256,
    files: {},
  }, null, 2))
  if (mutateAfterReady) writeFileSync(join(packageDir, "extra.js"), "drift\n")
  return stagingDir
}

function setActive(id) {
  atomicWriteJson(join(deployRoot, "active.json"), {
    schemaVersion: 1,
    generationId: id,
    readySha256: sha256File(join(deployRoot, "generations", id, "READY.json")),
    activatedAt: new Date().toISOString(),
    ...(readActive(deployRoot) === undefined ? {} : { previousGenerationId: readActive(deployRoot).generationId }),
  })
}

// ── promote lifecycle ─────────────────────────────────────────────────────
{
  const s1 = buildStaging("gen-a")
  const r1 = promoteGeneration(deployRoot, { stagingDir: s1 })
  check("promote: first generation activates", readActive(deployRoot).generationId === "gen-a")
  check("promote: result reports ready hash", r1.readySha256.length === 64)
  check("promote: staging renamed to final", existsSync(join(deployRoot, "generations", "gen-a", "package", "lib", "types", "index.js")) && !existsSync(s1))

  const s2 = buildStaging("gen-b")
  const r2 = promoteGeneration(deployRoot, { stagingDir: s2 })
  check("promote: second promote records rollback target", r2.previousGenerationId === "gen-a" && readActive(deployRoot).previousGenerationId === "gen-a")

  const drifted = buildStaging("gen-drift", { mutateAfterReady: true })
  throws("promote: tree drifted after READY is refused", () => promoteGeneration(deployRoot, { stagingDir: drifted }), "does not match READY")
  check("promote: refused promote leaves pointer untouched", readActive(deployRoot).generationId === "gen-b")

  const mismatch = buildStaging("gen-mismatch")
  const readyPath = join(mismatch, "READY.json")
  writeFileSync(readyPath, readFileSync(readyPath, "utf8").replaceAll('"gen-mismatch"', '"gen-other"'))
  throws("promote: staging name/READY id mismatch refused", () => promoteGeneration(deployRoot, { stagingDir: mismatch }), "does not match READY")

  mkdirSync(join(deployRoot, "generations", "gen-dupe"), { recursive: true })
  throws("promote: existing final generation is immutable", () => promoteGeneration(deployRoot, { stagingDir: buildStaging("gen-dupe") }), "already exists")

  const noReady = join(deployRoot, "generations", "gen-noready.staging")
  mkdirSync(join(noReady, "package"), { recursive: true })
  throws("promote: staging without READY refused", () => promoteGeneration(deployRoot, { stagingDir: noReady }), "no READY.json")
}

// ── build lock ────────────────────────────────────────────────────────────
{
  mkdirSync(join(deployRoot, "build-locks", "promote.lock"), { recursive: true })
  writeFileSync(join(deployRoot, "build-locks", "promote.lock", "info.json"), JSON.stringify({ pid: 1, at: new Date().toISOString() }))
  throws("promote: concurrent promote blocked with holder diagnostics", () => promoteGeneration(deployRoot, { stagingDir: buildStaging("gen-locked") }), "build lock")
  // 把锁 aged 到过期窗口之后：staleness 路径应报告而非永久锁死。
  const stale = new Date(Date.now() - 11 * 60 * 1000)
  utimesSync(join(deployRoot, "build-locks", "promote.lock"), stale, stale)
  promoteGeneration(deployRoot, { stagingDir: buildStaging("gen-stolen") })
  check("promote: stale build lock does not deadlock", readActive(deployRoot).generationId === "gen-stolen")
}

// ── active.json atomic replace: readers only ever see old-or-new ─────────
{
  // 注意 `node -e` 的 argv 没有脚本槽位：用户参数从 argv[1] 开始。
  const readerSrc = [
    "const path = process.argv[1]",
    "const fs = require('node:fs')",
    "let violations = 0, reads = 0",
    "const deadline = Date.now() + 2000",
    "while (Date.now() < deadline) {",
    "  try {",
    "    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))",
    "    if (typeof parsed.generationId !== 'string') violations++",
    "    reads++",
    "  } catch { violations++ }",
    "}",
    "console.log(JSON.stringify({ violations, reads }))",
  ].join("\n")
  const reader = spawn(process.execPath, ["-e", readerSrc, join(deployRoot, "active.json")], { stdio: ["ignore", "pipe", "inherit"] })
  let out = ""
  reader.stdout.on("data", chunk => { out += chunk })
  await new Promise(resolve => setTimeout(resolve, 150))
  for (let i = 0; i < 40; i += 1) {
    // 走与 promote 相同的指针替换路径（atomicWriteJson），哈希用真实
    // READY 字节哈希，保证事后指针仍是合法 manifest。
    setActive(i % 2 === 0 ? "gen-a" : "gen-b")
  }
  const result = await new Promise(resolve => reader.on("close", () => resolve(JSON.parse(out))))
  check("atomic-replace: reader never saw missing/half manifest (" + result.reads + " reads)", result.violations === 0 && result.reads > 100, JSON.stringify(result))
  // 供后续 pin 用例的确定性起点。
  setActive("gen-a")
}

// ── resolver modes + pin (child processes, fresh globalThis each) ────────
function childResolve(code, extraArgs) {
  const run = spawnSync(process.execPath, ["-e", code, resolveMjsPath, ...(extraArgs ?? [])], { encoding: "utf8", timeout: 30000 })
  return { status: run.status, stdout: (run.stdout || "").trim(), stderr: (run.stderr || "").trim() }
}
// `node -e` 求值脚本的 argv 从 argv[1] 起是用户参数；Windows 路径必须经
// pathToFileURL 转成 file:// URL 才能 dynamic import。
const RESOLVE_ONCE = [
  "const { pathToFileURL } = await import('node:url')",
  "const resolveMjs = process.argv[1]",
  "process.env.DSH_TUI_DEPLOY_ROOT = process.argv[2]",
  "const { resolveTuiRuntime } = await import(pathToFileURL(resolveMjs).href)",
  "const pin = await resolveTuiRuntime(pathToFileURL(resolveMjs).href)",
  "console.log('PIN ' + JSON.stringify({ mode: pin.mode, generationId: pin.generationId, packageRoot: pin.packageRootUrl ?? '' }))",
].join("\n")

{
  const genMode = childResolve(RESOLVE_ONCE, [deployRoot])
  const pinLine = genMode.stdout.split(/\r?\n/).find(line => line.startsWith("PIN "))
  const parsed = JSON.parse((pinLine ?? "PIN {}").slice(4))
  check("pin: generation mode resolves the active generation", genMode.status === 0 && parsed.mode === "generation" && parsed.generationId === "gen-a" && parsed.packageRoot.includes("gen-a"), genMode.stdout + genMode.stderr)
  // lease 存在性要在持 lease 的子进程活着时看：干净退出的子进程会按
  // 契约自行释放 lease（下面的 release 用例锁的就是这一半契约）。
  {
    const child = spawn(process.execPath, ["-e", [
      "const { pathToFileURL } = await import('node:url')",
      "const resolveMjs = process.argv[1]",
      "process.env.DSH_TUI_DEPLOY_ROOT = process.argv[2]",
      "const { resolveTuiRuntime } = await import(pathToFileURL(resolveMjs).href)",
      "const pin = await resolveTuiRuntime(pathToFileURL(resolveMjs).href)",
      "console.log('LEASE ' + (pin.lease ? pin.lease.path : 'none'))",
      "setInterval(() => {}, 60000)",
    ].join("\n"), resolveMjsPath, deployRoot], { stdio: ["ignore", "pipe", "inherit"] })
    let leaseLine = ""
    child.stdout.on("data", chunk => { leaseLine += chunk })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("lease holder child did not report")), 15000)
      const poll = setInterval(() => {
        if (leaseLine.includes("LEASE ")) {
          clearTimeout(timer)
          clearInterval(poll)
          resolve()
        }
      }, 25)
      child.on("close", () => { clearTimeout(timer); clearInterval(poll); resolve() })
    })
    const leasePath = leaseLine.trim().split(/\r?\n/).find(line => line.startsWith("LEASE "))?.slice(6)
    check("pin: lease exists while the pinning process lives", leasePath !== undefined && existsSync(leasePath) && leasesFor(deployRoot, "gen-a").some(lease => lease.state === "live"), leaseLine.trim())
    child.kill()
    await new Promise(resolve => { child.on("close", resolve) })
  }

  // 同进程 pin：子进程先 resolve、再自己翻转指针、再 resolve 一次。
  const pinMode = childResolve([
    "const { pathToFileURL } = await import('node:url')",
    "const resolveMjs = process.argv[1]",
    "process.env.DSH_TUI_DEPLOY_ROOT = process.argv[2]",
    "const fs = await import('node:fs')",
    "const path = await import('node:path')",
    "const { resolveTuiRuntime } = await import(pathToFileURL(resolveMjs).href)",
    "const first = await resolveTuiRuntime(pathToFileURL(resolveMjs).href)",
    "const activePath = path.join(process.argv[2], 'active.json')",
    "const active = JSON.parse(fs.readFileSync(activePath, 'utf8'))",
    "active.generationId = 'gen-b'",
    "fs.writeFileSync(activePath, JSON.stringify(active))",
    "const second = await resolveTuiRuntime(pathToFileURL(resolveMjs).href)",
    "console.log('PIN2 ' + JSON.stringify({ first: first.generationId, second: second.generationId }))",
  ].join("\n"), [deployRoot])
  const pin2Line = pinMode.stdout.split(/\r?\n/).find(line => line.startsWith("PIN2 "))
  const pin2 = JSON.parse((pin2Line ?? "PIN2 {}").slice(5))
  check("pin: mid-process pointer flip does not switch this process", pin2.first === "gen-a" && pin2.second === "gen-a", pinMode.stdout + pinMode.stderr)
  setActive("gen-a")

  // legacy：deploy root 存在但无 active.json。
  const legacyRoot = join(tmp, "legacy", ".dsh-tui", "deploy")
  mkdirSync(join(legacyRoot, "generations"), { recursive: true })
  const legacy = childResolve(RESOLVE_ONCE, [legacyRoot])
  check("pin: legacy mode without active.json", legacy.status === 0 && legacy.stdout.includes('"legacy"'), legacy.stdout + legacy.stderr)

  // source 模式：包目录带 dev 标记（src/ + tsconfig.json）时无视
  // active.json —— Junction 开发轨的只读识别。
  const sourcePkg = join(tmp, "source-pkg")
  mkdirSync(join(sourcePkg, "src"), { recursive: true })
  mkdirSync(join(sourcePkg, "dispatch"), { recursive: true })
  writeFileSync(join(sourcePkg, "tsconfig.json"), "{}\n")
  const sourceResolve = join(sourcePkg, "dispatch", "resolve.mjs")
  const { cpSync } = await import("node:fs")
  cpSync(resolveMjsPath, sourceResolve)
  const sourceMode = childResolve([
    "const { pathToFileURL } = await import('node:url')",
    "const sourceResolve = process.argv[3]",
    "process.env.DSH_TUI_DEPLOY_ROOT = process.argv[2]",
    "const { resolveTuiRuntime } = await import(pathToFileURL(sourceResolve).href)",
    "const pin = await resolveTuiRuntime(pathToFileURL(sourceResolve).href)",
    "console.log('PIN ' + JSON.stringify({ mode: pin.mode, generationId: pin.generationId }))",
  ].join("\n"), [deployRoot, sourceResolve])
  check("pin: source-mode markers bypass active.json (Junction dev track)", sourceMode.status === 0 && sourceMode.stdout.includes('"source"') && sourceMode.stdout.includes("source-"), sourceMode.stdout + sourceMode.stderr)

  // fail-closed：active 指向不存在的代。
  const activePath = join(deployRoot, "active.json")
  const goodActive = readFileSync(activePath, "utf8")
  writeFileSync(activePath, JSON.stringify({ schemaVersion: 1, generationId: "gen-missing", readySha256: "c".repeat(64), activatedAt: new Date().toISOString() }))
  const failClosed = childResolve([
    "const { pathToFileURL } = await import('node:url')",
    "const resolveMjs = process.argv[1]",
    "process.env.DSH_TUI_DEPLOY_ROOT = process.argv[2]",
    "const { resolveTuiRuntime } = await import(pathToFileURL(resolveMjs).href)",
    "try { await resolveTuiRuntime(pathToFileURL(resolveMjs).href); console.log('RESOLVED') } catch (error) { console.log('REJECTED: ' + error.message) }",
  ].join("\n"), [deployRoot])
  check("pin: missing generation fails closed (no silent fallback)", failClosed.stdout.includes("REJECTED"), failClosed.stdout + failClosed.stderr)
  // fail-closed：READY 哈希对不上。
  writeFileSync(activePath, JSON.stringify({ schemaVersion: 1, generationId: "gen-a", readySha256: "d".repeat(64), activatedAt: new Date().toISOString() }))
  const badHash = childResolve([
    "const { pathToFileURL } = await import('node:url')",
    "const resolveMjs = process.argv[1]",
    "process.env.DSH_TUI_DEPLOY_ROOT = process.argv[2]",
    "const { resolveTuiRuntime } = await import(pathToFileURL(resolveMjs).href)",
    "try { await resolveTuiRuntime(pathToFileURL(resolveMjs).href); console.log('RESOLVED') } catch (error) { console.log('REJECTED: ' + error.message) }",
  ].join("\n"), [deployRoot])
  check("pin: READY hash mismatch fails closed", badHash.stdout.includes("READY hash mismatch"), badHash.stdout + badHash.stderr)
  writeFileSync(activePath, goodActive)
}

// ── lease lifecycle + classification ─────────────────────────────────────
{
  const lease = acquireLease(deployRoot, "gen-a", "generation")
  check("lease: acquire writes the lease file", existsSync(lease.path))
  lease.heartbeat()
  check("lease: heartbeat refreshes without error", existsSync(lease.path))
  lease.release()
  check("lease: release removes the lease file", !existsSync(lease.path))

  const alive = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" })
  await new Promise(resolve => setTimeout(resolve, 150))
  const leaseDir = join(deployRoot, "leases", "gen-leases")
  mkdirSync(leaseDir, { recursive: true })
  const livePath = join(leaseDir, "live.json")
  writeFileSync(livePath, JSON.stringify({ pid: alive.pid, heartbeatAt: Date.now(), generationId: "gen-leases" }))
  const stalePath = join(leaseDir, "stale.json")
  writeFileSync(stalePath, JSON.stringify({ pid: 3999999, heartbeatAt: Date.now(), generationId: "gen-leases" }))
  const ambiguousPath = join(leaseDir, "ambiguous.json")
  writeFileSync(ambiguousPath, JSON.stringify({ pid: alive.pid, heartbeatAt: Date.now() - 3600000, generationId: "gen-leases" }))
  writeFileSync(join(leaseDir, "garbage.json"), "{not json")
  check("lease: live pid + fresh heartbeat", classifyLease(livePath).state === "live")
  check("lease: dead pid is stale", classifyLease(stalePath).state === "stale")
  check("lease: alive pid with stale heartbeat is ambiguous (kept)", classifyLease(ambiguousPath).state === "ambiguous")
  check("lease: unreadable lease is ambiguous (kept)", classifyLease(join(leaseDir, "garbage.json")).state === "ambiguous")
  alive.kill()
}

// ── GC matrix ────────────────────────────────────────────────────────────
{
  // 代次链：… → gen-c（将变老）→ gen-leased（将变老+持 lease）→ gen-newest。
  promoteGeneration(deployRoot, { stagingDir: buildStaging("gen-c") })
  promoteGeneration(deployRoot, { stagingDir: buildStaging("gen-leased") })
  promoteGeneration(deployRoot, { stagingDir: buildStaging("gen-newest") })
  const eightDaysAgo = new Date(Date.now() - 8 * 86400000)
  utimesSync(join(deployRoot, "generations", "gen-c"), eightDaysAgo, eightDaysAgo)
  utimesSync(join(deployRoot, "generations", "gen-leased"), eightDaysAgo, eightDaysAgo)
  // acquireLease 会自建 lease 目录；holder 直接写文件，先补目录。
  mkdirSync(join(deployRoot, "leases", "gen-leased"), { recursive: true })
  const holder = spawn(process.execPath, [
    "-e",
    [
      "const fs = require('node:fs')",
      "const path = process.argv[1]",
      "const beat = () => fs.writeFileSync(path, JSON.stringify({ pid: process.pid, heartbeatAt: Date.now(), generationId: 'gen-leased' }))",
      "beat()",
      "setInterval(beat, 500)",
    ].join("\n"),
    join(deployRoot, "leases", "gen-leased", "holder.json"),
  ], { stdio: "ignore" })
  await new Promise(resolve => setTimeout(resolve, 200))

  const staleStaging = join(deployRoot, "generations", "gen-abandoned.staging")
  mkdirSync(join(staleStaging, "package"), { recursive: true })
  utimesSync(staleStaging, eightDaysAgo, eightDaysAgo)

  const dry = gcGenerations(deployRoot)
  const dryRemove = new Set(dry.remove.map(item => item.id))
  check("gc: dry-run by default", dry.apply === false)
  check("gc: active kept", dry.keep.some(item => item.id === "gen-newest" && item.reasons.includes("active")))
  check("gc: rollback target kept", dry.keep.some(item => item.id === "gen-leased" && item.reasons.includes("rollback target")))
  check("gc: leased old generation kept (live lease)", dry.keep.some(item => item.id === "gen-leased" && item.reasons.includes("live lease")), JSON.stringify(leasesFor(deployRoot, "gen-leased")))
  check("gc: old unleased generation scheduled for removal", dryRemove.has("gen-c"))
  check("gc: stale staging scheduled for removal", dryRemove.has("gen-abandoned"))
  check("gc: nothing deleted in dry-run", existsSync(join(deployRoot, "generations", "gen-c")) && existsSync(staleStaging))

  gcGenerations(deployRoot, { apply: true })
  check("gc: apply removes only the scheduled set",
    !existsSync(join(deployRoot, "generations", "gen-c")) && !existsSync(staleStaging)
      && existsSync(join(deployRoot, "generations", "gen-leased"))
      && existsSync(join(deployRoot, "generations", "gen-newest")))
  holder.kill()
}

// ── staging owner 强判活（M2②）────────────────────────────────────────────
{
  const ownerDeploy = join(tmp, "owner-profile", ".dsh-tui", "deploy")
  mkdirSync(join(ownerDeploy, "generations"), { recursive: true })
  mkdirSync(join(ownerDeploy, "leases"), { recursive: true })
  function stagingWith(id, owner) {
    const dir = join(ownerDeploy, "generations", id + ".staging")
    mkdirSync(dir, { recursive: true })
    if (owner !== "none") writeFileSync(join(dir, ".owner.json"), JSON.stringify(owner))
    return dir
  }
  // Windows 无法回拨目录 mtime：用过期阈值 0ms＋间隔 5ms 制造「全部已过期」。
  const ttl = { stagingTtlMs: 0 }
  const liveChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" })
  await new Promise(resolve => liveChild.once("spawn", resolve))
  stagingWith("st-dead", { schemaVersion: 1, pid: 0x7ffffff0, processStartIdentity: { kind: "wall-start-ms", wallMs: 1 }, startedAt: Date.now() })
  stagingWith("st-none", "none")
  stagingWith("st-live", { schemaVersion: 1, pid: liveChild.pid, processStartIdentity: { kind: "wall-start-ms", wallMs: Date.now() - 60000 }, startedAt: Date.now() })
  stagingWith("st-young", "none")
  await new Promise(resolve => setTimeout(resolve, 5))
  const plan = gcGenerations(ownerDeploy, { ...ttl, apply: false })
  const removedIds = plan.remove.map(entry => entry.id)
  const keptIds = plan.keep.map(entry => entry.id)
  check("staging GC: dead-owner staging past TTL is scheduled", removedIds.includes("st-dead"))
  check("staging GC: unattributed staging past TTL is scheduled", removedIds.includes("st-none"))
  check("staging GC: live-owner staging is KEPT regardless of age (strong liveness)",
    !removedIds.includes("st-live") && keptIds.includes("st-live"), JSON.stringify(plan.keep.find(entry => entry.id === "st-live")?.reasons))
  check("staging GC: young staging kept by the REAL TTL window",
    !gcGenerations(ownerDeploy, { apply: false }).remove.some(entry => entry.id === "st-young"))
  gcGenerations(ownerDeploy, { ...ttl, apply: true })
  check("staging GC: apply removes exactly the dead set",
    !existsSync(join(ownerDeploy, "generations", "st-dead.staging"))
    && !existsSync(join(ownerDeploy, "generations", "st-none.staging"))
    && existsSync(join(ownerDeploy, "generations", "st-live.staging")))
  liveChild.kill()
  await new Promise(resolve => liveChild.once("exit", resolve))
}

// ── rollback = pointer change only ───────────────────────────────────────
{
  const before = readActive(deployRoot)
  const rolled = rollbackGeneration(deployRoot)
  check("rollback: pointer moves to previous", readActive(deployRoot).generationId === rolled.generationId && rolled.generationId === before.previousGenerationId)
  check("rollback: rolled-off generation still on disk", existsSync(join(deployRoot, "generations", before.generationId, "READY.json")))
  throws("rollback: missing target refused", () => rollbackGeneration(deployRoot, { to: "gen-c" }), "no READY")
  throws("rollback: self-rollback refused", () => rollbackGeneration(deployRoot, { to: readActive(deployRoot).generationId }), "already active")
}

// ── package tree hashing: symlink rejection (best effort) ────────────────
{
  const treeDir = join(tmp, "symlink-tree", "package")
  mkdirSync(join(treeDir, "lib"), { recursive: true })
  writeFileSync(join(treeDir, "lib", "index.js"), "x\n")
  try {
    symlinkSync(join(treeDir, "lib", "index.js"), join(treeDir, "lib", "link.js"), "file")
    throws("hash: symlink inside package tree rejected", () => hashPackageTree(treeDir), "symlink")
    rmSync(join(treeDir, "lib", "link.js"), { force: true })
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") skip("hash: symlink inside package tree rejected", "symlink creation needs privileges on this host")
    else throw error
  }
}

rmSync(tmp, { recursive: true, force: true })
rmSync(harnessPkg, { recursive: true, force: true })
console.log(failures === 0 ? "deploy-generations: ALL PASS" : "deploy-generations: " + failures + " FAILURE(S)" + (skips === 0 ? "" : " (" + skips + " skipped)"))
process.exit(failures === 0 ? 0 : 1)

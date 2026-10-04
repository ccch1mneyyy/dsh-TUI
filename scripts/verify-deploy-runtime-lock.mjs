#!/usr/bin/env node
/**
 * verify-deploy-runtime-lock.mjs — runtime-lock 依赖闭包锁定/健康检查回归
 * （deploy-transition 设计 §S04 M2①：「runtime-lock 及 closure 验证」，
 * 不再只标 providedByProfile）。
 *
 * 覆盖：
 *   - resolveRuntimeClosure：从 profile 根解析运行闭包——dep 与 peer 都拿到
 *     version＋package.json 字节指纹；bundled workspace 依赖只记 bundled
 *     （字节已计入 packageTreeSha256，不外查）；profile 里不存在的包如实
 *     found:false；closureSha256 对相同闭包稳定、对任何变动敏感；
 *   - runtimeLockHealth 三态：healthy（每条记录仍解析到同一字节）/
 *     drifted（版本升级、包消失、构建后才出现的包，逐条点名 recorded→now）/
 *     degraded（锁文件缺失/坏 JSON/非 schema 2）；
 *   - deployctl health 命令：active 代的健康输出与退出码（healthy=0，
 *     其他=1；无 active 时给 legacy 提示）；
 *   - 集成：真实 build-generation --skip-compile 对真实仓库构建，deploy
 *     root 落在带假 node_modules 的夹具 profile——锁记录 found:true 的
 *     依赖身份；随后升级夹具里的一个依赖，health 从 healthy 翻成 drifted
 *     并点名该依赖。
 *
 * 平台：全平台。运行：node scripts/verify-deploy-runtime-lock.mjs
 * （隔离 tmp fixture + 隔离 DSH_HOME，不触真实 profile）。
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { hashPackageTree, promoteGeneration, readActive, resolveRuntimeClosure, runtimeLockHealth } from "./deploy/core.mjs"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
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
function fakePackage(dir, name, version, extra = "") {
  mkdirSync(dir, { recursive: true })
  const manifest = { name, version, main: "index.js", ...JSON.parse(extra || "{}") }
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
  writeFileSync(join(dir, "index.js"), "export default " + JSON.stringify(name + "@" + version) + "\n")
}

// 夹具放仓库 .local/（verify-build-isolation 同款约定：%TEMP% 绝对路径经
// argv 传孙进程可能被沙箱改写；且 staging 编译链的 dynamic import 需要
// 祖先 node_modules 兜底——真实 profile 满足这一形状，OS tmp 不满足）。
const tmp = join(repoRoot, ".local", "verify-runtimelock-" + process.pid.toString(16) + "-" + Math.random().toString(16).slice(2, 8))
mkdirSync(tmp, { recursive: true })
const profileDir = join(tmp, "profile")
const deployRoot = join(profileDir, ".dsh-tui", "deploy")
mkdirSync(join(deployRoot, "generations"), { recursive: true })
mkdirSync(join(deployRoot, "leases"), { recursive: true })

const fixturePkg = {
  name: "@deepseek-harness-tui/dsh-tui",
  version: "9.9.9-fixture",
  dependencies: { chalk: "^6.0.0", react: "^19.0.0", "@dsh-std/core": "workspace:*", "definitely-not-a-real-pkg": "^0" },
  peerDependencies: { "@deepseek-ai/cordis": "^4.0.1" },
  bundledDependencies: ["@dsh-std/core"],
}

// ── resolveRuntimeClosure ────────────────────────────────────────────────
fakePackage(join(profileDir, "node_modules", "chalk"), "chalk", "6.0.0")
fakePackage(join(profileDir, "node_modules", "react"), "react", "19.2.1")
fakePackage(join(profileDir, "node_modules", "@deepseek-ai", "cordis"), "@deepseek-ai/cordis", "4.0.1")
{
  const closure = resolveRuntimeClosure(fixturePkg, deployRoot)
  const byName = new Map(closure.dependencies.map(entry => [entry.name, entry]))
  const chalk = byName.get("chalk")
  check("closure: dependency resolves with version + byte fingerprint",
    chalk?.found === true && chalk.version === "6.0.0" && /^[0-9a-f]{64}$/.test(chalk.integrity ?? ""))
  check("closure: bundled workspace dependency recorded as bundled (bytes already in the package tree)",
    byName.get("@dsh-std/core")?.bundled === true && byName.get("@dsh-std/core")?.found === undefined)
  check("closure: a dependency that exists nowhere is recorded found:false (honest, no hermetic theater)",
    byName.get("definitely-not-a-real-pkg")?.found === false)
  const peer = closure.peers.find(entry => entry.name === "@deepseek-ai/cordis")
  check("closure: peer resolves from the same profile root", peer?.found === true && peer.version === "4.0.1")
  const again = resolveRuntimeClosure(fixturePkg, deployRoot)
  check("closure: fingerprint is stable for an unchanged closure", again.closureSha256 === closure.closureSha256)
  fakePackage(join(profileDir, "node_modules", "chalk"), "chalk", "6.1.0")
  const moved = resolveRuntimeClosure(fixturePkg, deployRoot)
  check("closure: fingerprint is sensitive to any closure change", moved.closureSha256 !== closure.closureSha256)
  fakePackage(join(profileDir, "node_modules", "chalk"), "chalk", "6.0.0")
}

// ── 构造带 lock v2 的代次 ────────────────────────────────────────────────
function buildLockGeneration(id, mutate) {
  const stagingDir = join(deployRoot, "generations", id + ".staging")
  const packageDir = join(stagingDir, "package")
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, "index.js"), "export const generation = " + JSON.stringify(id) + "\n")
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: fixturePkg.name, version: "9.9.9-" + id, dependencies: fixturePkg.dependencies, peerDependencies: fixturePkg.peerDependencies, bundledDependencies: fixturePkg.bundledDependencies }, null, 2))
  const closure = resolveRuntimeClosure(fixturePkg, deployRoot)
  if (mutate !== undefined) mutate(closure)
  writeFileSync(join(stagingDir, "runtime-lock.json"), JSON.stringify({
    schemaVersion: 2, generationId: id, packageVersion: "9.9.9-" + id, sourceCommit: "fixture",
    nodeMajor: Number(process.versions.node.split(".")[0]), providedByProfile: true,
    peerDependencies: fixturePkg.peerDependencies,
    dependencies: closure.dependencies, peers: closure.peers, closureSha256: closure.closureSha256,
  }, null, 2))
  const { treeSha256 } = hashPackageTree(packageDir)
  writeFileSync(join(stagingDir, "READY.json"), JSON.stringify({
    schemaVersion: 1, generationId: id, packageVersion: "9.9.9-" + id, sourceCommit: "fixture",
    nodeMajor: Number(process.versions.node.split(".")[0]), packageTreeSha256: treeSha256, files: {},
  }, null, 2))
  return stagingDir
}

promoteGeneration(deployRoot, { stagingDir: buildLockGeneration("lock-healthy") })
{
  const health = runtimeLockHealth(deployRoot, "lock-healthy", fixturePkg)
  check("health: unchanged closure is healthy", health.status === "healthy", JSON.stringify(health.drift))
  check("health: healthy reports the current closure fingerprint", typeof health.closureSha256 === "string" && health.closureSha256.length === 64)
}

// ── drifted：升级 / 消失 / 构建后才出现 ──────────────────────────────────
{
  fakePackage(join(profileDir, "node_modules", "react"), "react", "19.9.9")
  let health = runtimeLockHealth(deployRoot, "lock-healthy", fixturePkg)
  const reactDrift = health.drift.find(entry => entry.name === "react")
  check("health: upgraded dependency is drifted and named (recorded→now)",
    health.status === "drifted" && reactDrift !== undefined && reactDrift.recorded.startsWith("19.2.1@") && reactDrift.current.startsWith("19.9.9@"),
    JSON.stringify(reactDrift))
  // 夹具在仓库 .local/ 下，删掉 profile 里的包会被祖先 node_modules 兜住，
  // 「消失」用幽灵条目构造：记录 found:true 但世上并无此包。
  promoteGeneration(deployRoot, { stagingDir: buildLockGeneration("lock-ghost", closure => {
    closure.dependencies.push({ name: "ghost-pkg", version: "1.0.0", integrity: "f".repeat(64), found: true })
  }) })
  const ghostHealth = runtimeLockHealth(deployRoot, "lock-ghost", fixturePkg)
  check("health: vanished dependency is drifted (absent now)",
    ghostHealth.status === "drifted" && ghostHealth.drift.some(entry => entry.name === "ghost-pkg" && entry.current === "absent"),
    JSON.stringify(ghostHealth.drift.find(entry => entry.name === "ghost-pkg") ?? null))
  fakePackage(join(profileDir, "node_modules", "left-pad"), "left-pad", "1.0.0")
  const absentPkg = { ...fixturePkg, dependencies: { ...fixturePkg.dependencies, "left-pad": "^1" } }
  const stagingAbsent = buildLockGeneration("lock-absent", closure => {
    closure.dependencies.push({ name: "left-pad", version: null, integrity: null, resolved: null, found: false })
  })
  promoteGeneration(deployRoot, { stagingDir: stagingAbsent })
  const absentHealth = runtimeLockHealth(deployRoot, "lock-absent", absentPkg)
  check("health: a package absent at build but present now is reported (closure grew)",
    absentHealth.status === "drifted" && absentHealth.drift.some(entry => entry.name === "left-pad" && entry.recorded === "absent-at-build"))
  rmSync(join(profileDir, "node_modules", "left-pad"), { recursive: true, force: true })
}

// ── degraded：锁不可读/形状不对 ─────────────────────────────────────────
{
  promoteGeneration(deployRoot, { stagingDir: buildLockGeneration("lock-broken", closure => { closure.dependencies = "not-an-array" }) })
  check("health: malformed lock shape is degraded",
    runtimeLockHealth(deployRoot, "lock-broken", fixturePkg).status === "degraded")
  const missingDir = join(deployRoot, "generations", "lock-healthy", "runtime-lock.json")
  const backup = readFileSync(missingDir, "utf8")
  rmSync(missingDir)
  check("health: missing lock is degraded (reported, never guessed)",
    runtimeLockHealth(deployRoot, "lock-healthy", fixturePkg).status === "degraded")
  writeFileSync(missingDir, backup)
}

// ── deployctl health 命令 ────────────────────────────────────────────────
{
  fakePackage(join(profileDir, "node_modules", "react"), "react", "19.2.1")
  const healthArgs = [join(repoRoot, "scripts", "deployctl.mjs"), "health", "--deploy-root", deployRoot, "--generation", "lock-healthy"]
  const run = spawnSync(process.execPath, healthArgs, { encoding: "utf8", timeout: 30000 })
  check("deployctl health: named generation is healthy (exit 0)", run.status === 0 && run.stdout.includes("HEALTHY"), run.stdout.slice(0, 160) + String(run.stderr).slice(0, 160))
  fakePackage(join(profileDir, "node_modules", "chalk"), "chalk", "6.2.0")
  const driftedRun = spawnSync(process.execPath, healthArgs, { encoding: "utf8", timeout: 30000 })
  check("deployctl health: drift names the dependency and exits 1",
    driftedRun.status === 1 && driftedRun.stdout.includes("drifted chalk:") && driftedRun.stdout.includes("6.2.0"),
    driftedRun.stdout.split("\n").find(line => line.includes("chalk")) ?? "")
  fakePackage(join(profileDir, "node_modules", "chalk"), "chalk", "6.0.0")
}

// ── 集成：真实 build-generation + 真实仓库 ───────────────────────────────
{
  if (!existsSync(join(repoRoot, "lib", "types", "index.js"))) {
    skip("integration: repo lib/ not compiled", "run compile:src once on this checkout")
  } else {
    const intProfile = join(tmp, "int-profile")
    const intDeploy = join(intProfile, ".dsh-tui", "deploy")
    mkdirSync(join(intDeploy, "generations"), { recursive: true })
    mkdirSync(join(intDeploy, "leases"), { recursive: true })
    // 夹具 profile 的 node_modules 放两个合成依赖包——绝不从仓库 node_modules
    // cpSync：pnpm 布局下那是指向共享 store 的符号链接，复制产物的写入会
    // 打穿到 store（本轮实测踩中，store yaml 曾被写脏后修复）。
    mkdirSync(join(intProfile, "node_modules"), { recursive: true })
    fakePackage(join(intProfile, "node_modules", "yaml"), "yaml", "2.9.1")
    fakePackage(join(intProfile, "node_modules", "semver"), "semver", "7.7.0")
    const dshHome = join(tmp, "dsh-home")
    mkdirSync(dshHome, { recursive: true })
    const genId = "9.9.9-lockint-" + Math.random().toString(16).slice(2, 8)
    const build = spawnSync(process.execPath, [join(repoRoot, "scripts", "build-generation.mjs"), "--deploy-root", intDeploy, "--source", repoRoot, "--id", genId, "--skip-compile"], {
      encoding: "utf8", timeout: 300000, env: { ...process.env, DSH_HOME: dshHome, DSH_TUI_DEPLOY_ROOT: intDeploy },
    })
    const lockPath = join(intDeploy, "generations", genId + ".staging", "runtime-lock.json")
    check("integration: real build writes runtime-lock v2 with the closure",
      build.status === 0 && existsSync(lockPath) && JSON.parse(readFileSync(lockPath, "utf8")).schemaVersion === 2,
      String(build.stderr).slice(0, 300))
    const lock = JSON.parse(readFileSync(lockPath, "utf8"))
    const yaml = (lock.dependencies ?? []).find(entry => entry.name === "yaml")
    const semverEntry = (lock.dependencies ?? []).find(entry => entry.name === "semver")
    check("integration: fixture-profile dependencies are locked found:true with fingerprints",
      yaml?.found === true && /^[0-9a-f]{64}$/.test(yaml.integrity ?? "") && semverEntry?.found === true)
    check("integration: closure covers the dependency list with real identities",
      (lock.dependencies ?? []).length >= 30 && (lock.dependencies ?? []).every(entry => entry.bundled === true || entry.found === true || entry.found === false))
    // deployctl health：先 healthy，再升级 yaml → drifted 点名。
    promoteGeneration(intDeploy, { stagingDir: join(intDeploy, "generations", genId + ".staging") })
    const realPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
    const before = runtimeLockHealth(intDeploy, genId, realPkg)
    check("integration: freshly built generation is healthy against its own profile", before.status === "healthy", JSON.stringify(before.drift.slice(0, 3)))
    const yamlManifest = join(intProfile, "node_modules", "yaml", "package.json")
    const manifest = JSON.parse(readFileSync(yamlManifest, "utf8"))
    manifest.version = "999.999.999"
    writeFileSync(yamlManifest, JSON.stringify(manifest, null, 2) + "\n")
    const after = runtimeLockHealth(intDeploy, genId, realPkg)
    check("integration: upgrading one dependency flips health to drifted and names it",
      after.status === "drifted" && after.drift.some(entry => entry.name === "yaml" && entry.current.startsWith("999.999.999@")),
      JSON.stringify(after.drift.find(entry => entry.name === "yaml") ?? null))
  }
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? "\nruntime-lock: ALL PASS" + (skips === 0 ? "" : " (" + skips + " skipped)") : "\n" + failures + " FAILURES")
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * build-generation.mjs — 把一次完整包构建落进独立的 staging 目录
 * （deploy-transition 设计 §S04 "构建迁移路线" 的 M0 落点）。
 *
 * 构建写入 <deployRoot>/generations/<id>.staging/package/，绝不写活动
 * 运行路径：tsc 经由仓库内的临时继承配置把 outDir 指到 staging（不碰
 * tsconfig.json、不 clean、不写 live lib/），settings 生成器以 --lib-dir
 * 读 staging 的编译产物，静态 files 树从源树复制。产物逐文件哈希进
 * READY.json（tmp + rename 的代次内部提交标志），可选 --promote 直接
 * 走 core.promoteGeneration 原子激活。
 *
 * Usage:
 *   node scripts/build-generation.mjs --deploy-root <dir> [--source <repoRoot>]
 *        [--id <generationId>] [--promote] [--replace-staging] [--skip-compile]
 *
 *   --deploy-root      <profile>/.dsh-tui/deploy（必须已存在或可创建）
 *   --source           源码树（默认 cwd）；必须是本包的源码检出
 *   --id               generation id（默认 <version>-<gitSha12>-<rand>，
 *                      字符白名单 [A-Za-z0-9._-]）
 *   --promote          构建成功后原子激活（默认只留 staging 供检查）
 *   --replace-staging  删除同 id 的旧 staging 后重建（staging 不属于任何
 *                      活进程，可安全替换；final 代次仍然不可变）
 *   --skip-compile     直接复制源树现有 lib/（CI 外的快速路径；产物仍会
 *                      全量哈希与 READY 提交）
 *
 * 预检（fail fast）：源树是 profile junction 的当前指向时拒绝（live
 * runtime tree，见 scripts/deploy/guard.mjs）——构建必须在 detached
 * worktree/源码树执行，这正是“构建在独立 build tree”的结构性保证。
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { hashPackageTree } from "./deploy/core.mjs"
import { assertBuildableTree } from "./deploy/guard.mjs"
import { isValidGenerationId } from "../dispatch/resolve.mjs"

function flag(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(name + " needs a value")
  return value
}
const has = name => process.argv.includes(name)

const sourceRoot = resolve(flag("--source", process.cwd()))
const pkgPath = join(sourceRoot, "package.json")
if (!existsSync(pkgPath)) throw new Error("not a source checkout (no package.json): " + sourceRoot)
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
if (pkg.name !== "@deepseek-harness-tui/dsh-tui") throw new Error("unexpected package " + pkg.name + " at " + sourceRoot)

// ── 预检：live runtime tree 拒绝 ─────────────────────────────────────────
assertBuildableTree(sourceRoot, "build a generation from")

// ── generation id ─────────────────────────────────────────────────────────
function gitSha(dir) {
  try {
    const dotGit = lstatSync(join(dir, ".git"))
    const gitDir = dotGit.isDirectory() ? join(dir, ".git") : readFileSync(join(dir, ".git"), "utf8").trim().replace(/^gitdir:\s*/, "")
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim()
    if (/^[0-9a-f]{40,64}$/i.test(head)) return head.slice(0, 12)
    const ref = head.replace(/^ref:\s*/, "")
    const sha = readFileSync(join(gitDir, ref), "utf8").trim()
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha.slice(0, 12) : "ungit"
  } catch {
    return "ungit"
  }
}
const defaultId = pkg.version + "-" + gitSha(sourceRoot) + "-" + Math.random().toString(16).slice(2, 8)
const generationId = flag("--id", defaultId)
if (!isValidGenerationId(generationId)) throw new Error("invalid generation id (charset [A-Za-z0-9._-]): " + generationId)

const deployRoot = resolve(flag("--deploy-root", undefined))
if (deployRoot === undefined) throw new Error("pass --deploy-root <dir> (the profile's .dsh-tui/deploy)")
mkdirSync(join(deployRoot, "generations"), { recursive: true })
const stagingDir = join(deployRoot, "generations", generationId + ".staging")
if (existsSync(stagingDir)) {
  if (!has("--replace-staging")) throw new Error("staging already exists (pass --replace-staging to rebuild it): " + stagingDir)
  rmSync(stagingDir, { recursive: true, force: true })
  if (existsSync(stagingDir)) throw new Error("staging removal silently failed: " + stagingDir)
}
const packageDir = join(stagingDir, "package")
mkdirSync(packageDir, { recursive: true })

// ── 编译：经临时继承 tsconfig 直写 staging，不触碰源树 tsconfig/lib ─────
if (has("--skip-compile")) {
  const liveTypes = join(sourceRoot, "lib", "types")
  if (!existsSync(liveTypes)) throw new Error("--skip-compile needs an existing lib/types in the source tree; run a compile first")
  cpSync(liveTypes, join(packageDir, "lib", "types"), { recursive: true })
} else {
  const buildScratch = join(sourceRoot, ".local", "build", generationId)
  mkdirSync(buildScratch, { recursive: true })
  // 临时配置位于 <repo>/.local/build/<id>/：extends/rootDir/include 都要
  // 回退三级才落在仓库根（.local → build → <id>）。
  const tsconfig = [
    "{",
    '  "extends": "../../../tsconfig.json",',
    '  "compilerOptions": {',
    '    "rootDir": "../../../src",',
    '    "outDir": ' + JSON.stringify(join(packageDir, "lib", "types").replaceAll("\\", "/")),
    "  },",
    '  "include": ["../../../src"]',
    "}",
  ].join("\n")
  writeFileSync(join(buildScratch, "tsconfig.json"), tsconfig)
  const tscBin = join(sourceRoot, "node_modules", "typescript", "bin", "tsc")
  if (!existsSync(tscBin)) throw new Error("typescript not installed in the source tree: " + tscBin)
  const compiled = spawnSync(process.execPath, [tscBin, "-p", join(buildScratch, "tsconfig.json")], {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: 600000,
  })
  if (compiled.status !== 0) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw new Error("tsc failed for the staging build:\n" + (compiled.stdout || "") + (compiled.stderr || ""))
  }
  rmSync(buildScratch, { recursive: true, force: true })
}

// ── settings.json：从 staging 的编译产物生成 ────────────────────────────
const settingsRun = spawnSync(process.execPath, [join(sourceRoot, "scripts", "gen-settings-json.mjs"), "--lib-dir", join(packageDir, "lib"), "--out", join(packageDir, "lib", "settings.json")], {
  cwd: sourceRoot,
  encoding: "utf8",
  timeout: 120000,
})
if (settingsRun.status !== 0) {
  rmSync(stagingDir, { recursive: true, force: true })
  throw new Error("settings generation failed for the staging build:\n" + (settingsRun.stdout || "") + (settingsRun.stderr || ""))
}

// ── 静态 files 树复制（以 package.json files 为准）──────────────────────
for (const entry of pkg.files ?? []) {
  if (entry === "lib") continue // 编译产物已在 staging
  const from = join(sourceRoot, entry)
  if (!existsSync(from)) throw new Error("files entry missing in source tree: " + entry)
  const to = join(packageDir, entry)
  const stat = lstatSync(from)
  if (stat.isDirectory()) cpSync(from, to, { recursive: true })
  else cpSync(from, to)
}
cpSync(pkgPath, join(packageDir, "package.json"))

// ── runtime-lock：如实记录身份，不虚称 hermetic ─────────────────────────
const lockfilePath = join(sourceRoot, "pnpm-lock.yaml")
const lockfileHash = existsSync(lockfilePath)
  ? createHash("sha256").update(readFileSync(lockfilePath)).digest("hex")
  : undefined
writeFileSync(join(stagingDir, "runtime-lock.json"), JSON.stringify({
  schemaVersion: 1,
  generationId,
  packageVersion: pkg.version,
  sourceCommit: gitSha(sourceRoot),
  nodeMajor: Number(process.versions.node.split(".")[0]),
  // 运行依赖由 profile 的 hoisted node_modules 提供（dsh profile 模板
  // nodeLinker: hoisted）——M0 如实记录 peer 面与 lockfile 指纹，不声称
  // 闭包已锁定（那是 M2 的 runtime-lock 验证范围）。
  providedByProfile: true,
  peerDependencies: pkg.peerDependencies,
  ...(lockfileHash === undefined ? {} : { lockfileSha256: lockfileHash }),
}, null, 2))

// ── READY.json：代次内部提交标志（tmp + rename）───────────────────────
const { files, treeSha256 } = hashPackageTree(packageDir)
const readyTmp = join(stagingDir, "READY.json.tmp")
writeFileSync(readyTmp, JSON.stringify({
  schemaVersion: 1,
  generationId,
  packageVersion: pkg.version,
  sourceCommit: gitSha(sourceRoot),
  nodeMajor: Number(process.versions.node.split(".")[0]),
  packageTreeSha256: treeSha256,
  files,
  builtBy: "scripts/build-generation.mjs",
}, null, 2))
const { renameSync } = await import("node:fs")
renameSync(readyTmp, join(stagingDir, "READY.json"))

console.log("staging generation built: " + stagingDir)
console.log("  package files: " + Object.keys(files).length + ", tree " + treeSha256.slice(0, 12))

if (has("--promote")) {
  const { promoteGeneration } = await import("./deploy/core.mjs")
  const result = promoteGeneration(deployRoot, { stagingDir })
  console.log("promoted " + result.generationId + " (ready " + result.readySha256.slice(0, 12) + ")")
}

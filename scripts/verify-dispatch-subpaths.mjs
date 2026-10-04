#!/usr/bin/env node
/**
 * verify-dispatch-subpaths.mjs — 子路径统一代次解析回归（deploy-transition
 * 设计 §S04 M1②："所有 TUI 包子路径统一走 dispatcher"，消 M0 遗留的
 * Cordis 子路径行混代风险）。
 *
 * 覆盖：
 *   - 锁步（source 模式）：每个 dispatch/<sub>.js 转发的名字集合与规范
 *     编译模块的运行时导出面完全一致（多出的 default 除外；jsx-runtime
 *     的 CJS 互操作键 module.exports 不属于 ESM 消费面）；
 *   - exports 映射 tripwire：所有代码子路径的 import/default 都指向
 *     ./dispatch/，且每个转发文件真实存在、引用正确的 lib 入口；
 *   - 代次 pin（generation 模式，真夹具 profile + deploy root）：active
 *     指向 gen-sub 时，**包名解析**（import.meta.resolve 走真实 exports
 *     映射）与全部 13 个门面（主入口 + 12 子路径）都从 gen-sub 的
 *     package/ 取码（标记值），规范树标记绝不泄漏；
 *   - 新进程取新代：翻转 active 到 gen-other 后，下一个进程的子路径
 *     解析到 gen-other；
 *   - 缺入口 fail closed：代次缺 lib/types/oauth.js 时，转发门面抛出
 *     可行动错误（不是深处的 ERR_MODULE_NOT_FOUND）；
 *   - legacy：无 deploy root 的安装副本照常跑规范内容。
 *
 * 平台：全平台。运行：node scripts/verify-dispatch-subpaths.mjs
 * （隔离 tmp fixture；源码树需先 compile:src 出 lib/types）。
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { hashPackageTree, promoteGeneration, atomicWriteJson, readActive } from "./deploy/core.mjs"
import { createHash } from "node:crypto"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

let failures = 0
function check(name, ok, detail = "") {
  console.log((ok ? "PASS" : "FAIL") + ": " + name + (detail === "" ? "" : "  (" + detail + ")"))
  if (!ok) failures += 1
}

// 每个子路径：lib 入口 + 门面里可用于标记断言的转发名。
const SUBS = {
  workspaces: { file: "lib/types/workspaces.js", marker: "name" },
  "command-trees": { file: "lib/types/command-trees.js", marker: "name" },
  "settings-sections": { file: "lib/types/settings-sections.js", marker: "name" },
  scenes: { file: "lib/types/scenes.js", marker: "name" },
  panels: { file: "lib/types/panels.js", marker: "name" },
  "plugin-host": { file: "lib/types/plugin-host.js", marker: "name" },
  extensions: { file: "lib/types/extensions.js", marker: "name" },
  oauth: { file: "lib/types/oauth.js", marker: "name" },
  "working-activity": { file: "lib/types/working-activity.js", marker: "name" },
  api: { file: "lib/types/api.js", marker: "TUI_PANEL_API_VERSION" },
  "jsx-runtime": { file: "lib/types/jsx-runtime.js", marker: "Fragment" },
  invariant: { file: "lib/types/dsh-adapter/invariant.js", marker: "name" },
}

// ── source-mode lockstep（仓库树本身就是 source 标记）───────────────────
{
  for (const [sub, spec] of Object.entries(SUBS)) {
    const forwarded = await import(pathToFileURL(join(repoRoot, "dispatch", sub + ".js")).href)
    const canonical = await import(pathToFileURL(join(repoRoot, spec.file)).href)
    // default 由门面按 mod.default ?? 命名空间合成，两侧都排除比较；
    // jsx-runtime 的 CJS 互操作键 module.exports 不属于 ESM 消费面。
    const fkeys = Object.keys(forwarded).filter(k => k !== "default").sort()
    const ckeys = Object.keys(canonical).filter(k => k !== "default" && !(sub === "jsx-runtime" && k === "module.exports")).sort()
    check("lockstep: " + sub + " forwards the canonical runtime surface",
      JSON.stringify(fkeys) === JSON.stringify(ckeys),
      "fwd=" + JSON.stringify(fkeys.slice(0, 6)) + "… canon=" + JSON.stringify(ckeys.slice(0, 6)) + "…")
  }
  const mainForwarded = await import(pathToFileURL(join(repoRoot, "dispatch", "index.js")).href)
  const mainCanonical = await import(pathToFileURL(join(repoRoot, "lib", "types", "index.js")).href)
  check("lockstep: main entry surface unchanged (M0 contract)",
    JSON.stringify(Object.keys(mainForwarded).filter(k => k !== "default").sort())
      === JSON.stringify(Object.keys(mainCanonical).sort()))
}

// ── exports-map tripwire ─────────────────────────────────────────────────
{
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
  for (const [sub, spec] of Object.entries(SUBS)) {
    const entry = pkg.exports["./" + sub]
    const target = entry?.import ?? entry?.default
    check("exports map: ./" + sub + " resolves through ./dispatch/",
      typeof target === "string" && target.startsWith("./dispatch/"), JSON.stringify(entry))
    check("exports map: dispatcher file exists for ./" + sub, existsSync(join(repoRoot, "dispatch", sub + ".js")))
    const source = readFileSync(join(repoRoot, "dispatch", sub + ".js"), "utf8")
    check("forwarder: ./" + sub + " pins before import and maps the right entry",
      source.includes('resolveTuiEntry(import.meta.url, "' + spec.file + '")'))
  }
  check("exports map: main entry unchanged at ./dispatch/index.js", pkg.exports["."].import === "./dispatch/index.js")
}

// ── fixture profile：包名可解析 + deploy root 可走 ──────────────────────
const tmp = mkdtempSync(join(tmpdir(), "verify-dispatch-sub-"))
const pkgDir = join(tmp, "profile", "node_modules", "@deepseek-harness-tui", "dsh-tui")
mkdirSync(pkgDir, { recursive: true })
cpSync(join(repoRoot, "dispatch"), join(pkgDir, "dispatch"), { recursive: true })
cpSync(join(repoRoot, "package.json"), join(pkgDir, "package.json"))

function writeMarkerPackage(packageDir, marker) {
  for (const spec of Object.values(SUBS)) {
    const target = join(packageDir, spec.file.replaceAll("/", sep()))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, [
      "const marker = " + JSON.stringify(marker),
      "export const name = marker",
      "export const inject = marker",
      "export const Config = marker",
      "export const apply = marker",
      "export const normalizeBackendChoice = marker",
      "export const TUI_PANEL_API_VERSION = marker",
      "export const Fragment = marker",
      "export const jsx = marker",
      "export const jsxs = marker",
      "export const generation = marker",
    ].join("\n") + "\n")
  }
  // 主入口的规范位置也带标记（legacy/混代断言用）。
  const indexTarget = join(packageDir, "lib", "types", "index.js")
  mkdirSync(dirname(indexTarget), { recursive: true })
  writeFileSync(indexTarget, [
    "const marker = " + JSON.stringify(marker),
    "export const name = marker",
    "export const inject = marker",
    "export const Config = marker",
    "export const apply = marker",
    "export const normalizeBackendChoice = marker",
  ].join("\n") + "\n")
}

function sep() {
  return process.platform === "win32" ? "\\" : "/"
}

function buildGeneration(deployRoot, id) {
  const stagingDir = join(deployRoot, "generations", id + ".staging")
  const packageDir = join(stagingDir, "package")
  mkdirSync(packageDir, { recursive: true })
  writeMarkerPackage(packageDir, id)
  const { treeSha256 } = hashPackageTree(packageDir)
  writeFileSync(join(stagingDir, "READY.json"), JSON.stringify({
    schemaVersion: 1, generationId: id, packageVersion: "9.9.9-" + id, sourceCommit: "fixture",
    nodeMajor: Number(process.versions.node.split(".")[0]), packageTreeSha256: treeSha256, files: {},
  }, null, 2))
  return stagingDir
}

const deployRoot = join(tmp, "profile", ".dsh-tui", "deploy")
mkdirSync(join(deployRoot, "generations"), { recursive: true })
mkdirSync(join(deployRoot, "leases"), { recursive: true })
promoteGeneration(deployRoot, { stagingDir: buildGeneration(deployRoot, "gen-sub") })
promoteGeneration(deployRoot, { stagingDir: buildGeneration(deployRoot, "gen-other") })
// 回到 gen-sub 作为 active（promote 已顺次激活 gen-other）。
{
  const active = readActive(deployRoot)
  const readySha256 = createHash("sha256").update(readFileSync(join(deployRoot, "generations", "gen-sub", "READY.json"))).digest("hex")
  atomicWriteJson(join(deployRoot, "active.json"), { ...active, generationId: "gen-sub", readySha256, previousGenerationId: "gen-other" })
}

// 驱动器：在夹具 profile 内按**包名**解析 + 导入全部门面，输出标记 JSON。
const driver = join(tmp, "profile", "driver.mjs")
writeFileSync(driver, [
  "const subs = " + JSON.stringify(SUBS),
  "const byName = await import('@deepseek-harness-tui/dsh-tui/panels')",
  "const resolved = import.meta.resolve('@deepseek-harness-tui/dsh-tui/panels')",
  "const main = await import('@deepseek-harness-tui/dsh-tui')",
  "const markers = { resolved, main: main.name }",
  "for (const [sub, spec] of Object.entries(subs)) {",
  "  const mod = await import('@deepseek-harness-tui/dsh-tui/' + sub)",
  "  markers[sub] = mod[spec.marker]",
  "}",
  "process.stdout.write(JSON.stringify(markers))",
].join("\n"))

function runDriver() {
  const run = spawnSync(process.execPath, [driver], { encoding: "utf8", timeout: 60000 })
  if (run.status !== 0) return { error: (run.stderr || run.stdout || "").slice(-400) }
  try {
    return JSON.parse(run.stdout)
  } catch (error) {
    return { error: "unparsable driver output: " + run.stdout.slice(0, 200) + " / " + error.message }
  }
}

{
  const markers = runDriver()
  check("generation pin: driver resolved the panels row THROUGH the exports map",
    typeof markers.resolved === "string" && markers.resolved.replaceAll("\\", "/").endsWith("/dispatch/panels.js"), JSON.stringify(markers.resolved))
  check("generation pin: main facade serves the pinned generation", markers.main === "gen-sub", JSON.stringify(markers.main))
  for (const sub of Object.keys(SUBS)) {
    check("generation pin: " + sub + " facade serves the pinned generation (not canonical)",
      markers[sub] === "gen-sub", JSON.stringify(markers[sub]))
  }
}

// ── 新进程取新代（翻指针后）────────────────────────────────────────────
{
  const active = readActive(deployRoot)
  const readySha256 = createHash("sha256").update(readFileSync(join(deployRoot, "generations", "gen-other", "READY.json"))).digest("hex")
  atomicWriteJson(join(deployRoot, "active.json"), { ...active, generationId: "gen-other", readySha256, previousGenerationId: "gen-sub" })
  const markers = runDriver()
  check("repoint: a NEW process resolves subpaths to the new generation",
    markers.oauth === "gen-other" && markers["jsx-runtime"] === "gen-other" && markers.main === "gen-other",
    JSON.stringify({ main: markers.main, oauth: markers.oauth }))
}

// ── 缺入口 fail closed ───────────────────────────────────────────────────
{
  const missingStaging = buildGeneration(deployRoot, "gen-missing")
  rmSync(join(missingStaging, "package", "lib", "types", "oauth.js"))
  const { treeSha256 } = hashPackageTree(join(missingStaging, "package"))
  const readyPath = join(missingStaging, "READY.json")
  writeFileSync(readyPath, JSON.stringify({ ...JSON.parse(readFileSync(readyPath, "utf8")), packageTreeSha256: treeSha256 }, null, 2))
  promoteGeneration(deployRoot, { stagingDir: missingStaging })
  const run = spawnSync(process.execPath, [driver], { encoding: "utf8", timeout: 60000 })
  const stderr = run.stderr || ""
  check("missing entry: actionable fail-closed error (not a bare ERR_MODULE_NOT_FOUND)",
    run.status !== 0 && stderr.includes("missing its lib/types/oauth.js entry"), stderr.slice(-160))
}

// ── legacy：无 deploy root 的安装副本 ────────────────────────────────────
{
  const legacyDir = join(tmp, "legacy", "node_modules", "@deepseek-harness-tui", "dsh-tui")
  mkdirSync(legacyDir, { recursive: true })
  cpSync(join(repoRoot, "dispatch"), join(legacyDir, "dispatch"), { recursive: true })
  cpSync(join(repoRoot, "package.json"), join(legacyDir, "package.json"))
  writeMarkerPackage(legacyDir, "canonical-legacy")
  const legacyDriver = join(tmp, "legacy", "driver.mjs")
  writeFileSync(legacyDriver, [
    "const mod = await import('@deepseek-harness-tui/dsh-tui/panels')",
    "const main = await import('@deepseek-harness-tui/dsh-tui')",
    "process.stdout.write(JSON.stringify({ panels: mod.name, main: main.name }))",
  ].join("\n"))
  const run = spawnSync(process.execPath, [legacyDriver], { encoding: "utf8", timeout: 60000 })
  let markers
  try {
    markers = JSON.parse(run.stdout)
  } catch {
    markers = {}
  }
  check("legacy: no deploy root → canonical content, byte-identical contract",
    markers.panels === "canonical-legacy" && markers.main === "canonical-legacy", JSON.stringify(markers))
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES")
process.exit(failures === 0 ? 0 : 1)

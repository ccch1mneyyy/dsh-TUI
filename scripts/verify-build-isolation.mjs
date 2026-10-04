#!/usr/bin/env node
/**
 * verify-build-isolation.mjs — 构建隔离 M0 回归（设计 §S04 “构建迁移
 * 路线”阶段 0 + “Junction” 行）。
 *
 * 覆盖：
 *   - live-tree 守卫：profile junction 当前指向的源树拒绝 clean/build
 *     （guidance 文案可操作），显式逃生口 DSH_TUI_ALLOW_LIVE_TREE_BUILD=1
 *     放行，无关树照常通过；对 clean-lib.mjs 做真实子进程集成（拒绝时
 *     仓库 lib/ 必须原样保留）；
 *   - build-generation：staging create-new（已存在拒绝 / --replace-staging
 *     重建）、静态 files 树齐备（bin/dispatch/cordis.patch.yml…）、
 *     READY 的 files 清单与树哈希可复核、runtime-lock 如实标
 *     providedByProfile、--promote 后 active 指针就位；
 *   - dispatch pin 能解析构建产物：把 dispatch 运行时放进假 profile 包
 *     目录，resolveTuiRuntime 必须落到刚 promote 的 generation（含 lease）；
 *   - gen-settings-json 参数化等价：--lib-dir/--out 输出与默认产物逐字节
 *     一致（默认行为不变的构造性证明）。
 *
 * 默认走 --skip-compile（快路径，CI 友好）；真实 tsc staging 构建用
 * DSH_TUI_VERIFY_FULL_COMPILE=1 触发（本地验收跑过一次即留在证据链）。
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { assertBuildableTree, findLiveJunctionReferences } from "./deploy/guard.mjs"
import { readActive } from "./deploy/core.mjs"

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
function runNode(args, extraEnv, timeoutMs = 300000) {
  return spawnSync(process.execPath, args, { encoding: "utf8", timeout: timeoutMs, env: { ...process.env, ...(extraEnv ?? {}) } })
}

// 夹具放在仓库 .local/ 下而不是 OS tmp：本仓库的验证常在路径虚拟化的
// 沙箱里跑，%TEMP% 下的绝对路径经 argv 传给孙进程时可能被改写成
// 相对形状，令 staging 产物的 dynamic import 失真；工作区路径不受影响。
// （.local 在 .gitignore 中，产物不会进提交面。）
const tmp = join(repoRoot, ".local", "verify-buildiso-" + process.pid.toString(16) + "-" + Math.random().toString(16).slice(2, 8))
mkdirSync(tmp, { recursive: true })

// ── live-tree 守卫 ────────────────────────────────────────────────────────
{
  // 假 DSH_HOME：一个 profile，其 TUI 包位置是指向本仓库的 junction。
  const dshHome = join(tmp, "dsh-home")
  const profileDir = join(dshHome, "profiles", "fixture")
  const linkPath = join(profileDir, "node_modules", "@deepseek-harness-tui", "dsh-tui")
  mkdirSync(dirname(linkPath), { recursive: true })
  try {
    symlinkSync(repoRoot, linkPath, "junction")
  } catch (error) {
    skip("guard: junction fixture needs privileges", error.code)
  }
  const hasJunction = existsSync(linkPath)
  if (hasJunction) {
    const refs = findLiveJunctionReferences(repoRoot)
    check("guard: junction reference discovered via DSH_HOME", runNode(
      ["-e", "const { findLiveJunctionReferences } = await import(process.argv[1]); console.log(JSON.stringify(findLiveJunctionReferences(process.argv[2])))", pathToFileURL(join(repoRoot, "scripts", "deploy", "guard.mjs")).href, repoRoot],
      { DSH_HOME: dshHome },
    ).stdout.includes("fixture"), "")
    // 守卫的进程内用例也要指向夹具 DSH_HOME（真实 HOME 的 junction 不指
    // 向本仓库，不能作为拒绝证据）。
    const previousDshHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    let refused = ""
    try {
      assertBuildableTree(repoRoot, "clean lib/")
    } catch (error) {
      refused = error.message
    }
    check("guard: live tree refused with actionable guidance", refused.includes("refusing") && refused.includes("build-generation") && refused.includes("DSH_TUI_ALLOW_LIVE_TREE_BUILD"), refused.split("\n")[0])
    // 真实 clean-lib 集成：拒绝退出且仓库 lib/ 原样保留。
    const libBefore = existsSync(join(repoRoot, "lib", "settings.json"))
    const cleanRun = runNode([join(repoRoot, "scripts", "clean-lib.mjs")], { DSH_HOME: dshHome })
    check("guard: clean-lib refuses on a live tree (integration)", cleanRun.status !== 0 && String(cleanRun.stderr).includes("refusing"), "status=" + cleanRun.status)
    check("guard: refused clean leaves lib/ untouched", libBefore === existsSync(join(repoRoot, "lib", "settings.json")))
    // 逃生口：守卫层放行（不在 clean-lib 上集成执行，避免真删仓库 lib）。
    process.env.DSH_TUI_ALLOW_LIVE_TREE_BUILD = "1"
    let escaped = false
    try {
      assertBuildableTree(repoRoot, "clean lib/")
      escaped = true
    } catch {
      escaped = false
    }
    delete process.env.DSH_TUI_ALLOW_LIVE_TREE_BUILD
    check("guard: explicit escape hatch honors the operator", escaped)
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    // 无关树：照常通过。
    const bystander = join(tmp, "bystander-tree")
    mkdirSync(join(bystander, "src"), { recursive: true })
    let bystanderOk = true
    try {
      assertBuildableTree(bystander, "clean lib/")
    } catch {
      bystanderOk = false
    }
    check("guard: unrelated tree passes", bystanderOk)
    // build-generation 对 live 树同样拒绝。
    const bg = runNode([join(repoRoot, "scripts", "build-generation.mjs"), "--deploy-root", join(tmp, "deploy-empty"), "--source", repoRoot, "--skip-compile"], { DSH_HOME: dshHome })
    check("guard: build-generation refuses a live source tree", bg.status !== 0 && String(bg.stderr).includes("refusing"), "status=" + bg.status)
  }
}

// ── build-generation：staging 构建产物形状 ───────────────────────────────
const deployRoot = join(tmp, "profile", ".dsh-tui", "deploy")
mkdirSync(join(deployRoot, "generations"), { recursive: true })
{
  if (!existsSync(join(repoRoot, "lib", "types", "index.js"))) {
    skip("build-generation: repo lib/ not compiled", "run pnpm compile once on this checkout")
  } else {
    const genId = "9.9.9-test-" + Math.random().toString(16).slice(2, 8)
    const stagingDir = join(deployRoot, "generations", genId + ".staging")
    const build = runNode([join(repoRoot, "scripts", "build-generation.mjs"), "--deploy-root", deployRoot, "--source", repoRoot, "--id", genId, "--skip-compile"], { DSH_TUI_DEPLOY_ROOT: deployRoot })
    check("build: staging generation built", build.status === 0 && existsSync(join(stagingDir, "READY.json")), String(build.stderr).slice(0, 300))

    const ready = JSON.parse(readFileSync(join(stagingDir, "READY.json"), "utf8"))
    check("build: READY files manifest is populated", Object.keys(ready.files ?? {}).length > 100)
    for (const expected of ["bin/dsh-tui.js", "dispatch/index.js", "dispatch/resolve.mjs", "lib/types/index.js", "lib/settings.json", "cordis.patch.yml", "package.json"]) {
      check("build: files manifest covers " + expected, ready.files[expected] !== undefined)
    }
    // 树哈希复核（独立重算）。
    const { hashPackageTree } = await import("./deploy/core.mjs")
    const recomputed = hashPackageTree(join(stagingDir, "package"))
    check("build: READY tree hash matches an independent recount", recomputed.treeSha256 === ready.packageTreeSha256)
    const lock = JSON.parse(readFileSync(join(stagingDir, "runtime-lock.json"), "utf8"))
    check("build: runtime-lock honestly marks profile-provided closure", lock.providedByProfile === true && lock.peerDependencies !== undefined && lock.generationId === genId)

    // staging create-new：同 id 再来一次必须拒绝；--replace-staging 重建。
    const again = runNode([join(repoRoot, "scripts", "build-generation.mjs"), "--deploy-root", deployRoot, "--source", repoRoot, "--id", genId, "--skip-compile"], { DSH_TUI_DEPLOY_ROOT: deployRoot })
    check("build: existing staging refused without --replace-staging", again.status !== 0 && String(again.stderr).includes("--replace-staging"))
    const replaced = runNode([join(repoRoot, "scripts", "build-generation.mjs"), "--deploy-root", deployRoot, "--source", repoRoot, "--id", genId, "--skip-compile", "--replace-staging"], { DSH_TUI_DEPLOY_ROOT: deployRoot })
    check("build: --replace-staging rebuilds the staging tree", replaced.status === 0)

    // promote 后 active 就位，且 dispatch pin 能解析到该代。
    const promoted = runNode([join(repoRoot, "scripts", "deployctl.mjs"), "promote", "--deploy-root", deployRoot, join(deployRoot, "generations", genId + ".staging")])
    check("build: deployctl promote activates the generation", promoted.status === 0 && readActive(deployRoot)?.generationId === genId, String(promoted.stderr).slice(0, 300))
    // 假 profile 包目录里的 dispatch 运行时：解析必须落到刚 promote 的代。
    mkdirSync(join(tmp, "fake-pkg", "dispatch"), { recursive: true })
    cpSync(join(repoRoot, "dispatch", "resolve.mjs"), join(tmp, "fake-pkg", "dispatch", "resolve.mjs"))
    const pinRun = runNode([
      "-e",
      [
        "const { pathToFileURL } = await import('node:url')",
        "const resolveCopy = process.argv[1]",
        "process.env.DSH_TUI_DEPLOY_ROOT = process.argv[2]",
        "const { resolveTuiRuntime } = await import(pathToFileURL(resolveCopy).href)",
        "const pin = await resolveTuiRuntime(pathToFileURL(resolveCopy).href)",
        "console.log('PIN ' + JSON.stringify({ mode: pin.mode, generationId: pin.generationId, leased: Boolean(pin.lease) }))",
      ].join("\n"),
      join(tmp, "fake-pkg", "dispatch", "resolve.mjs"),
      deployRoot,
    ])
    check("build: dispatcher pins the freshly promoted generation", pinRun.stdout.includes('"mode":"generation"') && pinRun.stdout.includes('"generationId":"' + genId + '"') && pinRun.stdout.includes('"leased":true'), pinRun.stdout + String(pinRun.stderr).slice(0, 300))

    // gen-settings-json 参数化等价（默认行为不变的构造性证明）。
    const settingsOut = join(tmp, "settings-equivalence.json")
    const gen = runNode([join(repoRoot, "scripts", "gen-settings-json.mjs"), "--lib-dir", join(repoRoot, "lib"), "--out", settingsOut])
    const same = gen.status === 0 && existsSync(settingsOut) && readFileSync(settingsOut, "utf8") === readFileSync(join(repoRoot, "lib", "settings.json"), "utf8")
    check("settings: --lib-dir/--out output is byte-identical to the default", same, String(gen.stderr).slice(0, 200))
  }
}

// ── 真实 tsc staging 构建（本地验收档；CI 默认跳过）────────────────────
if (process.env.DSH_TUI_VERIFY_FULL_COMPILE === "1" && existsSync(join(repoRoot, "lib", "types", "index.js"))) {
  const genId = "9.9.9-full-" + Math.random().toString(16).slice(2, 8)
  const build = runNode([join(repoRoot, "scripts", "build-generation.mjs"), "--deploy-root", deployRoot, "--source", repoRoot, "--id", genId], undefined, 600000)
  check("build-full: real tsc staging build succeeds", build.status === 0 && existsSync(join(deployRoot, "generations", genId + ".staging", "READY.json")), String(build.stderr).slice(0, 300))
} else {
  skip("build-full: real tsc staging build", "set DSH_TUI_VERIFY_FULL_COMPILE=1 to run")
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? "build-isolation: ALL PASS" : "build-isolation: " + failures + " FAILURE(S)" + (skips === 0 ? "" : " (" + skips + " skipped)"))
process.exit(failures === 0 ? 0 : 1)

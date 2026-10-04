#!/usr/bin/env node
/**
 * compile-src.mjs — compile:src 的新实现（deploy-transition 设计 §S04
 * "构建迁移路线·阶段 3 迁移点"：「compile:src 只留开发用途并将默认输出
 * 改至 .local/build/<fingerprint>」，保开发工作流不破）。
 *
 * 变更的本质：开发树的 lib/ 不再是「开发轨的默认活动运行路径」。产物落
 * .local/build/<fingerprint>/package/（镜像 npm files 布局：bin/lib/assets/
 * dispatch/…，相对资产路径与真实包同形），dispatch 的 source 模式经
 * .local/build/source-pointer.json 优先从这里解析——Junction 开发轨的
 * 「改 src → compile:src → 重启」循环因此不再需要写树内 lib，原地
 * clean/compile 对活进程的 ENOENT/混代窗口随之消失。
 *
 * 兼容与逃生口：
 *   --in-tree（或 DSH_TUI_COMPILE_SRC_IN_TREE=1）＝ 逐字节旧契约
 *   （tsc -p tsconfig.json + 默认 settings 生成，写树内 lib/）。
 *   旧构建根按 --keep（默认 2）保留最新 N 个，其余清理。
 *
 * Usage: node scripts/compile-src.mjs [--in-tree] [--keep <n>] [--fingerprint <id>]
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

function flag(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(name + " needs a value")
  return value
}

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"))

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

const inTree = process.argv.includes("--in-tree") || process.env.DSH_TUI_COMPILE_SRC_IN_TREE === "1"

// main 守卫：脚本被 import（回归取 pruneBuildRoots）时不执行 CLI 流程。
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href

if (invokedDirectly && inTree) {
  // 旧契约：留给确需树内 lib 的操作员/工具（如某些读 <pkg>/lib 的外部
  // 检查）。live-tree 守卫与 clean 的语义不变——这里不做破坏性操作。
  const compiled = spawnSync(process.execPath, [join(sourceRoot, "node_modules", "typescript", "bin", "tsc"), "-p", join(sourceRoot, "tsconfig.json")], {
    cwd: sourceRoot, encoding: "utf8", timeout: 600000,
  })
  if (compiled.status !== 0) {
    process.stderr.write((compiled.stdout || "") + (compiled.stderr || ""))
    process.exit(1)
  }
  const settings = spawnSync(process.execPath, [join(sourceRoot, "scripts", "gen-settings-json.mjs")], { cwd: sourceRoot, encoding: "utf8", timeout: 120000 })
  if (settings.status !== 0) {
    process.stderr.write((settings.stdout || "") + (settings.stderr || ""))
    process.exit(1)
  }
  process.stdout.write("compile:src (in-tree): lib/ rebuilt with the legacy contract\n")
  process.exit(0)
}

const buildRoot = join(sourceRoot, ".local", "build")
const fingerprint = flag("--fingerprint", gitSha(sourceRoot) + "-" + Date.now().toString(36))
if (!invokedDirectly) {
  // Imported as a module (tests): no build side effects; pruneBuildRoots below stays importable.
} else {
const target = join(buildRoot, fingerprint, "package")
mkdirSync(target, { recursive: true })

// ── 编译：经临时继承 tsconfig 直写 build root，不碰树内 tsconfig/lib ──────
const scratch = join(buildRoot, fingerprint)
const tsconfig = [
  "{",
  '  "extends": "../../../tsconfig.json",',
  '  "compilerOptions": {',
  '    "rootDir": "../../../src",',
  '    "outDir": ' + JSON.stringify(join(target, "lib", "types").replaceAll("\\", "/")) + ",",
  "  },",
  '  "include": ["../../../src"]',
  "}",
].join("\n")
writeFileSync(join(scratch, "tsconfig.json"), tsconfig)
const tscBin = join(sourceRoot, "node_modules", "typescript", "bin", "tsc")
if (!existsSync(tscBin)) throw new Error("typescript not installed in the source tree: " + tscBin)
const compiled = spawnSync(process.execPath, [tscBin, "-p", join(scratch, "tsconfig.json")], {
  cwd: sourceRoot, encoding: "utf8", timeout: 600000,
})
if (compiled.status !== 0) {
  rmSync(join(buildRoot, fingerprint), { recursive: true, force: true })
  process.stderr.write((compiled.stdout || "") + (compiled.stderr || ""))
  process.exit(1)
}

// ── settings：从 build root 的编译产物生成 ───────────────────────────────
const settings = spawnSync(process.execPath, [join(sourceRoot, "scripts", "gen-settings-json.mjs"), "--lib-dir", join(target, "lib"), "--out", join(target, "lib", "settings.json")], {
  cwd: sourceRoot, encoding: "utf8", timeout: 120000,
})
if (settings.status !== 0) {
  rmSync(join(buildRoot, fingerprint), { recursive: true, force: true })
  process.stderr.write((settings.stdout || "") + (settings.stderr || ""))
  process.exit(1)
}

// ── 静态 files 树复制（镜像 build-generation 的包形状：资产/配置的相对
//    路径与真实安装一致，dispatch source 模式按包根解析）─────────────────
for (const entry of pkg.files ?? []) {
  if (entry === "lib") continue
  const from = join(sourceRoot, entry)
  if (!existsSync(from)) continue // 开发树可能缺可选 files（如 guide 未构建）
  const to = join(target, entry)
  const stat = lstatSync(from)
  if (stat.isDirectory()) cpSync(from, to, { recursive: true })
  else cpSync(from, to)
}
cpSync(join(sourceRoot, "package.json"), join(target, "package.json"))

// ── 指针：source 模式的解析入口（tmp + rename 原子替换）─────────────────
const pointerTmp = join(buildRoot, ".source-pointer." + process.pid + ".tmp")
writeFileSync(pointerTmp, JSON.stringify({ fingerprint, dir: join(buildRoot, fingerprint), builtAt: new Date().toISOString() }, null, 2))
renameSync(pointerTmp, join(buildRoot, "source-pointer.json"))

// ── 旧构建根回收：保留最新 --keep 个（含本次）───────────────────────────
const keep = Number(flag("--keep", "2"))
pruneBuildRoots(buildRoot, keep)

process.stdout.write("compile:src: source build root " + join(buildRoot, fingerprint) + "\n")
process.stdout.write("  dispatch source mode resolves from .local/build/source-pointer.json (canonical lib/ untouched)\n")

}
/** 共享给回归测试：按 mtime 保留最新 n 个构建根，绝不碰 source-pointer.json。 */
export function pruneBuildRoots(root, keepN) {
  if (!existsSync(root)) return []
  const entries = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .map(entry => ({ name: entry.name, path: join(root, entry.name), mtimeMs: statSync(join(root, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const removed = []
  for (const entry of entries.slice(Math.max(1, keepN))) {
    rmSync(entry.path, { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}

#!/usr/bin/env node
/**
 * deployctl — operator CLI for the versioned-deploy M0 (design §S04).
 *
 * Usage:
 *   node scripts/deployctl.mjs status    --profile <profileDir>
 *   node scripts/deployctl.mjs promote   --profile <profileDir> <stagingDir> [--steal-lock]
 *   node scripts/deployctl.mjs rollback  --profile <profileDir> [--to <generationId>]
 *   node scripts/deployctl.mjs gc        --profile <profileDir> [--apply] [--min-age-days N]
 *
 * --profile is the dsh profile directory (the one containing node_modules/
 * and .dsh-tui/); DSH_TUI_DEPLOY_ROOT overrides the deploy root outright
 * (tests). The CLI is deliberately read-only by default: `gc` prints a
 * dry-run plan unless --apply is passed, and no command ever writes outside
 * the deploy root.
 */
import { deployRootFor, deployStatus, gcGenerations, promoteGeneration, readActive, rollbackGeneration, runtimeLockHealth } from "./deploy/core.mjs"
import { readFileSync } from "node:fs"
import { join } from "node:path"

function usage(exitCode) {
  console.log([
    "usage: node scripts/deployctl.mjs <command> --profile <profileDir> [options]",
    "",
    "commands:",
    "  status                          active pointer, generations, leases",
    "  promote <stagingDir>            commit a staging build and activate it",
    "                                  (--steal-lock removes a stale build lock)",
    "  rollback [--to <id>]            repoint active at the previous (or given) generation",
    "  gc [--apply]                    dry-run (default) or execute safe garbage collection",
"  health [--generation <id>]      runtime-lock closure health of the active (or given) generation",
    "",
    "options:",
    "  --profile <dir>                 dsh profile directory",
    "  --deploy-root <dir>             use this deploy root directly",
    "  --min-age-days <n>              GC retention window (default 7)",
    "  --keep <n>                      GC minimum kept READY generations (default 2)",
  ].join("\n"))
  process.exit(exitCode)
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith("--")) {
      const name = arg.slice(2)
      const next = argv[i + 1]
      if (name === "steal-lock" || name === "apply") {
        flags[name] = true
        continue
      }
      if (next === undefined || next.startsWith("--")) usage(2)
      flags[name] = next
      i += 1
    } else positional.push(arg)
  }
  return { positional, flags }
}

const argv = parseArgs(process.argv.slice(2))
const command = argv.positional[0]
if (command === undefined) usage(2)
const deployRoot = argv.flags["deploy-root"] !== undefined
  ? argv.flags["deploy-root"]
  : argv.flags.profile !== undefined
    ? deployRootFor(argv.flags.profile)
    : (process.env.DSH_TUI_DEPLOY_ROOT !== undefined ? process.env.DSH_TUI_DEPLOY_ROOT : undefined)
if (deployRoot === undefined) {
  console.error("error: pass --profile <profileDir> or --deploy-root <dir> (or set DSH_TUI_DEPLOY_ROOT)")
  usage(2)
}

try {
  if (command === "status" || command === "list") {
    const status = deployStatus(deployRoot)
    console.log("deploy root: " + status.deployRoot)
    if (status.active === undefined) {
      console.log("active: (none — the canonical package content is the runtime)")
    } else {
      console.log("active: " + status.active.generationId + " (ready " + status.active.readySha256.slice(0, 12) + ", activated " + status.active.activatedAt + ")")
      if (status.active.previousGenerationId !== undefined) console.log("rollback target: " + status.active.previousGenerationId)
    }
    for (const generation of status.generations) {
      if (generation.staging) {
        console.log("  [staging] " + generation.id + ".staging")
        continue
      }
      const tags = [
        generation.active ? "ACTIVE" : null,
        generation.rollbackTarget ? "ROLLBACK-TARGET" : null,
        generation.ready === undefined ? "NO-READY" : "ready v" + generation.ready.packageVersion + " (" + (generation.ready.sourceCommit ?? "?") + ")",
        generation.leases.join(","),
      ].filter(tag => tag !== null && tag !== "")
      console.log("  " + generation.id + (tags.length === 0 ? "" : "  [" + tags.join(" | ") + "]"))
    }
  } else if (command === "promote") {
    const stagingDir = argv.positional[1]
    if (stagingDir === undefined) usage(2)
    const result = promoteGeneration(deployRoot, { stagingDir, steal: argv.flags["steal-lock"] === true })
    console.log("promoted " + result.generationId + " (ready " + result.readySha256.slice(0, 12) + ")"
      + (result.previousGenerationId === undefined ? "" : "; rollback target: " + result.previousGenerationId))
  } else if (command === "rollback") {
    const result = rollbackGeneration(deployRoot, { to: argv.flags.to })
    console.log("rolled back to " + result.generationId + " (from " + result.from + ") — new processes pick it up; running processes keep their lease")
  } else if (command === "health") {
    const active = readActive(deployRoot)
    const generationId = argv.flags.generation ?? active?.generationId
    if (generationId === undefined) {
      console.log("health: no active generation and none passed via --generation (legacy runtime has no runtime-lock)")
      process.exit(0)
    }
    const pkgPath = join(deployRoot, "generations", generationId, "package", "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    const health = runtimeLockHealth(deployRoot, generationId, pkg)
    console.log("runtime-lock health for " + generationId + ": " + health.status.toUpperCase())
    if (health.reason !== undefined) console.log("  " + health.reason)
    for (const drift of health.drift) {
      console.log("  drifted " + drift.name + ": recorded " + drift.recorded + " → now " + drift.current)
    }
    if (health.drift.length === 0) console.log("  every recorded runtime dependency and peer resolves to the same bytes as at build time")
    if (health.status !== "healthy") process.exitCode = 1
  } else if (command === "gc") {
    const plan = gcGenerations(deployRoot, {
      apply: argv.flags.apply === true,
      minAgeDays: argv.flags["min-age-days"] === undefined ? undefined : Number(argv.flags["min-age-days"]),
      keepAtLeast: argv.flags.keep === undefined ? undefined : Number(argv.flags.keep),
    })
    console.log("gc " + (plan.apply ? "APPLIED" : "DRY-RUN (pass --apply to execute)"))
    for (const kept of plan.keep) console.log("  keep " + kept.id + "  (" + kept.reasons.join("; ") + ")")
    for (const removed of plan.remove) console.log("  " + (plan.apply ? "removed" : "would remove") + " " + removed.id + (removed.kind === "staging" ? ".staging" : "") + "  (" + removed.reason + ")")
  } else {
    console.error("unknown command: " + command)
    usage(2)
  }
} catch (error) {
  console.error("deployctl: " + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}

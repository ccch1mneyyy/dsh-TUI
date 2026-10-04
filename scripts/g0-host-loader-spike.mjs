#!/usr/bin/env node
/**
 * G0 host-loader spike — the deploy-transition design's开工 gate (§S04
 * "必须先过 G0 host-loader spike"; §分阶段交付 "M0 + G0 … Cordis loader
 * dispatcher spike、单 entry legacy compatibility").
 *
 * EMPIRICAL QUESTION: can the Cordis host loader — which resolves the TUI
 * plugin row by PACKAGE NAME — steer the running generation through a
 * stable dispatcher/package facade whose main export is a TLA module that
 * resolves deploy/active.json, takes a lease, and dynamically imports the
 * pinned generation's entry?
 *
 * METHOD: boot the REAL @deepseek-ai/cordis Context + the REAL
 * @deepseek-ai/cordis-plugin-loader from a fixture profile whose
 * node_modules is a physical flat tree (the hoisted shape the dsh profile
 * template produces — nodeLinker: hoisted), then drive the exact loader
 * code path the dsh host uses (EntryTree.import → unwrapExports →
 * registry.plugin). The facade's dispatch/ files are byte-copies of the
 * repo's dispatch/ runtime — the spike proves the shipped artifact, not a
 * mock.
 *
 * CASES (gated unless noted):
 *   generation-boot   active.json → g1: entry applies FROM the generation
 *                     tree, config forwarded, the lease exists BEFORE
 *                     generation modules evaluate (dep.js probes the leases
 *                     dir at eval time), and relative imports stay inside
 *                     the generation.
 *   pin-invariant     active.json repointed to g2 mid-process: a second
 *                     loader entry in the SAME process still evaluates g1
 *                     (one process, one generation).
 *   flip-new-process  a fresh process with active=g2 runs g2.
 *   legacy            no active.json → the package's own canonical entry
 *                     runs (single-entry legacy compatibility).
 *   source-mode       dev markers (src/ + tsconfig.json) on the package
 *                     realpath → canonical entry runs even with
 *                     active.json present (the Junction dev track must not
 *                     be silently switched by a manifest).
 *   fail-closed       wrong readySha256 in active.json → the facade import
 *                     REJECTS and the plugin never applies (no silent
 *                     canonical fallback).
 *   internal-loader   (diagnostic) which resolution path the loader took
 *                     on this Node; with --expose-internals the internals
 *                     path is exercised and must also accept the facade.
 *
 * Usage: node scripts/g0-host-loader-spike.mjs [--keep]
 * Exits non-zero when any gated case fails; prints a PASS/FAIL matrix.
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoNodeModules = join(repoRoot, "node_modules")
const fixtureSrc = join(repoRoot, "scripts", "g0-spike-fixtures")
const keep = process.argv.includes("--keep")

let failures = 0
function report(name, ok, detail = "") {
  console.log((ok ? "PASS" : "FAIL") + ": " + name + (detail === "" ? "" : "  (" + detail + ")"))
  if (!ok) failures += 1
}

/** Resolve a dependency's physical directory in the repo's pnpm layout. */
function locatePackage(scope, name) {
  const direct = join(repoNodeModules, scope, name)
  if (existsSync(direct)) return direct
  const store = join(repoNodeModules, ".pnpm")
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith(scope + "+" + name + "@")) continue
    const candidate = join(store, entry, "node_modules", scope, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error("cannot locate " + scope + "/" + name + " in the repo node_modules for the G0 fixture")
}

function writePluginEntry(typesDir, id, marker) {
  writeFileSync(join(typesDir, "dep.js"), readFileSync(join(fixtureSrc, "dep.js"), "utf8").replaceAll("__MARKER__", marker))
  writeFileSync(join(typesDir, "index.js"), readFileSync(join(fixtureSrc, "index.js"), "utf8").replaceAll("__ID__", id))
}

function writeReady(generationDir, id) {
  writeFileSync(join(generationDir, "READY.json"), JSON.stringify({
    schemaVersion: 1,
    generationId: id,
    packageVersion: "9.9.9-fixture",
    sourceCommit: "fixture",
    nodeMajor: Number(process.versions.node.split(".")[0]),
    packageTreeSha256: "0".repeat(64),
    files: {},
  }, null, 2))
  return readFileSync(join(generationDir, "READY.json"))
}

/** Build the fixture profile: flat hoisted node_modules + facade package. */
function buildFixture(root, options) {
  const withActive = options.withActive !== false
  const sourceMarkers = options.sourceMarkers === true
  const corruptReady = options.corruptReady === true
  const activeGeneration = options.activeGeneration || "g1"
  const profile = join(root, "profile")
  const nm = join(profile, "node_modules")
  mkdirSync(nm, { recursive: true })
  // A real dsh profile always carries its own package.json (name
  // "dsh-profile-<name>"). Without it, Node's package SELF-REFERENCE rule
  // resolves the bare TUI name from the nearest name-matching ancestor
  // package.json — in a dev sandbox that can be the repo checkout itself,
  // silently loading repo code instead of the fixture. The profile package
  // boundary is part of the real resolution contract under test.
  writeFileSync(join(profile, "package.json"), JSON.stringify({
    name: "dsh-profile-g0-fixture",
    private: true,
  }, null, 2))
  // Physical copies (NOT junctions): ESM resolution realpaths symlinks, so a
  // junctioned loader would resolve bare specifiers against the REPO tree,
  // not the fixture. dsh's hoisted profiles hold physical copies too. The
  // repo's own pnpm layout keeps some deps only in the virtual store, so
  // each package is located through the root link first, then .pnpm.
  for (const scope of [["@deepseek-ai", "cordis"], ["@deepseek-ai", "cordis-plugin-loader"], ["@deepseek-ai", "cosmokit"], ["@deepseek-ai", "schemastery"], ["@standard-schema", "spec"]]) {
    const from = locatePackage(scope[0], scope[1])
    const to = join(nm, scope[0], scope[1])
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true, force: true })
  }

  const facadeDir = join(nm, "@deepseek-harness-tui", "dsh-tui")
  mkdirSync(facadeDir, { recursive: true })
  writeFileSync(join(facadeDir, "package.json"), JSON.stringify({
    name: "@deepseek-harness-tui/dsh-tui",
    version: "9.9.9-fixture",
    type: "module",
    main: "./dispatch/index.js",
    exports: { ".": "./dispatch/index.js", "./package.json": "./package.json" },
  }, null, 2))
  cpSync(join(repoRoot, "dispatch"), join(facadeDir, "dispatch"), { recursive: true })
  if (sourceMarkers) {
    mkdirSync(join(facadeDir, "src"))
    writeFileSync(join(facadeDir, "tsconfig.json"), "{}\n")
  }

  // Canonical entry (legacy/source target): a stand-in plugin recording its
  // own module URL, distinct from any generation.
  mkdirSync(join(facadeDir, "lib", "types"), { recursive: true })
  writePluginEntry(join(facadeDir, "lib", "types"), "canonical", "canonical-dep")

  const deploy = join(profile, ".dsh-tui", "deploy")
  const generations = join(deploy, "generations")
  const readyBytes = {}
  for (const id of ["g1", "g2"]) {
    const generationDir = join(generations, id)
    const typesDir = join(generationDir, "package", "lib", "types")
    mkdirSync(typesDir, { recursive: true })
    writePluginEntry(typesDir, id, id + "-dep")
    readyBytes[id] = writeReady(generationDir, id)
  }
  if (withActive) {
    writeFileSync(join(deploy, "active.json"), JSON.stringify({
      schemaVersion: 1,
      generationId: activeGeneration,
      readySha256: corruptReady ? "f".repeat(64) : createHash("sha256").update(readyBytes[activeGeneration]).digest("hex"),
      activatedAt: new Date().toISOString(),
    }, null, 2))
  }
  cpSync(join(fixtureSrc, "runner.mjs"), join(root, "runner.mjs"))
  return { profile, facadeDir, deploy, generations }
}

function readEvidence(path) {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(line => line !== "").map(line => JSON.parse(line))
  } catch {
    return []
  }
}

function runRunner(root, fixture, evidencePath, extraEnv, execArgv) {
  return spawnSync(process.execPath, [...(execArgv || []), join(root, "runner.mjs")], {
    env: {
      ...process.env,
      G0_NM: join(fixture.profile, "node_modules"),
      G0_PROFILE: fixture.profile,
      G0_DEPLOY: fixture.deploy,
      G0_EVIDENCE: evidencePath,
      ...(extraEnv || {}),
    },
    encoding: "utf8",
    timeout: 60000,
  })
}

async function bootInProcess(fixture) {
  const nm = join(fixture.profile, "node_modules")
  const { Context } = await import(pathToFileURL(join(nm, "@deepseek-ai/cordis/lib/index.js")).href)
  const { Loader } = await import(pathToFileURL(join(nm, "@deepseek-ai/cordis-plugin-loader/lib/index.js")).href)
  const ctx = new Context()
  // Trailing-slash directory URL (see the runner fixture's note): without
  // it the loader's package resolution anchors one level too high.
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(fixture.profile.endsWith("/") || fixture.profile.endsWith("\\") ? fixture.profile : fixture.profile + "/").href })
  // Same stand-in "agents" service the runner fixture provides: the fake
  // plugin's inject must resolve for the fiber to reach apply.
  ctx.reflect.provide("agents", {})
  return ctx
}

const tmp = mkdtempSync(join(tmpdir(), "g0-spike-"))
try {
  // ── Cases 1 + 2 (in-process): generation boot + pin invariant ─────────
  const root12 = join(tmp, "c12")
  const fixture12 = buildFixture(root12, {})
  const evidence12 = join(root12, "evidence.jsonl")
  // The fake plugin's evidence/lease probes read G0_* env: the in-process
  // cases must set them too (the subprocess cases get them via runRunner).
  process.env.G0_DEPLOY = fixture12.deploy
  process.env.G0_EVIDENCE = evidence12
  const ctx1 = await bootInProcess(fixture12)
  await ctx1.loader.create({ id: "dsh-tui", name: "@deepseek-harness-tui/dsh-tui", config: { spike: 1 } })
  await new Promise(resolve => setTimeout(resolve, 400))
  let evidence = readEvidence(evidence12)
  const first = evidence.find(item => item.appliedConfig && item.appliedConfig.spike === 1)
  report("generation-boot: plugin applied from the pinned generation", first !== undefined)
  report("generation-boot: entry module URL is inside generations/g1/package",
    first !== undefined && first.entryUrl.replaceAll("\\", "/").includes(".dsh-tui/deploy/generations/g1/package/"))
  report("generation-boot: relative import stayed inside the generation",
    first !== undefined && first.depMarker === "g1-dep")
  report("generation-boot: entry config reached the generation's apply",
    first !== undefined && first.appliedConfig.spike === 1)
  report("generation-boot: config validated by the generation's own schema",
    first !== undefined && first.appliedConfig.fixtureId === "g1")
  report("generation-boot: lease existed before generation modules evaluated",
    first !== undefined && first.leaseDirsAtEval.includes("g1") && first.leaseFilesG1.length > 0)
  // The namespace the LOADER consumed (cached module — same instance): the
  // facade must forward the full plugin surface, not just apply.
  const facade = await import(pathToFileURL(join(fixture12.facadeDir, "dispatch", "index.js")).href)
  report("generation-boot: facade forwards name/inject/Config/extra exports",
    facade.name === "fake-tui" && Array.isArray(facade.inject) && facade.inject.length === 0
      && facade.Config?.dict?.fixtureId !== undefined
      && typeof facade.normalizeBackendChoice === "function"
      && typeof facade.default === "object")

  // Flip the pointer mid-process; a second entry must still run g1.
  const readyG2 = readFileSync(join(fixture12.generations, "g2", "READY.json"))
  writeFileSync(join(fixture12.deploy, "active.json"), JSON.stringify({
    schemaVersion: 1,
    generationId: "g2",
    readySha256: createHash("sha256").update(readyG2).digest("hex"),
    activatedAt: new Date().toISOString(),
  }, null, 2))
  await ctx1.loader.create({ id: "dsh-tui-again", name: "@deepseek-harness-tui/dsh-tui", config: { spike: 2 } })
  await new Promise(resolve => setTimeout(resolve, 400))
  evidence = readEvidence(evidence12)
  const second = evidence.filter(item => item.appliedConfig && item.appliedConfig.spike === 2)
  report("pin-invariant: repointed active.json did not switch this process",
    second.length === 1 && second[0].id === "g1")

  // ── Case 3: a fresh process picks up the new generation ───────────────
  const evidence3 = join(tmp, "c3-evidence.jsonl")
  const run3 = runRunner(root12, fixture12, evidence3)
  const third = readEvidence(evidence3)
  report("flip-new-process: fresh process booted g2",
    run3.status === 0 && third.length === 1 && third[0].id === "g2",
    "status=" + run3.status)

  // ── Case 4: legacy (no active.json) ───────────────────────────────────
  const root4 = join(tmp, "c4")
  const fixture4 = buildFixture(root4, { withActive: false })
  const evidence4 = join(root4, "evidence.jsonl")
  const run4 = runRunner(root4, fixture4, evidence4)
  const legacy = readEvidence(evidence4)
  report("legacy: no active.json → canonical entry applied",
    run4.status === 0 && legacy.length === 1 && legacy[0].id === "canonical",
    "status=" + run4.status)

  // ── Case 5: source-mode (dev markers win over active.json) ────────────
  const root5 = join(tmp, "c5")
  const fixture5 = buildFixture(root5, { sourceMarkers: true })
  const evidence5 = join(root5, "evidence.jsonl")
  const run5 = runRunner(root5, fixture5, evidence5)
  const sourced = readEvidence(evidence5)
  report("source-mode: dev markers bypass active.json → canonical entry",
    run5.status === 0 && sourced.length === 1 && sourced[0].id === "canonical",
    "status=" + run5.status)

  // ── Case 6: fail-closed (wrong readySha256) ───────────────────────────
  const root6 = join(tmp, "c6")
  const fixture6 = buildFixture(root6, { corruptReady: true })
  const evidence6 = join(root6, "evidence.jsonl")
  const run6 = runRunner(root6, fixture6, evidence6, { G0_DIRECT_FACADE: "1" })
  const none = readEvidence(evidence6)
  const rejected = (run6.stdout || "").includes("RUNNER_DIRECT_FACADE=rejected")
  const mismatchNamed = ((run6.stdout || "") + (run6.stderr || "")).includes("READY hash mismatch")
  report("fail-closed: corrupted manifest rejects the facade import", rejected)
  report("fail-closed: rejection names the READY hash mismatch", mismatchNamed)
  report("fail-closed: the plugin never applied (no silent fallback)", none.length === 0)

  // ── Case 7 (diagnostic): loader internals path ────────────────────────
  const root7 = join(tmp, "c7")
  const fixture7 = buildFixture(root7, {})
  const evidence7 = join(root7, "evidence.jsonl")
  const run7 = runRunner(root7, fixture7, evidence7, {}, ["--expose-internals"])
  const viaInternal = readEvidence(evidence7)
  const internalTag = (((run7.stdout || "").match(/RUNNER_LOADER_INTERNAL=(\S+)/) || [])[1]) || "unknown"
  report("internal-loader: facade accepted via the " + internalTag + " resolution path",
    run7.status === 0 && viaInternal.length === 1 && viaInternal[0].id === "g1",
    "internal=" + internalTag + " status=" + run7.status)
  console.log("INFO: loader resolution path on this Node: " + internalTag)
} finally {
  if (keep) console.log("fixture kept at " + tmp)
  else rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? "G0 SPIKE: ALL GATED CASES PASS" : "G0 SPIKE: " + failures + " FAILURE(S)")
process.exit(failures === 0 ? 0 : 1)

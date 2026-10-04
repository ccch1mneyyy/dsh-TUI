// G0 spike fake plugin entry — a stand-in for the real TUI plugin surface
// (name/inject/Config/apply + one extra named export) that records evidence
// when the loader applies it. __ID__ is substituted per copy (generation id
// or "canonical") so the spike can tell which tree actually ran.
//
// Config is a REAL schemastery schema (resolved through the generation's
// dependency walk-up: profile/node_modules) — cordis resolveConfig calls
// schema methods on it, and the entry config coming back validated through
// the generation's own schema is part of the forwarding proof.
import Schema from "@deepseek-ai/schemastery"
import { DEP_MARKER, LEASE_DIRS_AT_EVAL } from "./dep.js"
import { appendFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

export const name = "fake-tui"
// Empty inject on purpose: a bare Context has no services, and a fiber with
// an unmet inject stays "waiting for service" forever — which would test
// cordis scheduling, not the facade. Inject FORWARDING through the facade is
// asserted separately on the module namespace the loader consumed.
export const inject = []
export const Config = Schema.object({
  fixtureId: Schema.string().default("__ID__"),
  spike: Schema.any(),
})
export const normalizeBackendChoice = value => value

function leaseFiles(gen) {
  try {
    return readdirSync(join(process.env.G0_DEPLOY, "leases", gen))
  } catch {
    return []
  }
}

export async function apply(ctx, config) {
  appendFileSync(process.env.G0_EVIDENCE, JSON.stringify({
    id: "__ID__",
    entryUrl: import.meta.url,
    depMarker: DEP_MARKER,
    leaseDirsAtEval: LEASE_DIRS_AT_EVAL,
    leaseFilesG1: leaseFiles("g1"),
    appliedConfig: config,
  }) + "\n")
}

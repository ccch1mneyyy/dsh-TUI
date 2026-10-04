// G0 spike fake-plugin relative dep — probes the leases dir at EVAL time so
// the spike can prove lease-before-import ordering (the dispatcher must have
// written the lease before ANY generation module evaluated).
import { readdirSync } from "node:fs"
import { join } from "node:path"

export const DEP_MARKER = "__MARKER__"

function leaseDirs() {
  try {
    return readdirSync(join(process.env.G0_DEPLOY, "leases"))
  } catch {
    return []
  }
}

export const LEASE_DIRS_AT_EVAL = leaseDirs()

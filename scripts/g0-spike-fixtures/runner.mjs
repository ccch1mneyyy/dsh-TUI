// G0 spike runner — booted by scripts/g0-host-loader-spike.mjs in a fixture
// profile. Boots the REAL cordis Context + cordis-plugin-loader exactly like
// the dsh host (package-name entry through the loader), then exits. G0_* env
// carries fixture locations; G0_DIRECT_FACADE additionally imports the
// facade outside the loader to surface fail-closed rejections verbatim.
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const nm = process.env.G0_NM
const profile = process.env.G0_PROFILE
const { Context } = await import(pathToFileURL(join(nm, "@deepseek-ai/cordis/lib/index.js")).href)
const { Loader } = await import(pathToFileURL(join(nm, "@deepseek-ai/cordis-plugin-loader/lib/index.js")).href)
const ctx = new Context()
// baseUrl MUST be a directory URL (trailing slash): the loader passes it as
// the parentURL for package resolution, and a slash-less URL makes the last
// path segment act as a FILE — resolution then walks the WRONG node_modules
// chain and the bare package name stops resolving.
await ctx.plugin(Loader, { baseUrl: pathToFileURL(profile.endsWith("/") || profile.endsWith("\\") ? profile : profile + "/").href })
// The fake plugin injects the same "agents" service the real dsh-tui row
// does; provide a stand-in so the fiber actually starts (a bare Context has
// no services — without this the entry stays "waiting for service" and the
// spike would prove nothing about apply).
ctx.reflect.provide("agents", {})
console.log("RUNNER_LOADER_INTERNAL=" + (ctx.loader.internal ? ctx.loader.internal.version : "none"))
if (process.env.G0_DIRECT_FACADE === "1") {
  try {
    await import(pathToFileURL(join(nm, "@deepseek-harness-tui/dsh-tui/dispatch/index.js")).href)
    console.log("RUNNER_DIRECT_FACADE=resolved")
  } catch (error) {
    console.log("RUNNER_DIRECT_FACADE=rejected: " + error.message)
  }
}
// Surface loader-logged errors: the bare Context has no console sink, and
// Entry._init swallows import/apply-chain failures into ctx.logger.error —
// without this hook a rejected facade import is invisible.
for (const level of ["error", "warn"]) {
  const original = ctx.logger[level].bind(ctx.logger)
  ctx.logger[level] = (...args) => {
    console.log("RUNNER_LOG_" + level.toUpperCase() + ": " + args.map(item => (item && item.stack) || String(item)).join(" ").slice(0, 600))
    original(...args)
  }
}
await ctx.loader.create({ id: "dsh-tui", name: "@deepseek-harness-tui/dsh-tui", config: { spike: true } })
await new Promise(resolve => setTimeout(resolve, 400))
const entry = ctx.loader.store["dsh-tui"]
if (entry !== undefined) {
  console.log("RUNNER_ENTRY fiberState=" + entry.fiber?.state + " uid=" + entry.fiber?.uid
    + " initPending=" + (entry._initTask !== undefined) + " inject=" + JSON.stringify(entry.fiber?.inject))
}
console.log("RUNNER_DONE")
process.exit(0)

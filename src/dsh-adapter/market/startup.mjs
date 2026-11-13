/** Protect the real Node main before its first dependency import. */
import { acquireStartupLease } from './lease.mjs'

const profileDir = new URL(import.meta.url).searchParams.get('profileDir')
if (!profileDir) throw new Error('The TUI startup profile is missing')
// Native host diagnostics must not resolve socket addresses during module loading.
if (process.report !== undefined) process.report.excludeNetwork = true
await acquireStartupLease(profileDir)
// Replacements select their newly installed release's preload; other children
// must not inherit this one through execArgv. Preserve every caller-owned flag.
for (let index = 0; index < process.execArgv.length; index++) {
  if (process.execArgv[index] === '--import' && process.execArgv[index + 1] === import.meta.url) {
    process.execArgv.splice(index, 2)
    break
  }
}
// The profile row adopts this same lease. Queries and boot failures exit
// naturally: the unref'ed marker closes with this actual application process.

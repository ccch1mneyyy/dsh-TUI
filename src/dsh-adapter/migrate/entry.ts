/**
 * Child processes do not inherit the TUI's package resolution hooks. Install
 * the host resolver before the first import of migration's framework peers.
 */
import { loadHostDsh, prepareHostModuleResolution } from '../host-dsh.js'

const reasonOf = (value: unknown): string => value instanceof Error ? value.message : String(value)

/** Keep a directly written diagnostic on one line. */
const flat = (value: unknown): string =>
  reasonOf(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()

export async function cliMigrate(argv: readonly string[], profileDir: string): Promise<number> {
  let root: Awaited<ReturnType<typeof prepareHostModuleResolution>> | undefined
  let hostError: unknown
  try {
    root = await prepareHostModuleResolution(await loadHostDsh(), profileDir)
  } catch (error) {
    // Development installs and older hosts may already resolve their peers
    // directly. Try that path once: a failed ESM import cannot be retried
    // reliably because Node caches rejected module jobs.
    hostError = error
  }
  let failed = false
  let exitCode: number
  try {
    const { cliMigrate: run } = await import('./cli.js')
    exitCode = await run(argv)
  } catch (error) {
    failed = true
    if (hostError === undefined) throw error
    throw new Error(`${reasonOf(error)}; host module resolution: ${reasonOf(hostError)}`, { cause: error })
  } finally {
    try {
      await root?.fiber.dispose()
    } catch (error) {
      // The migration already ran: a cleanup failure must not turn a finished
      // run into "could not run". Keep the original error on the failure path.
      if (!failed) {
        process.stderr.write(`dsh-tui: migrate completed; host module resolution cleanup failed: ${flat(error)}\n`)
      }
    }
  }
  return exitCode
}

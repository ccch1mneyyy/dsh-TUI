/**
 * Which kernel the package's entry boots (docs/standalone-host-design.md).
 * The launcher repeats the cheap half inline; the entry decides again here
 * with the profile patch's Config row, which only it can afford to read.
 */
import { existsSync, readFileSync } from 'node:fs'
import { KERNEL_SWITCH_HANDOFF_ENV, parseBackendId, readKernelPrefs, resolveRememberedBackend, type KernelBackendId } from './kernelPrefs.js'
import { isRegisteredBackend, parseBackendChoice } from './dsh-adapter/backend-registry.js'
import { profilePatchPath, readProfileTuiSettings } from './tuiSettingsFile.js'

/** The profile the launcher would have started (`dsh --profile <name>`). */
const HOST_PROFILE_ENV = 'DSH_TUI_PROFILE'

export function hostProfile(env: NodeJS.ProcessEnv = process.env): string {
  const name = env[HOST_PROFILE_ENV]?.trim()
  return name === undefined || name === '' ? 'dsh-tui' : name
}

/** An expression that only forwards DSH_TUI_BACKEND (the bundle row's own
 *  form): the entry already ranks that variable, right below the row. */
const ENV_BACKEND_EXPRESSION = /^\s*process\.env\.DSH_TUI_BACKEND\s*(?:(?:\|\||\?\?)\s*undefined\s*)?$/u

/** The `backend` the profile patch's dsh-tui row pins, if any (the Config
 *  row a DSH composition would read). `'dynamic'`: a `!!js` expression only
 *  the profile's own Loader can evaluate; one that only forwards
 *  DSH_TUI_BACKEND is no pin. */
export function configuredBackend(profile: string, patchFile: string = profilePatchPath(profile)): KernelBackendId | 'dynamic' | undefined {
  // Most patches never mention it: skip the YAML parse then.
  try {
    if (!existsSync(patchFile) || !readFileSync(patchFile, 'utf8').includes('backend')) return undefined
  } catch {
    return undefined
  }
  const expressions = new Map<string, string>()
  const backend = readProfileTuiSettings(patchFile, ['backend'], expressions)?.backend
  const expression = expressions.get('backend')
  if (expression !== undefined) return ENV_BACKEND_EXPRESSION.test(expression) ? undefined : 'dynamic'
  return parseBackendChoice(backend)
}

/** Whether the entry hands this launch to `dsh --profile`: a dynamic Config
 *  row decides the kernel there, unless a kernel-switch handoff outranks it. */
export function delegatesToProfile(configured: KernelBackendId | 'dynamic' | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return configured === 'dynamic' && parseBackendId(env[KERNEL_SWITCH_HANDOFF_ENV]) === undefined
}

/** The kernel this launch boots on, ranked as in the plugin (handoff → Config
 *  row → DSH_TUI_BACKEND → kernel.json → dsh). An id that is not installed
 *  falls back to dsh like a typo, so the entry never mounts an unloadable kernel. */
export function entryKernel(env: NodeJS.ProcessEnv = process.env, input: {
  readonly configured?: KernelBackendId | 'dynamic'
  readonly memoryFile?: string
} = {}): KernelBackendId {
  const handoff = parseBackendId(env[KERNEL_SWITCH_HANDOFF_ENV])
  const memory = readKernelPrefs(input.memoryFile).backend
  return resolveRememberedBackend({
    ...(handoff === undefined ? {} : { handoff }),
    ...(input.configured === undefined || input.configured === 'dynamic' ? {} : { configured: input.configured }),
    envRaw: env.DSH_TUI_BACKEND,
    envKnown: isRegisteredBackend,
    memory: isRegisteredBackend(memory) ? memory : undefined,
  })
}

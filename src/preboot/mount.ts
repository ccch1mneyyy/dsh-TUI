/**
 * Mount the root tree in its boot phase and publish the slot.
 *
 * Runs inside the dsh process from the `--import` preload, BEFORE dsh reads
 * the profile. Nothing here may import `@deepseek-ai/*` directly: the point
 * is to paint before that module graph loads (Chat's own adapter modules do
 * pull a few upstream packages in, ~70ms, which dsh would load anyway; so
 * does the settings read below, which imports the host's own app-boot — the
 * same file dsh's bin imports right after, served from the module cache).
 * Renderer-affecting choices that the plugin later resolves through the
 * settings service (fullscreen, terminal images, page margin, minimal UI,
 * splash options, language) are read here from where the host keeps them:
 * on 0.1.7+ hosts the `dsh-tui` row's Config, composed by the host's own
 * profile code (../dsh-adapter/hostProfileConfig.ts); on older hosts
 * `$DSH_HOME/settings.yaml` plus the renderer decision the plugin recorded
 * for the profile's cordis.yml (rendererPrefs.ts). The `~/.dsh-tui`
 * preference files fill the rest. The plugin mounts a fresh slot if its own
 * resolution still disagrees (see plugin.ts). The landing page (workspace home or chat)
 * and the launchpad / first-run guide use the plugin's own rules
 * (homePrefs.ts) on the same inputs.
 *
 * Until the slot leaves `booting`, this module owns how the boot phase ends
 * badly: a fatal error, a boot watchdog (dsh never mounts dsh-tui, then the
 * plugin never goes live), or dsh exiting on its own all restore the
 * terminal, replay what dsh wrote to the swallowed stderr, and exit non-zero.
 * A deliberate user exit (double Ctrl+C, `/exit`) takes the same teardown
 * but exits 0.
 */
import { existsSync, readFileSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspect } from 'node:util'
import { parse as parseYaml } from 'yaml'
import { readHostTuiConfig } from '../dsh-adapter/hostProfileConfig.js'
import { QuestionStore } from '../dsh-adapter/questions.js'
import { readEffortPref } from '../effortPrefs.js'
import { decideLaunchpadOnBoot, decideOnboardingOnBoot, decideOpenHomeOnBoot, readHomePrefs } from '../homePrefs.js'
import { isLang, resolveStartupLang, setLang, t } from '../i18n.js'
import { fatalReasonForExit, registerProcessGuardFatalSink } from '../ink/update-overflow-guard.js'
import { setMinimalUiMode } from '../minimalUiMode.js'
import { readModelPref } from '../modelPrefs.js'
import { readRendererDecision, type RendererDecision } from '../rendererPrefs.js'
import { resumeTargetFromArgv } from '../sessionHistory.js'
import { initialPromptFromCmdlineArgs } from '../dsh-adapter/startup-args.js'
import { applyPageMargin, normalizePageMargin } from '../tuiDisplayPrefs.js'
import type { RenderOptions } from '../ui.js'
import { resolveDshProfileName } from '../update.js'
import { resolveSessionCwd } from '../utils/workspaceRoot.js'
import { captureBootStderr } from './stderrCapture.js'
import { createBootChannel } from './bootChannel.js'
import { publishPrebootSlot } from './handle.js'
import { mountChatHost, type BootSlot } from './host.js'

/** The `dsh-tui:` section of settings.yaml, loosely typed. */
export type TuiSettingsLayer = Readonly<Record<string, unknown>>

/** `$DSH_HOME`, defaulting like the launcher and dsh-home-paths do. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
}

/**
 * Read the `dsh-tui` namespace of the DSH settings document. A missing or
 * malformed file yields an empty layer — the boot screen must never be the
 * reason a launch fails.
 */
export function readTuiSettingsLayer(dshHome: string = resolveDshHome()): TuiSettingsLayer {
  return readTuiSettingsSection(join(dshHome, 'settings.yaml'))
}

/** The `dsh-tui` section of one settings document; missing/malformed → empty. */
function readTuiSettingsSection(path: string): TuiSettingsLayer {
  try {
    const document: unknown = parseYaml(readFileSync(path, 'utf8'))
    if (document === null || typeof document !== 'object') return {}
    const layer = (document as Record<string, unknown>)['dsh-tui']
    return layer !== null && typeof layer === 'object' ? layer as TuiSettingsLayer : {}
  } catch {
    return {}
  }
}

export interface PrebootSettingsOptions {
  dshHome?: string
  /** The dsh process argv after `node <entry>`. */
  argv: readonly string[]
  /** The dsh entry script about to run (the preload's `process.argv[1]`). */
  hostEntry: string | undefined
}

/**
 * The legacy settings document a `register()`-patched settings service on a
 * 0.1.7+ host reads (dsh-purge's order): its own `settings-legacy.yaml`, else
 * the `settings.yaml.imported` the host renamed the old document to. The
 * host's own `settings.yaml` is gone by then (it is imported and renamed).
 */
export function readLegacySettingsDocument(dshHome: string): TuiSettingsLayer {
  for (const name of ['settings-legacy.yaml', 'settings.yaml.imported']) {
    const path = join(dshHome, name)
    if (!existsSync(path)) continue
    return readTuiSettingsSection(path)
  }
  return {}
}

/**
 * The `dsh-tui` settings the live plugin will boot with, as far as they can
 * be known before dsh runs — resolved the way the plugin will resolve them
 * (src/dsh-adapter/compat/settings.ts):
 *
 * - older hosts (no host composition): the `settings.yaml` layer;
 * - a 0.1.7+ host with a `register()` settings service: its legacy document
 *   through the plugin's settings schema, Config filling only what that
 *   leaves unset (`value ?? config`);
 * - a 0.1.7+ host otherwise: the composed row Config, with a settings.yaml
 *   still waiting to be imported on top.
 */
export async function readPrebootSettingsLayer(options: PrebootSettingsOptions): Promise<TuiSettingsLayer> {
  const dshHome = options.dshHome ?? resolveDshHome()
  const pending = readTuiSettingsLayer(dshHome)
  const host = await readHostTuiConfig({
    hostEntry: options.hostEntry,
    profile: resolveDshProfileName(options.argv),
    dshHome,
    argv: options.argv,
  })
  if (host === undefined) return pending
  if (host.legacySettings) {
    const { resolveTuiSettingsDocument } = await import('../dsh-adapter/tuiSettingsSchema.js')
    const value = resolveTuiSettingsDocument(readLegacySettingsDocument(dshHome))
    const defined = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))
    return { ...host.config, ...defined }
  }
  // Imported into the profile (merged over the row) on this very boot.
  const statusBar = isRecord(host.config.statusBar) && isRecord(pending.statusBar)
    ? { statusBar: { ...host.config.statusBar, ...pending.statusBar } }
    : {}
  return { ...host.config, ...pending, ...statusBar }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const bool = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback
const str = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined
/** Timeout bounds as the messages print them: 60_000 → 60, 250 → 2.5. */
const secondsOf = (ms: number): number => Math.round(ms / 100) / 10

/** Renderer decisions and route hints derived from the settings layer, exported for the regression. */
export interface PrebootDecisions {
  fullscreen: boolean
  terminalImages: boolean
  minimalUi: boolean
  effort: string | undefined
  model: string
}

/**
 * Current branch of a git checkout, read from `.git/HEAD` (following a
 * worktree's `gitdir:` pointer). Detached HEAD and non-repos yield undefined
 * — the same cases where the channel's `git branch --show-current` shows
 * nothing. A file read instead of a spawn: this runs before the first frame.
 */
export function readGitBranch(root: string): string | undefined {
  try {
    let gitDir = join(root, '.git')
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/mu.exec(readFileSync(gitDir, 'utf8'))
      if (pointer === null) return undefined
      gitDir = resolve(root, pointer[1]!.trim())
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/u.exec(head)
    return ref === null ? undefined : ref[1]
  } catch {
    return undefined
  }
}

/**
 * @param layer - the `dsh-tui:` settings layer.
 * @param persisted - what the plugin resolved for this profile when
 *   settings.yaml was silent (its cordis.yml layer, see rendererPrefs.ts).
 */
export function decidePreboot(layer: TuiSettingsLayer, persisted?: RendererDecision): PrebootDecisions {
  return {
    // The plugin's precedence: the settings user layer, then cordis.yml
    // (known here only as the plugin's persisted record), then the schema
    // defaults from src/dsh-adapter/index.ts (both renderer flags on). A
    // boot slot that matches is taken live in place; one that does not is
    // re-mounted when dsh is up.
    fullscreen: bool(layer.fullscreen, persisted?.fullscreen ?? true),
    terminalImages: bool(layer.terminalImages, persisted?.terminalImages ?? true),
    minimalUi: bool(layer.minimal, false),
    // The live order: the effortDefault setting (`auto` = unset) re-seats
    // the route default over the Config `effort`, over effort.json.
    effort: (layer.effortDefault === 'auto' ? undefined : str(layer.effortDefault)) ?? str(layer.effort) ?? readEffortPref(),
    model: readModelPref()?.model ?? 'DeepSeek',
  }
}

/**
 * The app arguments dsh will hand the plugin as `ctx.cmdlineArgs`: the
 * launcher starts dsh as `<dsh> --profile <p> [host flags] -- <app args>`,
 * and dsh consumes that first `--` itself. No separator, no app args.
 */
export function appArgsFromHostArgv(argv: readonly string[]): readonly string[] {
  const separator = argv.indexOf('--')
  return separator === -1 ? [] : argv.slice(separator + 1)
}

/** The boot-screen choices Chat seeds once at mount (see PrebootLanding). */
export interface PrebootLanding {
  readonly openHomeOnBoot: boolean
  readonly launchpadOnBoot: boolean
  readonly onboardingOnBoot: boolean
}

/**
 * The plugin's landing decisions (plugin.ts, `openHomeOnBoot` /
 * `launchpadOnBoot` / `onboardingOnBoot`), from what the preload can see: the
 * same env handoffs cordis.patch.yml feeds into `sessionId` / `workspace`,
 * and the same argv parsers and rules. A literal `sessionId:` /
 * `workspace:` in a hand-written cordis.yml is invisible here; the plugin's
 * value still arrives at the handoff (Chat follows it for the home).
 */
export function decidePrebootLanding(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): PrebootLanding {
  const appArgs = appArgsFromHostArgv(argv)
  const launch = {
    launchSessionId: env.DSH_TUI_RESUME_SESSION ?? resumeTargetFromArgv(appArgs),
    initialPrompt: initialPromptFromCmdlineArgs(appArgs),
  }
  return {
    openHomeOnBoot: decideOpenHomeOnBoot({
      ...launch,
      homeSeen: readHomePrefs().seen === true,
      requestedWorkspace: env.DSH_TUI_WORKSPACE_TARGET,
    }),
    launchpadOnBoot: decideLaunchpadOnBoot(launch, env),
    onboardingOnBoot: decideOnboardingOnBoot(launch),
  }
}

/**
 * How long the boot screen waits for the dsh-tui plugin to take the slot
 * before giving up: 60s.
 *
 * The clock covers only dsh loading its module graph and composing the
 * profile up to the dsh-tui row's apply (normally 1–2s; a cold start on a
 * slow disk or under an on-access virus scanner can take several times
 * that, and the row waits for every service it injects). A slot nobody
 * takes by then means the profile has no dsh-tui row or its config failed
 * validation, and the alternative is a boot screen that never leaves.
 *
 * Taking the slot does NOT end the boot, so this clock hands over to
 * HANDOFF_TIMEOUT_MS instead of disarming: the plugin's own startup (settings
 * against the live services, workspace, resume, agent create) still runs
 * behind it. `DSH_TUI_PREBOOT_TIMEOUT_MS` overrides it; `0` disables it.
 */
export const BOOT_TIMEOUT_MS = 60_000

export function resolveBootTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DSH_TUI_PREBOOT_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return BOOT_TIMEOUT_MS
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : BOOT_TIMEOUT_MS
}

/**
 * How long the boot screen waits, after the plugin has taken the slot, for
 * `ready(live)` before giving up: 180s.
 *
 * `claimed` says only that the dsh-tui row's apply ran and owns the terminal;
 * the plugin still resolves its settings against the live services, creates
 * the agent, resolves the workspace and resumes the session before it replaces
 * the boot channel — resuming a large session can take minutes, which is why
 * this clock is several times the boot one. Disarming here instead (the old
 * behavior) meant a boot stuck in that stretch sat on the boot screen forever,
 * with the terminal in modes nothing would restore. A boot that reaches
 * `ready` (or is disposed) clears it; `DSH_TUI_PREBOOT_HANDOFF_TIMEOUT_MS`
 * overrides it; `0` disables it.
 */
export const HANDOFF_TIMEOUT_MS = 180_000

export function resolveHandoffTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DSH_TUI_PREBOOT_HANDOFF_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return HANDOFF_TIMEOUT_MS
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : HANDOFF_TIMEOUT_MS
}

export interface MountPrebootOptions {
  dshHome?: string
  /** Process exit used by Chat's double Ctrl+C and the boot funnel; injectable for tests. */
  exit?: (code: number) => void
  /** Renderer stream/console overrides (headless regressions). */
  renderOptions?: Pick<RenderOptions, 'stdout' | 'stdin' | 'stderr' | 'patchConsole'>
  /** The dsh process argv after `node <dsh>` (default `process.argv.slice(2)`). */
  argv?: readonly string[]
  /** The dsh entry script (default `process.argv[1]`); its install composes the profile. */
  hostEntry?: string
  /** Boot watchdog bound (default: resolveBootTimeoutMs()); 0 disables it. */
  bootTimeoutMs?: number
  /** Post-claim watchdog bound (default: resolveHandoffTimeoutMs()); 0 disables it. */
  handoffTimeoutMs?: number
}

/**
 * Upper bound on waiting for the first visible frame. Terminal background
 * detection (ThemeProvider, OSC 11) normally answers in ~10ms and times out
 * at 400ms; past this bound dsh starts loading regardless.
 */
export const FIRST_FRAME_WAIT_MS = 700

/**
 * Paint the boot-phase root and publish the slot. Resolves once the first
 * VISIBLE frame has been committed (bounded by FIRST_FRAME_WAIT_MS) so the
 * preload can let dsh start loading without racing the paint.
 */
export async function mountPreboot(options: MountPrebootOptions = {}): Promise<BootSlot> {
  const argv = options.argv ?? process.argv.slice(2)
  const layer = await readPrebootSettingsLayer({
    dshHome: options.dshHome,
    argv,
    hostEntry: options.hostEntry ?? process.argv[1],
  })
  // Same precedence as plugin.ts before the first render: env → settings
  // user layer → persisted /lang choice → locale/zh. (cordis.yml `lang` is
  // not visible here; the plugin re-applies it, strings re-resolve live.)
  const envLang = process.env.DSH_TUI_LANG
  setLang(isLang(envLang) ? envLang : isLang(layer.lang) ? layer.lang : resolveStartupLang())
  const persisted = readRendererDecision(resolveDshProfileName(argv))
  const decisions = decidePreboot(layer, persisted)
  setMinimalUiMode(decisions.minimalUi)
  applyPageMargin(normalizePageMargin(layer.pageMargin))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const cwd = resolveSessionCwd(undefined)
  const channel = createBootChannel({
    model: decisions.model,
    effort: decisions.effort,
    cwd,
    gitBranch: readGitBranch(cwd),
    settings: layer,
  })

  // ── boot-phase lifecycle ────────────────────────────────────────────────
  // Until the plugin takes the slot, nothing in dsh knows the boot screen
  // exists: if dsh-tui never mounts, or dsh dies or returns first, the
  // terminal stays in the boot screen's modes and the reason stays inside
  // its swallowed stderr. Everything below funnels those endings through
  // `failBoot`: restore the terminal, replay what dsh wrote, say why, exit
  // non-zero.
  const fatalOut = options.renderOptions?.stderr ?? process.stderr
  let slot: BootSlot | undefined
  let capture: ReturnType<typeof captureBootStderr> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  /** Drop the armed clock without touching anything else. */
  const clearWatchdog = (): void => {
    if (watchdog !== undefined) clearTimeout(watchdog)
    watchdog = undefined
  }
  /**
   * (Re-)arm the boot-phase clock; `0` disables it. `message` is called when
   * it fires, so the language active at that point decides the text. The
   * `booting` guard keeps a clock that lost the race with `ready`/`dispose`
   * from reporting a boot that did end well.
   */
  const armWatchdog = (timeoutMs: number, message: () => string): void => {
    clearWatchdog()
    if (timeoutMs <= 0) return
    watchdog = setTimeout(() => {
      if (bootSlot.phase !== 'booting') return
      failBoot(`${message()}\n`, 1)
    }, timeoutMs)
    // The boot screen's stdin keeps the loop alive while it waits; if
    // nothing else does, the exit backstop above covers the exit.
    watchdog.unref?.()
  }
  /** Stop guarding for good: the slot left `booting`, or was torn down. */
  const standDown = (): void => {
    clearWatchdog()
    capture?.release()
  }
  /** Leaving `booting` for good also drops the exit backstop. */
  const settle = (): void => {
    standDown()
    process.off('exit', onProcessExit)
  }
  /**
   * Tear the boot screen down and put `message` (after whatever dsh wrote
   * to stderr meanwhile) on the restored terminal. Synchronous on the real
   * fd: an exit follows immediately, and a stream write to a redirected
   * stderr can be dropped (macOS pipes/files).
   */
  const teardown = (message: string | undefined): void => {
    const replay = capture?.text() ?? ''
    // Best-effort restore: a throw here (EIO on a revoked TTY, an effect
    // cleanup) would escape a process-guard listener as exit 7 and mask the
    // reason. dispose() fires 'disposed', which settles the guards.
    try {
      slot?.dispose()
    } catch {}
    settle()
    const text = `${replay}${replay === '' || replay.endsWith('\n') ? '' : '\n'}${message ?? ''}`
    if (text === '') return
    const fd = (fatalOut as { fd?: unknown }).fd
    try {
      if (typeof fd === 'number') writeSync(fd, text)
      else fatalOut.write(text)
    } catch {}
  }
  const failBoot = (message: string | undefined, code: number): void => {
    teardown(message)
    exit(code)
  }
  /**
   * Backstop for an exit nobody routed through failBoot while still booting
   * (dsh returned or called process.exit before mounting dsh-tui): restore
   * the terminal, and never report success for a session that never ran.
   * `process.exitCode` set inside an 'exit' listener is the status Node exits
   * with.
   */
  function onProcessExit(code: number): void {
    if (slot?.phase !== 'booting') return
    teardown(code === 0
      ? `${t('preboot-exited-early')}\n`
      : undefined)
    if (code === 0) process.exitCode = 1
  }

  const bootTimeoutMs = options.bootTimeoutMs ?? resolveBootTimeoutMs()
  const handoffTimeoutMs = options.handoffTimeoutMs ?? resolveHandoffTimeoutMs()
  const bootSlot = await mountChatHost({
    fullscreen: decisions.fullscreen,
    terminalImages: decisions.terminalImages,
    renderOptions: options.renderOptions,
    firstFrameWaitMs: FIRST_FRAME_WAIT_MS,
    onLifecycle: event => {
      if (event === 'claimed') {
        // Handed over, but not booted: the plugin still has its settings,
        // workspace, resume and agent create in front of it before
        // `ready(live)`. Stop capturing dsh's stderr (the plugin owns the
        // terminal now) and swap this clock for the longer handoff one —
        // standing down here is what let a stuck handoff sit on the boot
        // screen with nothing left to end it.
        capture?.release()
        armWatchdog(handoffTimeoutMs, () =>
          t('preboot-handoff-timeout', { seconds: secondsOf(handoffTimeoutMs) }))
      } else {
        settle()
      }
    },
    initial: {
      channel,
      props: {
        // Inert until the plugin's `ready(live)` replaces it: no ask can be
        // parked before a session exists.
        questionStore: new QuestionStore(),
        // Same rules as the plugin (homePrefs.ts), so the first frame is
        // already the page the live session lands on.
        ...decidePrebootLanding(argv),
        // Chat's double Ctrl+C (or a boot-safe /exit) while dsh is still
        // loading is a user exit, so it leaves with 0 like the plugin's exit
        // funnel does. Any other code reads as a crash to the launcher, which
        // then prints the profile-exited diagnosis and offers safe mode —
        // for a deliberate exit. teardown() drops the exit backstop first,
        // so this 0 is not rewritten to 1.
        onExit: () => failBoot(undefined, 0),
      },
    },
  })
  slot = bootSlot
  process.on('exit', onProcessExit)
  // Constructing the Ink instance installed the #185 process guard, whose
  // listeners rethrow anything no sink claims — from inside the listener, so
  // Node exits 7 without an 'exit' event and the terminal keeps the
  // alt-screen, mouse tracking and hidden cursor. The plugin registers the
  // real sink deep inside apply; until then (dsh composing the profile,
  // loading plugins) a fatal error is dsh's, not ours: restore the terminal,
  // print it the way Node would, and exit 1 — the plain path's behavior. The
  // plugin's registration replaces this one before it takes the slot live.
  registerProcessGuardFatalSink((error, origin) => {
    if (bootSlot.phase !== 'booting') return false
    // `Promise.reject()` / `throw undefined` would print a bare `undefined`.
    failBoot(`${inspect(fatalReasonForExit(error, origin))}\n`, 1)
    return true
  })
  // Above Ink's own stderr/console patches (installed with the instance).
  capture = captureBootStderr()
  armWatchdog(bootTimeoutMs, () => t('preboot-timeout', { seconds: secondsOf(bootTimeoutMs) }))
  publishPrebootSlot(bootSlot)
  return bootSlot
}

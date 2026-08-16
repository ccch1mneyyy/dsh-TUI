/**
 * Optional host runtime for the Smart dsh-routing-suite enhancement.
 *
 * Router Standard is bundled as preset source. Super Injector is loaded from
 * an independently installed, byte-verified upstream v0.3.3 payload instead
 * of being redistributed here: upstream declares BSD-3-Clause but publishes
 * no LICENSE/NOTICE artifact. The bridge supplies only the web route registry
 * contract required by the host bundle; it does not open a server or claim to
 * provide the upstream browser settings client.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { enhancementOf } from './enhancementInheritance.js'
import { resolveDshProfileName } from '../update.js'
import { smartModeOf } from '../smartPrefs.js'

export const name = 'dsh-tui-smart-runtime'
export const inject = ['loader', 'timer', 'tools', 'systemPrompt']

export const SUPER_INJECTOR_VERSION = '0.3.3'
export const SUPER_INJECTOR_BUNDLE_SHA256 = '5dbe8495cd8960267293c6a1f3e0f604b8c32665c02b980d03256cf41a966e38'
export const SUPER_INJECTOR_TOOL_NAMES = [
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_stage_demote',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_uninject_plugin',
  'dev_clear_routes',
  'dev_reload_package',
  'dev_heal_links',
  'dev_fix_patch',
  'dev_plugin_status',
  'dev_install_package',
  'dev_scaffold_plugin',
  'dev_build_plugin',
  'dev_release_plugin',
  'dev_self_test',
] as const

interface WebRoute {
  readonly kind: 'exact' | 'prefix' | 'upgrade'
  readonly path: string
  readonly handler: unknown
}

/** Minimal registry-only webServer contract used by the upstream host code. */
export class TerminalWebServerCompat {
  readonly exact = new Map<string, WebRoute>()
  readonly prefixes = new Map<string, WebRoute>()
  readonly upgrades = new Map<string, WebRoute>()

  register(route: WebRoute): () => void {
    const table = route.kind === 'exact'
      ? this.exact
      : route.kind === 'upgrade'
        ? this.upgrades
        : this.prefixes
    table.set(route.path, route)
    return () => {
      if (table.get(route.path) === route) table.delete(route.path)
    }
  }
}

export interface SmartHostLocation {
  readonly entry: string
  readonly packageFile: string
}

function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  return configured ? configured : join(homedir(), '.dsh')
}

function locationFrom(value: string): SmartHostLocation {
  const absolute = resolve(value)
  if (extname(absolute).toLowerCase() === '.js') {
    return { entry: absolute, packageFile: resolve(dirname(absolute), '..', 'package.json') }
  }
  return { entry: join(absolute, 'lib', 'index.js'), packageFile: join(absolute, 'package.json') }
}

/** Resolve an explicit override, the active profile, then the suite's web profile. */
export function findSmartHostRuntime(
  home = dshHome(),
  profile = resolveDshProfileName() ?? 'dsh-tui',
  override = process.env.DSH_SMART_RUNTIME_PATH?.trim(),
): SmartHostLocation | undefined {
  const candidates = [
    ...(override ? [locationFrom(override)] : []),
    locationFrom(join(home, 'profiles', profile, 'node_modules', '@dsh-external', 'dsh-super-injector')),
    locationFrom(join(home, 'profiles', 'web', 'node_modules', '@dsh-external', 'dsh-super-injector')),
  ]
  return candidates.find(candidate => existsSync(candidate.entry) && existsSync(candidate.packageFile))
}

export function verifySmartHostRuntime(location: SmartHostLocation): { ok: true } | { ok: false; reason: string } {
  try {
    const metadata = JSON.parse(readFileSync(location.packageFile, 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (metadata.name !== '@dsh-external/dsh-super-injector') {
      return { ok: false, reason: `unexpected package name in ${location.packageFile}` }
    }
    if (metadata.version !== SUPER_INJECTOR_VERSION) {
      return { ok: false, reason: `expected Smart host runtime v${SUPER_INJECTOR_VERSION}, found ${String(metadata.version)}` }
    }
    const digest = createHash('sha256').update(readFileSync(location.entry)).digest('hex')
    if (digest !== SUPER_INJECTOR_BUNDLE_SHA256) {
      return { ok: false, reason: `host bundle SHA-256 mismatch (${digest})` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

type HostRuntimeModule = {
  readonly apply: (ctx: Context, config: Record<string, unknown>) => unknown
  readonly Config?: unknown
  readonly inject?: unknown
  readonly name?: string
}

export interface SmartRuntimeStatus {
  phase: 'router-only' | 'loading' | 'active' | 'failed'
  detail: string
  source?: string
}

export async function apply(ctx: Context): Promise<void> {
  const status: SmartRuntimeStatus = {
    phase: 'router-only',
    detail: `optional Smart host runtime v${SUPER_INJECTOR_VERSION} is not installed; routing remains active`,
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dev_smart_status',
    description: 'Show Smart routing and optional host runtime integration status.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return [
        'mode=smart',
        'router=dsh-router-standard v0.3.0 (Flash=standard, V4 Pro=pro)',
        `host=${status.phase}: ${status.detail}`,
        ...(status.source === undefined ? [] : [`source=${status.source}`]),
        'browser-ui=unavailable in the terminal profile',
      ].join('\n')
    },
  })), `${name}: dev_smart_status`)

  const smartTools = new Set<string>(['dev_smart_status', ...SUPER_INJECTOR_TOOL_NAMES])
  const smartContexts = new Set(['dsh-super-injector'])
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent !== undefined
      && (enhancementOf(ctx, agent as Agent) === 'smart' || smartModeOf(agent.session))) return assembled
    return {
      ...assembled,
      contexts: assembled.contexts.filter(entry => !smartContexts.has(entry.name)),
      tools: assembled.tools.filter(tool => !smartTools.has(tool.name)),
    }
  })

  const location = findSmartHostRuntime()
  if (location === undefined) {
    ctx.logger.warn(
      `dsh-tui Smart: optional host runtime v${SUPER_INJECTOR_VERSION} payload not found; `
      + 'set DSH_SMART_RUNTIME_PATH to its package directory to enable the full host tool set',
    )
    return
  }
  status.source = location.entry
  const verified = verifySmartHostRuntime(location)
  if (!verified.ok) {
    status.phase = 'failed'
    status.detail = verified.reason
    ctx.logger.warn(`dsh-tui Smart: refusing unverified host runtime payload: ${verified.reason}`)
    return
  }

  status.phase = 'loading'
  status.detail = `loading verified v${SUPER_INJECTOR_VERSION} host payload`
  try {
    const injector = await import(pathToFileURL(location.entry).href) as HostRuntimeModule
    if (typeof injector.apply !== 'function') throw new Error('host bundle has no apply() export')

    // A real web host wins when present. The TUI fallback only retains route
    // ownership/cleanup semantics; it never listens on a network interface.
    const injectorCtx = ctx.get('webServer') === undefined ? ctx.isolate('webServer') : ctx
    if (injectorCtx.get('webServer') === undefined) {
      injectorCtx.provide('webServer', new TerminalWebServerCompat())
    }
    const profile = resolveDshProfileName() ?? 'dsh-tui'
    const home = dshHome()
    const fiber = injectorCtx.plugin(injector as unknown as {
      apply(ctx: Context, config: Record<string, unknown>): unknown
    }, {
      registryFile: join(home, 'super-injector', 'smart-registry.json'),
      profileNodeModules: join(home, 'profiles', profile, 'node_modules'),
      autoRestore: true,
      intervalMs: 1500,
      watches: [],
    })
    // Do not await here: the compatibility webServer is owned by this parent
    // fiber and becomes dependency-visible only after apply() returns.
    fiber.then(() => {
      status.phase = 'active'
      status.detail = `verified upstream v${SUPER_INJECTOR_VERSION} host tools active`
      ctx.logger.info(`dsh-tui Smart: host runtime v${SUPER_INJECTOR_VERSION} active`)
    }, (error: unknown) => {
      status.phase = 'failed'
      status.detail = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`dsh-tui Smart: host runtime activation failed: ${status.detail}`)
    })
  } catch (error) {
    status.phase = 'failed'
    status.detail = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`dsh-tui Smart: host runtime activation failed: ${status.detail}`)
  }
}

export default { name, inject, apply }

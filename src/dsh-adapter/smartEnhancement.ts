/** Compose the Smart overlay after the selected official agent preset. */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as StrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import { registerEnhancementAgent } from './enhancementInheritance.js'
import SmartHostRuntime from './smartRuntime.js'

type RouterModule = {
  readonly apply: (ctx: Context, config: {
    readonly registerTools?: boolean
    readonly resetAnchored?: boolean
  }) => unknown
}

interface SmartEnhancementOptions {
  readonly resetAnchored?: boolean
}

let routerModule: Promise<RouterModule> | undefined
const smartHosts = new WeakMap<object, Promise<void>>()

function routerEntry(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(moduleDir, '..', '..', '..', 'smart-assets', 'router-standard', 'router-bootstrap-v1.mjs'),
    join(moduleDir, '..', '..', 'smart-assets', 'router-standard', 'router-bootstrap-v1.mjs'),
  ]
  const found = candidates.find(existsSync)
  if (found === undefined) throw new Error('dsh-tui Smart router asset is missing')
  return found
}

async function loadRouter(): Promise<RouterModule> {
  routerModule ??= import(pathToFileURL(routerEntry()).href) as Promise<RouterModule>
  return await routerModule
}

function ensureSmartHost(ctx: Context): Promise<void> {
  const root = ctx.root
  const existing = smartHosts.get(root)
  if (existing !== undefined) return existing
  const started = (async () => {
    await root.plugin(SmartHostRuntime)
  })()
  smartHosts.set(root, started)
  return started
}

export async function mountSmartEnhancement(
  hostCtx: Context,
  agentCtx: Context,
  basePreset?: string,
  options: SmartEnhancementOptions = {},
): Promise<void> {
  await ensureSmartHost(hostCtx)
  // Agent-local ownership keeps Code -> Standard blank-session recomposition
  // viable; an existing Minimal/custom editor must not be registered twice.
  // The Router hides this enhancement-owned tool on non-Standard bases.
  if (basePreset === 'standard'
    && agentCtx.tools.get('str_replace_editor', agentCtx.agent as Agent) === undefined) {
    await agentCtx.plugin(StrReplaceEditor, {})
  }
  const router = await loadRouter()
  await agentCtx.plugin(router as unknown as {
    apply(ctx: Context, config: SmartEnhancementOptions): unknown
  }, options)
  registerEnhancementAgent(hostCtx, agentCtx.agent as Agent, 'smart', childCtx => {
    // agent/created is synchronous and precedes session-start/first assembly.
    // Never register tools in a child-local scope: DSH tool restrictions are
    // applied earlier in child setup and must remain the final capability cap.
    router.apply(childCtx, { registerTools: false })
  })
}

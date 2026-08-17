/** Small helpers shared by the plugin runtime verification batteries. */

import type { Context } from '@deepseek-ai/cordis'

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Build a minimal Community v0.15 manifest for an admitted test activation. */
export function testManifest(options: {
  id: string
  requires?: readonly { apiVersion: string; kind: string; optional?: boolean; fallback?: string }[]
  permissions?: readonly { name: string; scope: string; reason?: string }[]
  subscriptions?: readonly (string | { apiVersion: string; kind: string; scope?: string })[]
  commands?: readonly { id: string; title?: string; description?: string }[]
}): string {
  const commands = (options.commands ?? []).map(command => ({
    id: command.id,
    title: command.title ?? command.id,
    ...(command.description === undefined ? {} : { description: command.description }),
  }))
  return JSON.stringify({
    $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
    id: options.id,
    name: options.id,
    version: '0.1.0',
    manifestVersion: '0.15',
    facets: { host: { entry: 'dist/main.js', apiVersion: 'v1alpha1' } },
    requires: { contracts: [...(options.requires ?? [])] },
    permissions: [...(options.permissions ?? [])],
    contributes: { commands },
    subscriptions: [...(options.subscriptions ?? [])],
    license: 'MIT',
    source: { repository: 'https://example.com/test-plugin' },
  })
}

/** Mount one Cordis row and admit its Component before exposing its context. */
export async function mountAdmitted(
  root: Context,
  name: string,
  manifestSource: string,
  source = `test:${name}/dsh-plugin.json`,
  admissionOptions: { activationId?: string } = {},
): Promise<{ context: Context; fiber: { dispose(): unknown } }> {
  let context: Context | undefined
  let fiber: { dispose(): unknown } | undefined
  fiber = root.plugin({
    name,
    apply: (candidate: Context) => {
      const host = candidate.get('tuiPluginHost')
      if (host === undefined) throw new Error('tuiPluginHost is not mounted')
      host.admit(candidate, manifestSource, { source, ...admissionOptions })
      context = candidate
    },
  }) as unknown as { dispose(): unknown }
  await sleep(30)
  if (context === undefined || fiber === undefined) {
    await Promise.resolve(fiber?.dispose())
    throw new Error(`Component activation ${name} did not admit`)
  }
  return { context, fiber }
}

export const STORAGE_COORDINATE = { apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' } as const
export const COMMAND_COORDINATE = { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' } as const
export const MESSAGE_COORDINATE = { apiVersion: 'messages.dsh/v1alpha1', kind: 'MessageObserver' } as const
export const DECISION_COORDINATE = { apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' } as const

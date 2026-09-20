/**
 * Small helpers shared by the plugin runtime verification batteries.
 *
 * These are repository-internal only. The public
 * `@deepseek-harness-tui/dsh-tui/test-utils` subpath has been removed because
 * these helpers mount REAL cordis fibers and inject deterministic activation
 * IDs through the test admission token; they are not a production public API.
 * Ecosystem plugin authors should copy the approach into their own test
 * environment and run through the normal admission flow.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  apply as hostRowApply,
  getHostAdmissionForTest,
  getHostInitialKernelRefreshForTest,
  name as hostRowName,
} from '../../src/dsh-adapter/plugin-host.js'

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
  let fiber: { dispose(): unknown; await(): Promise<unknown> } | undefined
  fiber = root.plugin({
    name,
    apply: (candidate: Context) => {
      const host = candidate.get('tuiPluginHost')
      if (host === undefined) throw new Error('tuiPluginHost is not mounted')
      // Test-only admission accessor: keeps the deterministic activationId
      // injection isolated from production `getHostAdmission`.
      const admission = getHostAdmissionForTest(host)
      if (admission === undefined) throw new Error('host test admission capability is not available')
      admission.admit(candidate, manifestSource, { source, ...admissionOptions })
      context = candidate
    },
  }) as unknown as { dispose(): unknown; await(): Promise<unknown> }
  // Cordis retains an apply/admission exception on its Fiber and exposes it
  // through await(). Propagate that original error instead of timing out and
  // hiding its admission reason behind a generic readiness failure.
  try {
    await fiber.await()
  } catch (error) {
    try {
      await Promise.resolve(fiber.dispose())
    } catch {
      // Preserve the startup/admission error as the actionable failure.
    }
    throw error
  }
  if (context === undefined) {
    await Promise.resolve(fiber.dispose())
    throw new Error(`Component activation ${name} completed without an admission context`)
  }
  return { context, fiber }
}

/** Bounded ceiling for the host-owned initial kernel refresh; it only turns a
 * pathological hang into a loud, attributable error. */
const INITIAL_KERNEL_REFRESH_TIMEOUT_MS = 5_000

/** Mount the plugin-host row on a battery context and wait until new-mode
 * admission is actually possible. Admission stays fail-closed while the
 * initial kernel refresh is pending (build() then publishes an empty
 * descriptor that rejects every required protocol, issue #844), so batteries
 * must await the host-owned readiness signal instead of gambling on a fixed
 * timer. A failed or skipped refresh is still a loud error; this helper
 * never retries. */
export async function mountAdmissionHost(root: Context, label: string): Promise<void> {
  const fiber = root.plugin({ name: hostRowName, apply: hostRowApply }) as unknown as { await(): Promise<unknown> }
  await fiber.await()
  const host = root.get('tuiPluginHost')
  if (host === undefined) throw new Error(`${label}: tuiPluginHost is not mounted`)
  const readiness = getHostInitialKernelRefreshForTest(host)
  if (readiness === undefined) throw new Error(`${label}: initial kernel readiness accessor unavailable`)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      readiness.awaitResult(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `${label}: initial kernel refresh did not settle within ${INITIAL_KERNEL_REFRESH_TIMEOUT_MS}ms`,
        )), INITIAL_KERNEL_REFRESH_TIMEOUT_MS)
      }),
    ])
    if (result.status !== 'completed') {
      throw new Error(`${label}: initial kernel refresh ended ${result.status}${result.error === undefined ? '' : ` (${result.error})`}`)
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export const STORAGE_COORDINATE = { apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' } as const
export const COMMAND_COORDINATE = { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' } as const
export const MESSAGE_COORDINATE = { apiVersion: 'messages.dsh/v1alpha1', kind: 'MessageObserver' } as const
export const DECISION_COORDINATE = { apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' } as const

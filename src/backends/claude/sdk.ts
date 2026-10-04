/**
 * Loader for the optional `@anthropic-ai/claude-agent-sdk` peer.
 * The package is an optional peer dependency: a DSH-only install never has
 * it, so it is only ever reached through a dynamic `import()` whose
 * specifier is not a string literal — bundlers, `verify:package` and the bun
 * package check never try to resolve it statically, and loading dsh-tui
 * without it costs nothing until the Claude backend is selected.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk'

/** The SDK's session-store read/write API: the catalog, the
 *  resume replay, fork and conversation rewind. */
export type ClaudeSessionStoreSdk = Pick<typeof ClaudeSdk,
  | 'listSessions' | 'getSessionInfo' | 'getSessionMessages' | 'listSubagents' | 'getSubagentMessages'
  | 'renameSession' | 'deleteSession' | 'forkSession'>

/** The SDK surface this backend calls: a structural subset, so tests can
 *  hand the session a fake module without the real CLI. */
export type ClaudeSdkModule = Pick<typeof ClaudeSdk, 'query' | 'resolveSettings' | 'filterEscalatingDefaultMode'> & ClaudeSessionStoreSdk

/** Assembled at runtime on purpose (see the module comment). */
const SDK_SPECIFIER: string = ['@anthropic-ai', 'claude-agent-sdk'].join('/')

let loading: Promise<ClaudeSdkModule> | undefined

/** Import the SDK once per process; a failed import is retried next time. */
export function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  loading ??= (import(SDK_SPECIFIER) as Promise<ClaudeSdkModule>).catch((error: unknown) => {
    loading = undefined
    throw error
  })
  return loading
}

/** The installed SDK version, or undefined when it cannot be read. */
export function installedSdkVersion(): string | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve(SDK_SPECIFIER)
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8'))
    const version = typeof manifest === 'object' && manifest !== null ? (manifest as { version?: unknown }).version : undefined
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

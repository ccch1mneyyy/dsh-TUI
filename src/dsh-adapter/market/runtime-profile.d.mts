import type { BinaryLike } from 'node:crypto'

export const PACKAGE: '@deepseek-harness-tui/dsh-tui'
export const RUNTIME_BUNDLE: '@deepseek-harness-tui/dsh-tui-runtime'
export const PROFILE: 'dsh-tui'
export const RESCUE_PROFILE: 'dsh-tui-safe'
export type RuntimeProfileName = typeof PROFILE | typeof RESCUE_PROFILE

/** Raw JSON is untrusted; an explicit type argument describes the caller's own document. */
export function readJson<T = unknown>(path: string): T | undefined
export function packageDirectory(profileDir: string): string
export function ownedDirectory(profileDir: string): string
export function recipeDirectory(profileDir: string, version: string, patchSha256: string): string
export function digest(content: BinaryLike): string
export function compareVersions(left: string, right: string): number

/** Fields checked by runtimeTemplate before it returns the installed package. */
export interface RuntimePackageManifest {
  name: typeof PACKAGE
  version: string
  main: string
  dshTui: { runtimeBundle: './lib/tui-runtime' }
  [key: string]: unknown
}

export interface RuntimeBundleManifest {
  name: typeof RUNTIME_BUNDLE
  version: string
  dependencies: { [PACKAGE]: string }
  dsh: { bundle: { patch: './cordis.patch.yml' } }
  dshTui: { patchSha256: string }
  [key: string]: unknown
}

export interface RuntimeTemplate {
  manifest: RuntimePackageManifest
  bundle: RuntimeBundleManifest
  patch: Buffer
  source: string
}

interface RuntimeLocation {
  profileDir: string
  packageRoot: string
}

export interface ReadyRuntimeStatus extends RuntimeLocation {
  ready: true
  version: string
  recipe: string
}

export interface UnreadyRuntimeStatus extends RuntimeLocation {
  ready: false
  version?: string
  problem?: string
}

export type RuntimeStatus = ReadyRuntimeStatus | UnreadyRuntimeStatus

export function runtimeTemplate(packageRoot: string): RuntimeTemplate
export function runtimeStatus(profileDir: string): RuntimeStatus
export function materializeRecipe(profileDir: string, packageRoot: string): Promise<string>
export function runtimeBundleOrder(bundles: unknown): string[]

export interface LiveRuntimeProcess {
  pid: number
  token: string
  port: number
}

/** Only lease bookkeeping may retain unverified owners; updates must use the default. */
export function liveRuntimeProcesses(profileDir: string, options?: { keepUnverified?: boolean }): Promise<LiveRuntimeProcess[]>

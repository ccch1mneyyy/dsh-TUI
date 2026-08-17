/**
 * vendored 规范数据（`ecosystem-spec/`，见该目录 README）的加载与自检：
 * registry/permissions/schemas 读取、schemaHash 重算比对（verifyRegistry）、
 * contract profile 十点完备性 + 坐标/权限 parity（verifyContractProfiles）。
 * 蓝本是上游 run.js 的同名函数。
 *
 * 定位策略：从本模块（源码树 `src/plugin-spec/` 或打包树
 * `lib/types/plugin-spec/`）逐级上溯找 `ecosystem-spec/registry/
 * registry-0.15.json`；找不到返回 undefined —— 调用方按软降级处理
 * （同 contract.ts 的 drift 检查风格：数据缺失是打包事故，不是崩溃理由，
 * 但 Host Descriptor 必须因此对受影响的 contract fail closed）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContractRegistry, PermissionRegistry } from './types.js'

export interface SpecData {
  /** 数据目录（…/ecosystem-spec）。 */
  dir: string
  registry: ContractRegistry
  permissions: PermissionRegistry
  schemas: {
    plugin: Record<string, unknown>
    host: Record<string, unknown>
    message: Record<string, unknown>
    ledger: Record<string, unknown>
    claim: Record<string, unknown>
  }
}

const REGISTRY_FILE = join('registry', 'registry-0.15.json')

/** 从 `start` 逐级上溯定位 ecosystem-spec 目录；找不到返回 undefined。 */
export function locateSpecDir(start: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'ecosystem-spec', REGISTRY_FILE))) return join(dir, 'ecosystem-spec')
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function loadJson(dir: string, relative: string): unknown {
  return JSON.parse(readFileSync(join(dir, relative), 'utf8'))
}

/**
 * Load the vendored registry + permission registry + the five schemas.
 * `dir` injectable for tests; default = located from this module.
 */
export function loadSpecData(dir: string | undefined = locateSpecDir()): SpecData | undefined {
  if (dir === undefined) return undefined
  try {
    return {
      dir,
      registry: loadJson(dir, REGISTRY_FILE) as ContractRegistry,
      permissions: loadJson(dir, join('registry', 'permissions-0.1.json')) as PermissionRegistry,
      schemas: {
        plugin: loadJson(dir, join('schemas', 'dsh-plugin.schema.json')) as Record<string, unknown>,
        host: loadJson(dir, join('schemas', 'host-descriptor.schema.json')) as Record<string, unknown>,
        message: loadJson(dir, join('schemas', 'messages-observe-envelope.schema.json')) as Record<string, unknown>,
        ledger: loadJson(dir, join('schemas', 'effect-ledger-record.schema.json')) as Record<string, unknown>,
        claim: loadJson(dir, join('schemas', 'conformance-claim.schema.json')) as Record<string, unknown>,
      },
    }
  } catch {
    return undefined
  }
}

/** sha256 digest (`sha256:<hex>`) of a file inside the spec dir. */
export function digestFile(dir: string, relative: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(join(dir, relative))).digest('hex')}`
}

/**
 * C-020: every registry entry's schemaHash must equal the actual digest of
 * the vendored schema file. Returns the list of drifted entries (empty =
 * OK) — callers decide fail-closed vs warn per surface.
 */
export function verifyRegistry(data: SpecData): string[] {
  const failures: string[] = []
  for (const entry of data.registry.entries) {
    let actual: string
    try {
      actual = digestFile(data.dir, entry.schema)
    } catch {
      failures.push(`${entry.name}: schema file unreadable (${entry.schema})`)
      continue
    }
    if (actual !== entry.schemaHash) {
      failures.push(`${entry.name}: schemaHash drifted (registry ${entry.schemaHash}, actual ${actual})`)
    }
  }
  return failures
}

/**
 * C-040 + SPEC-WRITING-RULES §5: every contract profile answers the
 * ten-point capability boundary, its coordinates match its registry entry,
 * its permission set matches, and trusted-in-process v0.15 declares
 * `securityBoundary: false`. Returns violations (empty = OK).
 */
export function verifyContractProfiles(data: SpecData): string[] {
  const REQUIRED_KEYS = [
    'name', 'version', 'kind', 'coordinates', 'caller', 'permissions',
    'errors', 'concurrency', 'timeout', 'cleanup', 'privacyClass', 'securityBoundary',
  ]
  const failures: string[] = []
  for (const entry of data.registry.entries) {
    let profile: Record<string, unknown>
    try {
      profile = loadJson(data.dir, entry.schema) as Record<string, unknown>
    } catch {
      failures.push(`${entry.name}: contract profile unreadable (${entry.schema})`)
      continue
    }
    for (const key of REQUIRED_KEYS) {
      if (!(key in profile)) failures.push(`${entry.name}: contract profile missing "${key}" (SPEC-WRITING-RULES §5)`)
    }
    const coordinates = profile.coordinates as { apiVersion?: unknown; kind?: unknown } | undefined
    if (coordinates?.apiVersion !== entry.coordinates.apiVersion) {
      failures.push(`${entry.name}: profile/registry apiVersion mismatch`)
    }
    if (coordinates?.kind !== entry.coordinates.kind) {
      failures.push(`${entry.name}: profile/registry kind mismatch`)
    }
    const profilePermissions = [...((profile.permissions as string[] | undefined) ?? [])].sort()
    const entryPermissions = [...entry.permissions].sort()
    if (JSON.stringify(profilePermissions) !== JSON.stringify(entryPermissions)) {
      failures.push(`${entry.name}: profile/registry permissions mismatch`)
    }
    if (entry.kind === 'capability' && !('operations' in profile || ('input' in profile && 'output' in profile))) {
      failures.push(`${entry.name}: capability profile missing an input/output surface`)
    }
    if (entry.kind === 'event' && !('envelope' in profile)) {
      failures.push(`${entry.name}: event profile missing envelope`)
    }
    if (profile.securityBoundary !== false) {
      failures.push(`${entry.name}: trusted-in-process v0.15 must declare securityBoundary:false`)
    }
  }
  return failures
}

/**
 * storage.local contract surface (C-040, `storage.dsh/v1alpha1#LocalStorage`):
 * per-plugin private persistence, mounted by the dsh-tui-plugin-host row as
 * `ctx.tuiPluginStorage`.
 *
 * The plugin-facing API is `open(ctx)` → `{ get, set, delete }`:
 *
 * - HONEST IDENTITY: the namespace is derived from the PASSED context's
 *   `ctx.fiber.name` (the row's `name` export, nearest named ancestor, else
 *   'root') — there is no parameter to name another plugin, so cross-plugin
 *   access is rejected by construction (contract scope rule).
 * - GRANTS AT CALL TIME: `get` requires `storage.local.read`, `set`/`delete`
 *   require `storage.local.write` — checked per call against the grant store
 *   (a revoked grant = edit + restart = every later call fails with
 *   PERMISSION_NOT_GRANTED).
 * - Backend: `~/.dsh-tui/plugin-storage/<namespace>.json`, one flat JSON
 *   object per namespace. Writes go through dsh-atomic-write (`withFileLock`
 *   for the read-modify-write cycle + `writeFileAtomic` for the commit), and
 *   an in-process per-namespace promise chain serializes operations in
 *   invocation order (contract concurrency rule — the lock alone does not
 *   order contenders).
 * - QUOTA (host-defined): 256 keys AND 256 KiB of serialized content per
 *   namespace; a `set` that would cross either fails with QUOTA_EXCEEDED and
 *   changes nothing.
 * - Keys stay ordinary data even when they collide with Object.prototype
 *   names ("__proto__", "toString", "constructor"): namespace tables are
 *   null-prototype and membership is decided with Object.hasOwn. Values
 *   must be EXACT JSON values — inputs JSON.stringify would silently
 *   mutate (undefined, NaN/±Infinity, functions, class instances, sparse
 *   arrays, cycles) are rejected instead of round-tripping a lie.
 * - A corrupt namespace file is NEVER overwritten silently: every operation
 *   fails with STORAGE_UNAVAILABLE and the bytes stay on disk for manual
 *   recovery. Closing a handle (plugin unload) retains data (contract
 *   cleanup rule); later calls on a closed handle fail STORAGE_UNAVAILABLE.
 * - privacyClass: sensitive — keys AND values are never logged.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { Context, Service } from '@deepseek-ai/cordis'
import { DATA_DIR } from '../utils/paths.js'
import { readGrantStore, type GrantStore } from './grants.js'
import type { TuiEffectLedgerRuntime } from './effect-ledger.js'

/** Quota: max distinct keys per namespace. */
export const STORAGE_MAX_KEYS = 256
/** Quota: max serialized file size per namespace (bytes). */
export const STORAGE_MAX_BYTES = 256 * 1024
/** Max key length (characters). */
export const STORAGE_KEY_MAX_LENGTH = 128

export type PluginStorageErrorCode =
  | 'PERMISSION_NOT_GRANTED'
  | 'INVALID_KEY'
  | 'QUOTA_EXCEEDED'
  | 'STORAGE_UNAVAILABLE'

/** Storage failure with the contract's error code on `.code`. */
export class PluginStorageError extends Error {
  readonly code: PluginStorageErrorCode
  constructor(code: PluginStorageErrorCode, message: string) {
    super(message)
    this.name = 'PluginStorageError'
    this.code = code
  }
}

/** The per-namespace handle returned by {@link TuiPluginStorageRuntime.open}. */
export interface TuiPluginStorage {
  /** The stored JSON value, or null when the key is absent. */
  get(key: string): Promise<unknown>
  /** Store a JSON-serializable value; resolves true when written. */
  set(key: string, value: unknown): Promise<boolean>
  /** Delete a key; resolves true when the key existed. */
  delete(key: string): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiPluginStorage: TuiPluginStorageRuntime
  }
}

/** Namespace directory under the data dir. */
export const PLUGIN_STORAGE_DIR = 'plugin-storage'

/**
 * Plugin name → safe, collision-free file name. encodeURIComponent keeps
 * alphanumerics and `- _ . ! ~ * ' ( )`, so scoped names like `@foo/bar`
 * encode reversibly; pathological results ('', '.', '..') map to '_'.
 */
export function storageFileName(plugin: string): string {
  const encoded = encodeURIComponent(plugin)
  return encoded === '' || encoded === '.' || encoded === '..' ? '_' : encoded
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key === '' || key.length > STORAGE_KEY_MAX_LENGTH || /[\x00-\x1f\x7f-\x9f]/.test(key)) {
    throw new PluginStorageError('INVALID_KEY', 'storage keys are non-empty control-free strings of at most 128 characters')
  }
}

/**
 * Exact JSON values only. JSON.stringify silently MUTATES edge inputs
 * (NaN/±Infinity → null, undefined array items → null, undefined object
 * properties dropped, class instances reduced to own fields) — a storage
 * contract must not round-trip a value the caller never stored, so those
 * inputs are rejected instead. Accepts: null, boolean, string, finite
 * number, arrays (dense), and plain objects (Object.prototype or null
 * prototype only — a function-valued property such as toJSON fails too);
 * rejects cycles and anything whose inspection throws (hostile getters).
 */
function assertJsonValue(value: unknown): void {
  let ok = false
  try {
    ok = isJsonValue(value, new Set())
  } catch {
    ok = false
  }
  if (!ok) {
    // The contract offers no INVALID_VALUE code; argument validation
    // failures report under INVALID_KEY.
    throw new PluginStorageError(
      'INVALID_KEY',
      'storage values must be exact JSON values (no undefined, functions, symbols, BigInt, NaN/Infinity, class instances, sparse arrays, or cycles)',
    )
  }
}

function isJsonValue(value: unknown, seen: Set<object>): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object': {
      const object = value as object
      if (seen.has(object)) return false
      seen.add(object)
      try {
        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index++) {
            // A sparse hole would serialize as null — a value never stored.
            if (!(index in value)) return false
            if (!isJsonValue(value[index], seen)) return false
          }
          return true
        }
        const proto: unknown = Object.getPrototypeOf(value)
        if (proto !== Object.prototype && proto !== null) return false
        return Object.values(value as Record<string, unknown>).every(item => isJsonValue(item, seen))
      } finally {
        // DAGs (shared references without cycles) serialize fine — only
        // reject a value reachable from ITSELF.
        seen.delete(object)
      }
    }
    default:
      // undefined / function / symbol / bigint
      return false
  }
}

interface NamespaceState {
  /** In-process invocation-order chain (contract concurrency rule). Shared
   *  by every handle opened on the namespace. */
  chain: Promise<unknown>
}

/**
 * `ctx.tuiPluginStorage` — storage.local contract surface. Mounted by the
 * dsh-tui-plugin-host row; grants come from that row's store when present
 * (normal path) or a private read otherwise (bare mounts in tests).
 */
export class TuiPluginStorageRuntime extends Service {
  private readonly grantsOption: GrantStore | undefined
  private readonly fallbackGrants: GrantStore
  private readonly ledgerOption: TuiEffectLedgerRuntime | undefined
  private readonly namespaces = new Map<string, NamespaceState>()
  private readonly dir: string

  constructor(ctx: Context, options: { dir?: string; grants?: GrantStore; ledger?: TuiEffectLedgerRuntime } = {}) {
    super(ctx, 'tuiPluginStorage')
    this.grantsOption = options.grants
    this.fallbackGrants = readGrantStore()
    this.ledgerOption = options.ledger
    this.dir = options.dir ?? join(DATA_DIR, PLUGIN_STORAGE_DIR)
  }

  /** Grants: the plugin-host row's store when mounted, else a private read.
   *  Resolved PER CALL — sibling services mounted later by the same apply()
   *  are not visible to constructors (cordis), so a constructor-time probe
   *  would silently stick to the fallback. */
  private grants(): GrantStore {
    return this.grantsOption ?? this.ctx.get('tuiPluginHost')?.grants ?? this.fallbackGrants
  }

  /** Optional observability; a bare mount (tests) simply records nothing. */
  private ledger(): TuiEffectLedgerRuntime | undefined {
    return this.ledgerOption ?? this.ctx.get('tuiEffectLedger')
  }

  /**
   * Open the caller's private namespace. Identity = the PASSED context's
   * fiber name (honest API — no way to name another plugin). The handle
   * closes automatically when the caller's context unloads (idempotent
   * disposer); data is retained (contract cleanup rule).
   */
  open(pluginCtx: Context): TuiPluginStorage {
    let plugin = 'root'
    try {
      const resolved: unknown = pluginCtx.fiber?.name
      if (typeof resolved === 'string' && resolved !== '') plugin = resolved
    } catch {
      // Degraded context without fiber access: 'root' namespace.
    }
    let state = this.namespaces.get(plugin)
    if (state === undefined) {
      state = { chain: Promise.resolve() }
      this.namespaces.set(plugin, state)
    }
    this.ledger()?.record(
      { operation: 'create', resource: { kind: 'storage-namespace', id: plugin }, result: 'applied' },
      pluginCtx,
    )
    // `closed` is PER HANDLE, not per namespace: unloading one fiber must not
    // kill another handle opened on the same namespace. Close on unload;
    // idempotent (a double-close stays harmless by design); degraded contexts
    // without `effect` simply never auto-close.
    let closed = false
    try {
      pluginCtx.effect(() => () => {
        if (closed) return
        closed = true
        this.ledger()?.record(
          { operation: 'release', resource: { kind: 'storage-namespace', id: plugin }, result: 'applied' },
          pluginCtx,
        )
      })
    } catch {
      // Degraded context: the handle lives until process end.
    }
    const file = join(this.dir, `${storageFileName(plugin)}.json`)
    const grants = (): GrantStore => this.grants()
    const ledger = (): TuiEffectLedgerRuntime | undefined => this.ledger()

    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
      if (closed) {
        return Promise.reject(new PluginStorageError('STORAGE_UNAVAILABLE', `storage namespace "${plugin}" handle is closed`))
      }
      const run = state.chain.then(operation)
      // Keep the chain alive after a failure without unhandled rejections.
      state.chain = run.catch(() => {})
      return run
    }

    const readTable = (): Record<string, unknown> => {
      let raw: string
      try {
        raw = readFileSync(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw new PluginStorageError(
          'STORAGE_UNAVAILABLE',
          `storage namespace "${plugin}" is unreadable; the file was left untouched for manual recovery`,
        )
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new PluginStorageError(
          'STORAGE_UNAVAILABLE',
          `storage namespace "${plugin}" is corrupt on disk; the file was left untouched for manual recovery`,
        )
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PluginStorageError(
          'STORAGE_UNAVAILABLE',
          `storage namespace "${plugin}" holds a non-object document; the file was left untouched for manual recovery`,
        )
      }
      // Rebuild on a NULL-PROTOTYPE table: key membership is decided with
      // Object.hasOwn, and keys like "__proto__" / "toString" must behave
      // as ordinary data (a prototype-chain read would leak host objects
      // into plugin results and fake membership for never-stored keys).
      const table: Record<string, unknown> = Object.create(null)
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) table[key] = value
      return table
    }

    const requireGrant = (permission: 'storage.local.read' | 'storage.local.write') => {
      if (!grants().allows(plugin, permission)) {
        ledger()?.record(
          {
            operation: 'bind',
            resource: { kind: 'permission', id: permission },
            result: 'failed',
            errorCode: 'PERMISSION_NOT_GRANTED',
          },
          pluginCtx,
        )
        throw new PluginStorageError(
          'PERMISSION_NOT_GRANTED',
          `storage.${permission.endsWith('.read') ? 'get' : 'set/delete'} from plugin "${plugin}" denied — grant "${permission}" ` +
          `for "${plugin}" in ~/.dsh-tui/extension-grants.json first`,
        )
      }
    }

    // withFileLock creates its lock as a SIBLING of the file and does not
    // create parent directories — ensure the tree exists before any write
    // path (read paths tolerate ENOENT as an empty namespace and never
    // materialize the tree).
    const ensureDir = (): void => {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    }

    return {
      get: (key: unknown) => enqueue(async () => {
        assertKey(key)
        requireGrant('storage.local.read')
        const table = readTable()
        return Object.hasOwn(table, key) ? table[key] : null
      }),
      set: (key: unknown, value: unknown) => enqueue(async () => {
        assertKey(key)
        assertJsonValue(value)
        requireGrant('storage.local.write')
        ensureDir()
        return withFileLock(file, async () => {
          const table = readTable()
          const isNewKey = !Object.hasOwn(table, key)
          if (isNewKey && Object.keys(table).length >= STORAGE_MAX_KEYS) {
            throw new PluginStorageError('QUOTA_EXCEEDED', `storage namespace "${plugin}" holds ${STORAGE_MAX_KEYS} keys already`)
          }
          table[key] = value
          const content = JSON.stringify(table)
          if (Buffer.byteLength(content, 'utf8') > STORAGE_MAX_BYTES) {
            throw new PluginStorageError('QUOTA_EXCEEDED', `storage namespace "${plugin}" would exceed ${STORAGE_MAX_BYTES} bytes`)
          }
          // 0o600/0o700: the namespace is privacyClass sensitive.
          await writeFileAtomic(file, content, { mode: 0o600, dirMode: 0o700 })
          return true
        })
      }),
      delete: (key: unknown) => enqueue(async () => {
        assertKey(key)
        requireGrant('storage.local.write')
        ensureDir()
        return withFileLock(file, async () => {
          const table = readTable()
          if (!Object.hasOwn(table, key)) return false
          delete table[key]
          await writeFileAtomic(file, JSON.stringify(table), { mode: 0o600, dirMode: 0o700 })
          return true
        })
      }),
    }
  }
}

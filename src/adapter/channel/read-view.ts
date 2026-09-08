/** Detached in-process read projections. Executable leaves are guarded, not serialized. */

/**
 * Rows are mutable while the channel reduces live events, but renderer-facing
 * snapshots are not. The reducer marks a row when it changes so a later read
 * can retain every untouched immutable row from the preceding revision.
 */
const dirtyRevisions = new WeakMap<object, number>()
/**
 * Projection brands distinguish inert immutable data from a graph containing
 * an executable leaf. An outer capability may reuse the former, but MUST walk
 * the latter so its own lifetime fence wraps every retained callback.
 */
const projectedValues = new WeakMap<object, boolean>()
let nextDirtyRevision = 1

export function markChannelReadDirty(value: object): void {
  dirtyRevisions.set(value, nextDirtyRevision++)
}

function isTranscriptRow(value: object): boolean {
  return 'id' in value && 'kind' in value && 'text' in value
}

type CopyEntry = { readonly value: object; readonly version: number; readonly dirtyRevision: number }

export function createChannelReadView(check: (mutation: boolean) => void) {
  let version = -1
  let copies = new WeakMap<object, CopyEntry>()
  function copy<T>(value: T, key = '', receiver?: object): T {
    if (typeof value === 'function') {
      const prior = copies.get(value)
      if (prior?.version === version) return prior.value as T
      // Settings conversions are local presentation callbacks. Every other
      // executable leaf (workspace continuations/run, etc.) is a mutation.
      const result = ((...args: unknown[]) => {
        check(key !== 'format' && key !== 'parse')
        const output = Reflect.apply(value, receiver, args)
        if (output instanceof Promise) return output.then(v => { check(false); return copy(v) })
        return copy(output)
      }) as T
      projectedValues.set(result as object, true)
      copies.set(value, { value: result as object, version, dirtyRevision: 0 })
      return result
    }
    if (value === null || typeof value !== 'object') return value
    // Structural containers are detached below. Every other object is a leaf
    // with its own identity and semantics — binary buffers, Date, Error, class
    // instances, promises — and copying one key by key silently hollows it
    // out: a projected transcript image reached sharp as a plain object and
    // decoded as "Input file is missing" (rendered 无法预览). Date and RegExp
    // get a faithful detached copy; everything else is shared as-is, because
    // no copy preserves an opaque value and a hollow one is strictly worse.
    if (!Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set)) {
      if (value instanceof Date) return new Date(value.getTime()) as T
      if (value instanceof RegExp) return new RegExp(value.source, value.flags) as T
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return value
    }
    // An inner ChannelUi projection is safe immutable data, but an outer
    // production mount must still capture its own lifetime around nested
    // callbacks. Reuse purely structural data; walk callable graphs again.
    if (projectedValues.get(value) === false) return value
    const prior = copies.get(value)
    const dirtyRevision = dirtyRevisions.get(value) ?? 0
    // Transcript row identity is deliberately stable across unrelated channel
    // revisions. A dirty row gets a new detached copy; old snapshots remain
    // frozen and therefore cannot observe the backend mutation.
    if (prior !== undefined && isTranscriptRow(value) && prior.dirtyRevision === dirtyRevision) return prior.value as T
    // The transcript container is marked on membership or row changes. When
    // no such mark occurred, activity/status versions retain the exact frozen
    // array rather than visiting historical rows again.
    if (
      prior !== undefined &&
      Array.isArray(value) &&
      (value.length === 0 || (value[0] !== null && typeof value[0] === 'object' && isTranscriptRow(value[0]))) &&
      (prior.value as unknown[]).length === value.length &&
      prior.dirtyRevision === dirtyRevision
    ) return prior.value as T
    if (prior !== undefined && !isTranscriptRow(value) && prior.version === version) return prior.value as T
    if (value instanceof Map) {
      const entries = new Map([...value].map(([k, v]) => [copy(k), copy(v)]))
      const view: ReadonlyMap<unknown, unknown> = Object.freeze({
        get size() { return entries.size }, has: entries.has.bind(entries), get: entries.get.bind(entries),
        entries: entries.entries.bind(entries), keys: entries.keys.bind(entries), values: entries.values.bind(entries),
        [Symbol.iterator]: entries[Symbol.iterator].bind(entries),
        forEach(callback, thisArg) { entries.forEach((v, k) => callback.call(thisArg, v, k, view)) },
      })
      const executable = [...entries].some(([key, entry]) => projectedValues.get(key) === true || projectedValues.get(entry) === true)
      projectedValues.set(view, executable)
      copies.set(value, { value: view, version, dirtyRevision })
      return view as T
    }
    if (value instanceof Set) {
      const entries = new Set([...value].map(v => copy(v)))
      const view: ReadonlySet<unknown> = Object.freeze({
        get size() { return entries.size }, has: entries.has.bind(entries),
        entries: entries.entries.bind(entries), keys: entries.keys.bind(entries), values: entries.values.bind(entries),
        [Symbol.iterator]: entries[Symbol.iterator].bind(entries),
        forEach(callback, thisArg) { entries.forEach(v => callback.call(thisArg, v, v, view)) },
      })
      const executable = [...entries].some(entry => projectedValues.get(entry) === true)
      projectedValues.set(view, executable)
      copies.set(value, { value: view, version, dirtyRevision })
      return view as T
    }
    const result = Array.isArray(value) ? [] : Object.create(null)
    copies.set(value, { value: result, version, dirtyRevision })
    if (Array.isArray(value)) {
      // Avoid Object.entries' whole-history tuple allocation. The new frozen
      // container is required to preserve old array snapshots, while each
      // unchanged row itself is structurally shared above.
      for (let index = 0; index < value.length; index++) result.push(copy(value[index], String(index), value))
    } else {
      for (const [name, child] of Object.entries(value)) result[name] = copy(child, name, value)
    }
    const frozen = Object.freeze(result)
    const executable = Object.values(result).some(child => child !== null && (typeof child === 'object' || typeof child === 'function') && projectedValues.get(child as object) === true)
    projectedValues.set(frozen, executable)
    copies.set(value, { value: frozen, version, dirtyRevision })
    return frozen as T
  }
  return <T>(value: T, nextVersion: number): T => {
    version = nextVersion
    return copy(value)
  }
}

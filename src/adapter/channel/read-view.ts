/** Detached in-process read projections. Executable leaves are guarded, not serialized. */
export function createChannelReadView(check: (mutation: boolean) => void) {
  let version = -1
  let copies = new WeakMap<object, object>()
  function copy<T>(value: T, key = '', receiver?: object): T {
    if (typeof value === 'function') {
      // Settings conversions are local presentation callbacks. Every other
      // executable leaf (workspace continuations/run, etc.) is a mutation.
      return ((...args: unknown[]) => {
        check(key !== 'format' && key !== 'parse')
        const result = Reflect.apply(value, receiver, args)
        if (result instanceof Promise) return result.then(v => { check(false); return copy(v) })
        return copy(result)
      }) as T
    }
    if (value === null || typeof value !== 'object') return value
    const prior = copies.get(value)
    if (prior) return prior as T
    if (value instanceof Map) {
      const entries = new Map([...value].map(([k, v]) => [copy(k), copy(v)]))
      const view: ReadonlyMap<unknown, unknown> = Object.freeze({
        get size() { return entries.size }, has: entries.has.bind(entries), get: entries.get.bind(entries),
        entries: entries.entries.bind(entries), keys: entries.keys.bind(entries), values: entries.values.bind(entries),
        [Symbol.iterator]: entries[Symbol.iterator].bind(entries),
        forEach(callback, thisArg) { entries.forEach((v, k) => callback.call(thisArg, v, k, view)) },
      })
      copies.set(value, view)
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
      copies.set(value, view)
      return view as T
    }
    const result = Array.isArray(value) ? [] : Object.create(null)
    copies.set(value, result)
    for (const [name, child] of Object.entries(value)) result[name] = copy(child, name, value)
    return Object.freeze(result) as T
  }
  return <T>(value: T, nextVersion: number): T => {
    if (nextVersion !== version) { version = nextVersion; copies = new WeakMap() }
    return copy(value)
  }
}

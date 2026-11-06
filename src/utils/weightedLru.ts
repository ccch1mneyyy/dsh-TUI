/**
 * Bounded LRU shared by the image backends.
 *
 * A cache entry is bounded twice: by entry count (cheap to scan) and by the
 * summed weight of its values (a handful of large rasters must not pin an
 * unbounded amount of memory). `weigh` is called on insert and eviction only,
 * so it may be O(size) but not O(deep structure).
 */
export class WeightedLru<V> {
  private readonly map = new Map<string, V>()
  private weight = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
    private readonly weigh: (value: V) => number,
  ) {}

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    // Refresh recency: Map preserves insertion order.
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: string, value: V): void {
    const previous = this.map.get(key)
    if (previous !== undefined) {
      this.weight -= this.weigh(previous)
      this.map.delete(key)
    }
    this.map.set(key, value)
    this.weight += this.weigh(value)
    while (this.map.size > this.maxEntries || this.weight > this.maxWeight) {
      const oldest = this.map.keys().next()
      if (oldest.done === true) break
      this.weight -= this.weigh(this.map.get(oldest.value)!)
      this.map.delete(oldest.value)
    }
  }

  clear(): void {
    this.map.clear()
    this.weight = 0
  }

  get size(): number {
    return this.map.size
  }
}

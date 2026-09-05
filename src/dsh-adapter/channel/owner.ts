/** Channel lifetime plus binding fences for work that crosses an await. */
export function createChannelOwner() {
  let active = true
  let externalCheck = () => true
  const cleanups = new Set<() => void>()
  const controller = new AbortController()
  const current = () => {
    if (!active) return false
    try { return externalCheck() } catch { return false }
  }
  const assertActive = () => {
    if (!current()) throw new Error('dsh-tui: Channel lifetime has ended')
  }
  return {
    current, assertActive,
    get cleanupCount() { return cleanups.size },
    signal: controller.signal,
    bind(check: () => boolean) { externalCheck = check },
    own(cleanup: () => void) {
      let released = false
      const release = () => {
        if (released) return
        released = true
        cleanups.delete(release)
        cleanup()
      }
      if (active) cleanups.add(release)
      else release()
      return release
    },
    dispose() {
      if (!active) return
      active = false
      controller.abort()
      for (const cleanup of [...cleanups]) cleanup()
    },
  }
}
export type ChannelOwner = ReturnType<typeof createChannelOwner>
const owners = new WeakMap<object, ChannelOwner>()
export function registerChannelOwner(channel: object, owner: ChannelOwner): void { owners.set(channel, owner) }
export function bindChannelOwner(channel: object, check: () => boolean): void { owners.get(channel)?.bind(check) }
export function disposeChannelOwner(channel: object): void { owners.get(channel)?.dispose() }

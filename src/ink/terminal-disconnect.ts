/** Device loss is expected when a PTY master or a pipe reader disappears. */
export function isTerminalDisconnect(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === 'EIO' || error.code === 'EPIPE'
}

// A stream can report a queued write error after its renderer has detached.
// Keep one backstop per stream, without retaining detached React trees.
const outputs = new WeakMap<NodeJS.WriteStream, Set<() => void>>()

export function observeTerminalOutput(stdout: NodeJS.WriteStream, onDisconnect: () => void): () => void {
  let observers = outputs.get(stdout)
  if (observers === undefined) {
    observers = new Set()
    outputs.set(stdout, observers)
    const listeners = observers
    stdout.on('close', () => { for (const notify of [...listeners]) notify() })
    stdout.on('error', (error: unknown) => {
      if (!isTerminalDisconnect(error)) throw error
      for (const notify of [...listeners]) notify()
    })
  }
  observers.add(onDisconnect)
  return () => { observers.delete(onDisconnect) }
}

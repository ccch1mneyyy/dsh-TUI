/**
 * Permanently release input to a replacement process without closing the TTY.
 * Closing it would restore this process's saved termios over the child's raw
 * mode. pause()/unref() alone leave readable-mode prefetch able to steal the
 * child's terminal replies, so cancel the native read and prevent refills.
 * Temporary editor handoffs must keep using suspendStdin()/resumeStdin().
 */
export function detachHandoffStdin(
  stdin: Pick<NodeJS.ReadStream, 'removeAllListeners' | 'pause'> & { unref?: () => unknown } = process.stdin,
): void {
  stdin.removeAllListeners('readable')
  stdin.removeAllListeners('data')
  // Node exposes no public way to stop a native TTY read without destroying
  // the handle. _read also needs blocking: an already queued refill can run
  // after readStop(). Other runtimes/embedded streams may lack the handle.
  const input = stdin as typeof stdin & {
    _read?: (size: number) => void
    _handle?: { readStop?: () => number }
  }
  if (typeof input._read === 'function') input._read = () => {}
  stdin.pause()
  input._handle?.readStop?.()
  stdin.unref?.()
}

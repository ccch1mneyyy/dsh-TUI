/** A renderer-owned input lease retained until terminal cleanup has settled. */
export type ShutdownInput = {
  readonly stdout: NodeJS.WriteStream
  ownsInput: () => boolean
  drain: () => void
  release: () => void
}

const owners = new WeakMap<NodeJS.ReadStream | NodeJS.WriteStream, { revoke?: () => void }>()
const handles = new WeakMap<() => void, ShutdownInput>()

/** Share TTY input exclusively; input-free roots are independent per output. */
export function claimShutdownInput(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  drain: () => void,
  revoke?: () => void,
): ShutdownInput {
  // Non-TTY stdin has no raw-mode/readable owner; render() roots use stdout identity.
  const key = stdin.isTTY ? stdin : stdout
  const previous = owners.get(key)
  const token = { revoke }
  owners.set(key, token)
  // Revoke before latching the old renderer so its cleanup cannot touch ours.
  previous?.revoke?.()
  const ownsInput = () => owners.get(key) === token
  return {
    stdout,
    ownsInput,
    drain: () => { if (ownsInput() && stdin.isTTY && !stdin.destroyed) drain() },
    release: () => { if (owners.get(key) === token) owners.delete(key) },
  }
}

/** Preserve the lease even when a legacy wrapper retains only unmount(). */
export function registerShutdownInput(unmount: () => void, input: ShutdownInput): void {
  handles.set(unmount, input)
}

export function getShutdownInput(handle: { unmount: () => void } | undefined): ShutdownInput | undefined {
  return handle === undefined ? undefined : handles.get(handle.unmount)
}

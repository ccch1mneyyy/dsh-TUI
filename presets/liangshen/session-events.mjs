/** Presets are copied outside the package, so this reader stays self-contained. */
export function snapshotSessionEvents(session) {
  const events = typeof session.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : session.events
  if (!Array.isArray(events)) throw new TypeError('liangshen: session history must be an array')
  return events
}

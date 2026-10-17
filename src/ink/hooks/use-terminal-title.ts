import { createRequire } from 'node:module'
import { useContext, useEffect, useSyncExternalStore } from 'react'
import stripAnsi from 'strip-ansi'
import { OSC, osc } from '../termio/osc.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'
import { subscribeWindowsToastWiring, windowsToastProfileDocument, windowsToastWired } from '../notification-wiring-state.js'
import { logForDebugging } from '../../utils/debug.js'

/**
 * Declaratively set the terminal tab/window title.
 *
 * Pass a string to set the title. ANSI escape sequences are stripped
 * automatically so callers don't need to know about terminal encoding.
 * Pass `null` to opt out — the hook becomes a no-op and leaves the
 * terminal title untouched.
 *
 * On Windows, uses `process.title` (classic conhost doesn't support OSC).
 * Elsewhere, writes OSC 0 (set title+icon) via Ink's stdout.
 *
 * The Windows title also carries the `[dsh-tui:<pid>]` session marker, which is
 * how a click on a task-completion toast finds this session's tab again (D7).
 * @param title - the title to set, or null to opt out.
 */
export function useTerminalTitle(title: string | null): void {
  const writeRaw = useContext(TerminalWriteContext)
  // Subscribed, not read once: the host publishes its answer wherever it
  // configures the settings, which can be after the only title this session will
  // ever write - a resumed session keeps the one it started with. Without the
  // wakeup the marker would never be added, and a click on the toast would find
  // no tab (T-FIX-04).
  const wired = useSyncExternalStore(subscribeWindowsToastWiring, windowsToastWired)

  useEffect(() => {
    if (title === null || !writeRaw) return

    const clean = stripAnsi(title)

    if (process.platform === 'win32') {
      const marker = jumpBackMarker(wired)
      process.title = marker === undefined ? clean : `${clean} ${marker}`
    } else {
      writeRaw(osc(OSC.SET_TITLE_AND_ICON, clean))
    }
  }, [title, writeRaw, wired])
}

/**
 * The marker to append to the Windows title, or undefined to leave the title
 * exactly as it is.
 *
 * The marker is the toast's promise that a click comes back to this tab, so it
 * is written only while both halves of that promise hold: this launch routes task
 * completions to the toast at all - the settings the renderer cannot see, which
 * the host publishes (`notification-wiring-state.ts`) and the caller passes in, so
 * that a publish arriving after the first title re-decides it - and the Windows
 * transport can still keep it: a profile that runs an external notifier stands the
 * transport down (D8), as does a registration Windows refused, or a system root
 * that leaves no host to render a toast. R5 keeps the title's extra segment off
 * wherever it buys nothing. Both answers are synchronous, so the title and the
 * toast are decided in the same breath.
 * @param wired - Whether this launch routes task completions to the toast, as the
 *   render that scheduled this effect saw it.
 * @returns `[dsh-tui:<pid>]` while a toast can be clicked back here.
 */
function jumpBackMarker(wired: boolean): string | undefined {
  if (!wired) return noMarker('wiring-unpublished')
  // A profile this process cannot name (see windowsToastProfileDocument) leaves
  // the dedup question unasked, which the transport answers as "not yielded" - the
  // same answer a profile without the notifier gets, and the one that keeps a
  // jump-back the user would otherwise lose to a document nobody could read.
  const transport = windowsTransport()
  const profileDocument = windowsToastProfileDocument()
  const availability = transport.windowsToastAvailability({ profilePackageJsonPath: profileDocument })
  if (!availability.available) {
    return noMarker(availability.reason, {
      profile: profileDocument,
      ...(availability.detail === undefined ? {} : { detail: availability.detail }),
    })
  }
  return transport.markerFor(process.pid)
}

/**
 * Leave the title unmarked, and say why on the debug channel.
 *
 * Every way the marker is withheld ends here, because an unmarked title looks
 * exactly like a working one until the user clicks the toast and nothing comes
 * back: which half of the promise was missing is only answerable afterwards if
 * the reason was written when the title was (UAT-M3).
 * @param reason - The condition that withheld the marker.
 * @param fields - The inputs that decided it.
 * @returns undefined, so a caller can `return` it directly.
 */
function noMarker(reason: string, fields: Record<string, unknown> = {}): undefined {
  logForDebugging('terminal title: no jump-back marker', { reason, ...fields })
  return undefined
}

/** The Windows transport, or undefined until the first title that needs it. */
let transportModule: typeof import('../terminal-notification-windows.js') | undefined

/**
 * The Windows transport, loaded on the first Windows title.
 *
 * Importing it at load time would put the module - and the helper compiler behind
 * it - into every process that renders this hook, POSIX ones included (D12/AC-7);
 * not importing it is what keeps it out, not the platform guards inside. The load
 * stays synchronous, because the title is written from an effect and the marker
 * question has to be answered in the same breath. Node answers `require` of this
 * package's own ES module with the instance the host's `import()` gets, so the
 * transport's per-process registration state is one state.
 * @returns The transport module.
 */
function windowsTransport(): typeof import('../terminal-notification-windows.js') {
  return transportModule ??= createRequire(import.meta.url)('../terminal-notification-windows.js') as typeof import('../terminal-notification-windows.js')
}

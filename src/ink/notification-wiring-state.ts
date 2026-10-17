/**
 * Whether this launch delivers task completions through the native Windows
 * toast - the process-level fact the terminal title and the toast branch have
 * to agree on (R5) - and the profile document that question is read against.
 *
 * The host resolves the notification settings once, where it configures them,
 * and publishes the answer here, because the renderer that writes the title
 * cannot see them. Module-level state, like `terminal-focus-state.ts` beside it:
 * one process, one answer, and a live `/settings` edit moves both sides at once.
 *
 * Subscribable for the same reason: the host publishes wherever it configures
 * the settings, which can be after the title was first written - and a title that
 * never changes again would never be rewritten (T-FIX-04).
 */
import { join } from 'node:path'
import { resolveDshProfileName } from '../update.js'
import { dshHomeDir } from '../utils/credentials.js'

let wired = false
const subscribers: Set<() => void> = new Set()

/**
 * Publish whether this launch routes task completions to the native toast.
 * Watchers are notified only when the answer moves: each notification rewrites
 * the terminal title, so re-publishing the answer a live `/settings` edit did not
 * change would be work with nothing behind it.
 * @param value - true while the toast branch is the one that will deliver.
 */
export function setWindowsToastWiring(value: boolean): void {
  if (wired === value) return
  wired = value
  for (const cb of subscribers) {
    cb()
  }
}

/**
 * Whether a task completion from this process can be delivered as a native
 * toast - the condition under which the title's marker promises a click that
 * comes back. A process that never published an answer has no toast to promise,
 * so this reads false until the host says otherwise.
 * @returns true while this launch routes task completions to the toast.
 */
export function windowsToastWired(): boolean {
  return wired
}

/**
 * Subscribe to wiring changes, for useSyncExternalStore. The title hook needs
 * them: it writes the marker from the renderer, and the host's answer may only
 * arrive after the title that carries it was already written.
 * @param cb - callback invoked synchronously when the answer moves.
 * @returns a function that unsubscribes the callback.
 */
export function subscribeWindowsToastWiring(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * `<dshHome>/profiles/<profile>/package.json` - the document that says whether an
 * external notifier already owns task completions, which is what stands both the
 * toast and the title's marker down (D8).
 *
 * Resolved here, beside the wiring, because the two halves of the promise have to
 * read the same document: this module is the one place both of them ask
 * (`deliverTaskCompletionOnWindows` in `src/dsh-adapter/plugin.ts`, and the title
 * hook's `jumpBackMarker`), so the pair cannot drift into a toast whose click lands
 * on an unmarked title.
 *
 * Both launch routes have to be read: `dsh --profile <name>` keeps the name in
 * argv, while the launcher's entry route consumes the flag and hands it down as
 * `DSH_TUI_PROFILE` - the variable the entry itself reads. A launch that names no
 * profile leaves the question unasked, which the transport answers "not yielded":
 * guessing there would drop a notification.
 * @returns The path, or undefined when this launch names no profile.
 */
export function windowsToastProfileDocument(): string | undefined {
  const profile = resolveDshProfileName() ?? process.env.DSH_TUI_PROFILE?.trim()
  return profile === undefined || profile === '' ? undefined : join(dshHomeDir(), 'profiles', profile, 'package.json')
}

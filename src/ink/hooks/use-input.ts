import { useEffect, useLayoutEffect, useRef } from 'react'
import type { InputEvent, Key } from '../events/input-event.js'
import { isInputSuppressed } from '../input-suppression.js'
import useStdin from './use-stdin.js'

type Handler = (input: string, key: Key, event: InputEvent) => void

type EventCallback<T extends (...args: never[]) => unknown> = T

function useEventCallback<T extends (...args: never[]) => unknown>(fn: T): EventCallback<T> {
  const callbackRef = useRef(fn)
  useLayoutEffect(() => {
    callbackRef.current = fn
  }, [fn])
  return useRef(((...args: Parameters<T>) => callbackRef.current(...args)) as T).current
}

type Options = {
  /**
   * Enable or disable capturing of user input.
   * Useful when there are multiple useInput hooks used at once to avoid handling the same input several times.
   *
   * @default true
   */
  isActive?: boolean

  /**
   * Register ahead of every listener already attached instead of behind
   * them. Listener order is otherwise mount order, and React runs child
   * effects before their parent's — so a parent whose shortcuts must
   * shadow a child's bindings via `stopImmediatePropagation()` would sit
   * behind that child on first mount and ahead of it only after the child
   * remounts. Read once at mount.
   *
   * @default false
   */
  prepend?: boolean
}

/**
 * This hook is used for handling user input.
 * It's a more convenient alternative to using `StdinContext` and listening to `data` events.
 * The callback you pass to `useInput` is called for each character when user enters any input.
 * However, if user pastes text and it's more than one character, the callback will be called only once and the whole string will be passed as `input`.
 *
 * ```
 * import {useInput} from 'ink';
 *
 * const UserInput = () => {
 *   useInput((input, key) => {
 *     if (input === 'q') {
 *       // Exit program
 *     }
 *
 *     if (key.leftArrow) {
 *       // Left arrow key pressed
 *     }
 *   });
 *
 *   return …
 * };
 * ```
 * @param inputHandler - called for each user input with the input string,
 *   parsed key flags, and the originating event.
 * @param options - hook options; `isActive: false` disables input capture.
 */
const useInput = (inputHandler: Handler, options: Options = {}): void => {
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin()

  // useLayoutEffect (not useEffect) so that raw mode is enabled synchronously
  // during React's commit phase, before render() returns. With useEffect, raw
  // mode setup is deferred to the next event loop tick via React's scheduler,
  // leaving the terminal in cooked mode — keystrokes echo and the cursor is
  // visible until the effect fires.
  useLayoutEffect(() => {
    if (options.isActive === false) {
      return
    }

    setRawMode(true)

    return () => {
      setRawMode(false)
    }
  }, [options.isActive, setRawMode])

  // Register the listener once on mount so its slot in the EventEmitter's
  // listener array is stable. If isActive were in the effect's deps, the
  // listener would re-append on false→true, moving it behind listeners
  // that registered while it was inactive — breaking
  // stopImmediatePropagation() ordering. The callback ref updates in the
  // layout phase so a key after commit sees this render's handler.
  const handleData = useEventCallback((event: InputEvent) => {
    if (options.isActive === false) {
      return
    }
    // Post-handoff window (external editor restore): the byte burst the
    // tty delivers right after stdin resumes is terminal chatter, not
    // keystrokes — drop it here so NO listener sees it (a stray ESC would
    // clear the prompt via Chat/PromptInput escape handling).
    if (isInputSuppressed()) {
      return
    }
    const { input, key } = event

    // If app is not supposed to exit on Ctrl+C, then let input listener handle it
    // Note: discreteUpdates is called at the App level when emitting events,
    // so all listeners are already within a high-priority update context.
    if (!(input === 'c' && key.ctrl) || !internal_exitOnCtrlC) {
      inputHandler(input, key, event)
    }
  })

  // Mount-time value, per the option's contract: a later change must not
  // re-register the listener and move its slot.
  const prepend = useRef(options.prepend === true).current
  useEffect(() => {
    if (prepend) internal_eventEmitter?.prependListener('input', handleData)
    else internal_eventEmitter?.on('input', handleData)

    return () => {
      internal_eventEmitter?.removeListener('input', handleData)
    }
  }, [internal_eventEmitter, handleData])
}

export default useInput

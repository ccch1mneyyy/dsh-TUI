import type { InputEvent, Key } from '../events/input-event.js';
type Handler = (input: string, key: Key, event: InputEvent) => void;
type Options = {
    /**
     * Enable or disable capturing of user input.
     * Useful when there are multiple useInput hooks used at once to avoid handling the same input several times.
     *
     * @default true
     */
    isActive?: boolean;
};
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
declare const useInput: (inputHandler: Handler, options?: Options) => void;
export default useInput;
//# sourceMappingURL=use-input.d.ts.map
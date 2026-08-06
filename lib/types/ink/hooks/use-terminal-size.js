import { useContext } from 'react';
import { TerminalSizeContext, } from '../components/TerminalSizeContext.js';
/** Terminal dimensions from the Ink app shell (ported from the leak). */
export function useTerminalSize() {
    const size = useContext(TerminalSizeContext);
    if (!size) {
        throw new Error('useTerminalSize must be used within an Ink App component');
    }
    return size;
}
//# sourceMappingURL=use-terminal-size.js.map
import { createContext, useCallback, useContext, useMemo } from 'react';
import { isProgressReportingAvailable } from './terminal.js';
import { BEL } from './termio/ansi.js';
import { ITERM2, OSC, osc, PROGRESS, wrapForMultiplexer } from './termio/osc.js';
export const TerminalWriteContext = createContext(null);
export const TerminalWriteProvider = TerminalWriteContext.Provider;
export function useTerminalNotification() {
    const writeRaw = useContext(TerminalWriteContext);
    if (!writeRaw) {
        throw new Error('useTerminalNotification must be used within TerminalWriteProvider');
    }
    const notifyITerm2 = useCallback(({ message, title }) => {
        const displayString = title ? `${title}:\n${message}` : message;
        writeRaw(wrapForMultiplexer(osc(OSC.ITERM2, `\n\n${displayString}`)));
    }, [writeRaw]);
    const notifyKitty = useCallback(({ message, title, id, }) => {
        writeRaw(wrapForMultiplexer(osc(OSC.KITTY, `i=${id}:d=0:p=title`, title)));
        writeRaw(wrapForMultiplexer(osc(OSC.KITTY, `i=${id}:p=body`, message)));
        writeRaw(wrapForMultiplexer(osc(OSC.KITTY, `i=${id}:d=1:a=focus`, '')));
    }, [writeRaw]);
    const notifyGhostty = useCallback(({ message, title }) => {
        writeRaw(wrapForMultiplexer(osc(OSC.GHOSTTY, 'notify', title, message)));
    }, [writeRaw]);
    const notifyBell = useCallback(() => {
        // Raw BEL — inside tmux this triggers tmux's bell-action (window flag).
        // Wrapping would make it opaque DCS payload and lose that fallback.
        writeRaw(BEL);
    }, [writeRaw]);
    const progress = useCallback((state, percentage) => {
        if (!isProgressReportingAvailable()) {
            return;
        }
        if (!state) {
            writeRaw(wrapForMultiplexer(osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.CLEAR, '')));
            return;
        }
        const pct = Math.max(0, Math.min(100, Math.round(percentage ?? 0)));
        switch (state) {
            case 'completed':
                writeRaw(wrapForMultiplexer(osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.CLEAR, '')));
                break;
            case 'error':
                writeRaw(wrapForMultiplexer(osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.ERROR, pct)));
                break;
            case 'indeterminate':
                writeRaw(wrapForMultiplexer(osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.INDETERMINATE, '')));
                break;
            case 'running':
                writeRaw(wrapForMultiplexer(osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.SET, pct)));
                break;
            case null:
                // Handled by the if guard above
                break;
        }
    }, [writeRaw]);
    return useMemo(() => ({ notifyITerm2, notifyKitty, notifyGhostty, notifyBell, progress }), [notifyITerm2, notifyKitty, notifyGhostty, notifyBell, progress]);
}
//# sourceMappingURL=useTerminalNotification.js.map
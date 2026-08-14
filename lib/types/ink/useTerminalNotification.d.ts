import { type Progress } from './terminal.js';
type WriteRaw = (data: string) => void;
/**
 * React context providing a raw terminal write function. Null until a
 * TerminalWriteProvider is mounted.
 */
export declare const TerminalWriteContext: import("react").Context<WriteRaw | null>;
/**
 * React provider component for TerminalWriteContext.
 */
export declare const TerminalWriteProvider: import("react").Provider<WriteRaw | null>;
/**
 * Terminal notification API returned by useTerminalNotification.
 */
export type TerminalNotification = {
    notifyITerm2: (opts: {
        message: string;
        title?: string;
    }) => void;
    notifyKitty: (opts: {
        message: string;
        title: string;
        id: number;
    }) => void;
    notifyGhostty: (opts: {
        message: string;
        title: string;
    }) => void;
    notifyBell: () => void;
    /**
     * Report progress to the terminal via OSC 9;4 sequences.
     * Supported terminals: ConEmu, Ghostty 1.2.0+, iTerm2 3.6.6+
     * Pass state=null to clear progress.
     */
    progress: (state: Progress['state'] | null, percentage?: number) => void;
};
/**
 * Hook returning terminal notification helpers (iTerm2/kitty/Ghostty
 * notifications, BEL, and OSC 9;4 progress). Throws when used outside a
 * TerminalWriteProvider.
 * @returns the terminal notification API bound to the current provider.
 */
export declare function useTerminalNotification(): TerminalNotification;
export {};
//# sourceMappingURL=useTerminalNotification.d.ts.map
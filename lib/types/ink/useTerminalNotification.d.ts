import { type Progress } from './terminal.js';
type WriteRaw = (data: string) => void;
export declare const TerminalWriteContext: import("react").Context<WriteRaw | null>;
export declare const TerminalWriteProvider: import("react").Provider<WriteRaw | null>;
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
export declare function useTerminalNotification(): TerminalNotification;
export {};
//# sourceMappingURL=useTerminalNotification.d.ts.map
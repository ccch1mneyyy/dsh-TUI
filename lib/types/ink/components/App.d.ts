import React, { PureComponent, type ReactNode } from "react";
import { EventEmitter } from "../events/emitter.js";
import { type ParsedKey, type ParsedMouse } from "../parse-keypress.js";
import { type SelectionState } from "../selection.js";
import { TerminalQuerier } from "../terminal-querier.js";
import { type CursorDeclarationSetter } from "./CursorDeclarationContext.js";
type Props = {
    readonly children: ReactNode;
    readonly stdin: NodeJS.ReadStream;
    readonly stdout: NodeJS.WriteStream;
    readonly stderr: NodeJS.WriteStream;
    readonly exitOnCtrlC: boolean;
    readonly onExit: (error?: Error) => void;
    readonly terminalColumns: number;
    readonly terminalRows: number;
    readonly selection: SelectionState;
    readonly onSelectionChange: () => void;
    readonly onClickAt: (col: number, row: number) => boolean;
    readonly onHoverAt: (col: number, row: number) => void;
    readonly getHyperlinkAt: (col: number, row: number) => string | undefined;
    readonly onOpenHyperlink: (url: string) => void;
    readonly onMultiClick: (col: number, row: number, count: 2 | 3) => void;
    readonly onSelectionDrag: (col: number, row: number) => void;
    readonly onStdinResume?: () => void;
    readonly onCursorDeclaration?: CursorDeclarationSetter;
    readonly dispatchKeyboardEvent: (parsedKey: ParsedKey) => void;
};
type State = {
    readonly error?: Error;
};
export default class App extends PureComponent<Props, State> {
    static displayName: string;
    static getDerivedStateFromError(error: Error): {
        error: Error;
    };
    state: {
        error: undefined;
    };
    rawModeEnabledCount: number;
    internal_eventEmitter: EventEmitter;
    keyParseState: import("../parse-keypress.js").KeyParseState;
    incompleteEscapeTimer: NodeJS.Timeout | null;
    xtversionProbe: NodeJS.Immediate | null;
    readonly NORMAL_TIMEOUT = 50;
    readonly PASTE_TIMEOUT = 500;
    querier: TerminalQuerier;
    lastClickTime: number;
    lastClickCol: number;
    lastClickRow: number;
    clickCount: number;
    pendingHyperlinkTimer: ReturnType<typeof setTimeout> | null;
    lastHoverCol: number;
    lastHoverRow: number;
    lastStdinTime: number;
    writeRaw: (data: string) => void;
    isRawModeSupported(): boolean;
    render(): React.JSX.Element;
    componentDidMount(): void;
    componentWillUnmount(): void;
    componentDidCatch(error: Error): void;
    handleSetRawMode: (isEnabled: boolean) => void;
    flushIncomplete: () => void;
    processInput: (input: string | Buffer | null) => void;
    handleReadable: () => void;
    handleInput: (input: string | undefined) => void;
    handleExit: (error?: Error) => void;
    handleTerminalFocus: (isFocused: boolean) => void;
    handleSuspend: () => void;
}
/** Exported for testing. Mutates app.props.selection and click/hover state. */
export declare function handleMouseEvent(app: App, m: ParsedMouse): void;
export {};
//# sourceMappingURL=App.d.ts.map
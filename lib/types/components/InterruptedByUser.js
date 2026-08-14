import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Text } from '../ui.js';
/**
 * The dim "interrupted" row shown when the user stops a turn, ported from
 * the leak's `InterruptedByUser.tsx`.
 */
export function InterruptedByUser() {
    return (_jsxs(_Fragment, { children: [_jsx(Text, { dimColor: true, children: "Interrupted " }), _jsx(Text, { dimColor: true, children: "\u00B7 What should DeepSeek do instead?" })] }));
}

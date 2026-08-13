import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import Box from '../../ink/components/Box.js';
import { Divider } from './Divider.js';
/**
 * A pane — a region below the prompt bounded by a colored top line with a
 * one-row gap above and horizontal padding (ported from the leak's
 * design-system/Pane.tsx). Used by the slash-command dialogs (/thinking,
 * /model, /resume).
 *
 * @example
 * <Pane color="permission">...</Pane>
 */
export function Pane({ children, color, }) {
    return (_jsxs(Box, { flexDirection: "column", paddingTop: 1, children: [_jsx(Divider, { color: color }), _jsx(Box, { flexDirection: "column", paddingX: 2, children: children })] }));
}

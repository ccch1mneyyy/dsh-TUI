import { jsxs as _jsxs } from "react/jsx-runtime";
import figures from 'figures';
import Text from '../../ink/components/Text.js';
const STATUS_CONFIG = {
    success: { icon: figures.tick, color: 'success' },
    error: { icon: figures.cross, color: 'error' },
    warning: { icon: figures.warning, color: 'warning' },
    info: { icon: figures.info, color: 'suggestion' },
    pending: { icon: figures.circle, color: undefined },
    loading: { icon: '…', color: undefined },
};
/**
 * A status indicator icon with the CC color mapping (ported from the leak's
 * design-system/StatusIcon.tsx): ✓ green / ✗ red / ⚠ amber / ℹ blue /
 * ○ dim / … dim.
 */
export function StatusIcon({ status, withSpace = false, }) {
    const config = STATUS_CONFIG[status];
    return (_jsxs(Text, { color: config.color, children: [config.icon, withSpace ? ' ' : ''] }));
}

import { jsx as _jsx } from "react/jsx-runtime";
import Box from '../../ink/components/Box.js';
import Text from '../../ink/components/Text.js';
import { stringWidth } from '../../ink/stringWidth.js';
/**
 * Transcript-mode metadata row: `HH:MM · model`, right-aligned above the
 * assistant text (ported from the leak's MessageTimestamp + MessageModel,
 * collapsed into one row).
 */
export function MessageMetadata({ timestamp, model, }) {
    if (timestamp === undefined)
        return null;
    const formatted = new Date(timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    });
    const text = `${formatted} · ${model}`;
    return (_jsx(Box, { minWidth: stringWidth(text), children: _jsx(Text, { dimColor: true, children: text }) }));
}

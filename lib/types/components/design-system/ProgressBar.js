import { jsx as _jsx } from "react/jsx-runtime";
import Text from '../../ink/components/Text.js';
/**
 * A proportional progress bar drawn with block glyphs, ported from the
 * leak's design-system/ProgressBar.tsx: `█` fills whole cells, the partial
 * cell uses the `▏▎▍▌▋▊▉` ladder for sub-cell precision, and the empty
 * remainder is spaces with the empty color as background.
 *
 * @example
 * <ProgressBar ratio={0.42} width={20} fillColor="claude" emptyColor="inactive" />
 */
export function ProgressBar({ ratio: inputRatio, width, fillColor, emptyColor, }) {
    const ratio = Math.min(1, Math.max(0, inputRatio));
    const whole = Math.floor(ratio * width);
    const segments = [BLOCKS[BLOCKS.length - 1].repeat(whole)];
    if (whole < width) {
        const remainder = ratio * width - whole;
        const middle = Math.floor(remainder * BLOCKS.length);
        segments.push(BLOCKS[middle]);
        const empty = width - whole - 1;
        if (empty > 0) {
            segments.push(BLOCKS[0].repeat(empty));
        }
    }
    return (_jsx(Text, { color: fillColor, backgroundColor: emptyColor, children: segments.join('') }));
}
const BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

import React from 'react';
import type { Theme } from '../../theme.js';
/**
 * A proportional progress bar drawn with block glyphs, ported from the
 * leak's design-system/ProgressBar.tsx: `█` fills whole cells, the partial
 * cell uses the `▏▎▍▌▋▊▉` ladder for sub-cell precision, and the empty
 * remainder is spaces with the empty color as background.
 *
 * @example
 * <ProgressBar ratio={0.42} width={20} fillColor="claude" emptyColor="inactive" />
 */
export declare function ProgressBar({ ratio: inputRatio, width, fillColor, emptyColor, }: {
    /** How much progress to display, between 0 and 1 inclusive. */
    ratio: number;
    /** How many characters wide to draw the progress bar. */
    width: number;
    /** Optional color for the filled portion of the bar. */
    fillColor?: keyof Theme;
    /** Optional color for the empty portion of the bar. */
    emptyColor?: keyof Theme;
}): React.ReactNode;
//# sourceMappingURL=ProgressBar.d.ts.map
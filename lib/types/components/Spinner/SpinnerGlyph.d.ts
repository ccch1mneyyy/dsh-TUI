import React from 'react';
import { type Theme } from '../../theme.js';
type Props = {
    frame: number;
    messageColor: keyof Theme;
    stalledIntensity?: number;
    reducedMotion?: boolean;
    time?: number;
};
/**
 * The animated spinner glyph (·✢*✶✻✽ cycle), ported from the leak's
 * `Spinner/SpinnerGlyph.tsx`. Interpolates toward red when stalled.
 */
export declare function SpinnerGlyph({ frame, messageColor, stalledIntensity, reducedMotion, time, }: Props): React.ReactNode;
export {};
//# sourceMappingURL=SpinnerGlyph.d.ts.map
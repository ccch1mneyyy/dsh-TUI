import React from 'react';
import { type Theme } from '../../theme.js';
import type { SpinnerMode } from './spinnerMode.js';
type Props = {
    message: string;
    mode: SpinnerMode;
    messageColor: keyof Theme;
    glimmerIndex: number;
    flashOpacity: number;
    shimmerColor: keyof Theme;
    stalledIntensity?: number;
};
/**
 * The shimmering verb message next to the spinner glyph, ported from the
 * leak's `Spinner/GlimmerMessage.tsx`.
 */
export declare function GlimmerMessage({ message, mode, messageColor, glimmerIndex, flashOpacity, shimmerColor, stalledIntensity, }: Props): React.ReactNode;
export {};
//# sourceMappingURL=GlimmerMessage.d.ts.map
/**
 * SGR (Select Graphic Rendition) Parser
 *
 * Parses SGR parameters and applies them to a TextStyle.
 * Handles both semicolon (;) and colon (:) separated parameters.
 */
import type { TextStyle } from './types.js';
/**
 * Apply an SGR parameter string to a text style.
 * Handles both semicolon (;) and colon (:) separated parameters.
 * @param paramStr - the SGR parameter string (without the CSI prefix or final m).
 * @param style - the style to apply the parameters to.
 * @returns the resulting style; code 0 resets to the default style, other
 *   codes update the corresponding attribute of a copy.
 */
export declare function applySGR(paramStr: string, style: TextStyle): TextStyle;
//# sourceMappingURL=sgr.d.ts.map
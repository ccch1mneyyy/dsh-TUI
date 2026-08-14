/**
 * ESC Sequence Parser
 *
 * Handles simple escape sequences: ESC + one or two characters
 */
import type { Action } from './types.js';
/**
 * Parse a simple ESC sequence.
 *
 * @param chars - Characters after ESC (not including ESC itself).
 * @returns the semantic action for the sequence, or null when the sequence
 *   is empty or deliberately ignored (tab stop set, charset selection).
 */
export declare function parseEsc(chars: string): Action | null;
//# sourceMappingURL=esc.d.ts.map
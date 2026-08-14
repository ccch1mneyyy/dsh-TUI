import type { DOMElement } from '../ink/dom.js';
/**
 * Hook for synchronized blinking animations that pause when offscreen
 * (ported from the leak's `src/hooks/useBlink.ts`).
 *
 * @param enabled - Whether blinking is active
 * @param intervalMs - Blink cycle length in ms; defaults to 600.
 * @returns [ref, isVisible] - Ref to attach to element, true when visible in blink cycle
 */
export declare function useBlink(enabled: boolean, intervalMs?: number): [ref: (element: DOMElement | null) => void, isVisible: boolean];
//# sourceMappingURL=useBlink.d.ts.map
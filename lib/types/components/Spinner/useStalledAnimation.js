import { useRef } from 'react';
/**
 * Tracks the transition to red when tokens stop flowing (ported from the
 * leak's `Spinner/useStalledAnimation.ts`). Driven by the parent's animation
 * clock time instead of independent intervals, so it slows down when the
 * terminal is blurred.
 * @param time - Parent animation clock time in ms.
 * @param currentResponseLength - Chars streamed this turn; growth resets the stall timer.
 * @param hasActiveTools - True while tools are running; tool activity never stalls.
 * @param reducedMotion - True to apply intensity changes instantly instead of smoothing.
 * @returns Whether the response is stalled, plus the 0–1 stalled intensity.
 */
export function useStalledAnimation(time, currentResponseLength, hasActiveTools = false, reducedMotion = false) {
    const lastTokenTime = useRef(time);
    const lastResponseLength = useRef(currentResponseLength);
    const mountTime = useRef(time);
    const stalledIntensityRef = useRef(0);
    const lastSmoothTime = useRef(time);
    // Reset timer when new tokens arrive (check actual length change)
    if (currentResponseLength > lastResponseLength.current) {
        lastTokenTime.current = time;
        lastResponseLength.current = currentResponseLength;
        stalledIntensityRef.current = 0;
        lastSmoothTime.current = time;
    }
    // Derive time since last token from animation clock
    let timeSinceLastToken;
    if (hasActiveTools) {
        timeSinceLastToken = 0;
        lastTokenTime.current = time;
    }
    else if (currentResponseLength > 0) {
        timeSinceLastToken = time - lastTokenTime.current;
    }
    else {
        timeSinceLastToken = time - mountTime.current;
    }
    // Calculate stalled intensity based on time since last token
    // Start showing red after 3 seconds of no new tokens (only when no tools are active)
    const isStalled = timeSinceLastToken > 3000 && !hasActiveTools;
    const intensity = isStalled
        ? Math.min((timeSinceLastToken - 3000) / 2000, 1) // Fade over 2 seconds
        : 0;
    // Smooth intensity transition driven by animation frame ticks
    if (!reducedMotion && (intensity > 0 || stalledIntensityRef.current > 0)) {
        const dt = time - lastSmoothTime.current;
        if (dt >= 50) {
            const steps = Math.floor(dt / 50);
            let current = stalledIntensityRef.current;
            for (let i = 0; i < steps; i++) {
                const diff = intensity - current;
                if (Math.abs(diff) < 0.01) {
                    current = intensity;
                    break;
                }
                current += diff * 0.1;
            }
            stalledIntensityRef.current = current;
            lastSmoothTime.current = time;
        }
    }
    else {
        stalledIntensityRef.current = intensity;
        lastSmoothTime.current = time;
    }
    // When reducedMotion is enabled, use instant intensity change
    const effectiveIntensity = reducedMotion
        ? intensity
        : stalledIntensityRef.current;
    return { isStalled, stalledIntensity: effectiveIntensity };
}

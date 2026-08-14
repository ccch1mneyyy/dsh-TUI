import { jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js';
import { Box } from '../ui.js';
import { SpinnerAnimationRow } from './Spinner/SpinnerAnimationRow.js';
import { SPINNER_VERBS } from '../cc/spinnerVerbs.js';
import { sample } from 'lodash-es';
/**
 * The working spinner block shown between the transcript and the prompt
 * input while a turn is in flight. Ported from the leak's `Spinner.tsx`
 * (SpinnerWithVerb path) with the swarm/teammate/effort/tips branches
 * removed; the channel feeds the mode, token count and thinking status.
 *
 * Random verb is picked once per turn (per mount of the spinner).
 */
export function WorkingSpinner({ mode, hasActiveTools, responseLengthRef, loadingStartTimeRef, totalPausedMsRef, pauseStartTimeRef, thinkingStatus, }) {
    const { columns } = useTerminalSize();
    // Pick a random verb once per spinner mount (per turn).
    const [randomVerb] = useState(() => sample(SPINNER_VERBS) ?? 'Working');
    const message = `${randomVerb}…`;
    return (_jsx(Box, { flexDirection: "column", width: "100%", alignItems: "flex-start", children: _jsx(SpinnerAnimationRow, { mode: mode, reducedMotion: false, hasActiveTools: hasActiveTools, responseLengthRef: responseLengthRef, message: message, messageColor: "claude", shimmerColor: "claudeShimmer", loadingStartTimeRef: loadingStartTimeRef, totalPausedMsRef: totalPausedMsRef, pauseStartTimeRef: pauseStartTimeRef, spinnerSuffix: null, verbose: true, columns: columns, thinkingStatus: thinkingStatus }) }));
}
/**
 * Tracks thinking status: 'thinking' while the model is streaming reasoning,
 * then the duration in ms for a minimum 2s display (avoids UI jank). Ported
 * from the leak's SpinnerWithVerb effect.
 */
export function useThinkingStatus(isThinking) {
    const [thinkingStatus, setThinkingStatus] = useState(null);
    const thinkingStartRef = useRef(null);
    useEffect(() => {
        let showDurationTimer = null;
        let clearStatusTimer = null;
        if (isThinking) {
            // Started thinking
            if (thinkingStartRef.current === null) {
                thinkingStartRef.current = Date.now();
                setThinkingStatus('thinking');
            }
        }
        else if (thinkingStartRef.current !== null) {
            // Stopped thinking - calculate duration and ensure 2s minimum display
            const duration = Date.now() - thinkingStartRef.current;
            const elapsed = Date.now() - thinkingStartRef.current;
            const remainingThinkingTime = Math.max(0, 2000 - elapsed);
            thinkingStartRef.current = null;
            // Show "thinking..." for remaining time if < 2s elapsed, then show duration
            const showDuration = () => {
                setThinkingStatus(duration);
                // Clear after 2s
                clearStatusTimer = setTimeout(() => setThinkingStatus(null), 2000);
            };
            if (remainingThinkingTime > 0) {
                showDurationTimer = setTimeout(showDuration, remainingThinkingTime);
            }
            else {
                showDuration();
            }
        }
        return () => {
            if (showDurationTimer)
                clearTimeout(showDurationTimer);
            if (clearStatusTimer)
                clearTimeout(clearStatusTimer);
        };
    }, [isThinking]);
    return thinkingStatus;
}

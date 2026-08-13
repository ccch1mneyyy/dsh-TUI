import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import figures from 'figures';
import { useMemo, useRef } from 'react';
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js';
import Box from '../../ink/components/Box.js';
import Text from '../../ink/components/Text.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { formatDuration, formatNumber } from '../../cc/format.js';
import { Byline } from '../design-system/Byline.js';
import { GlimmerMessage } from './GlimmerMessage.js';
import { SpinnerGlyph } from './SpinnerGlyph.js';
import { useStalledAnimation } from './useStalledAnimation.js';
import { interpolateColor, toRGBColor } from './spinnerUtils.js';
const SEP_WIDTH = stringWidth(' · ');
const THINKING_BARE_WIDTH = stringWidth('thinking');
const SHOW_TOKENS_AFTER_MS = 30_000;
// Thinking shimmer constants (same as the leak).
const THINKING_INACTIVE = { r: 153, g: 153, b: 153 };
const THINKING_INACTIVE_SHIMMER = { r: 185, g: 185, b: 185 };
const THINKING_DELAY_MS = 3000;
const THINKING_GLOW_PERIOD_S = 2;
/**
 * The 50ms-animated portion of the working spinner, ported from the leak's
 * `Spinner/SpinnerAnimationRow.tsx` with the swarm/teammate/effort branches
 * removed. Owns `useAnimationFrame(50)` and all values derived from the
 * animation clock (frame, glimmer, token counter animation, elapsed time,
 * stalled intensity, thinking shimmer).
 */
export function SpinnerAnimationRow({ mode, reducedMotion, hasActiveTools, responseLengthRef, message, messageColor, shimmerColor, loadingStartTimeRef, totalPausedMsRef, pauseStartTimeRef, spinnerSuffix, verbose, columns, thinkingStatus, }) {
    const [viewportRef, time] = useAnimationFrame(reducedMotion ? null : 50);
    // === Elapsed time (wall-clock, derived from refs each frame) ===
    const now = Date.now();
    const elapsedTimeMs = pauseStartTimeRef.current !== null
        ? pauseStartTimeRef.current -
            loadingStartTimeRef.current -
            totalPausedMsRef.current
        : now - loadingStartTimeRef.current - totalPausedMsRef.current;
    // === Animation derivations from `time` ===
    const currentResponseLength = responseLengthRef.current;
    const { isStalled, stalledIntensity } = useStalledAnimation(time, currentResponseLength, hasActiveTools, reducedMotion);
    const frame = reducedMotion ? 0 : Math.floor(time / 120);
    const glimmerSpeed = mode === 'requesting' ? 50 : 200;
    const glimmerMessageWidth = useMemo(() => stringWidth(message), [message]);
    const cycleLength = glimmerMessageWidth + 20;
    const cyclePosition = Math.floor(time / glimmerSpeed);
    const glimmerIndex = reducedMotion
        ? -100
        : isStalled
            ? -100
            : mode === 'requesting'
                ? (cyclePosition % cycleLength) - 10
                : glimmerMessageWidth + 10 - (cyclePosition % cycleLength);
    const flashOpacity = reducedMotion
        ? 0
        : mode === 'tool-use'
            ? (Math.sin((time / 1000) * Math.PI) + 1) / 2
            : 0;
    // === Token counter animation (smooth increment, driven by 50ms clock) ===
    const tokenCounterRef = useRef(currentResponseLength);
    if (reducedMotion) {
        tokenCounterRef.current = currentResponseLength;
    }
    else {
        const gap = currentResponseLength - tokenCounterRef.current;
        if (gap > 0) {
            let increment;
            if (gap < 70) {
                increment = 3;
            }
            else if (gap < 200) {
                increment = Math.max(8, Math.ceil(gap * 0.15));
            }
            else {
                increment = 50;
            }
            tokenCounterRef.current = Math.min(tokenCounterRef.current + increment, currentResponseLength);
        }
    }
    const displayedResponseLength = tokenCounterRef.current;
    const leaderTokens = Math.round(displayedResponseLength / 4);
    const timerText = formatDuration(elapsedTimeMs);
    const timerWidth = stringWidth(timerText);
    const tokenCount = formatNumber(leaderTokens);
    const tokensText = `${figures.arrowDown} ${tokenCount} tokens`;
    const tokensWidth = stringWidth(tokensText);
    // === Thinking text (may shrink to fit) ===
    let thinkingText = thinkingStatus === 'thinking'
        ? 'thinking'
        : typeof thinkingStatus === 'number'
            ? `thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s`
            : null;
    let thinkingWidthValue = thinkingText ? stringWidth(thinkingText) : 0;
    // === Progressive width gating ===
    const messageWidth = glimmerMessageWidth + 2;
    const sep = SEP_WIDTH;
    const wantsThinking = thinkingStatus !== null;
    const wantsTimerAndTokens = verbose || elapsedTimeMs > SHOW_TOKENS_AFTER_MS;
    const availableSpace = columns - messageWidth - 5;
    let showThinking = wantsThinking && availableSpace > thinkingWidthValue;
    if (!showThinking && wantsThinking && thinkingStatus === 'thinking') {
        if (availableSpace > THINKING_BARE_WIDTH) {
            thinkingText = 'thinking';
            thinkingWidthValue = THINKING_BARE_WIDTH;
            showThinking = true;
        }
    }
    const usedAfterThinking = showThinking ? thinkingWidthValue + sep : 0;
    const showTimer = wantsTimerAndTokens && availableSpace > usedAfterThinking + timerWidth;
    const usedAfterTimer = usedAfterThinking + (showTimer ? timerWidth + sep : 0);
    const showTokens = wantsTimerAndTokens &&
        leaderTokens > 0 &&
        availableSpace > usedAfterTimer + tokensWidth;
    const thinkingOnly = showThinking &&
        thinkingStatus === 'thinking' &&
        !spinnerSuffix &&
        !showTimer &&
        !showTokens;
    // === Thinking shimmer color ===
    const thinkingElapsedSec = (time - THINKING_DELAY_MS) / 1000;
    const thinkingOpacity = time < THINKING_DELAY_MS
        ? 0
        : (Math.sin((thinkingElapsedSec * Math.PI * 2) / THINKING_GLOW_PERIOD_S) +
            1) /
            2;
    const thinkingShimmerColor = toRGBColor(interpolateColor(THINKING_INACTIVE, THINKING_INACTIVE_SHIMMER, thinkingOpacity));
    // === Build status parts ===
    const parts = [
        ...(spinnerSuffix
            ? [
                _jsx(Text, { dimColor: true, children: spinnerSuffix }, "suffix"),
            ]
            : []),
        ...(showTimer
            ? [
                _jsx(Text, { dimColor: true, children: timerText }, "elapsedTime"),
            ]
            : []),
        ...(showTokens
            ? [
                _jsxs(Box, { flexDirection: "row", children: [_jsx(SpinnerModeGlyph, { mode: mode }), _jsxs(Text, { dimColor: true, children: [tokenCount, " tokens"] })] }, "tokens"),
            ]
            : []),
        ...(showThinking && thinkingText
            ? [
                thinkingStatus === 'thinking' && !reducedMotion ? (_jsx(Text, { color: thinkingShimmerColor, children: thinkingOnly ? `(${thinkingText})` : thinkingText }, "thinking")) : (_jsx(Text, { dimColor: true, children: thinkingText }, "thinking")),
            ]
            : []),
    ];
    const status = parts.length > 0 ? (thinkingOnly ? (_jsx(Byline, { children: parts })) : (_jsxs(_Fragment, { children: [_jsx(Text, { dimColor: true, children: "(" }), _jsx(Byline, { children: parts }), _jsx(Text, { dimColor: true, children: ")" })] }))) : null;
    return (_jsxs(Box, { ref: viewportRef, flexDirection: "row", flexWrap: "wrap", marginTop: 1, width: "100%", children: [_jsx(SpinnerGlyph, { frame: frame, messageColor: messageColor, stalledIntensity: stalledIntensity, reducedMotion: reducedMotion, time: time }), _jsx(GlimmerMessage, { message: message, mode: mode, messageColor: messageColor, glimmerIndex: glimmerIndex, flashOpacity: flashOpacity, shimmerColor: shimmerColor, stalledIntensity: stalledIntensity }), status] }));
}
function SpinnerModeGlyph({ mode }) {
    switch (mode) {
        case 'tool-input':
        case 'tool-use':
        case 'responding':
        case 'thinking':
            return (_jsx(Box, { width: 2, children: _jsx(Text, { dimColor: true, children: figures.arrowDown }) }));
        case 'requesting':
            return (_jsx(Box, { width: 2, children: _jsx(Text, { dimColor: true, children: figures.arrowUp }) }));
    }
}

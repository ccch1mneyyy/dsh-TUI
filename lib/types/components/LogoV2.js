import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { Box, Text, useAnimationFrame, useTerminalSize } from '../ui.js';
import { getTheme } from '../theme.js';
import { useTheme } from './design-system/ThemeProvider.js';
import { parseRGB } from './Spinner/spinnerUtils.js';
import { renderBigText } from './bigfont.js';
import { BRAND, FLASH, ICE, PALE, sweep } from './shimmer.js';
import { STANDARD_FRAME_INDEX, WhaleArt } from './Whale.js';
import { OPENING_SEQUENCE } from './whaleFrames.js';
const VERSION = '0.1.0';
/** Below this width the whale hides and the header goes text-only. */
const WHALE_MIN_COLUMNS = 64;
/**
 * Fixed whale box width: the tail-wag frames reach 4 columns further right
 * than the standard pose, and a pinned width keeps the text column from
 * shifting sideways during the opening animation.
 */
const FULL_WHALE_WIDTH = 40;
/** `max` → `Max` (effort levels arrive lower-case from the adapter). */
function capitalize(text) {
    return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}
/**
 * The header splash: one layout, two phases. The **opening** (~3.4s, once)
 * plays the hand-drawn whale animation (blink → water-spout bloom → tail
 * wag) and runs the shimmer sweeps; the **settled** header is the same
 * tree frozen at t=0 — whale on the standard pose, sweep highlights parked
 * off-screen, clock unsubscribed, zero timers.
 *
 * Layout: the 13-row pixel whale beside a text column of matching height —
 * the `✦ dsh-cc` wordmark with version, the `DEEPSEEK`/`HARNESS` tagline in
 * the 5-row block font (brand-blue → ice gradient), the model/effort and
 * cwd in plain text (no brand-color highlight), the startup tip, and below
 * the block the `探索未至之境！` welcome line in ice blue. Narrow terminals
 * drop the whale and keep the text column.
 */
export function LogoV2({ model, effort, cwd, skipIntro = false, }) {
    const [step, setStep] = React.useState(skipIntro ? OPENING_SEQUENCE.length : 0);
    const settled = step >= OPENING_SEQUENCE.length;
    // Opening clock: drives the shimmer sweep and big-text highlight only
    // while the intro plays; `null` afterwards unsubscribes so the settled
    // header never repaints.
    const [ref, time] = useAnimationFrame(settled ? null : 200);
    // Frame chain: dwell per OPENING_SEQUENCE entry, then settle for good.
    React.useEffect(() => {
        if (settled)
            return;
        const timer = setTimeout(() => {
            setStep(s => s + 1);
        }, OPENING_SEQUENCE[step].ms);
        return () => {
            clearTimeout(timer);
        };
    }, [step, settled]);
    const [themeName] = useTheme();
    const theme = getTheme(themeName);
    const { columns } = useTerminalSize();
    const wordmarkRGB = parseRGB(theme.claude) ?? BRAND;
    const wordmarkShimmerRGB = parseRGB(theme.claudeShimmer) ?? ICE;
    const taglineRGB = parseRGB(theme.claudeBlue_FOR_SYSTEM_SPINNER) ?? ICE;
    const showWhale = columns >= WHALE_MIN_COLUMNS;
    const frameIndex = settled ? STANDARD_FRAME_INDEX : OPENING_SEQUENCE[step].frame;
    // Frozen clock for the settled header: t=0 parks every sweep highlight
    // off-screen, leaving the static gradient behind.
    const t = settled ? 0 : time;
    const bigDeepSeek = renderBigText('DEEPSEEK', t, wordmarkRGB, taglineRGB, FLASH);
    const bigHarness = renderBigText('HARNESS', t, taglineRGB, PALE, FLASH);
    return (_jsxs(Box, { ref: ref, flexDirection: "column", marginTop: 1, children: [_jsxs(Box, { flexDirection: "row", gap: 2, width: "100%", alignItems: "center", children: [showWhale && _jsx(WhaleArt, { frameIndex: frameIndex, width: FULL_WHALE_WIDTH }), _jsxs(Box, { flexDirection: "column", flexShrink: 1, children: [_jsxs(Text, { wrap: "truncate-end", children: [sweep('✦ dsh-cc', t, wordmarkRGB, wordmarkShimmerRGB), _jsx(Text, { dimColor: true, children: '  v' + VERSION })] }), bigDeepSeek.map((row, index) => (_jsx(Text, { wrap: "truncate-end", children: row }, `ds-${index}`))), bigHarness.map((row, index) => (_jsx(Text, { wrap: "truncate-end", children: row }, `h-${index}`))), _jsxs(Text, { wrap: "truncate-end", children: [model, effort !== undefined && _jsx(Text, { dimColor: true, children: ' · ' + capitalize(effort) + ' effort' })] }), _jsx(Text, { dimColor: true, wrap: "truncate-end", children: cwd }), _jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { dimColor: true, children: "Tip: " }), "/model", _jsx(Text, { dimColor: true, children: " \u5207\u6362\u6A21\u578B \u00B7 " }), "/help", _jsx(Text, { dimColor: true, children: " \u67E5\u770B\u547D\u4EE4 \u00B7 " }), "Tab", _jsx(Text, { dimColor: true, children: " \u81EA\u52A8\u8865\u5168" })] })] })] }), _jsx(Box, { marginTop: 1, paddingLeft: 2, children: _jsx(Text, { children: sweep('探索未至之境！', t, taglineRGB, FLASH) }) })] }));
}
//# sourceMappingURL=LogoV2.js.map
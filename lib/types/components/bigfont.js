import { interpolateColor } from './Spinner/spinnerUtils.js';
/** Glyph rows are 5 columns wide; `·` is a transparent cell. */
const GLYPHS = {
    D: ['█▀▀▀▄', '█···█', '█···█', '█···█', '█▄▄▄▀'],
    E: ['█▀▀▀▀', '█····', '█▀▀▀·', '█····', '█▄▄▄▄'],
    P: ['█▀▀▀▄', '█···█', '█▄▄▄▀', '█····', '█····'],
    S: ['█▀▀▀▀', '█····', '·▀▀▀▄', '····█', '█▄▄▄▀'],
    K: ['█···█', '█·█··', '██···', '█·█··', '█···█'],
    H: ['█···█', '█···█', '█▀▀▀█', '█···█', '█···█'],
    A: ['·▄▀▄·', '█···█', '█▀▀▀█', '█···█', '█···█'],
    R: ['█▀▀▀▄', '█···█', '█▄▄▄▀', '█·█··', '█···█'],
    N: ['█···█', '██··█', '█·█·█', '█··██', '█···█'],
};
const FALLBACK = [
    '▄▄▄▄▄',
    '█···█',
    '█···█',
    '█···█',
    '▀▀▀▀▀',
];
/** Per-glyph advance (5 glyph columns + 1 kerning column). */
const ADVANCE = 6;
/** Space between words. */
const WORD_GAP = 2;
/** Sweep highlight window width, in terminal columns. */
const SWEEP_WINDOW = 8;
const esc = (rgb) => `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
const RESET = '\x1b[39m';
/**
 * Render `text` in the 5-row block font. The gradient runs `from` → `to`
 * across the full line width; a SWEEP_WINDOW-wide highlight mixed toward
 * `flash` travels left to right (one column per `stepMs`, matching the
 * wordmark shimmer's cadence). Returns 5 ANSI rows.
 * @param text - Text to render; only D, E, P, S, K, H, A, R, N have glyphs, unknown letters fall back to a hollow box.
 * @param time - Elapsed time in milliseconds; drives the sweep position and the brightness pulse.
 * @param from - Gradient start color at the left edge.
 * @param to - Gradient end color at the right edge.
 * @param flash - Highlight color mixed into the moving sweep window.
 * @param stepMs - Milliseconds per column of sweep advance (default 60).
 * @returns Five ANSI rows, one per block-font line.
 */
export function renderBigText(text, time, from, to, flash, stepMs = 60) {
    const width = text.length * ADVANCE + (text.includes(' ') ? WORD_GAP - 1 : 0);
    const cycle = width + SWEEP_WINDOW * 2;
    const sweepStart = (Math.floor(time / stepMs) % cycle) - SWEEP_WINDOW;
    const pulse = (Math.sin(time / (stepMs * 2)) + 1) / 2;
    const rows = [];
    for (let row = 0; row < 5; row++) {
        let out = '';
        let current = '';
        let x = 0;
        const emit = (ch) => {
            if (ch === ' ' || ch === '·') {
                if (current !== '') {
                    out += RESET;
                    current = '';
                }
                out += ' ';
                x += 1;
                return;
            }
            const t = width <= 1 ? 0 : x / (width - 1);
            let color = interpolateColor(from, to, t);
            if (x >= sweepStart && x < sweepStart + SWEEP_WINDOW) {
                color = interpolateColor(color, flash, pulse);
            }
            const seq = esc(color);
            if (seq !== current) {
                out += seq;
                current = seq;
            }
            out += ch;
            x += 1;
        };
        for (const ch of text) {
            if (ch === ' ') {
                for (let i = 0; i < WORD_GAP; i++)
                    emit(' ');
                continue;
            }
            const glyph = GLYPHS[ch] ?? FALLBACK;
            for (const cell of glyph[row])
                emit(cell);
            emit(' ');
        }
        if (current !== '')
            out += RESET;
        rows.push(out);
    }
    return rows;
}

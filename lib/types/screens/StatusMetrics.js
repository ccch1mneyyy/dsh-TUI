/**
 * Status-line metric renderers, ported from two pi extensions:
 *  - `pi-nano-context`: segmented context progress bar (morandi pastel
 *    segments by content type, free space right-aligned with the usage
 *    readout, largest-remainder column allocation).
 *  - `pi-tps-meter`: live 1/8-cell gauge while streaming and a min-max
 *    normalized sparkline after each completed turn; colors green ≥ 50 tps,
 *    yellow ≥ 20, red below.
 */
/** Context bar segments — DeepSeek blue family (dark-theme friendly: deep
 *  navy → brand blue, neutral grey free segment; labels adapt to width). */
const USED_SEGMENTS = [
    { key: 'system', color: '#22305F', labels: ['system', 'sys', 's'] }, // deep navy
    { key: 'prompt', color: '#2B3D78', labels: ['prompt', 'pr', 'p'] }, // navy
    { key: 'assistant', color: '#344A92', labels: ['assistant', 'ast', 'a'] }, // indigo
    { key: 'thinking', color: '#4D6BFE', labels: ['think', 'th', 't'] }, // DeepSeek brand blue
    { key: 'tools', color: '#5A7CFF', labels: ['tools', 'tl', 'x'] }, // lighter blue
];
const USED_SEGMENT_TEXT = '#FFFFFF';
const FREE_SEGMENT_FILL = '#E8E8E8';
const FREE_SEGMENT_TEXT = '#4A4A4A';
const FREE_SEGMENT_LABELS = ['free', 'fr', 'f'];
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text) => text.replace(ANSI_RE, '');
const plainWidth = (text) => Array.from(stripAnsi(text)).length;
function ansiColor(mode, hex, text) {
    const value = Number.parseInt(hex.replace(/^#/, ''), 16);
    const red = (value >> 16) & 0xff;
    const green = (value >> 8) & 0xff;
    const blue = value & 0xff;
    return `\x1b[${mode};2;${red};${green};${blue}m${text}\x1b[${mode === 38 ? 39 : 49}m`;
}
const foreground = (hex, text) => ansiColor(38, hex, text);
const background = (hex, text) => ansiColor(48, hex, text);
/** Compact token count like pi's: `988`, `3.4k`, `12k`, `1.0M`.
 * @param count - The raw token count; negative values clamp to zero.
 * @returns The compact count string.
 */
export function formatTokens(count) {
    const value = Math.max(0, Math.round(count));
    if (value < 1000)
        return String(value);
    if (value < 10000)
        return `${(value / 1000).toFixed(1)}k`;
    if (value < 1000000)
        return `${Math.round(value / 1000)}k`;
    if (value < 10000000)
        return `${(value / 1000000).toFixed(1)}M`;
    return `${Math.round(value / 1000000)}M`;
}
// --- Context bar (pi-nano-context) ---
function centeredText(text, width) {
    const textWidth = plainWidth(text);
    if (textWidth > width)
        return ' '.repeat(width);
    const left = Math.floor((width - textWidth) / 2);
    const right = width - textWidth - left;
    return `${' '.repeat(left)}${text}${' '.repeat(right)}`;
}
function chooseLabel(labels, width) {
    for (const label of labels) {
        if (plainWidth(label) <= width)
            return label;
    }
    return '';
}
function renderUsedSegment(labels, color, width) {
    if (width <= 0)
        return '';
    const label = chooseLabel(labels, width);
    const text = label.length > 0
        ? foreground(USED_SEGMENT_TEXT, centeredText(label, width))
        : ' '.repeat(width);
    return background(color, text);
}
function chooseRightAlignedText(options, width, blockedUntil) {
    for (const option of options) {
        const start = width - plainWidth(option);
        if (start > blockedUntil)
            return option;
    }
    return '';
}
function renderFreeSegment(options, width, fill, text) {
    if (width <= 0)
        return '';
    const content = Array.from({ length: width }, () => ' ');
    const label = chooseLabel(FREE_SEGMENT_LABELS, width);
    const labelStart = Math.max(0, Math.floor((width - plainWidth(label)) / 2));
    const labelEnd = label.length > 0 ? labelStart + plainWidth(label) : -1;
    const rightText = chooseRightAlignedText(options, width, labelEnd);
    if (rightText) {
        const start = width - plainWidth(rightText);
        for (const [offset, char] of Array.from(rightText).entries()) {
            content[start + offset] = char;
        }
    }
    if (label) {
        for (const [offset, char] of Array.from(label).entries()) {
            content[labelStart + offset] = char;
        }
    }
    return background(fill, foreground(text, content.join('')));
}
/** Largest-remainder column allocation (pi-nano-context). */
function allocateProportionally(values, columns) {
    if (columns <= 0)
        return values.map(() => 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    if (total <= 0)
        return values.map(() => 0);
    const rawColumns = values.map(value => (value / total) * columns);
    const allocatedColumns = rawColumns.map(Math.floor);
    let remaining = columns - allocatedColumns.reduce((sum, value) => sum + value, 0);
    const largestRemainders = rawColumns
        .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
        .sort((left, right) => right.remainder - left.remainder);
    for (const slot of largestRemainders) {
        if (remaining <= 0)
            break;
        allocatedColumns[slot.index] = (allocatedColumns[slot.index] ?? 0) + 1;
        remaining--;
    }
    return allocatedColumns;
}
/** Give every visible used segment at least one column before sharing the rest. */
function allocateBarColumns(values, width) {
    const visibleUsedSegments = USED_SEGMENTS
        .map((_, index) => index)
        .filter(index => (values[index] ?? 0) > 0);
    if (visibleUsedSegments.length === 0 || visibleUsedSegments.length >= width) {
        return allocateProportionally(values, width);
    }
    const minimumColumns = Array.from({ length: values.length }, () => 0);
    for (const index of visibleUsedSegments) {
        minimumColumns[index] = 1;
    }
    const remainingColumns = allocateProportionally(values, width - visibleUsedSegments.length);
    return minimumColumns.map((minimum, index) => minimum + (remainingColumns[index] ?? 0));
}
/**
 * The segmented context bar: used segments by content type, the remainder as
 * a light free segment whose right edge carries the usage readout
 * (`ctx 12.3k/1.0M 1.2% 988.9k`, shrinking as width allows).
 * @param segments - Used tokens per content type.
 * @param usedTokens - Total used tokens, driving the usage readout.
 * @param contextWindow - The context window size in tokens.
 * @param width - Total bar width in terminal columns.
 * @returns The ANSI-styled segmented bar, or '' when `width` or `contextWindow` is non-positive.
 */
export function renderContextBar(segments, usedTokens, contextWindow, width, colors) {
    if (width <= 0 || contextWindow <= 0)
        return '';
    const freeTokens = Math.max(0, contextWindow - usedTokens);
    const values = [...USED_SEGMENTS.map(segment => segments[segment.key]), freeTokens];
    const columns = allocateBarColumns(values, width);
    const used = USED_SEGMENTS.map((segment, index) => renderUsedSegment(segment.labels, segment.color, columns[index] ?? 0)).join('');
    const freeWidth = columns[USED_SEGMENTS.length] ?? 0;
    const percent = `${((usedTokens / contextWindow) * 100).toFixed(1)}%`;
    const total = `${formatTokens(usedTokens)}/${formatTokens(contextWindow)}`;
    const free = formatTokens(contextWindow - usedTokens);
    return `${used}${renderFreeSegment([`ctx ${total} ${percent} ${free}`, `${total} ${percent} ${free}`, `${total} ${percent}`, percent], freeWidth, colors?.freeFill ?? FREE_SEGMENT_FILL, colors?.freeText ?? FREE_SEGMENT_TEXT)}`;
}
// --- TPS gauge + sparkline (pi-tps-meter) ---
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const HBLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const GAUGE_LEN = 11;
const GAUGE_FLOOR = 40;
const TRACK = '·';
const FAST = 50;
const MED = 20;
/** Speed color: green ≥ 50, yellow ≥ 20, red below (pi-tps-meter).
 * @param tps - Tokens per second; selects the color threshold.
 * @param text - Text to color.
 * @returns The ANSI 24-bit color-wrapped text.
 */
export function speedColor(tps, text) {
    const color = tps >= FAST ? 'success' : tps >= MED ? 'warning' : 'error';
    return `\x1b[38;2;${colorHex(color)}m${text}\x1b[39m`;
}
function colorHex(key) {
    // dsh-tui dark theme values (theme.ts), semicolon-separated for raw ANSI.
    const palette = {
        success: '78;186;101',
        warning: '202;138;4',
        error: '255;107;128',
    };
    return palette[key] ?? '255;255;255';
}
/** Live 1/8-cell horizontal gauge: `▕███████▋···▏`.
 * @param tps - Current tokens per second.
 * @param peak - Scaling peak; values below 40 scale against the floor instead.
 * @returns The ANSI gauge string.
 */
export function renderTpsGauge(tps, peak) {
    const scale = Math.max(peak, GAUGE_FLOOR);
    const frac = Math.min(1, Math.max(0, scale > 0 ? tps / scale : 0));
    const eighths = Math.round(frac * GAUGE_LEN * 8);
    const full = Math.floor(eighths / 8);
    const rem = eighths % 8;
    let fill = '█'.repeat(full);
    if (full < GAUGE_LEN && rem > 0) {
        fill += HBLOCKS[rem];
    }
    const track = TRACK.repeat(Math.max(0, GAUGE_LEN - fill.length));
    return `▕${speedColor(tps, fill)}${`\x1b[2m${track}\x1b[22m`}▏`;
}
/** Min-max normalized 12-sample sparkline: `▁▄▇▅▂▁▇█▅▃▆▇`.
 * @param samples - Turn TPS samples; only the last 12 are rendered.
 * @returns The ANSI sparkline string.
 */
export function renderTpsSparkline(samples) {
    const vals = samples.slice(-12);
    if (vals.length === 0)
        return '\x1b[2m' + TRACK.repeat(12) + '\x1b[22m';
    let min = Infinity;
    let max = 0;
    for (const { tps } of vals) {
        if (tps < min)
            min = tps;
        if (tps > max)
            max = tps;
    }
    const range = max - min;
    return vals
        .map(({ tps }) => {
        const norm = range < 1e-6
            ? max > 0
                ? 4
                : 0
            : Math.min(7, Math.max(0, Math.round(((tps - min) / range) * 7)));
        return speedColor(tps, BLOCKS[norm] ?? '▁');
    })
        .join('');
}
/** Rolling stats: 60s average, all-time mean and p95.
 * @param samples - Turn TPS samples with their timestamps in milliseconds.
 * @param nowMs - Current time in milliseconds; the 60s rolling window keeps samples with `nowMs - at <= 60_000`.
 * @returns The 60s average, all-time mean, and all-time p95 (all zero for an empty sample list).
 */
export function tpsStats(samples, nowMs) {
    if (samples.length === 0)
        return { avg: 0, mean: 0, p95: 0 };
    const window = samples.filter(sample => nowMs - sample.at <= 60_000);
    const avg = window.length > 0
        ? window.reduce((sum, sample) => sum + sample.tps, 0) / window.length
        : 0;
    const mean = samples.reduce((sum, sample) => sum + sample.tps, 0) / samples.length;
    const sorted = [...samples].map(sample => sample.tps).sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    return { avg, mean, p95 };
}

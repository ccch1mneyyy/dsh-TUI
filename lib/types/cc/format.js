/**
 * Token/byte display formatters, ported from the leaked Claude Code source
 * (src/utils/format.ts) minus the app-level formatter registry.
 */
function numberFormatter(compact) {
    return new Intl.NumberFormat('en', {
        notation: compact ? 'compact' : 'standard',
        maximumFractionDigits: 1,
    });
}
export function formatNumber(number) {
    const compact = number >= 1000;
    return numberFormatter(compact).format(number).toLowerCase();
}
export function formatTokens(count) {
    return formatNumber(count).replace('.0', '');
}
/** Compact duration like `12s`, `3m 4s`, `1h 2m` (ported from the leak). */
export function formatDuration(durationMs, options = {}) {
    const { mostSignificantOnly = false } = options;
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0) {
        parts.push(`${hours}h`);
        if (mostSignificantOnly)
            return parts.join(' ');
    }
    if (minutes > 0) {
        parts.push(`${minutes}m`);
        if (mostSignificantOnly && hours === 0)
            return parts.join(' ');
    }
    if (seconds > 0 || parts.length === 0) {
        parts.push(`${seconds}s`);
    }
    return parts.join(' ');
}
//# sourceMappingURL=format.js.map
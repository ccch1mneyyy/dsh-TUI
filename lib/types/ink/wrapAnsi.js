import wrapAnsiNpm from 'wrap-ansi';
const wrapAnsiBun = typeof Bun !== 'undefined' && typeof Bun.wrapAnsi === 'function'
    ? Bun.wrapAnsi
    : null;
const wrapAnsi = wrapAnsiBun ?? wrapAnsiNpm;
export { wrapAnsi };
//# sourceMappingURL=wrapAnsi.js.map
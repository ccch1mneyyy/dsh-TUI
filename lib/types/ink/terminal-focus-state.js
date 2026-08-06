let focusState = 'unknown';
const resolvers = new Set();
const subscribers = new Set();
export function setTerminalFocused(v) {
    focusState = v ? 'focused' : 'blurred';
    // Notify useSyncExternalStore subscribers
    for (const cb of subscribers) {
        cb();
    }
    if (!v) {
        for (const resolve of resolvers) {
            resolve();
        }
        resolvers.clear();
    }
}
export function getTerminalFocused() {
    return focusState !== 'blurred';
}
export function getTerminalFocusState() {
    return focusState;
}
// For useSyncExternalStore
export function subscribeTerminalFocus(cb) {
    subscribers.add(cb);
    return () => {
        subscribers.delete(cb);
    };
}
export function resetTerminalFocusState() {
    focusState = 'unknown';
    for (const cb of subscribers) {
        cb();
    }
}
//# sourceMappingURL=terminal-focus-state.js.map
/**
 * The ported Ink core calls this once stdin handoff completes
 * (ink/components/App.tsx). Early-input capture is not used by cc-tui, so this
 * is a no-op.
 */
export declare function stopCapturingEarlyInput(): void;

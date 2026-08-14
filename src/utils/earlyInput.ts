/**
 * The ported Ink core calls this once stdin handoff completes
 * (ink/components/App.tsx). Early-input capture is not used by dsh-tui, so this
 * is a no-op.
 */
export function stopCapturingEarlyInput(): void {}

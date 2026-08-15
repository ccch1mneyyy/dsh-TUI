import { isEnvTruthy } from './envUtils.js';
/**
 * Whether mouse click handling is disabled for the ported Ink core. dsh-tui
 * reads its own env flag (`DSH_TUI_DISABLE_MOUSE`); the original module
 * consulted Claude Code's fullscreen state.
 * @returns True when DSH_TUI_DISABLE_MOUSE is set to a truthy value.
 */
export function isMouseClicksDisabled() {
    return isEnvTruthy(process.env.DSH_TUI_DISABLE_MOUSE);
}

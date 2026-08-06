import { isEnvTruthy } from './envUtils.js';
/**
 * Whether mouse click handling is disabled for the ported Ink core. cc-tui
 * reads its own env flag (`CC_TUI_DISABLE_MOUSE`); the original module
 * consulted Claude Code's fullscreen state.
 */
export function isMouseClicksDisabled() {
    return isEnvTruthy(process.env.CC_TUI_DISABLE_MOUSE);
}
//# sourceMappingURL=fullscreen.js.map
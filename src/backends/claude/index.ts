/** The Claude Agent backend (the only directory that may import `@anthropic-ai/*`). */
export { claudeBackend } from './backend.js'
export { CLAUDE_BACKEND_ID, CLAUDE_BACKEND_LABEL, VALIDATED_CLI_VERSIONS, VALIDATED_SDK_VERSION, claudeResumeCommand } from './contract.js'
export { fileClaudePrefs } from './prefs.js'

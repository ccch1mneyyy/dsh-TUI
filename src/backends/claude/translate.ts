/** Translate Claude SDK messages and expose replay helpers without changing import paths. */
export { createClaudeTranslator } from './translate/core.js'
export type { ClaudeTranslator } from './translate/core.js'
export type { ClaudeActivityState, ClaudeTaskSeed, ClaudeTranslatorOptions, ClaudeUserRows } from './translate/types.js'
export { COMMAND_TAG, INTERRUPT_ECHO, LOCAL_COMMAND_TAG, userText } from './translate/content.js'
export { backgroundOutputPath } from './translate/lanes.js'
export { formatDuration } from './translate/system.js'
export { claudeEmits } from './translate/events.js'

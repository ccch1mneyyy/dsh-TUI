/**
 * Prompt-content sanitization shared by migrated TUI rows.
 *
 * Tool-analysis XML blocks carry no user-facing content and are removed before
 * markdown or plain-text rendering.
 */

/** Tool-analysis tag blocks that carry no user-facing content. */
const TOOL_ANALYSIS_TAG_BLOCKS =
  /<(commit_analysis|context|function_analysis|pr_analysis)>.*?<\/\1>\n?/gs

/**
 * Strip tool-analysis XML blocks and their contents, then trim the result.
 */
export function stripPromptXMLTags(content: string): string {
  return content.replace(TOOL_ANALYSIS_TAG_BLOCKS, '').trim()
}

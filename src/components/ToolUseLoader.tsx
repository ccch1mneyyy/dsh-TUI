import React from 'react'
import Box from '../ink/components/Box.js'
import { Text } from '../ui.js'
import { useBlink } from '../hooks/useBlink.js'
import { BLACK_CIRCLE, BULLET, MULTIPLICATION_X } from '../cc/figures.js'
import type { Theme } from '../theme.js'

type Props = {
  isError: boolean
  isUnresolved: boolean
  shouldAnimate: boolean
  /** Raw tool id (bash/read/edit/…) — picks the category color for a settled dot. */
  toolName?: string
}

type ToolCategory = 'exec' | 'read' | 'write' | 'web' | 'task' | 'default'

const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
  bash: 'exec',
  powershell: 'exec',
  pwsh: 'exec',
  read: 'read',
  grep: 'read',
  glob: 'read',
  search: 'read',
  file_search: 'read',
  edit: 'write',
  write: 'write',
  str_replace_editor: 'write',
  multiedit: 'write',
  web_search: 'web',
  web_fetch: 'web',
  browser: 'web',
  subagent: 'task',
  task: 'task',
  job: 'task',
  workflow: 'task',
}

const CATEGORY_TOKEN: Record<ToolCategory, keyof Theme> = {
  exec: 'toolDotExec',
  read: 'toolDotRead',
  write: 'toolDotWrite',
  web: 'toolDotWeb',
  task: 'toolDotTask',
  default: 'success',
}

/**
 * The status dot on tool-call rows. State shapes the glyph, the tool
 * category picks the settled color: blinking `●` while running (attention),
 * a smaller category-colored `•` once settled (quiet), and a red `✗` on
 * error — a glyph swap, not just a hue, so failures read at a glance
 * (Codex-style category colors; every color is a theme token).
 */
export function ToolUseLoader({
  isError,
  isUnresolved,
  shouldAnimate,
  toolName,
}: Props): React.ReactNode {
  const [ref, isBlinking] = useBlink(shouldAnimate)
  if (isError) {
    return (
      <Box ref={ref} minWidth={2}>
        <Text color="error">{MULTIPLICATION_X}</Text>
      </Box>
    )
  }
  const category = CATEGORY_BY_TOOL[toolName ?? ''] ?? 'default'
  const color = isUnresolved ? undefined : CATEGORY_TOKEN[category]
  const char = shouldAnimate ? (isBlinking ? BLACK_CIRCLE : ' ') : BULLET

  return (
    <Box ref={ref} minWidth={2}>
      <Text color={color} dimColor={isUnresolved}>
        {char}
      </Text>
    </Box>
  )
}

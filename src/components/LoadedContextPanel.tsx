import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import type { LoadedContext, LoadedContextEntry } from '../dsh-adapter/channel.js'
import { summarizeLoadedContext, truncateContextText } from '../utils/loaded-context.js'

/** One named entry (section or dynamic context) with its full text. */
function Entry({ entry }: { entry: LoadedContextEntry }): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold dimColor>
        {entry.name}
      </Text>
      <Text dimColor wrap="wrap">
        {truncateContextText(entry.text)}
      </Text>
    </Box>
  )
}

/** A titled group of rows inside the expanded panel. */
function Group({ title, children }: { title: string; children: React.ReactNode }): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="subtle">
        {title}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {children}
      </Box>
    </Box>
  )
}

/**
 * The startup context panel: a collapsed one-line summary of what a
 * fresh conversation will load for the current agent (system prompt
 * sections, workspace instruction files, dynamic context, skill catalog,
 * tools), expandable to the grouped details with Ctrl+P. The `/context`
 * local command still prints the same details as a transcript report.
 * The panel renders only while the transcript is still empty — the first
 * message's rows take over. Renders nothing for an empty snapshot.
 * @param context - the channel's loaded-context snapshot.
 * @param open - whether the grouped details are shown.
 * @param onToggle - flips `open`; fired by the Ctrl+P keybinding.
 */
export function LoadedContextPanel({
  context,
  open,
  onToggle,
}: {
  context: LoadedContext
  open: boolean
  onToggle: () => void
}): React.ReactNode {
  const summary = summarizeLoadedContext(context)
  if (summary === '') return null
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box paddingX={1} backgroundColor={open ? 'userMessageBackground' : undefined}>
        <Text bold={open} wrap="truncate">
          {open ? '▼' : '▶'} <Text dimColor>（Ctrl+P{open ? t('context-panel-collapse') : t('context-panel-expand')}）</Text> {t('context-loaded')} · {summary}
        </Text>
      </Box>
      {open && (
        <Box flexDirection="column" paddingX={1} paddingTop={1}>
          {context.sections.length > 0 && (
            <Group title={t('context-panel-sections', { n: context.sections.length })}>
              {context.sections.map(section => (
                <Entry key={section.name} entry={section} />
              ))}
            </Group>
          )}
          {context.files.length > 0 && (
            <Group title={t('context-panel-files', { n: context.files.length })}>
              {context.files.map(file => (
                <Text key={file.displayPath} dimColor>
                  {file.displayPath}
                </Text>
              ))}
            </Group>
          )}
          {context.contexts.length > 0 && (
            <Group title={t('context-panel-runtime', { n: context.contexts.length })}>
              {context.contexts.map(entry => (
                <Entry key={entry.name} entry={entry} />
              ))}
            </Group>
          )}
          {context.skills.length > 0 && (
            <Group title={t('context-panel-skills', { n: context.skills.length })}>
              {context.skills.map(skill => (
                <Box key={skill.name} flexDirection="column">
                  <Text bold dimColor>
                    {skill.name}
                  </Text>
                  <Text dimColor wrap="wrap">
                    {skill.description}
                  </Text>
                </Box>
              ))}
            </Group>
          )}
          {context.tools.length > 0 && (
            <Group title={t('context-panel-tools', { n: context.tools.length })}>
              {context.tools.map(tool => (
                <Box key={tool.name} flexDirection="column">
                  <Text bold dimColor>
                    {tool.name}
                  </Text>
                  <Text dimColor wrap="wrap">
                    {truncateContextText(tool.description, 160)}
                  </Text>
                </Box>
              ))}
            </Group>
          )}
          <Text dimColor>· /context</Text>
        </Box>
      )}
    </Box>
  )
}

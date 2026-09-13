import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import type { SkillInfo } from '../dsh-adapter/channel.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { LoadingState } from './design-system/LoadingState.js'
import { listWindow } from './listWindow.js'
import { useOverlayListRows } from './OverlayAbove.js'

/** 来源桶 → 本地化标签（未知桶原样显示，SkillSource 对自定义桶开放）。 */
function sourceLabel(source: string): string {
  switch (source) {
    case 'bundled':
      return t('skills-source-bundled')
    case 'user-dsh':
    case 'user-agents':
      return t('skills-source-user')
    case 'project-dsh':
    case 'project-agents':
      return t('skills-source-project')
    case 'runtime':
      return t('skills-source-runtime')
    case 'custom':
      return t('skills-source-custom')
    default:
      return source
  }
}

/**
 * `/skills` picker (issue #204) in the ModelPicker style: a
 * permission-colored Pane listing the live agent's skill catalog —
 * user-invocable skills lead with `/name`（它们在 / 菜单里也是这个形态），
 * 描述行是「来源 · 简述」。Enter 由 Chat 填回 `/name `，Esc 关闭。
 *
 * 长列表按焦点窗口化（ModelPicker 同款）：picker 经 OverlayAbove 浮层挂载后
 * 有 maxHeight 裁剪，全量渲染会让焦点行被裁掉（看不到焦点按 Enter）。
 */
export function SkillsPicker({
  skills,
  focusIndex,
  onPick,
}: {
  skills: readonly SkillInfo[]
  focusIndex: number
  /** Mouse pick (fullscreen): clicked row's absolute index (Chat applies
   *  the same code path as the keyboard Enter). */
  onPick?: (index: number) => void
}): React.ReactNode {
  // 每项恒占 2 行（正文 + 来源/简述描述行，均 truncate 成单行）。
  // 预算来自最近一层 OverlayAbove 的有效高度（ModelPicker 同款），减去框架行：
  // Pane 2 + 标题 2 + 页脚 1 + 挂载包裹 marginTop 1 = 6。
  const listRows = useOverlayListRows(6)
  const { start, end } = listWindow(
    skills.map(() => 2),
    focusIndex,
    listRows,
  )
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('picker-title-skills')}
          </Text>
        </Box>
        {skills.length === 0 ? (
          <Text dimColor>{t('skills-empty')}</Text>
        ) : (
          skills.slice(start, end).map((skill, index) => {
            const absoluteIndex = start + index
            return (
              <ListItem
                key={skill.name}
                isFocused={absoluteIndex === focusIndex}
                description={`${sourceLabel(skill.source)}${skill.description === '' ? '' : ` · ${skill.description}`}`}
                showScrollUp={absoluteIndex === start && start > 0}
                showScrollDown={absoluteIndex === end - 1 && end < skills.length}
                onClick={onPick ? () => onPick(absoluteIndex) : undefined}
              >
                {skill.userInvocable ? `/${skill.name}` : skill.name}
              </ListItem>
            )
          })
        )}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-fill-exit')} />
      </Text>
    </Pane>
  )
}

/** `/skills` while the registry snapshot is still in flight (ModelPickerLoading 同款). */
export function SkillsPickerLoading(): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1}>
        <Text bold color="permission">
          {t('picker-title-skills')}
        </Text>
        <LoadingState
          message={t('skills-loading')}
          bold
          subtitle={t('skills-loading-subtitle')}
        />
      </Box>
    </Pane>
  )
}

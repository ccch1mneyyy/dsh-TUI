import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { kernelSubtitle, type KernelOption } from './kernelCatalog.js'

/**
 * 内核选择器（launchpad 的「内核」入口、/kernel 与右下角内核区三条入口共用
 * 同一个浮层）——一行一个内核：名字 + 副标题（版本 / 置灰原因），当前内核打
 * 勾，不可选的置灰。
 *
 * 视觉照 ModePicker（Pane color=permission + 标题 + 行列表 + Enter/Esc 提示行，
 * 第五版那套 picker 的统一姿态）；键盘归宿主（Chat 的 overlay 分支）：↑/↓ 移
 * 焦点、Enter 走确认路径、Esc 关掉，本组件不碰 useInput。
 *
 * 行是 ListItem，但 **styled=false**：文本样式由这里自己画。原因是不可选行
 * 必须变暗，而 ListItem 的 disabled 会把 ❯ 焦点指针一起吞掉（renderIndicator
 * 在 disabled 时只画一格空格）——那样键盘走上来就看不见自己在哪一行了。
 * 于是禁用态用 dimColor 表达、指针留给 isFocused，两者互不干扰。
 *
 * 鼠标契约照仓库规矩：给了 onPick 行才可点（ListItem 的 hover 底色随之出现），
 * 点击回的是**行号**——宿主把它喂给与键盘 Enter 完全相同的那条确认路径。
 */
export function KernelPicker({ options, focusIndex, pinned, onPick }: {
  options: readonly KernelOption[]
  focusIndex: number
  /** 启动参数锁定了内核：多画一行提示 */
  pinned?: boolean
  /** 鼠标点行（落到 Chat 同一条确认路径） */
  onPick?: (index: number) => void
}): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('kernel-picker-title')}
          </Text>
        </Box>
        {options.map((option, index) => {
          const focused = index === focusIndex
          const subtitle = kernelSubtitle(option, key => t(key))
          return (
            <ListItem
              key={option.id}
              isFocused={focused}
              isSelected={option.current}
              description={subtitle}
              styled={false}
              onClick={onPick === undefined ? undefined : () => onPick(index)}
            >
              <Text
                // 不可选 = 变暗（**始终**变暗，焦点落上来也只是多一个 ❯ 指针，
                // 不把「这一行选不了」这件事照亮成可选的假象）。
                dimColor={!option.selectable}
                color={option.current ? 'success' : focused && option.selectable ? 'suggestion' : undefined}
                bold={focused && option.selectable}
                wrap="truncate-end"
              >
                {t(option.labelKey as never)}
              </Text>
            </ListItem>
          )
        })}
        {pinned === true && (
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate">
              {t('kernel-pinned-hint')}
            </Text>
          </Box>
        )}
        <Text dimColor italic>
          <HintLine text={t('hint-confirm-exit')} />
        </Text>
      </Box>
    </Pane>
  )
}

/**
 * The questionnaire panel — Claude Code style ask-user-question UI for the
 * DSH user-interaction seam. One question per panel (progress header, header
 * chip, wrapped question text, optional detail, option list with focus
 * pointer and multi-select checkmarks, free-text "Other" mode), styled in
 * the cc-tui mist-blue design language.
 */

import React from 'react'
import { Box, Text, useInput } from '../../ui.js'
import { Divider } from '../design-system/Divider.js'
import { POINTER } from '../../cc/figures.js'
import type { QuestionSelection } from '../../questions.js'

const CHECKED = '◉'
const UNCHECKED = '○'
const PENCIL = '✎'

export type AskUserQuestionPanelProps = {
  /** The question to render (from the QuestionStore snapshot). */
  readonly question: {
    readonly question: string
    readonly header?: string
    readonly detail?: string
    readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
    readonly multiSelect?: boolean
  }
  /** 1-based position within the batch (progress header). */
  readonly position: number
  /** Total questions in the batch (progress header). */
  readonly total: number
  /** Questions answered before the current one. */
  readonly answered: number
  readonly onAnswer: (selection: QuestionSelection) => void
  /** Esc / Ctrl+C — aborts the whole ask (ASK_ABORTED back to the model). */
  readonly onCancel: () => void
}

export function AskUserQuestionPanel({
  question,
  position,
  total,
  answered,
  onAnswer,
  onCancel,
}: AskUserQuestionPanelProps): React.ReactNode {
  const options = question.options ?? []
  const multiSelect = question.multiSelect === true
  const [focusIndex, setFocusIndex] = React.useState(0)
  const [checked, setChecked] = React.useState<ReadonlySet<number>>(() => new Set())
  const [mode, setMode] = React.useState<'options' | 'custom'>(options.length > 0 ? 'options' : 'custom')
  const [customText, setCustomText] = React.useState('')
  const [customCursor, setCustomCursor] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)

  const moveFocus = (delta: 1 | -1): void => {
    if (options.length <= 1) return
    setFocusIndex(index => (index + delta + options.length) % options.length)
  }

  const submitOptions = (): void => {
    if (multiSelect) {
      const selected = [...checked].sort((a, b) => a - b).map(index => options[index]?.label)
        .filter((label): label is string => label !== undefined)
      if (selected.length === 0) {
        setError('至少选择一个选项，或按 Tab 输入自定义回答')
        return
      }
      onAnswer({ selected })
      return
    }
    const label = options[focusIndex]?.label
    if (label === undefined) {
      setError('至少选择一个选项，或按 Tab 输入自定义回答')
      return
    }
    onAnswer({ selected: [label] })
  }

  const submitCustom = (): void => {
    const custom = customText.trim()
    if (custom === '') {
      setError('先输入回答内容再提交')
      return
    }
    const selected = multiSelect
      ? [...checked].sort((a, b) => a - b).map(index => options[index]?.label)
          .filter((label): label is string => label !== undefined)
      : []
    onAnswer({ selected, custom })
  }

  useInput((input, key) => {
    if (mode === 'custom') {
      if (key.escape) {
        if (options.length > 0) {
          setMode('options')
          setError(null)
        } else {
          onCancel()
        }
        return
      }
      if (key.ctrl && input === 'c') {
        onCancel()
        return
      }
      if (key.return) {
        submitCustom()
        return
      }
      if (key.backspace) {
        if (customCursor > 0) {
          setCustomText(text => text.slice(0, customCursor - 1) + text.slice(customCursor))
          setCustomCursor(cursor => cursor - 1)
        }
        return
      }
      if (key.delete) {
        if (customCursor < customText.length) {
          setCustomText(text => text.slice(0, customCursor) + text.slice(customCursor + 1))
        }
        return
      }
      if (key.leftArrow) {
        setCustomCursor(cursor => Math.max(0, cursor - 1))
        return
      }
      if (key.rightArrow) {
        setCustomCursor(cursor => Math.min(customText.length, cursor + 1))
        return
      }
      if (key.home) {
        setCustomCursor(0)
        return
      }
      if (key.end) {
        setCustomCursor(customText.length)
        return
      }
      if (!key.ctrl && !key.meta && input) {
        setCustomText(text => text.slice(0, customCursor) + input + text.slice(customCursor))
        setCustomCursor(cursor => cursor + input.length)
      }
      return
    }

    // Options mode.
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (key.upArrow) {
      moveFocus(-1)
      return
    }
    if (key.downArrow) {
      moveFocus(1)
      return
    }
    if (key.tab) {
      setMode('custom')
      setError(null)
      return
    }
    if (input === ' ' && multiSelect) {
      setChecked(previous => {
        const next = new Set(previous)
        if (next.has(focusIndex)) next.delete(focusIndex)
        else next.add(focusIndex)
        return next
      })
      return
    }
    if (key.return) {
      submitOptions()
    }
  }, { isActive: true })

  const remaining = total - answered
  const headerTitle = ` 📋 提问 · 第 ${position}/${total} 题${remaining > 1 ? ` · 还剩 ${remaining} 题` : ''} `

  const renderOptions = (): React.ReactNode => (
    <Box flexDirection="column" marginTop={1}>
      {options.map((option, index) => {
        const focused = index === focusIndex
        const selected = multiSelect ? checked.has(index) : focused
        return (
          <Box key={option.label} flexDirection="row" marginTop={focused ? 1 : 0}>
            <Box width={1} flexShrink={0}>
              <Text color={focused ? 'claude' : undefined} bold={focused}>
                {focused ? POINTER : ' '}
              </Text>
            </Box>
            <Box width={1} flexShrink={0}>
              <Text color={focused ? 'claude' : undefined} bold={selected}>
                {selected ? (multiSelect ? CHECKED : '●') : UNCHECKED}
              </Text>
            </Box>
            <Box flexDirection="column" marginLeft={1}>
              <Text bold={focused || selected} color={focused ? 'claude' : undefined} wrap="wrap">
                {option.label}
              </Text>
              {option.description !== undefined && (
                <Text dimColor wrap="wrap">
                  {option.description}
                </Text>
              )}
            </Box>
          </Box>
        )
      })}
    </Box>
  )

  const renderCustom = (): React.ReactNode => {
    const cursorChar = customCursor < customText.length ? customText[customCursor] : ' '
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color="suggestion" bold>
            {PENCIL}{' '}
          </Text>
          <Text color="claude" bold>
            自定义回答
          </Text>
        </Box>
        <Box flexDirection="row" marginTop={1}>
          <Text wrap="wrap">
            {customText.slice(0, customCursor)}
          </Text>
          <Text inverse>{cursorChar}</Text>
          <Text wrap="wrap">
            {customText.slice(customCursor + 1)}
          </Text>
        </Box>
      </Box>
    )
  }

  const hintParts = mode === 'custom'
    ? [
        'Enter 提交',
        ...(options.length > 0 ? ['Esc 返回选项'] : ['Esc 取消']),
        ...(multiSelect && checked.size > 0 ? [`已选 ${checked.size}`] : []),
      ]
    : [
        '↑/↓ 选择',
        ...(multiSelect ? ['Space 多选'] : []),
        ...(options.length > 0 ? ['Tab 自定义'] : []),
        'Enter 提交',
        'Esc 中断',
        ...(multiSelect && checked.size > 0 ? [`已选 ${checked.size}`] : []),
      ]

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} width="100%">
      <Divider color="permission" title={headerTitle} />
      <Box flexDirection="column" marginTop={1}>
        {question.header !== undefined && (
          <Text color="suggestion" bold>
            ◈ {question.header}
          </Text>
        )}
        <Text bold wrap="wrap">
          {question.question}
        </Text>
        {question.detail !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            {question.detail.split('\n').map((line, index) => (
              <Text key={index} dimColor italic wrap="wrap">
                {line}
              </Text>
            ))}
          </Box>
        )}
      </Box>
      {mode === 'custom' ? renderCustom() : renderOptions()}
      {error !== null && (
        <Box marginTop={1}>
          <Text color="error">{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>{hintParts.join(' · ')}</Text>
      </Box>
    </Box>
  )
}

/**
 * CompanionPanel（设计分文档 §4 + v2.1）：会话投影 → resolveCompanionMood
 * （纯函数）→ planPose（whaleIdle 薄包装）→ 皮肤。默认皮肤 deepy
 * （assets/deepy 素材包），whale 皮肤与开屏 splash 同一规划器同一帧表。
 *
 * v2.1 要点：
 * - attention 只来自已有可靠投影（context 注入的审批/问卷快照 +
 *   PanelStore 的 jobs 失败未读 badge）；不造新业务状态。
 * - 时钟修正：!visible ? null : sleeping ? 1000 : 120——visible=false
 *   时零订阅（评审 §十的 bug 修正版）。
 * - 交互：点击 → 爱心 pass（whaleIdle 现有语义）；Enter（焦点在右栏）
 *   → poke：气泡显示完整 activity.line 3 秒。
 * - 宽度不足皮肤 cells.columns + 2 时切 compact 形态：心情图标 +
 *   气泡 + 统计行，不画皮肤（永不超宽，§16.6）。
 */
import React from 'react'
import { Box, Text, useAnimationFrame } from '../../../ui.js'
import { t, type I18nKey } from '../../../i18n.js'
import { panelStore } from '../PanelStore.js'
import { getCompanionSkin, subscribeCompanionSkin } from '../../../tuiDisplayPrefs.js'
import { useSidePanelChannel, SidePanelRuntimeContext } from '../SidePanelRuntimeContext.js'
import { usePanelInput } from '../usePanelInput.js'
import type { PanelProps } from '../types.js'
import {
  initialCompanionMoodState,
  stepCompanionMood,
  type CompanionMood,
  type CompanionMoodState,
} from './mood.js'
import { initialCompanionPoseState, nextCompanionPoseStep } from './pose.js'
import { DeepySkin, resolveCompanionSkin } from './skins.js'

/** 入睡延迟：Panel 常驻，沿用分文档的 60s（开屏 splash 保持 10s）。 */
const SLEEP_AFTER_MS = 60_000
/** 回合完成后的庆祝窗口。 */
const CELEBRATE_MS = 2_500
/** poke 显示完整活动行的时长。 */
const POKE_MS = 3_000

const MOOD_LABEL_KEY: Readonly<Record<CompanionMood, I18nKey>> = {
  sleeping: 'companion-mood-sleeping',
  idle: 'companion-mood-idle',
  waiting: 'companion-mood-waiting',
  thinking: 'companion-mood-thinking',
  working: 'companion-mood-working',
  responding: 'companion-mood-responding',
  attention: 'companion-mood-attention',
  celebrate: 'companion-mood-celebrate',
  error: 'companion-mood-error',
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return seconds + 's'
  return Math.floor(seconds / 60) + 'm' + (seconds % 60) + 's'
}

export function CompanionPanel({ width, focused, visible }: PanelProps): React.ReactNode {
  const channel = useSidePanelChannel()
  const runtimeCtx = React.useContext(SidePanelRuntimeContext)
  const activity = runtimeCtx?.activity
  const attentionCtx = runtimeCtx?.attention
  const jobsBadge = React.useSyncExternalStore(panelStore.subscribe, () => panelStore.get('jobs')?.badge ?? null)
  const jobsFailedUnread = jobsBadge !== null && jobsBadge.level === 'error' ? jobsBadge.unread : 0

  // 活动 = 任何会话动静 + 面板交互；睡眠由这个时钟驱动（60s 无活动）。
  const lastInputAtRef = React.useRef(Date.now())
  const version = channel.version
  React.useEffect(() => {
    lastInputAtRef.current = Date.now()
  }, [version])

  // 回合完成（working true→false）触发短暂庆祝。
  const [celebrateUntil, setCelebrateUntil] = React.useState(0)
  const prevWorkingRef = React.useRef(channel.working)
  React.useEffect(() => {
    const was = prevWorkingRef.current
    prevWorkingRef.current = channel.working
    if (was && !channel.working) setCelebrateUntil(Date.now() + CELEBRATE_MS)
  }, [channel.working])

  const [pokeUntil, setPokeUntil] = React.useState(0)
  const heartPendingRef = React.useRef(false)

  const now = Date.now()
  const moodInputs = {
    working: channel.working,
    spinnerMode: channel.spinnerMode,
    activity,
    attention: {
      approvalPending: (attentionCtx?.approvals ?? 0) > 0,
      questionPending: (attentionCtx?.questions ?? 0) > 0,
      failedJobsUnread: jobsFailedUnread,
    },
    lastInputAt: lastInputAtRef.current,
    celebration: celebrateUntil > now ? { kind: 'turn-done' as const, until: celebrateUntil } : undefined,
    sleepAfterMs: SLEEP_AFTER_MS,
  }
  const moodRef = React.useRef<CompanionMoodState>(initialCompanionMoodState)
  moodRef.current = stepCompanionMood(moodRef.current, moodInputs, now)
  const moodState = moodRef.current

  // 时钟（v2.1 修正顺序）：visible=false 零订阅；睡眠降频 1s；其余 120ms。
  const [clockRef] = useAnimationFrame(!visible ? null : moodState.mood === 'sleeping' ? 1000 : 120)

  const poseRef = React.useRef(initialCompanionPoseState(now))
  const poseStep = nextCompanionPoseStep(
    poseRef.current,
    { mood: moodState.mood, heart: heartPendingRef.current },
    now,
  )
  poseRef.current = poseStep.state
  heartPendingRef.current = false
  const pose = poseStep.pose

  // Enter（焦点在右栏）→ poke：气泡短暂显示完整 activity.line。
  // 's' → Send to Chat：把当前活动摘要附为下一次提交的上下文（§6.7）。
  usePanelInput((input, key) => {
    if (key.return_ === true || input === '\r') {
      if (activity?.line !== undefined && activity.line !== '') {
        setPokeUntil(Date.now() + POKE_MS)
        lastInputAtRef.current = Date.now()
        return true
      }
    }
    if (input === 's') {
      if (typeof channel.attachContext !== 'function') return false
      const content = [
        `宠物心情：${t(MOOD_LABEL_KEY[moodState.mood])}`,
        activity?.line !== undefined && activity.line !== '' ? `当前活动：${activity.line}` : undefined,
        `统计：${statsText}`,
      ].filter((line): line is string => line !== undefined).join('\n')
      channel.attachContext({ source: 'panel', sourceId: 'companion', title: t('companion-send-title'), content })
      channel.notify(t('panel-sent-to-chat', { title: t('companion-send-title') }), { color: 'success' })
      lastInputAtRef.current = Date.now()
      return true
    }
    return false
  }, { active: focused && visible })

  const skinId = React.useSyncExternalStore(subscribeCompanionSkin, getCompanionSkin)
  const skin = resolveCompanionSkin(skinId)
  const rawBubble = pokeUntil > now && activity?.line !== undefined ? activity.line : moodState.bubble
  // activity.phrase 自带 '⏵ ' 前缀——剥掉再统一加，避免 '⏵ ⏵' 双前缀。
  const bubble = rawBubble?.replace(/^\s*[⏵▸]+\s*/u, '')

  const statsText = (() => {
    if (activity !== undefined && channel.working && activity.phaseStartedAt > 0) {
      const elapsed = formatElapsed(now - activity.phaseStartedAt)
      return activity.toolCount > 0
        ? t('companion-stats-working', { duration: elapsed, count: activity.toolCount })
        : elapsed
    }
    return t(MOOD_LABEL_KEY[moodState.mood])
  })()

  const compact = width < skin.cells.columns + 2
  return (
    <Box ref={clockRef} flexDirection="column" flexGrow={1} overflow="hidden">
      {compact ? (
        // 窄栏 compact：心情图标 + 气泡/统计，不画皮肤。
        <Box flexDirection="column" paddingX={1} paddingTop={1}>
          <Box height={1} flexShrink={0}>
            <Text wrap="truncate-end">
              <Text color="accent">{'♥ '}</Text>
              <Text dimColor>{t(MOOD_LABEL_KEY[moodState.mood])}</Text>
              {channel.working && <Text dimColor>{' · '}{statsText}</Text>}
            </Text>
          </Box>
          {bubble !== undefined && (
            <Box height={1} flexShrink={0}>
              <Text dimColor wrap="truncate-end">{'⏵ '}{bubble}</Text>
            </Box>
          )}
        </Box>
      ) : (
        <>
          <Box
            flexDirection="column"
            flexGrow={1}
            alignItems="center"
            justifyContent="center"
            overflow="hidden"
            onClick={() => {
              heartPendingRef.current = true
              lastInputAtRef.current = Date.now()
            }}
          >
            {skin.render({ pose, moodSince: moodState.since, now, width })}
          </Box>
          <Box flexDirection="column" flexShrink={0} paddingX={1}>
            {bubble !== undefined && (
              <Box height={1} flexShrink={0}>
                <Text dimColor wrap="truncate-end">{'⏵ '}{bubble}</Text>
              </Box>
            )}
            <Box height={1} flexShrink={0}>
              <Text dimColor wrap="truncate-end">{statsText}</Text>
            </Box>
          </Box>
        </>
      )}
    </Box>
  )
}

export const COMPANION_SKIN_DEFAULT = DeepySkin.id

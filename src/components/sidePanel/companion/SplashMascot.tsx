/**
 * 启动页吉祥物（LogoV2 艺术槽，2026-10 复用轮）。
 *
 * 吉祥物跟随 companion.skin：deepy → 字母格动画；whaleGirl → 鲸娘动画
 * （经 WhaleGirlSkin 内部的图像协议自适应：kitty/sixel 走 img/ 帧管线，
 * 无协议回退字母格帧包——首帧字母格同步可画，图像异步解码完成后替换，
 * 绝不让启动帧等 IO）。whale 皮肤不进本组件（LogoV2 维持原分层鲸路径）。
 *
 * 动画/互动语义与侧栏宠物同源（零复制），但按 2026-10 用户拍板收窄：
 * 启动页是瞬时门面——**不做空闲轮换**，稳态恒播单一 idle 动画（循环）；
 * 点击 = poke（左/右半判定，播 poke-left/right 头段；鲸娘在 poke 后接一段
 * smile-hearts 爱心——同面板「亲昵互动」语义，deepy 帧包无爱心键故只 poke）；
 * 连点 = 900ms 内 ≥3 次触发 tickle（复用 mood.ts 的 TICKLE_WINDOW_MS/
 * TICKLE_MIN_CLICKS 判定）；播完自然回稳态 idle。不做拖拽。
 * active=false（第一个任务后冻结，照鲸鱼的 whaleFrozen 契约）或卸载后零
 * 时钟：定格 idle 帧 0，interval 清空。
 *
 * 欢迎语/求星标语不在本组件——按 2026-10 用户拍板保持原「艺术下方居中」
 * 渲染路径（LogoV2 底部块，welcomePad 缩进）。
 */
import React from 'react'
import { Box, Text } from '../../../ui.js'
import type { ClickEvent } from '../../../ink/events/click-event.js'
import { getCompanionSkin, subscribeCompanionSkin } from '../../../tuiDisplayPrefs.js'
import { TICKLE_MIN_CLICKS, TICKLE_WINDOW_MS } from './mood.js'
import { DeepySkin, WhaleGirlSkin, type CompanionSkinRenderInput } from './skins.js'
import { initialCompanionPoseState, nextCompanionPoseStep } from './pose.js'

/** 点击反应档时长：poke 帧表一轮 2100ms，取头段（同 CompanionPanel 的口径）。 */
const SPLASH_POKE_MS = 1400
/** poke 后鲸娘的爱心档时长（smile-hearts 一轮 ~1.9s，取一轮多的头段）。 */
const SPLASH_HEART_MS = 2400
/** 吉祥物动画 tick（同 CompanionPanel 的 TICK_MS）。 */
const SPLASH_TICK_MS = 160
/** 吉祥物字母格宽（与侧栏宠物同包同宽；艺术槽盒 40 列居中容纳）。 */
const SPLASH_MASCOT_COLUMNS = 42

export type SplashMascotSkin = 'deepy' | 'whaleGirl'

/** 读 companion.skin（LogoV2 的测试缝 prop 优先）；非吉祥物皮肤返回
 *  undefined（LogoV2 走原鲸鱼/女仆娘路径，零改动）。 */
export function useSplashMascotSkin(pinned?: string): SplashMascotSkin | undefined {
  const setting = React.useSyncExternalStore(subscribeCompanionSkin, getCompanionSkin)
  const id = pinned ?? setting
  return id === 'deepy' || id === 'whaleGirl' ? id : undefined
}


/** 启动页吉祥物本体：按 skin 渲染动画，点击交互（poke/连点）在内层盒。 */
export function SplashMascot({ skin, active }: {
  readonly skin: SplashMascotSkin
  /** 动画许可：false（冻结/落地页 whaleIdle=false）时定格 idle 帧 0、零时钟。 */
  readonly active: boolean
}): React.ReactNode {
  const [, setBump] = React.useState(0)
  // 稳态 idle 从挂载起循环；冻结时 now 钉在挂载值 → elapsed 恒 0 → 帧 0。
  const mountedAtRef = React.useRef(Date.now())
  const clicksRef = React.useRef<number[]>([])
  // 覆盖档：poke / tickle / poke 后的爱心（鲸娘），到期在渲染期自回收并
  // 链到下一档（poke → smile-hearts），全部播完自然回稳态 idle。
  const overrideRef = React.useRef<{ readonly semantic: string; readonly since: number; readonly until: number } | undefined>(undefined)
  const heartAfterOverrideRef = React.useRef(false)
  // 姿态是常量：吉祥物的动画全走 animationSemantic（deepy 规范键），
  // 皮肤在 semantic 有效时不读 mood/heart 层——只需一个合法 pose 形状。
  const [pose] = React.useState(() => nextCompanionPoseStep(
    initialCompanionPoseState(Date.now()),
    { mood: 'idle', heart: false },
    Date.now(),
  ).pose)

  React.useEffect(() => {
    if (!active) return
    const id = setInterval(() => { setBump(previous => previous + 1) }, SPLASH_TICK_MS)
    ;(id as { unref?: () => void }).unref?.()
    return () => { clearInterval(id) }
  }, [active])

  const now = active ? Date.now() : mountedAtRef.current
  if (overrideRef.current !== undefined && overrideRef.current.until <= now) {
    const heartNext = heartAfterOverrideRef.current
    overrideRef.current = undefined
    heartAfterOverrideRef.current = false
    if (heartNext) {
      overrideRef.current = { semantic: 'smile-hearts', since: now, until: now + SPLASH_HEART_MS }
    }
  }
  const override = overrideRef.current
  const animationSemantic = override?.semantic ?? 'idle'
  const animSince = override?.since ?? mountedAtRef.current

  const input: CompanionSkinRenderInput = {
    pose,
    moodSince: animSince,
    now,
    width: SPLASH_MASCOT_COLUMNS,
    animationSemantic,
  }
  return (
    <Box flexDirection="column" alignItems="center" flexShrink={0}>
      <Box onClick={(event: ClickEvent) => {
        event.stopImmediatePropagation()
        if (!active) return
        const at = Date.now()
        // 连点判定与面板同源（TICKLE_WINDOW_MS/TICKLE_MIN_CLICKS）：
        // 窗口内 ≥3 次 → tickle；否则按左/右半 poke（鲸娘再链一段爱心）。
        clicksRef.current = [...clicksRef.current.filter(ts => ts > at - TICKLE_WINDOW_MS), at]
        const rapid = clicksRef.current.length >= TICKLE_MIN_CLICKS
        if (rapid) clicksRef.current = []
        overrideRef.current = rapid
          ? { semantic: 'tickle', since: at, until: at + TICKLE_WINDOW_MS }
          : {
              semantic: event.localCol < SPLASH_MASCOT_COLUMNS / 2 ? 'poke-left' : 'poke-right',
              since: at,
              until: at + SPLASH_POKE_MS,
            }
        heartAfterOverrideRef.current = !rapid && skin === 'whaleGirl'
        setBump(previous => previous + 1)
      }}>
        {skin === 'deepy' ? DeepySkin.render(input) : WhaleGirlSkin.render(input)}
      </Box>
    </Box>
  )
}

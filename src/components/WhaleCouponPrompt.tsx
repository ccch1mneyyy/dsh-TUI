import React from 'react'
import { Box, Text, useInput, useTerminalImages, useTerminalSize } from '../ui.js'
import { getLang, subscribeLang, t } from '../i18n.js'
import { Divider } from './design-system/Divider.js'
import { HintLine } from './design-system/HintLine.js'
import { CLAUDE_GIRL_ASSETS, MAID_ASSETS, MaidPortrait, useMaidPortraits } from './maidPortrait.js'
import { getActiveBrand } from '../branding.js'
import { WhaleGirlHappyArt } from './WhaleGirl.js'
import { useTerminalBackground } from './design-system/ThemeProvider.js'
import type { WhaleCouponNotice } from '../dsh-adapter/oauth/bonus.js'

/** Art slot width — the pixel whale fallback is 40 columns wide, and the
 * raster portrait fits inside the same slot so the card width never moves. */
const ART_COLUMNS = 40
/** Art slot height: 18 rows (confetti 2 + portrait below it), and the text
 * column is pinned to the same height (see the column's comment). */
const ART_ROWS = 18
/** Text column width: every copy line and the hint stays on ONE row
 * (the "排版不舒适" report: no stranded glyphs, no mid-sentence breaks). */
const TEXT_COLUMNS = 48
/** Portrait + text side by side need this many columns (art 40 + gap 2 +
 * text 48 + card chrome 6); below that the card drops the art and stacks
 * text at the narrower width. */
const MIN_ART_COLUMNS = 98
/** Card height with the art (18 art rows + 2 border rows); terminals shorter
 * than this + 2 margin rows get the text-only card. */
const MIN_ART_ROWS = 23

/** Card copy date (login-grant expiry) in the terminal's shell of choice:
 * month/day/time, read off the ISO instant in the repo's home timezone. */
function couponExpiry(expiresAt: string): { month: string; day: string; time: string } | null {
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: string): string | undefined => parts.find(item => item.type === type)?.value
  const month = part('month')
  const day = part('day')
  const hour = part('hour')
  const minute = part('minute')
  return month === undefined || day === undefined || hour === undefined || minute === undefined
    ? null : { month, day, time: `${hour}:${minute}` }
}

/**
 * The login-grant coupon card (OAuth bonus issued by the DSH OAuth side, see
 * `dsh-adapter/oauth/bonus.ts`). Chat mounts it over a dimmed click-catcher
 * and yields the keyboard to it while it is up; `Esc`/Enter/click-outside
 * close it, and the store is told the notice was shown on mount so a coupon
 * is never replayed.
 *
 * Composition follows the house design system: the title sits in the card's
 * content column, a `Divider` separates the footer, and the hint line is a
 * `HintLine` with its bold key. The art slot shows the happy maid under a
 * star field, falling back to the pixel whale without image protocols.
 */
export function WhaleCouponPrompt({
  notice,
  onShown,
  onClose,
}: {
  readonly notice: WhaleCouponNotice
  readonly onShown: (orderId: WhaleCouponNotice['orderId']) => void
  readonly onClose: () => void
}): React.ReactNode {
  const lang = React.useSyncExternalStore(subscribeLang, getLang)
  const { columns, rows } = useTerminalSize()
  const imagesAvailable = useTerminalImages()
  const portraits = useMaidPortraits(true, getActiveBrand() === 'claude' ? CLAUDE_GIRL_ASSETS : MAID_ASSETS)
  const background = useTerminalBackground()
  const withArt = columns >= MIN_ART_COLUMNS && rows >= MIN_ART_ROWS
  const textColumns = withArt ? TEXT_COLUMNS : Math.max(1, Math.min(TEXT_COLUMNS, columns - 6))
  const cardColumns = withArt ? 96 : Math.min(columns, textColumns + 6)
  const cardRows = withArt ? ART_ROWS + 2 : Math.min(rows, 15)
  const left = Math.max(0, Math.floor((columns - cardColumns) / 2))
  const bottom = Math.max(0, Math.min(Math.floor((rows - cardRows) / 2), rows - cardRows))
  const amount = notice.amount.replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '')
  const unit = lang === 'zh' ? notice.currency === 'CNY' ? '元' : '美元' : notice.currency
  const expiry = couponExpiry(notice.expiresAt)

  React.useEffect(() => {
    const timer = setTimeout(() => onShown(notice.orderId), 0)
    return () => { clearTimeout(timer) }
  }, [notice.orderId, onShown])
  useInput((_input, key) => {
    if (key.return || key.escape) onClose()
  })

  return (
    <>
      <Box position="absolute" bottom={0} left={0} width="100%" height={rows}
        flexShrink={0} backdrop="dim" onClick={onClose} />
      <Box position="absolute" left={left} bottom={bottom} width={cardColumns} height={cardRows}
        flexDirection="column" flexShrink={0} overflow="hidden" backgroundColor={background} opaque
        onClick={event => { event.stopImmediatePropagation() }}>
        <Box flexDirection="row" gap={2} alignItems="center" justifyContent="center"
          borderStyle="round" borderColor="inactive" paddingX={2} backgroundColor={background}>
          {withArt && (
            <Box width={ART_COLUMNS} height={ART_ROWS} flexShrink={0} flexDirection="column"
              alignItems="center" justifyContent="center" backgroundColor={background} opaque>
              <Confetti width={ART_COLUMNS} />
              {imagesAvailable && portraits?.happy !== undefined
                ? <MaidPortrait source={portraits.happy} maxColumns={ART_COLUMNS}
                    maxRows={ART_ROWS - CONFETTI_ROWS} presentation="preview" />
                : <WhaleGirlHappyArt source={portraits?.happy} width={ART_COLUMNS} />}
            </Box>
          )}
          <Box flexDirection="column" width={textColumns} {...(withArt ? { height: ART_ROWS } : {})}>
            <Text color="accent" bold wrap="truncate-end">{t('coupon-modal-title')}</Text>
            <Box height={1} />
            <Text color="success" bold wrap="wrap">{t('coupon-modal-received', { amount, unit })}</Text>
            {expiry !== null && (
              <>
                <Box height={1} />
                <Text wrap="wrap">{t('coupon-modal-expiry', expiry)}</Text>
              </>
            )}
            <Box flexGrow={1} />
            <Divider width={textColumns} />
            <Text dimColor wrap="truncate-end"><HintLine text={t('coupon-modal-hint')} /></Text>
          </Box>
        </Box>
      </Box>
    </>
  )
}

/** 星光两行、稀疏：主星（常亮，金色）+ 闪烁星（各列相位不同，同一帧只有
 *  三分之一亮着）——比随机撒点安静，也比满屏星星精致。 */
const CONFETTI_GLYPHS = ['✦', '✧'] as const
const CONFETTI_COLORS = ['warning', 'accent', 'activity'] as const
const CONFETTI_FRAMES = 3
const CONFETTI_ROWS = 2
/** 每几列一颗主星（常亮）。 */
const CONFETTI_ANCHOR_STRIDE = 7

/** 一段同色游程（`color` 为 undefined = 默认前景）。 */
type ConfettiRun = { readonly text: string; readonly color: (typeof CONFETTI_COLORS)[number] | undefined }

const CONFETTI: readonly (readonly (readonly ConfettiRun[])[])[] =
  Array.from({ length: CONFETTI_FRAMES }, (_, frameIndex) =>
    Array.from({ length: CONFETTI_ROWS }, (_, row) => {
      const runs: { text: string; color: ConfettiRun['color'] }[] = []
      let current: ConfettiRun['color'] = undefined
      let buffer = ''
      for (let column = 0; column < ART_COLUMNS; column++) {
        const anchor = column % CONFETTI_ANCHOR_STRIDE === 0
        // 闪烁星：每列一个固定相位，逐帧轮到自己亮一次（在 3 帧里亮 1 帧）。
        const twinkle = !anchor
          && column % 2 === 0
          && (column / 2 + row) % CONFETTI_FRAMES === frameIndex
        const glyph = anchor ? CONFETTI_GLYPHS[0] : twinkle ? CONFETTI_GLYPHS[1] : ' '
        const color = anchor
          ? CONFETTI_COLORS[0]
          : twinkle
            ? (column / 2) % 2 === 0 ? CONFETTI_COLORS[1] : CONFETTI_COLORS[2]
            : undefined
        if (color !== current) {
          if (buffer !== '') runs.push({ text: buffer, color: current })
          buffer = ''
          current = color
        }
        buffer += glyph
      }
      if (buffer !== '') runs.push({ text: buffer, color: current })
      return runs
    }))

/** One confetti band, advancing a frame every 160ms while it is mounted. */
function Confetti({ width }: { width: number }): React.ReactNode {
  const frame = useConfettiFrame()
  const rows = CONFETTI[frame] ?? CONFETTI[0]!
  return (
    <Box flexDirection="column" flexShrink={0} width={width}>
      {rows.map((runs, index) => (
        <Text key={index} wrap="truncate-end">
          {runs.map((run, runIndex) => (
            <Text key={runIndex} color={run.color}>{run.text}</Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

function useConfettiFrame(): number {
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    const timer = setInterval(() => {
      setFrame(previous => (previous + 1) % CONFETTI_FRAMES)
    }, 220)
    ;(timer as { unref?: () => void }).unref?.()
    return () => { clearInterval(timer) }
  }, [])
  return frame
}

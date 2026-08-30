import React, { useEffect, useState } from 'react'
import { Box, Text } from '../ui.js'
import type { ChatRow } from '../dsh-adapter/channel.js'

export interface ImageDeckItem {
  id: string
  title: string
  subtitle?: string
  source?: string
  timestamp: number
  expiresAt: number
}

interface FloatingImageDeckProps {
  rows: readonly ChatRow[]
  terminalColumns: number
  terminalRows: number
}

/**
 * Bottom-right floating image/screenshot card stack:
 * - Detects screenshot/render/image tool invocations.
 * - Stacks cards behind each other with 3D offset and depth tints.
 * - Auto-dismisses cards after ~6 seconds.
 */
export function FloatingImageDeck({
  rows,
  terminalColumns,
  terminalRows,
}: FloatingImageDeckProps): React.ReactNode {
  const [deck, setDeck] = useState<ImageDeckItem[]>([])
  const lastSeenIdRef = React.useRef<string | null>(null)

  // Scan rows for new image / screenshot activity
  useEffect(() => {
    if (!rows || rows.length === 0) return

    const now = Date.now()
    const candidates: ImageDeckItem[] = []

    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 15); i--) {
      const row = rows[i]
      if (!row) continue

      const raw = JSON.stringify(row)
      const isScreenshot =
        raw.includes('screen_capture') ||
        raw.includes('ScreenCapture') ||
        raw.includes('inspect_image') ||
        raw.includes('blender_render') ||
        raw.includes('blender_preview') ||
        /\.(png|jpg|jpeg|webp)\b/i.test(raw)

      if (isScreenshot && String(row.id) !== String(lastSeenIdRef.current)) {
        // Extract title
        let title = 'Viewport Capture'
        if (raw.includes('screen_capture') || raw.includes('ScreenCapture')) {
          title = 'Studio Screenshot'
        } else if (raw.includes('blender_render') || raw.includes('blender_preview')) {
          title = 'Blender 3D Render'
        } else if (raw.includes('inspect_image')) {
          title = 'Image Analysis'
        }

        const match = raw.match(/([a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp))/i)
        const filename = match ? match[1] : 'capture.png'

        candidates.push({
          id: `img-${String(row.id || Math.random())}`,
          title,
          subtitle: filename,
          source: 'Live Agent Pipeline',
          timestamp: now,
          expiresAt: now + 7000,
        })
        break
      }
    }

    if (candidates.length > 0) {
      const top = candidates[0]
      lastSeenIdRef.current = String(rows[rows.length - 1]?.id ?? '')
      setDeck((prev) => {
        const filtered = prev.filter((item) => item.subtitle !== top.subtitle)
        return [top, ...filtered].slice(0, 3)
      })
    }
  }, [rows])

  // Timer loop to prune expired cards
  useEffect(() => {
    if (deck.length === 0) return
    const timer = setInterval(() => {
      const now = Date.now()
      setDeck((prev) => prev.filter((item) => item.expiresAt > now))
    }, 500)
    return () => clearInterval(timer)
  }, [deck.length])

  if (deck.length === 0) return null

  // Card geometry
  const cardWidth = Math.min(36, Math.floor(terminalColumns * 0.38))
  if (cardWidth < 22) return null

  return (
    <Box
      position="absolute"
      bottom={2}
      right={3}
      flexDirection="column"
      alignItems="flex-end"
    >
      {deck.map((item, index) => {
        const isTop = index === 0
        const ageSec = Math.max(0, Math.round((item.expiresAt - Date.now()) / 1000))
        const borderColor = isTop ? '#5EEAD4' : '#2A4440'

        return (
          <Box
            key={item.id}
            flexDirection="column"
            borderStyle={isTop ? 'round' : 'single'}
            borderColor={borderColor}
            paddingX={1}
            paddingY={0}
            width={cardWidth}
            backgroundColor="pane"
            marginTop={index > 0 ? -1 : 0}
            marginLeft={index * 2}
          >
            {/* Header */}
            <Box justifyContent="space-between" width="100%">
              <Box gap={1}>
                <Text color={isTop ? '#5EEAD4' : '#7D8C89'} bold>
                  {isTop ? '✦ ' : '  '}
                  {item.title}
                </Text>
              </Box>
              <Text dimColor>
                {`${ageSec}s`}
              </Text>
            </Box>

            {/* Thumbnail Representation */}
            {isTop && (
              <Box flexDirection="column" marginY={0}>
                <Box
                  borderStyle="single"
                  borderColor="#2A4440"
                  justifyContent="center"
                  alignItems="center"
                  height={3}
                  marginBottom={0}
                >
                  <Text color="#5EEAD4">▰▰▰ 🖼️ STREAM READY ▰▰▰</Text>
                </Box>
                <Box justifyContent="space-between">
                  <Text dimColor wrap="truncate-end">
                    {item.subtitle}
                  </Text>
                  <Text color="#5EEAD4" bold>
                    LIVE
                  </Text>
                </Box>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

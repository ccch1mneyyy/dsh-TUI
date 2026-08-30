import React, { useEffect, useState } from 'react'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Box, Text } from '../ui.js'

export interface CanvasArtifact {
  name: string
  title: string
  size: number
  modified: number
}

interface CanvasBrowserPaneProps {
  onClose?: () => void
  onOpenExternal?: (name?: string) => void
  activeUrl?: string
}

function parseHtmlContent(rawHtml: string): string[] {
  if (!rawHtml) return ['(Empty artifact)']
  return rawHtml
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, ' • $1\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n')
    .replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '$1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n')
}

export function CanvasBrowserPane({
  onClose,
  onOpenExternal,
  activeUrl = 'http://127.0.0.1:33007/',
}: CanvasBrowserPaneProps): React.ReactNode {
  const [artifacts, setArtifacts] = useState<CanvasArtifact[]>([])
  const [selectedIdx, setSelectedIdx] = useState<number>(0)
  const [lines, setLines] = useState<string[]>([])
  const [scrollOffset, setScrollOffset] = useState<number>(0)
  const artifactsDir = join(homedir(), '.dsh', 'artifacts')

  // Load and poll artifacts
  const loadArtifacts = async () => {
    try {
      const files = await readdir(artifactsDir, { withFileTypes: true })
      const list: CanvasArtifact[] = []
      for (const f of files) {
        if (f.isFile() && f.name.endsWith('.html')) {
          const fullPath = join(artifactsDir, f.name)
          const st = await stat(fullPath)
          const head = await readFile(fullPath, 'utf8').catch(() => '')
          const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)
          const title = match ? match[1].replace(/<[^>]*>/g, '').trim() : f.name.replace('.html', '')
          list.push({
            name: f.name,
            title: title || f.name,
            size: st.size,
            modified: st.mtimeMs,
          })
        }
      }
      list.sort((a, b) => b.modified - a.modified)
      setArtifacts(list)
    } catch {
      setArtifacts([])
    }
  }

  useEffect(() => {
    loadArtifacts()
    const timer = setInterval(loadArtifacts, 1500)
    return () => clearInterval(timer)
  }, [])

  // Load active artifact content
  const activeArtifact = artifacts[selectedIdx]
  useEffect(() => {
    if (!activeArtifact) {
      setLines(['No artifacts on stage. Write an artifact to stream live content here.'])
      return
    }
    const fullPath = join(artifactsDir, activeArtifact.name)
    readFile(fullPath, 'utf8')
      .then((html) => {
        setLines(parseHtmlContent(html))
        setScrollOffset(0)
      })
      .catch(() => {
        setLines(['Failed to read artifact content.'])
      })
  }, [activeArtifact?.name])

  const visibleLines = lines.slice(scrollOffset, scrollOffset + 32)

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      borderStyle="single"
      borderColor="#2A4440"
      backgroundColor="pane"
      height="100%"
      overflow="hidden"
    >
      {/* Browser Chrome Header */}
      <Box
        flexDirection="column"
        borderBottomColor="#2A4440"
        paddingX={1}
        paddingY={0}
      >
        <Box justifyContent="space-between" alignItems="center">
          <Box gap={1} alignItems="center">
            <Box
              borderStyle="single"
              borderColor="#5EEAD4"
              paddingX={0}
              height={1}
              justifyContent="center"
              alignItems="center"
            >
              <Text bold color="#5EEAD4">
                {' '}BROWSER{' '}
              </Text>
            </Box>
            <Text bold color="#E8EEF0">
              {activeArtifact?.title || 'Canvas Viewer'}
            </Text>
          </Box>
          <Box gap={1} alignItems="center">
            <Text color="#5EEAD4" bold>
              ● LIVE
            </Text>
            <Text dimColor>
              {activeUrl}
            </Text>
          </Box>
        </Box>

        {/* Tab Strip */}
        <Box gap={1} marginTop={0}>
          {artifacts.slice(0, 4).map((art, idx) => {
            const isSelected = idx === selectedIdx
            return (
              <Box
                key={art.name}
                borderStyle={isSelected ? 'round' : undefined}
                borderColor={isSelected ? '#5EEAD4' : undefined}
                paddingX={1}
              >
                <Text
                  color={isSelected ? '#5EEAD4' : '#7D8C89'}
                  bold={isSelected}
                  wrap="truncate-end"
                >
                  {`${idx + 1}. ${art.title}`}
                </Text>
              </Box>
            )
          })}
        </Box>
      </Box>

      {/* Browser Viewport / Live Stream */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        paddingX={1}
        paddingY={1}
        overflow="hidden"
      >
        {visibleLines.map((line, idx) => {
          const isHeading = line.startsWith('#')
          const isBullet = line.trim().startsWith('•')
          return (
            <Text
              key={idx}
              bold={isHeading}
              color={isHeading ? '#5EEAD4' : isBullet ? '#60A5FA' : '#E8EEF0'}
              wrap="wrap"
            >
              {line || ' '}
            </Text>
          )
        })}
      </Box>

      {/* Footer Controls */}
      <Box
        borderTopColor="#2A4440"
        paddingX={1}
        justifyContent="space-between"
      >
        <Text dimColor>
          Artifacts: {artifacts.length} · Showing {activeArtifact?.name || 'none'}
        </Text>
        <Box gap={2}>
          <Text color="#5EEAD4">1-4: Switch Tab</Text>
          <Text dimColor>j/k: Scroll</Text>
          <Text dimColor>Esc: Close</Text>
        </Box>
      </Box>
    </Box>
  )
}

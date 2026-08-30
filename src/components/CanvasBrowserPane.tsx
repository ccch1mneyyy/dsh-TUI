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

function parseHtmlContent(rawHtml: string): { type: 'h1' | 'h2' | 'h3' | 'code' | 'li' | 'p'; text: string }[] {
  if (!rawHtml || typeof rawHtml !== 'string') {
    return [{ type: 'p', text: '(Empty artifact content)' }]
  }

  const clean = rawHtml
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')

  const lines = clean.split(/\r?\n/)
  const result: { type: 'h1' | 'h2' | 'h3' | 'code' | 'li' | 'p'; text: string }[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (/<h1[^>]*>([\s\S]*?)<\/h1>/i.test(line)) {
      const match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(line)
      result.push({ type: 'h1', text: stripTags(match ? match[1] : line) })
    } else if (/<h2[^>]*>([\s\S]*?)<\/h2>/i.test(line)) {
      const match = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(line)
      result.push({ type: 'h2', text: stripTags(match ? match[1] : line) })
    } else if (/<h3[^>]*>([\s\S]*?)<\/h3>/i.test(line)) {
      const match = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(line)
      result.push({ type: 'h3', text: stripTags(match ? match[1] : line) })
    } else if (/<li[^>]*>([\s\S]*?)<\/li>/i.test(line)) {
      const match = /<li[^>]*>([\s\S]*?)<\/li>/i.exec(line)
      result.push({ type: 'li', text: stripTags(match ? match[1] : line) })
    } else if (/<pre|<code>/i.test(line)) {
      result.push({ type: 'code', text: stripTags(line) })
    } else {
      const text = stripTags(line)
      if (text) result.push({ type: 'p', text })
    }
  }

  return result.length > 0 ? result : [{ type: 'p', text: '(Empty artifact)' }]
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0}B`
  return `${(bytes / 1024).toFixed(1)}K`
}

export function CanvasBrowserPane({
  onClose,
  onOpenExternal,
  activeUrl = 'http://127.0.0.1:45575/',
}: CanvasBrowserPaneProps): React.ReactNode {
  const [artifacts, setArtifacts] = useState<CanvasArtifact[]>([])
  const [selectedIdx, setSelectedIdx] = useState<number>(0)
  const [parsedBlocks, setParsedBlocks] = useState<{ type: string; text: string }[]>([])
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
    const timer = setInterval(loadArtifacts, 1000)
    return () => clearInterval(timer)
  }, [])

  // Load active artifact content
  const activeArtifact = artifacts[selectedIdx]
  useEffect(() => {
    if (!activeArtifact) {
      setParsedBlocks([{ type: 'p', text: 'No artifacts on stage.' }])
      return
    }
    const fullPath = join(artifactsDir, activeArtifact.name)
    readFile(fullPath, 'utf8')
      .then((html) => {
        setParsedBlocks(parseHtmlContent(html))
        setScrollOffset(0)
      })
      .catch(() => {
        setParsedBlocks([{ type: 'p', text: 'Failed to read artifact content.' }])
      })
  }, [activeArtifact?.name])

  const visibleBlocks = parsedBlocks.slice(scrollOffset, scrollOffset + 24)

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
      width="100%"
    >
      {/* Top Header Bar */}
      <Box
        flexDirection="column"
        borderBottomColor="#2A4440"
        paddingX={1}
        paddingY={0}
      >
        <Box justifyContent="space-between" alignItems="center">
          <Box gap={1} alignItems="center">
            <Text bold color="#5EEAD4">
              ◫ STAGE
            </Text>
            <Text color="#7D8C89">│</Text>
            <Text bold color="#E8EEF0" wrap="truncate-end">
              {activeArtifact?.title || 'Canvas'}
            </Text>
          </Box>
          <Box gap={1} alignItems="center">
            <Text color="#5EEAD4" bold>
              ● LIVE
            </Text>
          </Box>
        </Box>

        {/* Tab Row */}
        <Box gap={1} marginTop={0}>
          {artifacts.length === 0 ? (
            <Text dimColor>[ No artifacts ]</Text>
          ) : (
            artifacts.slice(0, 3).map((art, idx) => {
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
                    {`${idx + 1}.${art.title.slice(0, 12)} (${formatBytes(art.size)})`}
                  </Text>
                </Box>
              )
            })
          )}
        </Box>
      </Box>

      {/* Main Viewport Content */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        paddingX={1}
        paddingY={1}
        overflow="hidden"
      >
        {visibleBlocks.map((block, idx) => {
          if (block.type === 'h1') {
            return (
              <Box key={idx} marginY={0} borderBottomColor="#2A4440">
                <Text bold color="#5EEAD4" wrap="wrap">
                  {`# ${block.text}`}
                </Text>
              </Box>
            )
          }
          if (block.type === 'h2') {
            return (
              <Box key={idx} marginTop={0}>
                <Text bold color="#60A5FA" wrap="wrap">
                  {`## ${block.text}`}
                </Text>
              </Box>
            )
          }
          if (block.type === 'h3') {
            return (
              <Box key={idx} marginTop={0}>
                <Text bold color="#FBBF24" wrap="wrap">
                  {`### ${block.text}`}
                </Text>
              </Box>
            )
          }
          if (block.type === 'li') {
            return (
              <Box key={idx} paddingLeft={1}>
                <Text color="#E8EEF0" wrap="wrap">
                  <Text color="#5EEAD4">• </Text>
                  {block.text}
                </Text>
              </Box>
            )
          }
          if (block.type === 'code') {
            return (
              <Box
                key={idx}
                borderStyle="single"
                borderColor="#2A4440"
                paddingX={1}
                marginY={0}
              >
                <Text color="#5EEAD4" wrap="wrap">
                  {block.text}
                </Text>
              </Box>
            )
          }
          return (
            <Text key={idx} color="#E8EEF0" wrap="wrap">
              {block.text}
            </Text>
          )
        })}
      </Box>

      {/* Footer Navigation Bar */}
      <Box
        borderTopColor="#2A4440"
        paddingX={1}
        justifyContent="space-between"
      >
        <Text dimColor wrap="truncate-end">
          {activeArtifact ? activeArtifact.name : 'empty'}
        </Text>
        <Box gap={1}>
          <Text color="#5EEAD4">^B Toggle</Text>
          <Text dimColor>1-3 Tabs</Text>
        </Box>
      </Box>
    </Box>
  )
}

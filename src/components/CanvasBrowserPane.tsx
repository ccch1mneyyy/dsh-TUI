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

interface ParsedNode {
  kind: 'header' | 'metric' | 'bar' | 'table' | 'card' | 'badge' | 'list' | 'code' | 'text' | 'hr'
  title?: string
  subtitle?: string
  value?: string
  max?: string
  pct?: number
  color?: string
  items?: { label: string; status: string; color?: string }[]
  text?: string
}

function parseHtmlToVisualDOM(html: string): ParsedNode[] {
  if (!html || typeof html !== 'string') {
    return [{ kind: 'text', text: 'No content on stage.' }]
  }

  const nodes: ParsedNode[] = []

  // Extract Main Page Title / Header
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  const subMatch = /<p[^>]*class="subtitle"[^>]*>([\s\S]*?)<\/p>/i.exec(html) || /<p[^>]*style="[^"]*color:[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(html)
  if (h1Match) {
    nodes.push({
      kind: 'header',
      title: cleanText(h1Match[1]),
      subtitle: subMatch ? cleanText(subMatch[1]) : undefined,
    })
  }

  // Extract Cards / Gauges / Metrics
  const cardRegex = /<div[^>]*class="card"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi
  let cardMatch: RegExpExecArray | null
  const extractedCards: ParsedNode[] = []

  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const cardBody = cardMatch[1]
    const labelMatch = /<div[^>]*class="(?:card-label|card-title)"[^>]*>([\s\S]*?)<\/div>/i.exec(cardBody)
    const valMatch = /<div[^>]*class="(?:card-value|card-val)"[^>]*>([\s\S]*?)<\/div>/i.exec(cardBody)
    const descMatch = /<div[^>]*class="card-desc"[^>]*>([\s\S]*?)<\/div>/i.exec(cardBody)

    const label = labelMatch ? cleanText(labelMatch[1]) : 'Metric'
    const val = valMatch ? cleanText(valMatch[1]) : ''
    const desc = descMatch ? cleanText(descMatch[1]) : ''

    // Calculate percentage if numbers exist (e.g. 1480 / 1900 or 62 / 100)
    let pct = 75
    let color = '#5EEAD4'
    const numMatch = val.match(/([\d,]+)\s*\/\s*([\d,]+)/)
    if (numMatch) {
      const cur = parseFloat(numMatch[1].replace(/,/g, ''))
      const max = parseFloat(numMatch[2].replace(/,/g, ''))
      if (max > 0) pct = Math.min(100, Math.max(0, Math.round((cur / max) * 100)))
    }
    if (/health|hp/i.test(label)) color = '#4ADE80'
    else if (/stamina/i.test(label)) color = '#FBBF24'
    else if (/mana|astral/i.test(label)) color = '#60A5FA'
    else if (/danger|error/i.test(label)) color = '#F87171'

    extractedCards.push({
      kind: 'metric',
      title: label,
      value: val,
      text: desc,
      pct,
      color,
    })
  }

  if (extractedCards.length > 0) {
    nodes.push(...extractedCards)
  }

  // Extract Lists / Spells / Tables
  const liMatches = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
  if (liMatches.length > 0) {
    const listItems: { label: string; status: string; color?: string }[] = []
    for (const m of liMatches) {
      const full = m[1]
      const spanMatches = [...full.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
      if (spanMatches.length >= 2) {
        const label = cleanText(spanMatches[0][1])
        const status = cleanText(spanMatches[1][1])
        let color = '#5EEAD4'
        if (/cd|cooldown/i.test(status)) color = '#FBBF24'
        else if (/ready/i.test(status)) color = '#4ADE80'
        listItems.push({ label, status, color })
      } else {
        listItems.push({ label: cleanText(full), status: '•', color: '#60A5FA' })
      }
    }
    nodes.push({ kind: 'list', items: listItems })
  }

  // Fallback / standard prose if no rich cards found
  if (nodes.length === 0) {
    const clean = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    nodes.push({ kind: 'text', text: clean.slice(0, 1000) })
  }

  return nodes
}

function cleanText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function renderProgressBar(pct: number, width: number = 22): string {
  const filled = Math.round((pct / 100) * width)
  const empty = Math.max(0, width - filled)
  return '█'.repeat(filled) + '░'.repeat(empty)
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
  const [nodes, setNodes] = useState<ParsedNode[]>([])
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
      setNodes([{ kind: 'text', text: 'No artifacts on stage. Write an artifact to see live browser preview.' }])
      return
    }
    const fullPath = join(artifactsDir, activeArtifact.name)
    readFile(fullPath, 'utf8')
      .then((html) => {
        setNodes(parseHtmlToVisualDOM(html))
      })
      .catch(() => {
        setNodes([{ kind: 'text', text: 'Failed to read artifact content.' }])
      })
  }, [activeArtifact?.name])

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      borderStyle="round"
      borderColor="#5EEAD4"
      backgroundColor="pane"
      height="100%"
      overflow="hidden"
      width="100%"
    >
      {/* Chrome Window Top Bar (Traffic lights & Browser Tabs) */}
      <Box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        borderBottomColor="#2A4440"
        paddingX={1}
        paddingY={0}
      >
        {/* Window Controls */}
        <Box gap={1} alignItems="center">
          <Text color="#F87171">●</Text>
          <Text color="#FBBF24">●</Text>
          <Text color="#4ADE80">●</Text>
          <Text dimColor>│</Text>
          {/* Active Tabs */}
          {artifacts.length === 0 ? (
            <Box paddingX={1}>
              <Text dimColor>New Tab</Text>
            </Box>
          ) : (
            artifacts.slice(0, 2).map((art, idx) => {
              const isSelected = idx === selectedIdx
              return (
                <Box
                  key={art.name}
                  borderStyle={isSelected ? 'round' : undefined}
                  borderColor={isSelected ? '#5EEAD4' : undefined}
                  paddingX={1}
                >
                  <Text color={isSelected ? '#5EEAD4' : '#7D8C89'} bold={isSelected}>
                    {`🌐 ${art.title.slice(0, 14)} ×`}
                  </Text>
                </Box>
              )
            })
          )}
        </Box>

        <Box gap={1} alignItems="center">
          <Text color="#5EEAD4" bold>
            60 FPS
          </Text>
        </Box>
      </Box>

      {/* Omnibox / Browser Navigation Toolbar */}
      <Box
        flexDirection="row"
        alignItems="center"
        justifyContent="space-between"
        borderBottomColor="#2A4440"
        paddingX={1}
        paddingY={0}
      >
        {/* Navigation Buttons */}
        <Box gap={1} alignItems="center">
          <Text dimColor>‹</Text>
          <Text dimColor>›</Text>
          <Text color="#5EEAD4">↻</Text>
        </Box>

        {/* Address URL Pill */}
        <Box
          flexGrow={1}
          marginX={1}
          borderStyle="single"
          borderColor="#2A4440"
          paddingX={1}
          justifyContent="space-between"
          alignItems="center"
        >
          <Box gap={1}>
            <Text color="#4ADE80">🔒</Text>
            <Text color="#E8EEF0" bold>
              {activeUrl.replace(/\/$/, '')}
            </Text>
            <Text dimColor>
              {activeArtifact ? `?a=${activeArtifact.name}` : ''}
            </Text>
          </Box>
          <Text color="#5EEAD4" bold>
            ● LIVE
          </Text>
        </Box>

        <Text dimColor>⋮</Text>
      </Box>

      {/* Webpage Viewport Canvas */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        paddingX={2}
        paddingY={1}
        overflow="hidden"
      >
        {nodes.map((node, idx) => {
          if (node.kind === 'header') {
            return (
              <Box key={idx} flexDirection="column" marginBottom={1} borderBottomColor="#2A4440">
                <Box justifyContent="space-between" alignItems="center">
                  <Text bold color="#5EEAD4">
                    {`✦ ${node.title || 'Canvas'}`}
                  </Text>
                  <Text color="#4ADE80" bold>
                    [ ACTIVE STAGE ]
                  </Text>
                </Box>
                {node.subtitle && (
                  <Text dimColor>
                    {node.subtitle}
                  </Text>
                )}
              </Box>
            )
          }

          if (node.kind === 'metric') {
            return (
              <Box
                key={idx}
                flexDirection="column"
                borderStyle="round"
                borderColor="#2A4440"
                paddingX={1}
                paddingY={0}
                marginBottom={1}
              >
                <Box justifyContent="space-between">
                  <Text bold color="#7D8C89">
                    {(node.title || '').toUpperCase()}
                  </Text>
                  <Text bold color="#5EEAD4">
                    {node.value}
                  </Text>
                </Box>
                {node.pct !== undefined && (
                  <Box gap={1} alignItems="center" marginY={0}>
                    <Text color="#5EEAD4">
                      {renderProgressBar(node.pct, 20)}
                    </Text>
                    <Text dimColor>
                      {`${node.pct}%`}
                    </Text>
                  </Box>
                )}
                {node.text ? (
                  <Text dimColor wrap="truncate-end">
                    {node.text}
                  </Text>
                ) : null}
              </Box>
            )
          }

          if (node.kind === 'list' && node.items) {
            return (
              <Box
                key={idx}
                flexDirection="column"
                borderStyle="single"
                borderColor="#2A4440"
                paddingX={1}
                marginBottom={1}
              >
                <Box marginBottom={0} borderBottomColor="#2A4440">
                  <Text bold color="#60A5FA">
                    ACTIVE EQUIPPED SPELLS & ACTIONS
                  </Text>
                </Box>
                {node.items.map((item, iIdx) => (
                  <Box key={iIdx} justifyContent="space-between">
                    <Text color="#E8EEF0">
                      {item.label}
                    </Text>
                    <Text bold color="#5EEAD4">
                      {`[ ${item.status} ]`}
                    </Text>
                  </Box>
                ))}
              </Box>
            )
          }

          return (
            <Text key={idx} color="#E8EEF0" wrap="wrap">
              {node.text || ' '}
            </Text>
          )
        })}
      </Box>

      {/* Browser Footer Status */}
      <Box
        borderTopColor="#2A4440"
        paddingX={1}
        justifyContent="space-between"
      >
        <Text dimColor>
          {activeArtifact ? `Rendering ${activeArtifact.name} (${formatBytes(activeArtifact.size)})` : 'Ready'}
        </Text>
        <Box gap={2}>
          <Text color="#5EEAD4">Ctrl+B: Split</Text>
          <Text dimColor>1-2: Tabs</Text>
        </Box>
      </Box>
    </Box>
  )
}

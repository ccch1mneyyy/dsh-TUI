/**
 * Reports every session gets: `/doctor` (the backend-neutral facts plus the
 * backend's own diagnostics lines) and `/export` (the projected transcript as
 * Markdown in the working directory). A composition with a richer source
 * overrides them; the DSH extension exports the durable session log.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSession } from '../../../agent/session.js'
import { t } from '../../../i18n.js'
import type { ChannelBinding } from '../binding.js'
import type { ChannelOwner } from '../owner.js'
import type { ChannelState, ChatRow } from '../types.js'

/** One transcript row as an export section; undefined = not exported. */
function exportSection(row: ChatRow): string | undefined {
  switch (row.kind) {
    case 'user':
      return row.text === '' ? undefined : `${t('export-user-section')}\n\n${row.text}\n`
    case 'reasoning':
      return row.text === '' ? undefined : `${t('export-thinking-section')}\n\n${row.text}\n`
    case 'assistant':
      return row.text === '' ? undefined : `${t('export-assistant-section')}\n\n${row.text}\n`
    case 'tool': {
      const tool = row.tool
      if (tool === undefined) return undefined
      const parts = [`${t('export-tool-section', { name: tool.name })}\n\n\`\`\`json\n${tool.argsFull ?? tool.argsText}\n\`\`\`\n`]
      const result = tool.resultFull ?? tool.resultText ?? tool.errorText
      if (result !== undefined && result !== '') parts.push(`${t('export-result-section')}\n\n\`\`\`\n${result}\n\`\`\`\n`)
      return parts.join('\n')
    }
    default:
      return undefined
  }
}

export function createCoreReports(deps: {
  owner: Pick<ChannelOwner, 'current'>
  binding: Pick<ChannelBinding, 'session' | 'capture' | 'isCurrent'>
  state: () => Pick<ChannelState, 'rows' | 'model' | 'cwd' | 'contextWindow' | 'agentId' | 'backendCapabilities'>
}) {
  /** `/doctor`: the backend-neutral facts plus the backend's own lines. */
  const doctorInfo = (): string[] => {
    const session: AgentSession = deps.binding.session
    const state = deps.state()
    const label = state.backendCapabilities.backendLabel
    return [
      `Node ${process.version} · ${process.platform} ${process.arch}`,
      t('doctor-backend', { label, id: session.ref.backendId }),
      t('doctor-model', { model: state.model || t('doctor-unknown'), provider: label }),
      t('doctor-cwd', { cwd: state.cwd }),
      t('doctor-context-window', { window: state.contextWindow ?? t('doctor-unknown') }),
      t('doctor-session', { id: session.ref.sessionId }),
      ...session.capabilities.diagnostics?.lines() ?? [],
    ]
  }

  /**
   * `/export`: the transcript as this channel projected it (user, thinking,
   * assistant and tool rows), written next to the session's work. Returns
   * the file path, or null when the binding moved on or the write failed.
   */
  const exportSession = (): string | null => {
    const capture = deps.binding.capture()
    const current = (): boolean => deps.owner.current() && deps.binding.isCurrent(capture)
    const state = deps.state()
    const parts = [t('export-title'), '', t('export-time', { time: new Date().toLocaleString() }),
      t('export-model', { model: state.model }), t('export-session', { id: state.agentId }), t('export-dir', { cwd: state.cwd }), '']
    for (const row of state.rows) {
      const section = exportSection(row)
      if (section !== undefined) parts.push(section)
    }
    if (!current()) return null
    try {
      const target = join(state.cwd, `dsh-tui-export-${Date.now()}.md`)
      writeFileSync(target, parts.join('\n'), 'utf8')
      return current() ? target : null
    } catch {
      return null
    }
  }

  return { doctorInfo, exportSession }
}

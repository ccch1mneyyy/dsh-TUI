import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectAdapterDiagnostics } from '../../adapter/kernel/diagnostics.js'
import { readGrantStore } from '../../adapter/standard/grants.js'
import type { AdapterRuntimeOptions } from '../../adapter/kernel/runtime.js'
import { fetchBalance } from '../../deepseekBalance.js'
import { t } from '../../i18n.js'
import { homeDir } from '../../utils/paths.js'
import { sessionsRoots } from '../compat/index.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import { getHostGrantStore } from '../host-grants.js'
import { getHostFacade } from '../plugin-host.js'
import { pluginsInfoLines } from '../plugins-info.js'
import type { ChannelOwner } from './owner.js'

/** Local reports and filesystem actions, fenced to the originating binding. */
export function createReportActions(ctx: Context, deps: {
  owner: Pick<ChannelOwner, 'current'>
  capture(): { readonly agent: Agent; readonly generation: number }
  current(capture: { readonly agent: Agent; readonly generation: number }): boolean
  cwd(): string
  model(): string
  provider(): string
  contextWindow(): number | undefined
  sessionTitle(): string
  runtime: AdapterRuntimeOptions
  grantStore(): ReturnType<typeof readGrantStore>
}) {
  const current = (capture: ReturnType<typeof deps.capture>): boolean => deps.owner.current() && deps.current(capture)

  const balanceInfo = async () => {
    const capture = deps.capture()
    const credentials = ctx.get('credentials') as { resolve(ref: string): Promise<{ value: string } | undefined> } | undefined
    let apiKey = ''
    if (credentials) {
      try { apiKey = (await credentials.resolve('DEEPSEEK_API_KEY'))?.value ?? '' } catch { /* env fallback */ }
    }
    if (!current(capture)) return { ok: false as const, reason: 'network' as const }
    return fetchBalance(apiKey || process.env.DEEPSEEK_API_KEY || '')
  }

  const mcpStatus = (): string[] => {
    const runtime = ctx.get('tools') as { schemas(scope?: unknown): readonly { name: string; description: string }[] } | undefined
    const byServer = new Map<string, string[]>()
    for (const schema of runtime?.schemas() ?? []) {
      const match = schema.name.match(/^mcp__([a-z0-9-]+)__(.+)$/)
      if (!match) continue
      const tools = byServer.get(match[1]) ?? []
      tools.push(match[2])
      byServer.set(match[1], tools)
    }
    if (byServer.size === 0) return [
      t('mcp-none-configured'), t('mcp-insert-hint'), '  - insert:',
      '      - id: mcp-context7', "        name: '@deepseek-ai/dsh-mcp-client'",
      '        config: { transport: stdio, serverName: context7, command: npx, args: ["-y", "@upstash/context7-mcp"] }',
      t('mcp-readme-hint'),
    ]
    return [...byServer].map(([server, tools]) => t('mcp-server-tools', { server, count: tools.length, tools: tools.join(', ') }))
  }

  const firstTextOf = (content: readonly unknown[] | undefined): string => {
    for (const block of content ?? []) {
      if (block === null || typeof block !== 'object') continue
      const record = block as { type?: unknown; text?: unknown }
      if (record.type === 'text' && typeof record.text === 'string') return record.text.trim()
    }
    return ''
  }
  const textOf = (content: readonly unknown[] | undefined): string =>
    (content ?? []).flatMap(block => {
      if (block === null || typeof block !== 'object') return []
      const record = block as { type?: unknown; text?: unknown }
      return record.type === 'text' && typeof record.text === 'string' ? [record.text] : []
    }).join('').trim()

  const exportSession = (): string | null => {
    const capture = deps.capture()
    const agent = capture.agent
    const parts = [t('export-title'), '', t('export-time', { time: new Date().toLocaleString() }),
      t('export-model', { model: deps.model() }), t('export-session', { id: agent.id }), t('export-dir', { cwd: deps.cwd() }), '']
    for (const event of snapshotLiveSessionEvents(agent.session)) {
      switch (event.type) {
        case 'user/message': {
          if (event.data.source.kind !== 'user') break
          const text = firstTextOf(event.data.content)
          if (text) parts.push(`${t('export-user-section')}\n\n${text}\n`)
          break
        }
        case 'assistant/message':
          for (const block of event.data.message.content) {
            if (block.type === 'reasoning' && block.text) parts.push(`${t('export-thinking-section')}\n\n${block.text}\n`)
            else if (block.type === 'text' && block.text) parts.push(`${t('export-assistant-section')}\n\n${block.text}\n`)
          }
          break
        case 'tool/call': parts.push(`${t('export-tool-section', { name: event.data.name })}\n\n\`\`\`json\n${event.data.arguments}\n\`\`\`\n`); break
        case 'tool/result': {
          const block = event.data.message.content[0]
          if (block?.type === 'tool-result') {
            const text = textOf(block.content)
            if (text) parts.push(`${t('export-result-section')}\n\n\`\`\`\n${text}\n\`\`\`\n`)
          }
          break
        }
      }
    }
    if (!current(capture)) return null
    try {
      const target = join(deps.cwd(), `dsh-tui-export-${Date.now()}.md`)
      writeFileSync(target, parts.join('\n'), 'utf8')
      return current(capture) ? target : null
    } catch { return null }
  }

  const initWorkspace = (): string | 'exists' | null => {
    const capture = deps.capture()
    const target = join(deps.cwd(), 'AGENTS.md')
    if (!current(capture)) return null
    if (existsSync(target)) return 'exists'
    const template = ['# AGENTS.md', '', t('agentsmd-project'), '', t('agentsmd-project-body'), '', t('agentsmd-conventions'), '', t('agentsmd-convention-read'), t('agentsmd-convention-style'), ''].join('\n')
    try {
      writeFileSync(target, template, 'utf8')
      return current(capture) ? target : null
    } catch { return null }
  }

  const doctorInfo = (): string[] => {
    const lines = [
      `Node ${process.version} · ${process.platform} ${process.arch}`,
      t('doctor-api-key', { state: process.env.DEEPSEEK_API_KEY ? t('doctor-key-configured') : t('doctor-key-missing') }),
      t('doctor-model', { model: deps.model(), provider: deps.provider() }),
      t('doctor-cwd', { cwd: deps.cwd() }),
      t('doctor-context-window', { window: deps.contextWindow() ?? t('doctor-unknown') }),
      `${t('doctor-session', { id: deps.capture().agent.id })}${deps.sessionTitle() ? ` · ${deps.sessionTitle()}` : ''}`,
    ]
    for (const candidate of [join(homeDir(), '.dsh-tui/cordis.yml'), join(homeDir(), '.dsh/profiles/dsh-tui/cordis.patch.yml')]) {
      lines.push(t('doctor-config', { candidate, state: existsSync(candidate) ? '✓' : t('doctor-config-missing') }))
    }
    for (const dir of sessionsRoots()) lines.push(t('doctor-storage', { dir, state: existsSync(dir) ? '✓' : t('doctor-storage-uninit') }))
    const pluginHost = ctx.get('tuiPluginHost')
    lines.push(t('doctor-plugin-generation', { id: pluginHost?.generationId ?? t('doctor-plugin-host-missing') }))
    const violations = pluginHost?.selfCheck()
    lines.push(t('doctor-plugin-registry', { state: violations === undefined ? t('doctor-plugin-host-missing') : violations.length === 0 ? '✓' : `✗ ${violations.length}` }))
    const facade = getHostFacade(pluginHost)
    if (!facade) lines.push('Adapter kernel (P2): HostFacade unavailable')
    else {
      const diagnostics = collectAdapterDiagnostics(deps.runtime, facade.descriptor.snapshot(), getHostGrantStore(pluginHost)?.knownPermissions() ?? [])
      lines.push(`Adapter kernel (P2): mode=${diagnostics.runtime.mode} · contracts=${diagnostics.descriptor.contracts.length} · permissions=${diagnostics.permissions.length}`)
    }
    return lines
  }

  const pluginsInfo = (args: string): string[] => {
    const host = ctx.get('tuiPluginHost')
    return pluginsInfoLines(args, { grants: getHostGrantStore(host) ?? deps.grantStore(), host: host?.describe() })
  }

  return { balanceInfo, mcpStatus, exportSession, initWorkspace, doctorInfo, pluginsInfo }
}

import { setTimeout as delay } from 'node:timers/promises'
import { createInitialChannelView } from '../../lib/types/dsh-adapter/channel/state.js'
import { LOCAL_COMMANDS } from '../../lib/types/commands.js'

const supported = new Set([
  'help', 'new', 'clear', 'model', 'theme', 'vim', 'thinking', 'tokens',
  'status', 'doctor', 'lang', 'activity', 'color', 'effort', 'rename',
  'rewind', 'settings', 'config', 'mcp', 'skills',
])

/** Deterministic demo data only. This adapter never creates an Agent or tools. */
export function createDemoChannel() {
  const listeners = new Set()
  let sequence = 0
  let flight
  const channel = createInitialChannelView(
    { model: 'deepseek-v4-flash', provider: 'demo', cwd: process.cwd(), effort: 'high',
      whaleIdle: true, smoothStreaming: true, configuredLang: 'zh', pageMargin: 'slim' },
    { agentId: 'web-preview', mode: { id: 'default', sandbox: 'read-only', approval: 'ask' },
      cwdDescription: '/demo/dsh-tui' },
  )
  const bump = () => { channel.version++; for (const listener of listeners) listener() }
  const add = row => {
    const value = { id: sequence++, time: Date.now(), ...row }
    channel.rows.push(value)
    bump()
    return value
  }
  const unsupported = () => channel.notify('Demo only: this operation needs a real DSH host.')
  const empty = []
  Object.assign(channel, {
    status: 'idle', sessionTitle: 'Interactive preview', gitBranch: 'demo',
    contextWindow: 131072, autoRecapOnOpen: false,
    commandList: LOCAL_COMMANDS.filter(command => supported.has(command.name)),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    notify(text, options = {}) {
      const notice = { id: sequence++, text, color: options.color, timeoutMs: options.timeoutMs ?? 4000 }
      channel.notifications = [...channel.notifications.slice(-3), notice]
      bump()
      return () => { channel.notifications = channel.notifications.filter(item => item !== notice); bump() }
    },
    pushLocal(title, lines) { add({ kind: 'assistant', text: `### ${title}\n\n${lines.join('\n')}` }) },
    async submit(input) {
      const text = typeof input === 'string' ? input : input.text
      if (!text?.trim()) return
      if (channel.working) { channel.notify('Demo turn in progress. Interrupt before sending again.'); return }
      if (channel.rows.length > 120) { channel.notify('Demo limit reached. Start a new session.'); return }
      flight = new AbortController()
      const signal = flight.signal
      add({ kind: 'user', text: text.slice(0, 2000) })
      Object.assign(channel, { working: true, status: 'running', turnStart: Date.now(),
        lastUserText: text, spinnerMode: 'thinking', responseChars: 0 })
      const reasoning = add({ kind: 'reasoning', text: '', streaming: true })
      try {
        for (const chunk of ['This is a deterministic preview. ', 'Inspecting the example project ', 'and preparing a short summary.']) {
          await delay(180, undefined, { signal })
          reasoning.text += chunk
          bump()
        }
        reasoning.streaming = false
        reasoning.durationMs = 540
        channel.spinnerMode = 'tool'
        channel.activeToolCount = 1
        const tool = add({ kind: 'tool', text: '', tool: {
          callId: `demo-${sequence}`, name: 'Read',
          argsText: '{"file_path":"/demo/README.md"}', argsFull: '{"file_path":"/demo/README.md"}',
          status: 'running', startedAt: Date.now(),
        } })
        await delay(650, undefined, { signal })
        Object.assign(tool.tool, { status: 'ok', durationMs: 650,
          resultText: '# Demo project\n\nA terminal interface powered by React and Ink.\nNo file was read: this result is fixture data.' })
        channel.activeToolCount = 0
        channel.spinnerMode = 'requesting'
        const answer = add({ kind: 'assistant', text: '', streaming: true })
        const message = [
          '## Preview result\n\n',
          'The **real dsh-TUI screen and renderer** are running in a dedicated process.\n\n',
          '| Surface | State |\n| --- | --- |\n',
          '| Input, menus, scrolling | Live |\n',
          '| Thinking and tool cards | Scripted demo data |\n',
          '| Model API and shell | Not connected |\n\n',
          'Your message was kept inside this temporary demo session.',
        ].join('')
        for (const chunk of message.match(/[\s\S]{1,18}/g)) {
          await delay(45, undefined, { signal })
          answer.text += chunk
          channel.responseChars += chunk.length
          channel.tps = 42
          channel.tpsSamples = [...channel.tpsSamples.slice(-15), { tps: 42, at: Date.now() }]
          bump()
        }
        answer.streaming = false
        channel.tokens = { ...channel.tokens, input: channel.tokens.input + 380, output: channel.tokens.output + 128 }
        channel.lastUsage = { input: 640, output: 128, cacheRead: 256, cacheWrite: 0 }
      } catch (error) {
        if (error.name !== 'AbortError') throw error
        add({ kind: 'interrupt', text: 'Demo turn interrupted.' })
      } finally {
        for (const row of channel.rows) {
          if (row.streaming) row.streaming = false
          if (row.tool?.status === 'running') Object.assign(row.tool, { status: 'error', resultText: 'Interrupted' })
        }
        Object.assign(channel, { working: false, status: 'idle', activeToolCount: 0 })
        bump()
      }
    },
    cancel() { flight?.abort() },
    clear() { if (channel.working) return unsupported(); channel.rows = []; bump() },
    async newSession() { if (channel.working) return false; channel.clear(); return true },
    renameSession(title) { channel.sessionTitle = title; bump() },
    setSessionColor(color) { channel.sessionColor = color; bump() },
    async listModels() {
      return [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (demo)', provider: 'demo' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (demo)', provider: 'demo' },
      ]
    },
    async listProviders() { return [{ id: 'demo', name: 'Demo models' }] },
    async switchModel(provider, id) { channel.provider = provider; channel.model = id; bump(); return true },
    async listEfforts() { return { efforts: ['low', 'high', 'max'].map(id => ({ id, name: id })), defaultEffort: 'high' } },
    async setEffort(value) { channel.reasoningEffort = value; bump(); return true },
    setActivityFrames(value) { channel.activityFrames = value; bump(); return true },
    setDefaultEffort(value) { channel.reasoningEffort = value; bump() },
    invalidateModelCompletion() {},
    async promptRewind() { return null },
    async rewindTo(row) {
      const index = channel.rows.findIndex(item => item.id === row.id)
      if (index < 0 || channel.working) return null
      channel.rows = channel.rows.slice(0, index)
      bump()
      return row.kind === 'user' ? row.text : ''
    },
    doctorInfo() { return ['Runtime: real dsh-TUI renderer', 'Model: demo data only', 'Credentials: not loaded', 'Shell: disabled'] },
    settingsHost() { return undefined },
    settingsSections() { return [] },
    subscribeSettingsSections() { return () => {} },
    permissionPresets() { return { availability: 'unavailable', options: [] } },
    async cycleMode() { unsupported() },
    async runPermissionPreset() { unsupported(); return false },
    async listSkills() { return [] },
    mcpStatus() { return ['No MCP servers in the demo.'] },
    traceEvents() { return empty },
    agentViewRows() { return empty },
    subscribeAgentView() { return () => {} },
    async backgroundCurrent() { unsupported(); return { ok: false } },
    async listSessions() { return [] },
    setResumeTarget() { unsupported() },
    async resumeTo() { unsupported(); return { ok: false, reason: 'unavailable' } },
    async deleteSession() { unsupported(); return false },
    async renameSessionTo() { unsupported(); return false },
    async previewSession() { return [] },
    loadOlder() { return 0 },
    async listFiles() { return [] },
    async listFileCandidates() { return [] },
    commandCompletions() { return [] },
    stagedImageGeneration() { return 0 },
    stagedImageLimits() { return { maxImagesPerMessage: 0, maxImageBytes: 0, maxMessageImageBytes: 0, mediaTypes: [] } },
    hasStagedImage() { return false },
    stagedImage() { return undefined },
    discardStagedImage() {},
    async stageImage() { throw new Error('Image uploads are not enabled in this demo.') },
    async stageComposerImage() { throw new Error('Image uploads are not enabled in this demo.') },
    async runExternalCommandOutcome() { return { kind: 'error', text: 'External commands are not enabled in the demo.', consumeDraft: true } },
    async runExternalCommand() { return 'External commands are not enabled in the demo.' },
    async listPresets() { return [] },
    providerSetup() { return undefined },
    async describeCredential() { return undefined },
    async oauthProviderStatuses() { return [] },
    async balanceInfo() { return { ok: false, reason: 'no-key' } },
    pluginsInfo() { return ['No host plugins in the demo.'] },
    exportSession() { unsupported(); return null },
    initWorkspace() { unsupported(); return null },
    compact: unsupported,
    async listSubagents() { return ['No subagents in the demo.'] },
    async listWorkspaces() { return [] },
    workspaceCommands() { return [] },
    async resolveWorkspace() { return undefined },
    async switchWorkspace() { unsupported(); return false },
    async renameWorkspace() { unsupported(); return false },
    async runWorkspaceCommand() { unsupported(); return undefined },
    async forkSession() { unsupported(); return false },
    async buildSessionTree() { unsupported(); return null },
    async rewindToNode() { unsupported(); return null },
    async switchPreset() { unsupported(); return false },
    async dispatchBackgroundAgent() { unsupported(); return { ok: false, reason: 'unavailable' } },
    async stopBackgroundAgent() { unsupported(); return false },
    async attachToAgent() { unsupported(); return { ok: false, reason: 'unavailable' } },
    async peekAgentSession() { return [] },
    async replyToAgent() { unsupported(); return false },
    pluginScene: undefined,
    subagentControl: { interrupt() { unsupported(); return false } },
    jobControl: { kill() { unsupported(); return false } },
    async recapRecent() { return { summary: null, error: 'No model connected in the demo.' } },
    async sideQuestion() { return { answer: null, error: 'No model connected in the demo.' } },
    openPluginScene() { return false },
    closePluginScene() {},
    steer: unsupported,
    removePending() { return false },
    interruptAndDeliver() { channel.cancel(); return 0 },
  })
  for (const [method, field] of Object.entries({
    setDiffLayout: 'diffLayout', setThinkingFold: 'thinkingFold', setToolBackground: 'toolBackground',
    setScrollGutter: 'scrollGutter', setPageMargin: 'pageMargin', setFoldTerminalCommand: 'foldTerminalCommand',
    setPromptSessionLabel: 'promptSessionLabel', setExpandEditor: 'expandEditor',
    setSmoothStreaming: 'smoothStreaming', setStatusBar: 'statusBar',
    setWhale: 'whale', setWhaleIdle: 'whaleIdle', setMinimal: 'minimal',
  })) channel[method] = value => { channel[field] = value; bump() }
  return channel
}

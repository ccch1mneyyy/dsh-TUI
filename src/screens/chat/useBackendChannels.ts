import React from 'react'
import type { BackendChannelsHost, ChannelUi } from '../../adapter/ports/channel-ui.js'
import { runChannelWizard } from '../../channel/channel-wizard.js'
import type { QuestionStore } from '../../channel/questions.js'
import type { ChannelPickerRow } from '../../components/ChannelPicker.js'
import { t } from '../../i18n.js'
import type { ChatOverlayAction } from '../chatOverlay.js'
import { backendLoginLines, channelMapLines } from './backendCommands.js'

export function useBackendChannels({ channel, host, questionStore, dispatchOverlay, onRestartFreshSession, runOAuthLogin }: {
  channel: ChannelUi
  host: BackendChannelsHost | undefined
  questionStore: QuestionStore
  dispatchOverlay: React.Dispatch<ChatOverlayAction>
  onRestartFreshSession: ((notice: string) => void) | undefined
  runOAuthLogin: typeof import('../../dsh-adapter/providerWizard.js').runOAuthLogin
}) {
  const [rosterTick, refreshRoster] = React.useReducer(tick => tick + 1, 0)
  const snapshot = React.useMemo(() => host?.snapshot() ?? { channels: [], activeId: undefined }, [channel, channel.agentBindingGeneration, rosterTick])
  const rows: readonly ChannelPickerRow[] = [
    ...snapshot.channels.map((option): ChannelPickerRow => ({ kind: 'channel', option, active: option.id === snapshot.activeId })),
    { kind: 'import' },
    { kind: 'add' },
    { kind: 'manage' },
    { kind: 'view' },
  ]
  const open = (): void => {
    if (host === undefined) return
    refreshRoster()
    const fresh = host.snapshot()
    dispatchOverlay({ type: 'open', overlay: { kind: 'channel', index: Math.max(0, fresh.channels.findIndex(option => option.id === fresh.activeId)) } })
  }
  const restart = (name: string): void => {
    if (onRestartFreshSession !== undefined) {
      dispatchOverlay({ type: 'close' })
      onRestartFreshSession(t('channel-switch-restart', { name }))
    } else {
      channel.notify(t('channel-switch-restart-unavailable', { name }), { color: 'warning' })
    }
  }
  const pick = (index: number): void => {
    if (host === undefined) return
    const row = rows[index]
    if (row === undefined) return
    if (row.kind === 'channel') {
      if (row.active) { channel.notify(t('channel-already-active')); return }
      const result = host.activate(row.option.id)
      if (result.ok) {
        refreshRoster()
        if (result.restart) restart(row.option.name)
        else channel.notify(t('channel-switched', { name: row.option.name }), { color: 'success' })
      }
      return
    }
    if (row.kind === 'import') {
      if (channel.working) {
        channel.notify(t('channel-switch-while-working'), { color: 'warning' })
        return
      }
      const imported = host.importFromSettings()
      refreshRoster()
      channel.notify(imported === undefined ? t('channel-import-none') : t('channel-import-done', { name: imported.option.name }), { color: imported === undefined ? 'warning' : 'success' })
      if (imported?.restart) restart(imported.option.name)
      return
    }
    if (row.kind === 'add' || row.kind === 'manage') {
      if (channel.working) {
        channel.notify(t('channel-switch-while-working'), { color: 'warning' })
        return
      }
      dispatchOverlay({ type: 'close' })
      void runChannelWizard({
        host,
        ask: (request, options) => questionStore.ask(request, options),
        notify: (text, options) => channel.notify(text, options),
        pushLocal: (title, lines) => channel.pushLocal(title, lines),
      }).then(outcome => {
        refreshRoster()
        if (!outcome.restart) return
        const name = t('channel-wiz-active-channel')
        // A background wake can start a turn while the wizard is open.
        if (channel.working) channel.notify(t('channel-switch-restart-unavailable', { name }), { color: 'warning' })
        else restart(name)
      }).catch(() => {})
      return
    }
    dispatchOverlay({ type: 'close' })
    channel.pushLocal('/channel', channelMapLines(snapshot))
  }
  const setMode = (id: string, name: string): Promise<boolean> => {
    const modes = channel.backendModes?.()
    if (modes === undefined) return Promise.resolve(false)
    const originBinding = channel.agentBindingGeneration
    return modes.set(id).then(ok => {
      if (channel.agentBindingGeneration !== originBinding) return false
      if (ok) channel.notify(t('mode-switched', { name }), { color: 'success' })
      return ok
    })
  }
  const login = (): boolean => {
    const auth = channel.backendAuth?.()
    if (auth === undefined) return false
    const backend = channel.backendCapabilities?.backendLabel ?? ''
    void auth.status()
      .catch((error: unknown) => [t('capability-failed', { name: 'login', err: error instanceof Error ? error.message : String(error) })])
      .then(async lines => {
        channel.pushLocal('/login', backendLoginLines(backend, auth.oauth === undefined, lines))
        if (auth.oauth === undefined || auth.provider === undefined) return
        const outcome = await runOAuthLogin({
          ask: (request, options) => questionStore.ask(request, options),
          notify: (text, options) => channel.notify(text, options),
          pushLocal: (title, rows) => channel.pushLocal(title, rows),
        }, auth.oauth, auth.provider)
        if (outcome !== 'added' && outcome !== 'signed-out') return
        try {
          await auth.reconnect()
          channel.notify(t('login-backend-reconnected', { backend }), { color: 'success' })
        } catch (error) {
          channel.notify(t('login-backend-reconnect-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
        }
      }).catch(() => {})
    return true
  }
  return { rows, open, pick, setMode, login }
}

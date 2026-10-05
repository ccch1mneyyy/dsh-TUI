import type { BackendChannelsHost, BackendModesHost } from '../../adapter/ports/channel-ui.js'
import type { BackendModeOption } from '../../adapter/ports/channel-view.js'
import { t } from '../../i18n.js'
import type { ChatOverlay } from '../chatOverlay.js'

export function channelMapLines(snapshot: ReturnType<BackendChannelsHost['snapshot']>): string[] {
  const active = snapshot.channels.find(option => option.id === snapshot.activeId)
  if (active === undefined) return [t('channel-map-none')]
  const lines = [t('channel-map-heading', { name: active.name })]
  lines.push(active.models.length > 0 ? t('channel-map-models-heading') : t('channel-map-models-none'))
  for (const entry of active.models) lines.push(t('channel-map-row', { from: entry.from, to: entry.to }))
  lines.push(active.tiers.length > 0 ? t('channel-map-tiers-heading') : t('channel-map-tiers-none'))
  for (const rule of active.tiers) lines.push(t('channel-map-row', { from: rule.tier, to: rule.to }))
  lines.push(t('channel-map-file-hint'))
  return lines
}

export function parseMcpCommand(rawInput: string):
  | { kind: 'status' }
  | { kind: 'usage' }
  | { kind: 'reconnect'; name: string }
  | { kind: 'toggle'; name: string; enabled: boolean } {
  const sub = /^(reconnect|toggle)(?:\s+([\s\S]*))?$/u.exec(rawInput.trim())
  if (sub === null) return { kind: 'status' }
  const rest = (sub[2] ?? '').trim()
  if (sub[1] === 'reconnect') return rest === '' ? { kind: 'usage' } : { kind: 'reconnect', name: rest }
  const toggle = /^([\s\S]+?)\s+(on|off)$/u.exec(rest)
  return toggle === null
    ? { kind: 'usage' }
    : { kind: 'toggle', name: toggle[1]!.trim(), enabled: toggle[2] === 'on' }
}

export function backendPermissionCommand(snapshot: ReturnType<BackendModesHost['snapshot']> | undefined, rawInput: string, fallbackName: string):
  | { kind: 'status'; lines: readonly string[] }
  | { kind: 'picker'; overlay: Extract<ChatOverlay, { kind: 'mode' }> }
  | { kind: 'set'; mode: BackendModeOption }
  | { kind: 'unknown'; id: string }
  | undefined {
  if (snapshot === undefined || snapshot.modes.length === 0) return undefined
  const parts = rawInput.trim().split(/\s+/).filter(Boolean)
  const current = snapshot.modes[snapshot.currentIndex]
  if (parts[0] === 'status') return { kind: 'status', lines: [
    t('permission-mode-current', { name: current?.name ?? fallbackName }),
    t('permission-mode-switch-hint'),
  ] }
  if (parts.length === 0) return { kind: 'picker', overlay: {
    kind: 'mode',
    index: Math.max(0, snapshot.currentIndex),
    modes: snapshot.modes,
    currentId: current?.id,
  } }
  const target = snapshot.modes.find(mode => mode.id === parts[0])
  return target === undefined ? { kind: 'unknown', id: parts[0]! } : { kind: 'set', mode: target }
}

export function backendModeStatus(snapshot: ReturnType<BackendModesHost['snapshot']> | undefined, onOpen: () => void) {
  const current = snapshot?.modes[snapshot.currentIndex]
  return current === undefined ? undefined : { id: current.id, name: current.name, onOpen }
}

export function backendLoginLines(backend: string, oauthMissing: boolean, lines: readonly string[]): readonly string[] {
  return [t('login-backend-heading', { backend }), ...lines, ...(oauthMissing ? [t('login-backend-no-oauth')] : [])]
}

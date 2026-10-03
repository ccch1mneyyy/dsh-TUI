import type { BackendChannelOption } from '../adapter/ports/channel-view.js'
import { t } from '../i18n.js'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'

/**
 * `/channel` 管理向导（三期）——问句式驱动，照 providerWizard.ts 的先例：
 * 一串 QuestionStore ask（模型侧 ask_user_question 共用的那个面板），自身
 * 没有 UI 状态；全部副作用走 deps 上的通道动作（saveChannel /
 * removeChannel / setChannel / peekChannelImport），token 只经能力层进
 * 凭据库，向导与 UI 层全程见不到明文之外的东西（redact 输入直接转交）。
 *
 * 本模块 React-free，scripts/verify-claude-channels.ts 可以用脚本化答案
 * headless 驱动（同 verify-provider-wizard 的方式）。
 */

export interface ChannelWizardDeps {
  readonly ask: (
    request: AskUserQuestionRequest,
    options?: { redact?: boolean },
  ) => Promise<AskUserQuestionAnswer>
  readonly notify: (
    text: string,
    options?: { color?: 'error' | 'warning' | 'success'; timeoutMs?: number },
  ) => void
  readonly pushLocal: (title: string, lines: readonly string[]) => void
  /** Live roster (the picker's own listChannels snapshot). */
  readonly roster: () => { channels: readonly BackendChannelOption[]; activeId: string | undefined }
  /** Upsert with connection fields; undefined = the backend has no surface. */
  readonly save: (input: {
    readonly id: string
    readonly name: string
    readonly baseUrl?: string
    readonly token?: string
    readonly env?: Readonly<Record<string, string>>
    readonly models?: Readonly<Record<string, string>>
    readonly tiers?: Readonly<Record<string, string>>
  }) => BackendChannelOption | undefined
  /** Drop one channel (+ its stored token); false when absent. */
  readonly remove: (id: string) => boolean
  /** Switch activation (persist + same-call model display refresh). */
  readonly activate: (id: string) => boolean
  /** What settings.json holds for an import (absorb offer), read-only. */
  readonly peekSettings: () => { readonly baseUrl?: string; readonly tiers: Readonly<Record<string, string>> } | undefined
}

/** What the wizard did (the caller refreshes the roster; `restart` says
 * the ACTIVE connection changed and the running session cannot pick it
 * up in place — the caller routes through the fresh-session funnel). */
export interface ChannelWizardOutcome {
  readonly kind: 'saved' | 'switched' | 'deleted' | 'cancelled' | 'failed'
  readonly restart: boolean
}

const MAX_RETRY = 3
/** The edit fields' clear sentinel: typing exactly this removes the value. */
const CLEAR = '-'

function answerText(answer: AskUserQuestionAnswer, id: string): string {
  return answer.answers.find(item => item.id === id)?.custom?.trim() ?? ''
}

function answerSelected(answer: AskUserQuestionAnswer, id: string): readonly string[] {
  return answer.answers.find(item => item.id === id)?.selected ?? []
}

type WizardQuestionItem = AskUserQuestionItem & { hideCustomInput?: boolean }

function optionQuestion(
  id: string,
  question: string,
  options: readonly { label: string; description?: string }[],
  extra?: { detail?: string; hideCustomInput?: boolean },
): WizardQuestionItem {
  return {
    id,
    question,
    header: '/channel',
    options: options.map(option => ({ ...option })),
    ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra?.hideCustomInput ? { hideCustomInput: true } : {}),
  }
}

function textQuestion(id: string, question: string, detail?: string): AskUserQuestionItem {
  return {
    id,
    question,
    header: '/channel',
    ...(detail !== undefined ? { detail } : {}),
  }
}

/** Whether switching `from`→`to` keeps the SAME connection (no restart):
 * both mapping-only, or connection fingerprints equal. Pure — the picker's
 * switch rows share it for the restart-vs-refresh decision. */
export function sameOptionConnection(
  from: BackendChannelOption | undefined,
  to: BackendChannelOption | undefined,
): boolean {
  if (from === undefined || to === undefined) return from === to
  if (from.connection === undefined || to.connection === undefined) return from.connection === to.connection
  return from.connection.fingerprint === to.connection.fingerprint
}

/** Run the /channel management wizard (the picker's add/manage rows). */
export async function runChannelWizard(deps: ChannelWizardDeps): Promise<ChannelWizardOutcome> {
  const { ask, notify } = deps
  let managing = false
  try {
    const actionAnswer = await ask({
      questions: [optionQuestion('action', t('channel-wiz-q-action'), [
        { label: t('channel-wiz-opt-add'), description: t('channel-wiz-opt-add-desc') },
        { label: t('channel-wiz-opt-manage'), description: t('channel-wiz-opt-manage-desc') },
      ], { hideCustomInput: true })],
    })
    managing = answerSelected(actionAnswer, 'action')[0] === t('channel-wiz-opt-manage')
    return await (managing ? runManageFlow(deps) : runAddFlow(deps))
  } catch (error) {
    if (error instanceof UserQuestionError) {
      notify(t('channel-wiz-cancelled'))
      return { kind: 'cancelled', restart: false }
    }
    const err = error instanceof Error ? error.message : String(error)
    notify(t('capability-failed', { name: 'channel', err }), { color: 'error', timeoutMs: 8000 })
    return { kind: 'failed', restart: false }
  }
}

/** The add flow: name → base URL → token (redact) → tier source → switch.
 * Esc anywhere cancels with nothing written. */
async function runAddFlow(deps: ChannelWizardDeps): Promise<ChannelWizardOutcome> {
  const { ask, notify, pushLocal } = deps
  // ── 1. name (validated, retry ≤3) ────────────────────────────────
  let name = ''
  for (let attempt = 0; attempt < MAX_RETRY && name === ''; attempt += 1) {
    const nameAnswer = await ask({ questions: [textQuestion('name', t('channel-wiz-q-name'), t('channel-wiz-q-name-detail'))] })
    name = answerText(nameAnswer, 'name')
    if (name === '') notify(t('channel-wiz-name-required'), { color: 'warning' })
  }
  if (name === '') return { kind: 'cancelled', restart: false }
  const id = channelWizardSlug(name)
  // ── 2. base URL (blank = skip) ──────────────────────────────────
  const settings = deps.peekSettings()
  const urlAnswer = await ask({
    questions: [textQuestion('baseurl', t('channel-wiz-q-baseurl'), t('channel-wiz-q-baseurl-detail', { current: settings?.baseUrl ?? '' }))],
  })
  const baseUrl = answerText(urlAnswer, 'baseurl')
  // ── 3. token (redact, blank = skip) ─────────────────────────────
  const tokenAnswer = await ask(
    { questions: [textQuestion('token', t('channel-wiz-q-token'), t('channel-wiz-q-token-detail'))] },
    { redact: true },
  )
  const token = answerText(tokenAnswer, 'token')
  // ── 4. tier source (absorb from settings env / skip) ────────────
  let tiers: Readonly<Record<string, string>> | undefined
  const absorbable = settings !== undefined && Object.keys(settings.tiers).length > 0
  if (absorbable) {
    const tierAnswer = await ask({
      questions: [optionQuestion('tiers', t('channel-wiz-q-tiers'), [
        { label: t('channel-wiz-opt-tiers-absorb'), description: t('channel-wiz-opt-tiers-absorb-desc', { n: String(Object.keys(settings.tiers).length) }) },
        { label: t('channel-wiz-opt-tiers-skip'), description: t('channel-wiz-opt-tiers-skip-desc') },
      ], { hideCustomInput: true })],
    })
    if (answerSelected(tierAnswer, 'tiers')[0] === t('channel-wiz-opt-tiers-absorb')) tiers = settings.tiers
  }
  // ── 5. confirm + save ───────────────────────────────────────────
  pushLocal('/channel', buildSummary(name, baseUrl !== '', token !== '', tiers))
  const before = deps.roster()
  const saved = deps.save({
    id, name,
    ...(baseUrl === '' ? {} : { baseUrl }),
    ...(token === '' ? {} : { token }),
    ...(tiers === undefined ? {} : { tiers }),
  })
  if (saved === undefined) {
    notify(t('channel-wiz-save-failed'), { color: 'error', timeoutMs: 8000 })
    return { kind: 'failed', restart: false }
  }
  notify(t('channel-wiz-saved', { name }), { color: 'success' })
  // ── 6. switch now? ──────────────────────────────────────────────
  const activeBefore = before.channels.find(option => option.id === before.activeId)
  // The save may have overwritten the ACTIVE row itself (same name → same
  // id, or an explicit clash confirmation): its connection then changed on
  // disk even when the user declines the switch, and the running child
  // still holds the old one — the funnel is owed regardless (R3-2/R3-4).
  const overwroteActive = activeBefore !== undefined && activeBefore.id === id
  const activeConnectionChanged = overwroteActive && !sameOptionConnection(activeBefore, saved)
  const switchAnswer = await ask({
    questions: [optionQuestion('switch', t('channel-wiz-q-switch', { name }), [
      { label: t('channel-wiz-opt-switch-yes') },
      { label: t('channel-wiz-opt-switch-no') },
    ], { hideCustomInput: true })],
  })
  if (answerSelected(switchAnswer, 'switch')[0] !== t('channel-wiz-opt-switch-yes')) return { kind: 'saved', restart: activeConnectionChanged }
  deps.activate(id)
  return { kind: 'switched', restart: !sameOptionConnection(activeBefore, saved) }
}

/** The manage flow: pick a channel, then ONE targeted edit (applies
 * immediately, providerWizard's edit-menu precedent) or delete. */
async function runManageFlow(deps: ChannelWizardDeps): Promise<ChannelWizardOutcome> {
  const { ask, notify } = deps
  const roster = deps.roster()
  if (roster.channels.length === 0) {
    notify(t('channel-wiz-empty'), { color: 'warning' })
    return { kind: 'cancelled', restart: false }
  }
  const pickAnswer = await ask({
    questions: [optionQuestion('pick', t('channel-wiz-q-pick'),
      roster.channels.map(option => ({
        label: option.name,
        description: option.connection?.baseUrl ?? t('channel-wiz-row-mapping-only'),
      })), { hideCustomInput: true })],
  })
  const pickedLabel = answerSelected(pickAnswer, 'pick')[0]
  const target = roster.channels.find(option => option.name === pickedLabel)
  if (target === undefined) return { kind: 'cancelled', restart: false }
  const menuAnswer = await ask({
    questions: [optionQuestion('edit', t('channel-wiz-q-edit', { name: target.name }), [
      { label: t('channel-wiz-opt-edit-baseurl'), description: target.connection?.baseUrl ?? t('channel-wiz-row-mapping-only') },
      { label: t('channel-wiz-opt-edit-token'), description: target.connection?.hasToken === true ? t('channel-wiz-token-present') : t('channel-wiz-token-absent') },
      { label: t('channel-wiz-opt-edit-tiers'), description: t('channel-wiz-opt-edit-tiers-desc', { n: String(target.tiers.length) }) },
      { label: t('channel-wiz-opt-edit-delete'), description: t('channel-wiz-opt-edit-delete-desc') },
      { label: t('channel-wiz-opt-edit-done') },
    ], { hideCustomInput: true })],
  })
  const pick = answerSelected(menuAnswer, 'edit')[0]
  const isActive = roster.activeId === target.id
  if (pick === t('channel-wiz-opt-edit-delete')) {
    const confirmAnswer = await ask({
      questions: [optionQuestion('confirm', t('channel-wiz-q-delete', { name: target.name }), [
        { label: t('channel-wiz-opt-delete-yes') },
        { label: t('channel-wiz-opt-delete-no') },
      ], { hideCustomInput: true })],
    })
    if (answerSelected(confirmAnswer, 'confirm')[0] !== t('channel-wiz-opt-delete-yes')) return { kind: 'cancelled', restart: false }
    if (!deps.remove(target.id)) {
      notify(t('channel-wiz-save-failed'), { color: 'error', timeoutMs: 8000 })
      return { kind: 'failed', restart: false }
    }
    notify(t('channel-wiz-deleted', { name: target.name }), { color: 'success' })
    // Deleting the ACTIVE channel with a connection severs what the RUNNING
    // child still holds: erasing the token and the profile row cannot reach
    // the live process, so the next message would keep riding the deleted
    // connection — that is a connection change, routed through the
    // fresh-session funnel (R3-2). A mapping-only row never shaped the
    // spawn, so deleting it changes nothing the child sees.
    return { kind: 'deleted', restart: isActive && target.connection !== undefined }
  }
  if (pick === t('channel-wiz-opt-edit-baseurl')) {
    const answer = await ask({ questions: [textQuestion('value', t('channel-wiz-q-baseurl'), t('channel-wiz-q-edit-value-hint'))] })
    const value = answerText(answer, 'value')
    if (value === '') return { kind: 'cancelled', restart: false }
    const saved = deps.save({ id: target.id, name: target.name, ...(value === CLEAR ? { baseUrl: '' } : { baseUrl: value }) })
    if (saved === undefined) return { kind: 'failed', restart: false }
    notify(t('channel-wiz-saved', { name: target.name }), { color: 'success' })
    return { kind: 'saved', restart: isActive && !sameOptionConnection(target, saved) }
  }
  if (pick === t('channel-wiz-opt-edit-token')) {
    const answer = await ask(
      { questions: [textQuestion('value', t('channel-wiz-q-token'), t('channel-wiz-q-edit-value-hint'))] },
      { redact: true },
    )
    const value = answerText(answer, 'value')
    if (value === '') return { kind: 'cancelled', restart: false }
    const saved = deps.save({ id: target.id, name: target.name, ...(value === CLEAR ? { token: '' } : { token: value }) })
    if (saved === undefined) return { kind: 'failed', restart: false }
    notify(t('channel-wiz-saved', { name: target.name }), { color: 'success' })
    return { kind: 'saved', restart: isActive && !sameOptionConnection(target, saved) }
  }
  if (pick === t('channel-wiz-opt-edit-tiers')) {
    const settings = deps.peekSettings()
    if (settings === undefined || Object.keys(settings.tiers).length === 0) {
      notify(t('channel-import-none'), { color: 'warning' })
      return { kind: 'cancelled', restart: false }
    }
    const saved = deps.save({ id: target.id, name: target.name, tiers: settings.tiers })
    if (saved === undefined) return { kind: 'failed', restart: false }
    notify(t('channel-wiz-saved', { name: target.name }), { color: 'success' })
    return { kind: 'saved', restart: false }
  }
  return { kind: 'cancelled', restart: false }
}

function buildSummary(name: string, hasUrl: boolean, hasToken: boolean, tiers: Readonly<Record<string, string>> | undefined): readonly string[] {
  const lines = [t('channel-wiz-summary-heading', { name })]
  lines.push(hasUrl ? t('channel-wiz-summary-url-set') : t('channel-wiz-summary-url-skip'))
  lines.push(hasToken ? t('channel-wiz-summary-token-set') : t('channel-wiz-summary-token-skip'))
  lines.push(tiers !== undefined
    ? t('channel-wiz-summary-tiers', { n: String(Object.keys(tiers).length) })
    : t('channel-wiz-summary-tiers-none'))
  lines.push(t('channel-wiz-summary-store'))
  return lines
}

/** The wizard's slug of a channel name — identical to the backend's
 * channelSlug (restated so this module never imports the backend). */
function channelWizardSlug(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'channel' : slug
}

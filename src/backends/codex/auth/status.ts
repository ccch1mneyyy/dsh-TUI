/** /login's three methods over the shared question UI. API-key answers go
 * directly to auth; events contain only the secret question and settlement. */
import { randomUUID } from 'node:crypto'
import type { QuestionAnswers, SessionCapabilities } from '../../../agent/capabilities.js'
import type { AgentEvent, QuestionItemView } from '../../../agent/events.js'
import { t } from '../../../i18n.js'
import { CODEX_OAUTH_PROVIDER, type CodexAuthRuntime } from './external-tokens.js'

export interface CodexAuthCapabilityBridge {
  readonly capability: NonNullable<SessionCapabilities['auth']> & {
    login(loginOAuth?: () => Promise<boolean>): Promise<void>
  }
  /** True means this was our prompt, so do not pass it to native approvals. */
  respondQuestion(requestId: string, answers: QuestionAnswers): boolean
  cancelQuestion(requestId: string): boolean
  /** Withdraw current prompts without preventing login after a reconnect. */
  withdrawAll(): void
  dispose(): void
}

export function createCodexAuthCapability(runtime: CodexAuthRuntime, emit: (events: readonly AgentEvent[]) => void): CodexAuthCapabilityBridge {
  const pending = new Map<string, (answers: QuestionAnswers | undefined) => void>()
  let disposed = false
  let running: Promise<void> | undefined
  const settle = (id: string, answers?: QuestionAnswers): boolean => {
    const resolve = pending.get(id)
    if (resolve === undefined) return false
    pending.delete(id)
    emit([{ type: 'question.settled', requestId: id }])
    resolve(answers)
    return true
  }
  const ask = (question: QuestionItemView) => {
    const id = 'codex-login:' + randomUUID()
    const answer = disposed ? Promise.resolve(undefined) : new Promise<QuestionAnswers | undefined>(resolve => {
      pending.set(id, resolve)
      emit([{ type: 'question.request', request: { requestId: id, questions: [question] } }])
    })
    return { answer, withdraw: () => { settle(id) } }
  }
  const notice = (level: 'info' | 'warning' | 'error', text: string): void => {
    if (!disposed) emit([{ type: 'notice', level, key: 'codex-login', text }])
  }
  const login = async (loginOAuth?: () => Promise<boolean>): Promise<void> => {
    if (disposed) return
    if (runtime.source === 'channel') { notice('warning', t('codex-auth-channel-active')); return }
    const methods = [
      ...(loginOAuth === undefined ? [] : [{ id: 'oauth', label: t('codex-login-oauth'), description: t('codex-login-oauth-desc') }]),
      { id: 'device', label: t('codex-login-device'), description: t('codex-login-device-desc') },
      { id: 'api-key', label: t('codex-login-api-key'), description: t('codex-login-api-key-storage') },
    ]
    const selection = await ask({ header: 'Codex', question: t('codex-login-choose'), options: methods.map(({ label, description }) => ({ label, description })), hideCustomInput: true }).answer
    const label = selection?.answers[0]?.selected[0]
    const method = methods.find(row => row.label === label)?.id
    if (disposed || method === undefined) return
    try {
      if (method === 'oauth') {
        if (!runtime.route.firstParty) { notice('warning', t('codex-auth-route-blocked')); return }
        if (await loginOAuth?.() !== true || disposed) return
        await runtime.reconnect()
        notice(runtime.source === 'dsh-auth' ? 'info' : 'error', t(runtime.source === 'dsh-auth' ? 'codex-login-success' : 'codex-auth-login-failed'))
        return
      }
      if (method === 'api-key') {
        const answers = await ask({ header: 'Codex', question: t('codex-login-api-key-prompt'), detail: t('codex-login-api-key-storage'), options: [], secret: true }).answer
        if (answers === undefined || disposed) return
        const apiKey = answers.answers[0]?.custom
        if (apiKey === undefined || apiKey.trim() === '') { notice('warning', t('codex-auth-api-key-required')); return }
        await runtime.apiKeyLogin(apiKey)
        notice('info', t('codex-login-success'))
        return
      }
      const device = await runtime.deviceLogin()
      if (disposed) { await device.cancel(); return }
      const prompt = ask({ header: 'Codex', question: t('codex-login-device-code', { code: device.userCode }), detail: t('codex-login-device-wait'), link: device.verificationUrl, options: [{ label: t('codex-login-cancel') }], hideCustomInput: true })
      const outcome = await Promise.race([
        device.done.then(success => ({ kind: 'done' as const, success })),
        prompt.answer.then(() => ({ kind: 'cancel' as const })),
      ])
      if (outcome.kind === 'cancel') await device.cancel()
      else {
        prompt.withdraw()
        notice(outcome.success ? 'info' : 'error', t(outcome.success ? 'codex-login-success' : 'codex-auth-login-failed'))
      }
    } catch { notice('error', t('codex-auth-login-failed')) }
  }
  return {
    capability: {
      oauthProvider: CODEX_OAUTH_PROVIDER,
      status: () => runtime.status(),
      reconnect: () => runtime.reconnect(),
      login: loginOAuth => {
        if (running === undefined) running = login(loginOAuth).finally(() => { running = undefined })
        return running
      },
    },
    respondQuestion: (id, answers) => settle(id, answers),
    cancelQuestion: id => settle(id),
    withdrawAll() { for (const id of pending.keys()) settle(id) },
    dispose() {
      for (const id of pending.keys()) settle(id)
      disposed = true
    },
  }
}

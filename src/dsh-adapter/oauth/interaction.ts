/**
 * The `AuthInteraction` bridge: pi-ai OAuth flows speak prompts and events;
 * every interactive surface in this ecosystem speaks `ctx.userQuestions`.
 *
 * `prompt()` maps one pi-ai prompt onto one question — `select` prompts carry
 * their options, text/secret/manual-code prompts expect the custom-answer
 * input row.
 *
 * `notify()` opens browser/device URLs for pi-ai. Browser flows immediately
 * race a callback server against a `manual_code` prompt; the URL and
 * copy/reopen/cancel actions therefore share that SAME question with the
 * paste field. A separate waiting question would claim the FIFO question
 * surface first and make remote/headless callback fallback unreachable.
 * Browser flows without a manual prompt still get a waiting panel. Device
 * flows use that panel to show/copy the short code until polling settles.
 *
 * One `AbortController` owns the whole run: pi-ai reads `interaction.signal`
 * to abort the flow, ask requests compose it with per-prompt cancellation,
 * and the waiting panel's cancel action fires it.
 *
 * Nothing here assumes a browser or GUI *exists* (TUI-RUN-001): when no
 * opener or clipboard helper is available the panel degrades to showing the
 * URL / code verbatim with a clear note, and where no question provider is
 * registered at all, `ask` rejects and the login command turns that into a
 * clear refusal.
 *
 * @module @deepseek-harness-tui/dsh-tui/oauth/interaction
 */

import type { AskUserQuestionItem, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { t } from '../../i18n.js'
import { copyToClipboard, openInBrowser } from './opener.js'
import type { PiAiAuthEvent, PiAiAuthInteraction, PiAiAuthPrompt } from './pi-ai.js'

/** The ask surface this bridge drives (usually `ctx.userQuestions.ask`). */
export type AskFn = (request: {
  questions: AskUserQuestionItem[]
  signal?: AbortSignal
}) => Promise<AskUserQuestionAnswer>

/** Injectable host conveniences (tests substitute recorders). */
export interface QuestionBridgeHelpers {
  openUrl?: (url: string) => boolean
  copyText?: (text: string) => Promise<boolean>
}

/** Human-readable copy for one notify event. */
export function describeEvent(event: PiAiAuthEvent): string {
  switch (event.type) {
    case 'auth_url':
      return t('oauth-event-auth-url', { url: event.url })
    case 'device_code':
      return t('oauth-event-device-code', { uri: event.verificationUri, code: event.userCode })
    case 'info':
    case 'progress':
      return event.message
  }
}

/** One answer row, or a thrown error when the surface returned nothing usable. */
function singleAnswer(answer: AskUserQuestionAnswer): { selected: string | undefined; custom: string | undefined } {
  const row = answer.answers[0]
  if (row === undefined) throw new Error('dsh-auth: the question surface returned no answer')
  return { selected: row.selected[0], custom: row.custom }
}

/** The waiting panel one event kind renders: body plus copy/reopen targets. */
interface WaitingView {
  kind: 'auth_url' | 'device_code'
  /** Base body, shown below the standing question line. */
  body: string
  /** What a copy action copies; also its action label. */
  copyLabel: string
  copyText: string
  reopenLabel: string
  cancelLabel: string
  /** What the reopen action opens. */
  reopenUrl: string
}

function authUrlView(url: string, instructions: string | undefined, opened: boolean, notice: string | undefined): WaitingView {
  const lead = opened
    ? `${t('oauth-auth-url-opened')}\n${t('oauth-auth-url-opened-fallback')}`
    : `${t('oauth-auth-url-manual')}\n${t('oauth-auth-url-copy-hint')}`
  const body = [notice, lead, instructions, url].filter(part => part !== undefined && part !== '').join('\n')
  return {
    kind: 'auth_url', body, copyLabel: t('oauth-copy-link'), copyText: url,
    reopenLabel: t('oauth-open-again'), cancelLabel: t('oauth-cancel'), reopenUrl: url,
  }
}

function deviceCodeView(userCode: string, verificationUri: string, opened: boolean): WaitingView {
  const lead = opened
    ? t('oauth-device-opened', { uri: verificationUri })
    : t('oauth-device-manual', { uri: verificationUri })
  return {
    kind: 'device_code', body: `${lead}\n  ${userCode}`,
    copyLabel: t('oauth-copy-code'), copyText: userCode,
    reopenLabel: t('oauth-open-again'), cancelLabel: t('oauth-cancel'), reopenUrl: verificationUri,
  }
}

/**
 * The bridge for one login run. At most one waiting panel exists at a time;
 * `settle()` retires it when the flow ends (any outcome), so a completed or
 * failed login never leaves an interactive dead end on screen.
 */
export class QuestionBridge implements PiAiAuthInteraction {
  readonly signal: AbortSignal
  private readonly openUrl: (url: string) => boolean
  private readonly copy: (text: string) => Promise<boolean>
  private waiting: {
    controller: AbortController
    answer: Promise<ReturnType<typeof singleAnswer> | undefined>
  } | undefined
  private pendingBrowserView: WaitingView | undefined
  private notice: string | undefined
  private waitingClosed = false

  constructor(
    private readonly ask: AskFn,
    private readonly runAbort: AbortController,
    helpers: QuestionBridgeHelpers = {},
  ) {
    this.signal = runAbort.signal
    this.openUrl = helpers.openUrl ?? openInBrowser
    this.copy = helpers.copyText ?? copyToClipboard
  }

  async prompt(prompt: PiAiAuthPrompt): Promise<string> {
    if (this.waitingClosed) throw new Error('Login cancelled')
    const browserView = prompt.type === 'manual_code' ? this.pendingBrowserView : undefined
    if (browserView !== undefined) {
      this.pendingBrowserView = undefined
      await this.retireWaiting()
    }
    // pi-ai's callback race supplies a per-prompt abort signal. It must not
    // replace the login-wide signal: cancelling either one closes the ask.
    const signal = prompt.signal === undefined ? this.signal : AbortSignal.any([prompt.signal, this.signal])
    const secretNote = prompt.type === 'secret' ? t('oauth-secret-unmasked') : ''
    let actionNote: string | undefined
    while (true) {
      if (this.waitingClosed) throw new Error('Login cancelled')
      signal.throwIfAborted()
      const question: AskUserQuestionItem = prompt.type === 'select'
        ? {
          id: 'dsh-auth-prompt',
          header: 'dsh-auth',
          question: prompt.message,
          options: prompt.options.map(option => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        }
        : {
          id: 'dsh-auth-prompt',
          header: 'dsh-auth',
          question: prompt.message,
          ...(browserView === undefined
            ? (prompt.placeholder === undefined
              ? (secretNote === '' ? {} : { detail: secretNote })
              : { detail: [prompt.placeholder, secretNote].filter(part => part !== '').join('\n') })
            : {
              detail: [actionNote, browserView.body].filter(part => part !== undefined).join('\n'),
              options: [
                { label: browserView.copyLabel },
                { label: browserView.reopenLabel },
                { label: browserView.cancelLabel },
              ],
            }),
        }
      let answer: ReturnType<typeof singleAnswer>
      try {
        answer = singleAnswer(await this.ask({ questions: [question], signal }))
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null
          && (error as { code?: unknown }).code === 'ASK_CANCELLED') {
          this.runAbort.abort('user cancelled sign-in')
        }
        throw error
      }
      signal.throwIfAborted()
      if (prompt.type === 'select') {
        const label = answer.selected
        const option = label === undefined ? undefined : prompt.options.find(candidate => candidate.label === label)
        if (option === undefined) {
          if (answer.custom !== undefined && answer.custom !== '') return answer.custom
          throw new Error('dsh-auth: the selection answer did not match an offered option')
        }
        return option.id
      }
      // The TUI may attach the focused option label while typing on it;
      // entered callback text takes precedence over a copy/reopen action.
      const custom = answer.custom?.trim()
      if (custom !== undefined && custom !== '') return custom
      if (browserView === undefined) throw new Error('dsh-auth: the text answer was empty')
      if (answer.selected === browserView.copyLabel) {
        const copied = await this.copy(browserView.copyText).catch(() => false)
        actionNote = t(copied ? 'oauth-copied' : 'oauth-copy-failed')
        continue
      }
      if (answer.selected === browserView.reopenLabel) {
        const opened = this.openUrl(browserView.reopenUrl)
        actionNote = t(opened ? 'oauth-reopened' : 'oauth-open-failed')
        continue
      }
      if (answer.selected === browserView.cancelLabel) {
        this.runAbort.abort('user cancelled sign-in')
        throw new Error('Login cancelled')
      }
      throw new Error('dsh-auth: the authorization question returned no action or code')
    }
  }

  notify(event: PiAiAuthEvent): void {
    if (this.waitingClosed || this.signal.aborted) return
    if (event.type === 'info') {
      this.notice = event.message
      return
    }
    if (event.type === 'auth_url') {
      if (this.pendingBrowserView !== undefined) return
      const opened = this.openUrl(event.url)
      const view = authUrlView(event.url, event.instructions, opened, this.notice)
      this.notice = undefined
      this.pendingBrowserView = view
      // Current pi-ai browser flows call manual_code synchronously after
      // notify. Defer the fallback panel one microtask so that prompt can
      // consume this view without placing a second ask in the FIFO queue.
      queueMicrotask(() => {
        if (this.pendingBrowserView === view && !this.waitingClosed) {
          void this.runWaitingPanel(view).catch(() => this.runAbort.abort('authorization panel failed'))
        }
      })
      return
    }
    if (event.type === 'device_code') {
      if (this.waiting !== undefined) return
      const opened = this.openUrl(event.verificationUri)
      void this.runWaitingPanel(deviceCodeView(event.userCode, event.verificationUri, opened))
        .catch(() => this.runAbort.abort('authorization panel failed'))
    }
    // Progress lines are transient; the flow's next prompt or waiting panel
    // carries the actionable state.
  }

  /** Close the waiting panel (if any) and stop answering for this run. */
  async settle(): Promise<void> {
    this.waitingClosed = true
    this.pendingBrowserView = undefined
    await this.retireWaiting()
    this.waiting = undefined
  }

  private async retireWaiting(): Promise<void> {
    const waiting = this.waiting
    waiting?.controller.abort()
    await waiting?.answer
  }

  /**
   * Show the waiting panel until the flow settles or the user cancels,
   * re-asking after a copy/reopen action with a one-line status prefix.
   */
  private async runWaitingPanel(view: WaitingView): Promise<void> {
    let body = view.body
    const active = () => !this.waitingClosed && !this.signal.aborted
      && (view.kind === 'device_code' || this.pendingBrowserView === view)
    while (active()) {
      const controller = new AbortController()
      const answer = this.ask({
        questions: [{
          id: 'dsh-auth-waiting',
          header: 'dsh-auth',
          question: t('oauth-waiting'),
          detail: body,
          options: [
            { label: view.copyLabel },
            { label: view.reopenLabel },
            { label: view.cancelLabel },
          ],
        }],
        signal: AbortSignal.any([controller.signal, this.signal]),
      })
        .then(singleAnswer)
        .catch(() => {
          if (!controller.signal.aborted && active()) this.runAbort.abort('authorization panel was dismissed')
          return undefined
        })
      this.waiting = { controller, answer }
      const response = await answer
      if (this.waiting?.controller === controller) this.waiting = undefined
      if (response === undefined || !active()) return
      if (response.selected === undefined) {
        body = `${t('oauth-choose-action')}\n${view.body}`
        continue
      }
      if (response.selected === view.cancelLabel) {
        this.runAbort.abort('user cancelled sign-in')
        return
      }
      if (response.selected === view.copyLabel) {
        const copied = await this.copy(view.copyText).catch(() => false)
        body = `${t(copied ? 'oauth-copied' : 'oauth-copy-failed')}\n${view.body}`
        continue
      }
      if (response.selected === view.reopenLabel) {
        const opened = this.openUrl(view.reopenUrl)
        body = `${t(opened ? 'oauth-reopened' : 'oauth-open-failed')}\n${view.body}`
      }
    }
  }
}

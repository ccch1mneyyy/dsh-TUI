import type { AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account'
import { deepSeekClientMetadata } from './deepseek.js'

/** Structural public rc.2 protocol; older hosts do not export its types. */
export interface AccountNotificationNotice {
  readonly kind: 'account-notification'
  readonly orderId: string
  readonly title: string
  readonly body: string
  readonly displayUntil: string | null
  readonly amount?: string
  readonly currency?: 'CNY' | 'USD'
  readonly expiresAt?: string
  readonly actions: readonly {
    readonly label: string
    readonly style: 'primary' | 'secondary'
    readonly target: { readonly type: 'dismiss' } | { readonly type: 'app_route'; readonly name: 'account' }
  }[]
}

interface NotificationContent extends Omit<AccountNotificationNotice, 'kind' | 'orderId'> {
  readonly id: string
  readonly data?: unknown
}

export interface AccountNotifications {
  getNotifications(client: AccountClientMetadata): Promise<{
    readonly nextPollAfterSeconds: number
    readonly notifications: readonly NotificationContent[]
  } | null>
  getNotificationContent(id: string, client: AccountClientMetadata): Promise<NotificationContent | null>
  reportNotificationEvent(id: string, event: 'displayed' | 'cta_clicked' | 'dismissed', client: AccountClientMetadata): Promise<boolean>
}

export function accountNotificationsOf(account: unknown): AccountNotifications | undefined {
  const value = account as Partial<AccountNotifications> | null | undefined
  return typeof value?.getNotifications === 'function'
    && typeof value.getNotificationContent === 'function'
    && typeof value.reportNotificationEvent === 'function' ? value as AccountNotifications : undefined
}

const expired = (notice: AccountNotificationNotice): boolean => notice.displayUntil !== null
  && Date.parse(notice.displayUntil) <= Date.now()
// Preserve the existing coupon presentation only for explicit complete data.
// These optional business fields are not inferred from localized server copy.
function couponFields(data: unknown): Pick<AccountNotificationNotice, 'amount' | 'currency' | 'expiresAt'> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
  const value = data as Record<string, unknown>
  const expiresAt = value.expiresAt ?? value.expires_at
  return value.campaign === 'dsh_login_bonus' && typeof value.amount === 'string'
    && (value.currency === 'CNY' || value.currency === 'USD') && typeof expiresAt === 'string'
    && (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) > Date.now())
    ? { amount: value.amount, currency: value.currency, expiresAt } : {}
}
const noticeOf = (content: NotificationContent): AccountNotificationNotice => ({
  kind: 'account-notification', orderId: content.id, title: content.title,
  body: content.body, displayUntil: content.displayUntil, actions: content.actions,
  ...couponFields(content.data),
})

/** Account-owned cards: reads never acknowledge; only the presented card reports display. */
export class AccountNotificationStore {
  private account: AccountNotifications | undefined
  private generation = 0
  private pollEpoch = 0
  private localeGeneration = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private intervalMs = 600_000
  private cards: readonly AccountNotificationNotice[] = []
  private readonly displayed = new Set<string>()

  constructor(private readonly changed: () => void, private readonly diagnose: (operation: 'read' | 'content' | 'report') => void = () => {}) {}

  getSnapshot(): AccountNotificationNotice | null { return this.cards[0] ?? null }

  begin(account: AccountNotifications): void {
    if (this.account === account) return
    this.clear()
    this.account = account
    void this.poll(this.generation)
  }

  /** Explicit refresh uses the same generation fence and server-paced poll. */
  async refresh(account: AccountNotifications): Promise<void> {
    if (this.account !== account) { this.clear(); this.account = account }
    else {
      this.generation++
      if (this.timer !== undefined) clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.poll(this.generation)
  }

  clear(): void {
    this.generation++
    this.localeGeneration++
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer)
    this.timer = undefined
    this.expiryTimer = undefined
    this.account = undefined
    this.intervalMs = 600_000
    this.displayed.clear()
    this.publish([])
  }

  /** A language change refreshes content without consuming it or changing card order. */
  async localeChanged(): Promise<void> {
    const account = this.account
    if (account === undefined) return
    const generation = this.generation
    const localeGeneration = ++this.localeGeneration
    const updates = await Promise.allSettled(this.cards.map(card => account.getNotificationContent(card.orderId, deepSeekClientMetadata())))
    if (generation !== this.generation || localeGeneration !== this.localeGeneration) return
    if (updates.some(update => update.status === 'rejected')) this.diagnose('content')
    const byId = new Map(updates.flatMap(update => update.status === 'fulfilled' && update.value !== null
      ? [[update.value.id, noticeOf(update.value)] as const] : []))
    this.publish(this.cards.map(card => {
      const content = byId.get(card.orderId)
      // Like the public controller, content refresh changes localized copy
      // only. The list owns deadlines and optional business metadata.
      return content === undefined ? card : { ...card, title: content.title, body: content.body, actions: content.actions }
    }).filter(card => !expired(card)))
  }

  shown(id: string): void {
    this.dropExpired()
    if (this.cards[0]?.orderId !== id || this.displayed.has(id)) return
    this.displayed.add(id)
    this.report(id, 'displayed')
  }

  dismiss(id: string): void {
    this.dropExpired()
    if (this.cards[0]?.orderId !== id) return
    // A poll issued before this dismissal must not publish its stale reply:
    // the closed card would reappear and report `displayed` again. Expiry and
    // account cleanup fence polls through `generation`; a dismissal keeps the
    // same account lifetime, so it needs its own fence.
    this.pollEpoch++
    this.report(id, 'dismissed')
    this.publish(this.cards.slice(1))
  }

  private report(id: string, event: 'displayed' | 'dismissed'): void {
    // Server acceptance controls consumption; a failed report never fabricates success.
    void this.account?.reportNotificationEvent(id, event, deepSeekClientMetadata()).catch(() => { this.diagnose('report'); return false })
  }

  private dropExpired(): void { this.publish(this.cards.filter(card => !expired(card))) }

  private publish(cards: readonly AccountNotificationNotice[]): void {
    // Preserve React external-store snapshot identity for unchanged server copies.
    const previous = new Map(this.cards.map(card => [card.orderId, card]))
    cards = cards.map(card => {
      const old = previous.get(card.orderId)
      return old !== undefined && JSON.stringify(old) === JSON.stringify(card) ? old : card
    })
    if (cards.length === this.cards.length && cards.every((card, index) => card === this.cards[index])) return
    const ids = new Set(cards.map(card => card.orderId))
    for (const id of this.displayed) if (!ids.has(id)) this.displayed.delete(id)
    this.cards = cards
    this.scheduleExpiry()
    this.changed()
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    const deadlines = this.cards.flatMap(card => {
      const at = card.displayUntil === null ? NaN : Date.parse(card.displayUntil)
      return Number.isFinite(at) ? [at] : []
    })
    if (deadlines.length > 0) {
      this.expiryTimer = setTimeout(() => {
        this.expiryTimer = undefined
        this.dropExpired()
        // A capped timer can wake before the deadline while polling is pending.
        this.scheduleExpiry()
      }, Math.min(2_147_483_647, Math.max(1, Math.min(...deadlines) - Date.now())))
      this.expiryTimer.unref?.()
    }
  }

  private async poll(generation: number): Promise<void> {
    const account = this.account
    if (account === undefined || generation !== this.generation) return
    const localeGeneration = this.localeGeneration
    const epoch = this.pollEpoch
    try {
      const batch = await account.getNotifications(deepSeekClientMetadata())
      if (generation !== this.generation) return
      // A dismissal during the read retires this reply; keep polling on the
      // server-provided interval instead of resurrecting the closed card.
      if (batch !== null && epoch === this.pollEpoch) {
        const requestedDelay = batch.nextPollAfterSeconds * 1000
        if (Number.isFinite(requestedDelay) && requestedDelay > 0) this.intervalMs = Math.min(requestedDelay, 2_147_483_647)
        const current = new Map(this.cards.map(card => [card.orderId, card]))
        const offered = batch.notifications.map(content => {
          const card = noticeOf(content)
          const translated = current.get(card.orderId)
          // An in-flight poll carries its original locale. Keep newer copy even
          // if the follow-up content refresh fails; server expiry remains current.
          return localeGeneration !== this.localeGeneration && translated !== undefined
            ? { ...card, title: translated.title, body: translated.body, actions: translated.actions }
            : card
        })
        const candidates = offered.filter(card => !expired(card))
        const foreground = this.cards[0]
        // The backend may consume on displayed. Keep the already-presented card
        // until explicit dismissal or expiry, not until the next polling reply.
        // A same-ID response can explicitly shorten its deadline. Only an
        // omitted card keeps its old metadata; an expired offer must retire it.
        const refreshed = foreground === undefined ? undefined
          : offered.find(card => card.orderId === foreground.orderId) ?? foreground
        const retained = refreshed !== undefined && this.displayed.has(refreshed.orderId) && !expired(refreshed)
          ? refreshed : undefined
        this.publish(retained === undefined ? candidates : [retained, ...candidates.filter(card => card.orderId !== retained.orderId)])
        if (localeGeneration !== this.localeGeneration) await this.localeChanged()
      }
    } catch {
      if (generation === this.generation) this.diagnose('read')
      // Keep visible content; retry only at the server-provided interval.
    }
    if (generation !== this.generation) return
    this.dropExpired()
    this.timer = setTimeout(() => { void this.poll(generation) }, this.intervalMs)
    this.timer.unref?.()
  }
}

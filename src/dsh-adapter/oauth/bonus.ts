import type { AccountClientMetadata, AccountUserId } from '@deepseek-ai/dsh-deepseek-account'
import { deepSeekClientMetadata } from './deepseek.js'
import { accountNotificationsOf, AccountNotificationStore, type AccountNotificationNotice, type AccountNotifications } from './account-notifications.js'

export interface WhaleCouponNotice {
  readonly kind?: undefined
  readonly accountId?: AccountUserId
  readonly orderId: string
  readonly amount: string
  readonly currency: 'CNY' | 'USD'
  readonly expiresAt: string
}

/** The pre-0.2.2-rc.2 bonus API; newer hosts expose a different notification protocol. */
export interface LegacyBonusAccount {
  getUnnotifiedBonuses(client: AccountClientMetadata): Promise<{
    readonly accountId: AccountUserId
    readonly bonuses: readonly {
      readonly orderId: string
      readonly campaign?: unknown
      readonly amount?: unknown
      readonly currency?: unknown
      readonly expiresAt: string
    }[]
  } | null>
  ackBonusNotified(accountId: AccountUserId, orderId: string, client: AccountClientMetadata): Promise<boolean>
}

/** TUI-only presentation of a Platform-confirmed login grant. */
export class WhaleCouponStore {
  private readonly listeners = new Set<() => void>()
  private readonly seen = new Set<string>()
  private notice: WhaleCouponNotice | null = null
  private account: LegacyBonusAccount | undefined
  private generation = 0
  private notificationOwner: object | undefined
  private readonly notifications: AccountNotificationStore

  constructor(diagnose?: (operation: 'read' | 'content' | 'report') => void) {
    this.notifications = new AccountNotificationStore(() => this.emit(), diagnose)
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): WhaleCouponNotice | AccountNotificationNotice | null => this.notice ?? this.notifications.getSnapshot()

  /** New hosts provide server-authored cards instead of structured login bonuses. */
  refreshNotifications(account: AccountNotifications): void { this.notifications.begin(account) }

  /** An obsolete injected plugin must not clear or publish for its successor. */
  claimNotificationOwner(): { current: () => boolean; dispose: () => void } {
    const owner = {}
    this.notificationOwner = owner
    this.clear()
    const current = () => this.notificationOwner === owner
    return { current, dispose: () => { if (current()) { this.notificationOwner = undefined; this.clear() } } }
  }

  notificationLocaleChanged(): Promise<void> { return this.notifications.localeChanged() }

  async refresh(value: unknown): Promise<void> {
    const notifications = accountNotificationsOf(value)
    if (notifications !== undefined) { await this.notifications.refresh(notifications); return }
    const account = value as LegacyBonusAccount | undefined
    if (typeof account?.getUnnotifiedBonuses !== 'function' || typeof account.ackBonusNotified !== 'function') return
    const generation = ++this.generation
    if (this.listeners.size === 0) return
    let batch
    try { batch = await account.getUnnotifiedBonuses(deepSeekClientMetadata()) }
    catch { return }
    if (generation !== this.generation || batch === null) return
    const granted = batch.bonuses.find(bonus => bonus.campaign === 'dsh_login_bonus'
      && !this.seen.has(`${batch.accountId}:${bonus.orderId}`)
      && (Number.isNaN(Date.parse(bonus.expiresAt)) || Date.parse(bonus.expiresAt) > Date.now()))
    if (granted === undefined || typeof granted.amount !== 'string'
      || (granted.currency !== 'CNY' && granted.currency !== 'USD')) return
    this.account = account
    this.notice = {
      accountId: batch.accountId, orderId: granted.orderId,
      amount: granted.amount, currency: granted.currency, expiresAt: granted.expiresAt,
    }
    this.emit()
  }

  /** Called only after the modal has painted; a read alone never acknowledges. */
  shown(orderId: string, expected?: WhaleCouponNotice | AccountNotificationNotice): void {
    if (expected !== undefined && expected !== this.getSnapshot()) return
    if (this.notifications.getSnapshot()?.orderId === orderId) {
      this.notifications.shown(orderId)
      return
    }
    const notice = this.notice
    if (notice?.orderId !== orderId || this.account === undefined) return
    const key = `${notice.accountId}:${notice.orderId}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    void this.account.ackBonusNotified(notice.accountId!, orderId, deepSeekClientMetadata()).catch(() => false)
  }

  dismiss(orderId: string, expected?: WhaleCouponNotice | AccountNotificationNotice): void {
    if (expected !== undefined && expected !== this.getSnapshot()) return
    if (this.notifications.getSnapshot()?.orderId === orderId) {
      this.notifications.dismiss(orderId)
      return
    }
    if (this.notice?.orderId !== orderId) return
    this.shown(orderId)
    const account = this.account
    this.notice = null
    this.emit()
    if (account !== undefined) void this.refresh(account)
  }

  clear(): void {
    this.generation++
    this.notifications.clear()
    this.notice = null
    this.account = undefined
    this.seen.clear()
    this.emit()
  }

  private emit(): void { for (const listener of this.listeners) listener() }
}

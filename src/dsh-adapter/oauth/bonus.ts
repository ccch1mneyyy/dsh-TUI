import type {
  AccountClientMetadata, AccountNotification, AccountNotificationId, DeepSeekAccount,
} from '@deepseek-ai/dsh-deepseek-account'
import { deepSeekClientMetadata } from './deepseek.js'

/** One Platform-confirmed login grant, as the TUI presents it. */
export interface WhaleCouponNotice {
  /** Opaque Platform order id on older hosts, notification id on 0.2.2-rc.2+. */
  readonly orderId: string
  readonly amount: string
  readonly currency: 'CNY' | 'USD'
  readonly expiresAt: string
}

/**
 * The bonus API older hosts expose. 0.2.2-rc.2 deleted it (with its types) in
 * favour of account notifications, so it stays structural here: the store
 * probes for it at run time instead of importing a type that no longer exists.
 */
interface LegacyBonus {
  readonly orderId: string
  readonly campaign: string
  readonly amount: string
  readonly currency: 'CNY' | 'USD'
  readonly expiresAt: string
}

interface LegacyBonusBatch {
  readonly accountId: string
  readonly bonuses: readonly LegacyBonus[]
}

interface LegacyBonusAccount {
  getUnnotifiedBonuses(client: AccountClientMetadata): Promise<LegacyBonusBatch | null>
  ackBonusNotified(accountId: string, orderId: string, client: AccountClientMetadata): Promise<boolean>
}

/** The rc.2 notification surface (typed by the current package). */
type NotificationAccount = Pick<DeepSeekAccount, 'getNotifications' | 'reportNotificationEvent'>

/** Which account API this store polls, resolved from the live service each refresh. */
type CouponAccount =
  | { readonly kind: 'notifications'; readonly account: NotificationAccount }
  | { readonly kind: 'legacy'; readonly account: LegacyBonusAccount }

/** The grant awaiting its display/dismiss report. */
type PendingGrant =
  | { readonly kind: 'legacy'; readonly accountId: string; readonly orderId: string }
  | { readonly kind: 'notifications'; readonly id: AccountNotificationId; readonly orderId: string }

/**
 * Pick the account API the running host exposes: rc.2 account notifications
 * replace the bonus-specific methods, while older hosts keep them.
 */
export function couponAccountOf(account: unknown): CouponAccount | undefined {
  const notifications = account as Partial<NotificationAccount> | undefined
  if (typeof notifications?.getNotifications === 'function'
    && typeof notifications.reportNotificationEvent === 'function') {
    return { kind: 'notifications', account: notifications as NotificationAccount }
  }
  const legacy = account as Partial<LegacyBonusAccount> | undefined
  if (typeof legacy?.getUnnotifiedBonuses === 'function' && typeof legacy.ackBonusNotified === 'function') {
    return { kind: 'legacy', account: legacy as LegacyBonusAccount }
  }
  return undefined
}

/** A login grant's business metadata, when the notification carries one. */
function loginGrant(notification: AccountNotification): { amount: string; currency: 'CNY' | 'USD'; expiresAt: string } | undefined {
  const data = notification.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  if (record.campaign !== 'dsh_login_bonus') return undefined
  const { amount, currency } = record
  const expiresAt = record.expiresAt ?? record.expires_at
  if (typeof amount !== 'string' || (currency !== 'CNY' && currency !== 'USD') || typeof expiresAt !== 'string') return undefined
  return { amount, currency, expiresAt }
}

/** The legacy rule: an unparseable deadline counts as still valid. */
function expired(expiresAt: string): boolean {
  return !Number.isNaN(Date.parse(expiresAt)) && Date.parse(expiresAt) <= Date.now()
}

function seenKey(pending: PendingGrant): string {
  return pending.kind === 'legacy' ? `${pending.accountId}:${pending.orderId}` : `notification:${pending.orderId}`
}

/** TUI-only presentation of a Platform-confirmed login grant. */
export class WhaleCouponStore {
  private readonly listeners = new Set<() => void>()
  private readonly seen = new Set<string>()
  private notice: WhaleCouponNotice | null = null
  private account: CouponAccount | undefined
  private pending: PendingGrant | undefined
  private generation = 0

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): WhaleCouponNotice | null => this.notice

  /**
   * Poll the live account service for an unconsumed login grant. The account
   * object is probed structurally so one build serves both account APIs.
   */
  async refresh(account: unknown): Promise<void> {
    const target = couponAccountOf(account)
    if (target === undefined) return
    const generation = ++this.generation
    if (this.listeners.size === 0) return
    if (target.kind === 'notifications') await this.refreshNotifications(target.account, generation)
    else await this.refreshLegacy(target.account, generation)
  }

  /** Called only after the modal has painted; a read alone never acknowledges. */
  shown(orderId: string): void {
    const notice = this.notice
    const account = this.account
    const pending = this.pending
    if (notice?.orderId !== orderId || account === undefined || pending === undefined) return
    const key = seenKey(pending)
    if (this.seen.has(key)) return
    this.seen.add(key)
    const client = deepSeekClientMetadata()
    if (pending.kind === 'legacy' && account.kind === 'legacy') {
      void account.account.ackBonusNotified(pending.accountId, pending.orderId, client).catch(() => false)
    } else if (pending.kind === 'notifications' && account.kind === 'notifications') {
      void account.account.reportNotificationEvent(pending.id, 'displayed', client).catch(() => false)
    }
  }

  dismiss(orderId: string): void {
    if (this.notice?.orderId !== orderId) return
    this.shown(orderId)
    const account = this.account
    const pending = this.pending
    if (account?.kind === 'notifications' && pending?.kind === 'notifications') {
      void account.account.reportNotificationEvent(pending.id, 'dismissed', deepSeekClientMetadata()).catch(() => false)
    }
    this.notice = null
    this.pending = undefined
    this.emit()
    if (account !== undefined) void this.refresh(account.account)
  }

  clear(): void {
    this.generation++
    this.notice = null
    this.pending = undefined
    this.account = undefined
    this.seen.clear()
    this.emit()
  }

  private async refreshLegacy(account: LegacyBonusAccount, generation: number): Promise<void> {
    let batch: LegacyBonusBatch | null
    try { batch = await account.getUnnotifiedBonuses(deepSeekClientMetadata()) } catch { return }
    if (generation !== this.generation || batch === null) return
    const granted = batch.bonuses.find(bonus => bonus.campaign === 'dsh_login_bonus'
      && !this.seen.has(`${batch.accountId}:${bonus.orderId}`)
      && !expired(bonus.expiresAt))
    if (granted === undefined) return
    this.account = { kind: 'legacy', account }
    this.pending = { kind: 'legacy', accountId: batch.accountId, orderId: granted.orderId }
    this.notice = {
      orderId: granted.orderId,
      amount: granted.amount, currency: granted.currency, expiresAt: granted.expiresAt,
    }
    this.emit()
  }

  private async refreshNotifications(account: NotificationAccount, generation: number): Promise<void> {
    let batch: Awaited<ReturnType<NotificationAccount['getNotifications']>>
    try { batch = await account.getNotifications(deepSeekClientMetadata()) } catch { return }
    if (generation !== this.generation || batch === null) return
    for (const notification of batch.notifications) {
      const grant = loginGrant(notification)
      if (grant === undefined || expired(grant.expiresAt)) continue
      const pending: PendingGrant = { kind: 'notifications', id: notification.id, orderId: notification.id }
      if (this.seen.has(seenKey(pending))) continue
      this.account = { kind: 'notifications', account }
      this.pending = pending
      this.notice = { orderId: notification.id, ...grant }
      this.emit()
      return
    }
  }

  private emit(): void { for (const listener of this.listeners) listener() }
}

import type { DeepSeekAccount, AccountBonusOrderId, AccountUserId } from '@deepseek-ai/dsh-deepseek-account'
import { deepSeekClientMetadata } from './deepseek.js'

export interface WhaleCouponNotice {
  readonly accountId: AccountUserId
  readonly orderId: AccountBonusOrderId
  readonly amount: string
  readonly currency: 'CNY' | 'USD'
  readonly expiresAt: string
}

type BonusAccount = Pick<DeepSeekAccount, 'getUnnotifiedBonuses' | 'ackBonusNotified'>

/** TUI-only presentation of a Platform-confirmed login grant. */
export class WhaleCouponStore {
  private readonly listeners = new Set<() => void>()
  private readonly seen = new Set<string>()
  private notice: WhaleCouponNotice | null = null
  private account: BonusAccount | undefined
  private generation = 0

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): WhaleCouponNotice | null => this.notice

  async refresh(account: BonusAccount): Promise<void> {
    const generation = ++this.generation
    if (this.listeners.size === 0) return
    let batch
    try { batch = await account.getUnnotifiedBonuses(deepSeekClientMetadata()) }
    catch { return }
    if (generation !== this.generation || batch === null) return
    const granted = batch.bonuses.find(bonus => bonus.campaign === 'dsh_login_bonus'
      && !this.seen.has(`${batch.accountId}:${bonus.orderId}`)
      && (Number.isNaN(Date.parse(bonus.expiresAt)) || Date.parse(bonus.expiresAt) > Date.now()))
    if (granted === undefined) return
    this.account = account
    this.notice = {
      accountId: batch.accountId, orderId: granted.orderId,
      amount: granted.amount, currency: granted.currency, expiresAt: granted.expiresAt,
    }
    this.emit()
  }

  /** Called only after the modal has painted; a read alone never acknowledges. */
  shown(orderId: AccountBonusOrderId): void {
    const notice = this.notice
    if (notice?.orderId !== orderId || this.account === undefined) return
    const key = `${notice.accountId}:${notice.orderId}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    void this.account.ackBonusNotified(notice.accountId, orderId, deepSeekClientMetadata()).catch(() => false)
  }

  dismiss(orderId: AccountBonusOrderId): void {
    if (this.notice?.orderId !== orderId) return
    this.shown(orderId)
    const account = this.account
    this.notice = null
    this.emit()
    if (account !== undefined) void this.refresh(account)
  }

  clear(): void {
    this.generation++
    this.notice = null
    this.account = undefined
    this.seen.clear()
    this.emit()
  }

  private emit(): void { for (const listener of this.listeners) listener() }
}

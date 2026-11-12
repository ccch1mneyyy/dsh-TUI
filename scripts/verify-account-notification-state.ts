import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { WhaleCouponStore } from '../src/dsh-adapter/oauth/bonus.js'
const notice = { id: 'notification-one', createdAt: '2026-01-01T00:00:00Z', displayUntil: null, title: '账号消息 🐳', body: '服务端提供的内容，不猜测金额。', actions: [{ label: '关闭', style: 'secondary', target: { type: 'dismiss' } }] } as const
const events: Array<[string, string]> = []
const account = {
  getNotifications: async () => ({ nextPollAfterSeconds: 60, notifications: [notice] }),
  getNotificationContent: async () => ({ ...notice, title: 'Account notice', body: 'Localized content' }),
  reportNotificationEvent: async (id: string, event: string) => { events.push([id,event]); return true },
}
const store = new WhaleCouponStore()
const off = store.subscribe(()=>{})
const settled = async (check:()=>boolean) => {for(let i=0;i<400;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5))}assert.fail('notification state did not settle')}
try {
  store.refreshNotifications(account)
  await settled(()=>store.getSnapshot()?.orderId===notice.id)
  assert.deepEqual(events,[], 'reading does not acknowledge a notification')
  const card = store.getSnapshot()
  assert.equal(card?.kind, 'account-notification')
  if (card?.kind !== 'account-notification') throw new Error('missing generic card')
  assert.equal(card.title,notice.title)
  assert.equal(card.body,notice.body)
  assert.equal('amount' in card,false,'localized copy and business data never become a guessed coupon')
  store.shown(notice.id);store.shown(notice.id)
  await settled(()=>events.length===1)
  assert.deepEqual(events,[[notice.id,'displayed']])
  await store.notificationLocaleChanged()
  const localized = store.getSnapshot()
  assert.equal(localized?.kind==='account-notification' && localized.title,'Account notice')
  store.dismiss(notice.id)
  assert.deepEqual(events,[[notice.id,'displayed'],[notice.id,'dismissed']])
  assert.equal(store.getSnapshot(),null)
  let finish!: (value: Awaited<ReturnType<typeof account.getNotifications>>) => void
  const pending = {...account,getNotifications:()=>new Promise<Awaited<ReturnType<typeof account.getNotifications>>>(resolve=>{finish=resolve})}
  store.refreshNotifications(pending)
  store.clear()
  finish({nextPollAfterSeconds:60,notifications:[notice]})
  await new Promise(resolve=>setTimeout(resolve,0))
  assert.equal(store.getSnapshot(),null,'late old-account response cannot publish after clear')
  assert.equal(events.length,2,'cleanup is neither displayed nor dismissed')
  store.refreshNotifications({...account,getNotifications:async()=>({nextPollAfterSeconds:60,notifications:[{...notice,displayUntil:'2000-01-01T00:00:00Z'}]})})
  await new Promise(resolve=>setTimeout(resolve,0))
  assert.equal(store.getSnapshot(),null,'expired notices never appear or acknowledge')
  assert.equal(events.length,2)
  store.clear()
  const beforeUnseenClose = events.length
  store.refreshNotifications(account)
  await settled(() => store.getSnapshot() !== null)
  store.dismiss(notice.id)
  assert.deepEqual(events.slice(beforeUnseenClose), [[notice.id, 'dismissed']], 'closing before presentation never fabricates displayed')
  store.clear()
  let reads = 0
  const retained = { ...account, getNotifications: async () => ({ nextPollAfterSeconds: 0.01, notifications: ++reads === 1 ? [notice] : [] }) }
  store.refreshNotifications(retained)
  await settled(() => store.getSnapshot() !== null)
  store.shown(notice.id)
  await settled(() => reads >= 2)
  assert.equal(store.getSnapshot()?.orderId, notice.id, 'consumption by displayed does not remove the card on the next poll')
  store.clear()
  store.refreshNotifications({ ...account, getNotifications: async () => ({ nextPollAfterSeconds: 60, notifications: [notice, { ...notice, id: 'second' }] }), reportNotificationEvent: async () => { throw new Error('offline') } })
  await settled(() => store.getSnapshot() !== null)
  store.shown(notice.id)
  assert.equal(store.getSnapshot()?.orderId, notice.id, 'report failure does not remove the visible card')
  store.dismiss(notice.id)
  assert.equal(store.getSnapshot()?.orderId, 'second', 'dismissal advances the server order without dropping queued notifications')
  console.log('PASS rc.2 account notifications: plain content, paint/dismiss semantics, locale, expiry, exact account lifetime')
} finally {store.clear();off()}

// A controlled clock makes polling/locale races independent of rendering load.
const { mock } = await import('node:test')
const { AccountNotificationStore } = await import('../src/dsh-adapter/oauth/account-notifications.js')
mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
let publications = 0
const clockStore = new AccountNotificationStore(() => publications++)
let pollReads = 0, contentReads = 0
let oldReply!: (value: { nextPollAfterSeconds: number; notifications: readonly typeof notice[] }) => void
try {
  clockStore.begin({
    getNotifications: async () => {
      pollReads++
      if (pollReads === 2) return new Promise(resolve => { oldReply = resolve })
      return { nextPollAfterSeconds: 90, notifications: [{ ...notice }] }
    },
    getNotificationContent: async () => {
      if (++contentReads === 1) return { ...notice, title: 'English' }
      throw new Error('locale endpoint temporarily offline')
    },
    reportNotificationEvent: async () => true,
  })
  await flush()
  mock.timers.tick(89_999); await flush()
  assert.equal(pollReads, 1, 'server polling interval is respected')
  mock.timers.tick(1); await flush()
  await clockStore.localeChanged()
  assert.equal(clockStore.getSnapshot()?.title, 'English')
  oldReply({ nextPollAfterSeconds: 90, notifications: [notice] }); await flush()
  assert.equal(clockStore.getSnapshot()?.title, 'English', 'old-locale poll retains translated copy when refresh fails')
  clockStore.clear()
  clockStore.begin({ ...account, getNotifications: async () => ({ nextPollAfterSeconds: 90, notifications: [{ ...notice }] }) })
  await flush()
  const unchangedPublications = publications
  const sameSnapshot = clockStore.getSnapshot()
  mock.timers.tick(90_000); await flush()
  assert.equal(publications, unchangedPublications, 'unchanged notifications never notify transcript subscribers')
  assert.equal(clockStore.getSnapshot(), sameSnapshot, 'unchanged card retains snapshot identity')
  clockStore.clear()
  const beforeExpiry = events.length
  clockStore.begin({ ...account, getNotifications: async () => ({ nextPollAfterSeconds: 90, notifications: [{ ...notice, displayUntil: new Date(Date.now() + 1_000).toISOString() }] }) })
  await flush()
  assert.equal(clockStore.getSnapshot()?.orderId, notice.id, 'notification is visible before expiry')
  mock.timers.tick(999); await flush()
  assert.notEqual(clockStore.getSnapshot(), null)
  mock.timers.tick(1); await flush()
  assert.equal(clockStore.getSnapshot(), null, 'expiry clears independently of polling')
  assert.equal(events.length, beforeExpiry, 'expiry is neither displayed nor dismissed')
  clockStore.clear()
  let currentReads = 0
  clockStore.begin({...account,getNotifications:async()=>({nextPollAfterSeconds:1,notifications:[{
    ...notice, displayUntil:++currentReads===1?null:new Date(Date.now()-1).toISOString(),
  }]})})
  await flush();clockStore.shown(notice.id)
  assert.notEqual(clockStore.getSnapshot(),null)
  mock.timers.tick(1000);await flush()
  assert.equal(clockStore.getSnapshot(),null,'explicit server expiry of a displayed card is not omission')
  clockStore.clear()
  let longReads = 0
  const farDeadline = Date.now()+2_147_483_647+1000
  clockStore.begin({...account,getNotifications:async()=>{
    if(++longReads>1)return new Promise(()=>{})
    return {nextPollAfterSeconds:1,notifications:[{...notice,displayUntil:new Date(farDeadline).toISOString()}]}
  }})
  await flush();mock.timers.tick(2_147_483_647);await flush()
  assert.notEqual(clockStore.getSnapshot(),null,'long-deadline card stays until its actual deadline')
  mock.timers.tick(1000);await flush()
  assert.equal(clockStore.getSnapshot(),null,'capped timer rearms despite a pending poll')
  clockStore.clear()
  clockStore.begin({...account,getNotificationContent:async()=>({...notice,title:'Translated',displayUntil:'2000-01-01T00:00:00Z'})})
  await flush();await clockStore.localeChanged()
  assert.equal(clockStore.getSnapshot()?.title,'Translated','content refresh changes localized copy')
  assert.equal(clockStore.getSnapshot()?.displayUntil,null,'content endpoint does not replace list-owned deadline')
  console.log('PASS controlled notification clock: interval, stale locale, unchanged snapshot')
} finally { clockStore.clear(); mock.timers.reset() }


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
  clockStore.clear()
  const dismissReports: string[] = []
  let dismissReads = 0
  let staleReply!: (value: { nextPollAfterSeconds: number; notifications: readonly (typeof notice)[] }) => void
  clockStore.begin({
    getNotifications: async () => {
      if (++dismissReads === 1) return { nextPollAfterSeconds: 1, notifications: [{ ...notice }] }
      return new Promise(resolve => { staleReply = resolve })
    },
    getNotificationContent: async () => null,
    reportNotificationEvent: async (_id: string, event: string) => { dismissReports.push(event); return true },
  })
  await flush()
  clockStore.shown(notice.id)
  mock.timers.tick(1_000); await flush()
  assert.equal(dismissReads, 2, 'second poll is in flight')
  clockStore.dismiss(notice.id)
  assert.equal(clockStore.getSnapshot(), null)
  staleReply({ nextPollAfterSeconds: 90, notifications: [{ ...notice }] }); await flush()
  assert.equal(clockStore.getSnapshot(), null, 'dismissal fences a poll that was already in flight')
  assert.deepEqual(dismissReports, ['displayed', 'dismissed'], 'a fenced poll never re-reports displayed for the closed card')
  mock.timers.tick(1_000); await flush()
  assert.equal(dismissReads, 2, 'a fenced reply still adopts the server-provided interval')
  mock.timers.tick(89_000); await flush()
  assert.equal(dismissReads, 3, 'next poll follows the adopted server interval')
  clockStore.clear()
  let releaseDismiss!: () => void
  let dismissReportPending = false
  let pendingPollReads = 0
  clockStore.begin({
    getNotifications: async () => {
      pendingPollReads++
      return { nextPollAfterSeconds: 1, notifications: [{ ...notice }] }
    },
    getNotificationContent: async () => null,
    reportNotificationEvent: async (_id: string, event: string) => {
      if (event !== 'dismissed') return true
      dismissReportPending = true
      return new Promise<boolean>(resolve => { releaseDismiss = () => { dismissReportPending = false; resolve(true) } })
    },
  })
  await flush()
  assert.equal(clockStore.getSnapshot()?.orderId, notice.id)
  clockStore.dismiss(notice.id)
  assert.equal(clockStore.getSnapshot(), null)
  assert.equal(dismissReportPending, true, 'dismissal report is in flight')
  const readsBeforeSuppressed = pendingPollReads
  mock.timers.tick(1_000); await flush()
  assert.equal(pendingPollReads, readsBeforeSuppressed + 1, 'polling continues while the dismissal report is pending')
  assert.equal(clockStore.getSnapshot(), null, 'a repeated offer is suppressed until the dismissal settles')
  releaseDismiss(); await flush()
  mock.timers.tick(1_000); await flush()
  assert.equal(clockStore.getSnapshot()?.orderId, notice.id, 'after the dismissal settles a re-offered card may return')
  clockStore.clear()
  let localePollReads = 0
  let contentRequests = 0
  let contentResolve!: () => void
  let stalePollReply!: (value: { nextPollAfterSeconds: number; notifications: readonly (typeof notice)[] }) => void
  const refreshedContent = { ...notice, title: 'Refreshed' }
  clockStore.begin({
    getNotifications: async () => {
      if (++localePollReads === 1) return { nextPollAfterSeconds: 1, notifications: [{ ...notice }] }
      return new Promise(resolve => { stalePollReply = resolve })
    },
    getNotificationContent: async () => {
      if (++contentRequests === 1) return new Promise<typeof refreshedContent>(resolve => { contentResolve = () => resolve(refreshedContent) })
      throw new Error('duplicate locale request is offline')
    },
    reportNotificationEvent: async () => true,
  })
  await flush()
  mock.timers.tick(1_000); await flush()
  assert.equal(localePollReads, 2, 'poll with the old locale is in flight')
  const localeRefresh = clockStore.localeChanged()
  assert.equal(contentRequests, 1)
  stalePollReply({ nextPollAfterSeconds: 90, notifications: [{ ...notice }] }); await flush()
  assert.equal(contentRequests, 1, 'a stale-locale poll reuses the in-flight language refresh')
  contentResolve(); await localeRefresh; await flush()
  assert.equal(clockStore.getSnapshot()?.title, 'Refreshed', 'an overlapping poll does not discard the successful refresh')
  clockStore.clear()
  let switchRequests = 0
  const switchResolvers: Array<() => void> = []
  clockStore.begin({
    getNotifications: async () => ({ nextPollAfterSeconds: 90, notifications: [{ ...notice }] }),
    getNotificationContent: async () => new Promise(resolve => {
      const title = `Lang${++switchRequests}`
      switchResolvers.push(() => resolve({ ...notice, title }))
    }),
    reportNotificationEvent: async () => true,
  })
  await flush()
  const firstSwitch = clockStore.localeChanged()
  const secondSwitch = clockStore.localeChanged()
  await flush()
  assert.equal(switchRequests, 2, 'a second explicit language switch fetches again')
  switchResolvers[1]!(); await secondSwitch; await flush()
  assert.equal(clockStore.getSnapshot()?.title, 'Lang2', 'latest language switch applies first')
  switchResolvers[0]!(); await firstSwitch; await flush()
  assert.equal(clockStore.getSnapshot()?.title, 'Lang2', 'an earlier language completion cannot overwrite the newer one')
  clockStore.clear()
  let heldPollReads = 0
  let releaseHeldPoll!: () => void
  clockStore.begin({
    getNotifications: async () => {
      if (++heldPollReads === 2) await new Promise<void>(resolve => { releaseHeldPoll = resolve })
      return { nextPollAfterSeconds: 1, notifications: [{ ...notice }] }
    },
    getNotificationContent: async () => new Promise(() => {}),
    reportNotificationEvent: async () => true,
  })
  await flush()
  mock.timers.tick(1_000); await flush()
  assert.equal(heldPollReads, 2, 'poll is in flight')
  void clockStore.localeChanged()
  await flush()
  releaseHeldPoll(); await flush()
  mock.timers.tick(1_000); await flush()
  assert.equal(heldPollReads, 3, 'a pending language refresh never stalls polling')
  clockStore.clear()
  const dismissReleases: Array<() => void> = []
  const dismissAccount = {
    getNotifications: async () => ({ nextPollAfterSeconds: 1, notifications: [{ ...notice }] }),
    getNotificationContent: async () => null,
    reportNotificationEvent: async (_id: string, event: string) => {
      if (event !== 'dismissed') return true
      return new Promise<boolean>(resolve => { dismissReleases.push(() => resolve(true)) })
    },
  }
  clockStore.begin(dismissAccount)
  await flush(); clockStore.shown(notice.id)
  clockStore.dismiss(notice.id)
  clockStore.clear(); clockStore.begin(dismissAccount)
  await flush(); clockStore.shown(notice.id)
  clockStore.dismiss(notice.id)
  dismissReleases[0]!(); await flush()
  mock.timers.tick(1_000); await flush()
  assert.equal(clockStore.getSnapshot(), null, 'an older dismissal report cannot clear the newer fence')
  dismissReleases[1]!(); await flush()
  mock.timers.tick(1_000); await flush()
  assert.equal(clockStore.getSnapshot()?.orderId, notice.id, 'the newest fence releases its own id')
  clockStore.clear()
  // New ids offered by an old-locale poll must join the existing refresh.
  // Publishing X must not wait for slower Y, and polling remains independent.
  {
    const x = { ...notice, id: 'locale-X', title: 'X-old' }
    const y = { ...notice, id: 'locale-Y', title: 'Y-old' }
    const requests: string[] = []
    const diagnostics: string[] = []
    const pending = new Map<string, (value: typeof x) => void>()
    let reads = 0
    let releasePoll!: () => void
    const drain = new AccountNotificationStore(() => {}, operation => diagnostics.push(operation))
    try {
      drain.begin({
        getNotifications: async () => {
          reads++
          if (reads === 1) return { nextPollAfterSeconds: 1, notifications: [x] }
          if (reads === 2) return new Promise(resolve => { releasePoll = () => resolve({ nextPollAfterSeconds: 1, notifications: [x, y] }) })
          return { nextPollAfterSeconds: 1, notifications: [{ ...x, title: 'X-new' }, y] }
        },
        getNotificationContent: id => {
          requests.push(id)
          return new Promise(resolve => { pending.set(id, resolve) })
        },
        reportNotificationEvent: async () => true,
      })
      await flush(); mock.timers.tick(1_000); await flush()
      const refreshing = drain.localeChanged()
      releasePoll(); await flush()
      assert.deepEqual(requests, [x.id])
      pending.get(x.id)!({ ...x, title: 'X-new' }); await flush()
      assert.equal(drain.getSnapshot()?.title, 'X-new', 'completed X publishes while new Y is still pending')
      assert.deepEqual(requests, [x.id, y.id], 'only the new id joins the refresh')
      mock.timers.tick(1_000); await flush()
      assert.equal(reads, 3, 'a slow new-id content request does not block polling')
      pending.get(y.id)!({ ...y, title: 'Y-new' }); await refreshing; await flush()
      drain.dismiss(x.id)
      assert.equal(drain.getSnapshot()?.title, 'Y-new', 'new id receives localized content without refreshing X again')
      assert.deepEqual(requests, [x.id, y.id])
      assert.deepEqual(diagnostics, [])
    } finally { drain.clear(); for (const [id, resolve] of pending) resolve({ ...x, id }); releasePoll?.(); await flush() }
  }
  // A changed callback can synchronously retire a drain. A queued poll can also
  // arrive after its last publication but before its public promise settles.
  for (const action of ['clear', 'replace', 'switch', 'closing-poll'] as const) {
    const x = { ...notice, id: 'fence-X', title: 'X-old' }
    const y = { ...notice, id: 'fence-Y', title: 'Y-old' }
    const requests: string[] = []
    let reads = 0
    let armed = false
    let releaseX!: () => void
    let releasePoll!: () => void
    let secondSwitch: Promise<void> | undefined
    const replacement = {
      getNotifications: async () => ({ nextPollAfterSeconds: 90, notifications: [{ ...x, id: 'replacement', title: 'Replacement' }] }),
      getNotificationContent: async () => null,
      reportNotificationEvent: async () => true,
    }
    const fenced = new AccountNotificationStore(() => {
      if (!armed || fenced.getSnapshot()?.title !== 'X-new') return
      armed = false
      if (action === 'clear') fenced.clear()
      else if (action === 'replace') fenced.begin(replacement)
      else if (action === 'switch') secondSwitch = fenced.localeChanged()
      else releasePoll()
    })
    try {
      fenced.begin({
        getNotifications: () => {
          if (++reads === 1) return Promise.resolve({ nextPollAfterSeconds: 1, notifications: [x] })
          return new Promise(resolve => { releasePoll = () => resolve({ nextPollAfterSeconds: 90, notifications: [x, y] }) })
        },
        getNotificationContent: async id => {
          requests.push(id)
          if (requests.length === 1) return new Promise(resolve => { releaseX = () => resolve({ ...x, title: 'X-new' }) })
          return { ...(id === x.id ? x : y), title: action === 'switch' ? 'Latest-' + id : 'Y-new' }
        },
        reportNotificationEvent: async () => true,
      })
      await flush(); mock.timers.tick(1_000); await flush()
      const firstSwitch = fenced.localeChanged()
      if (action !== 'closing-poll') { releasePoll(); await flush() }
      armed = true; releaseX(); await firstSwitch; await secondSwitch; await flush()
      if (action === 'clear') assert.equal(fenced.getSnapshot(), null)
      else if (action === 'replace') assert.equal(fenced.getSnapshot()?.orderId, 'replacement')
      else if (action === 'switch') {
        assert.deepEqual(requests, [x.id, x.id, y.id], 'only the new explicit language owns the follow-up requests')
        assert.equal(fenced.getSnapshot()?.title, 'Latest-' + x.id)
      } else {
        assert.ok(requests.includes(y.id), 'poll queued at refresh completion starts a live refresh for its new id')
        fenced.dismiss(x.id)
        assert.equal(fenced.getSnapshot()?.title, 'Y-new')
      }
      if (action === 'clear' || action === 'replace') assert.deepEqual(requests, [x.id], 'retired drain must not request Y after its callback')
    } finally { fenced.clear(); releaseX?.(); releasePoll?.(); await flush() }
  }
  // The reused run is also observed when a poll starts it without a caller.
  // A synchronous adapter throw must not become an unhandled rejection.
  {
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => { unhandled.push(error) }
    let reads = 0
    let contentReads = 0
    let releasePoll!: () => void
    const throwing = new AccountNotificationStore(() => {})
    process.on('unhandledRejection', onUnhandled)
    try {
      throwing.begin({
        getNotifications: () => {
          if (++reads === 1) return Promise.resolve({ nextPollAfterSeconds: 1, notifications: [notice] })
          return new Promise(resolve => { releasePoll = () => resolve({ nextPollAfterSeconds: 90, notifications: [{ ...notice, id: 'throw-new' }] }) })
        },
        getNotificationContent: () => {
          if (++contentReads === 1) return Promise.resolve({ ...notice, title: 'Refreshed' })
          throw new Error('synchronous content failure')
        },
        reportNotificationEvent: async () => true,
      })
      await flush(); mock.timers.tick(1_000); await flush()
      await throwing.localeChanged()
      releasePoll(); await flush()
      // Observe Node's rejection turn; no extra notification poll or clock tick.
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(contentReads, 2, 'the fire-and-forget poll refresh reached the synchronous throw')
      assert.equal(throwing.getSnapshot()?.orderId, 'throw-new')
      assert.deepEqual(unhandled, [], 'poll content failures keep the existing rejection observer')
    } finally { throwing.clear(); releasePoll?.(); process.off('unhandledRejection', onUnhandled) }
  }
  // A later synchronous failure must still observe a previously returned promise.
  {
    const y = { ...notice, id: 'mixed-Y' }
    const z = { ...notice, id: 'mixed-Z' }
    const later = { ...notice, id: 'mixed-not-started' }
    const syncFailure = new Error('later content call failed synchronously')
    const lateFailure = new Error('earlier content promise rejected later')
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => { unhandled.push(error) }
    const requests: string[] = []
    let rejectEarlier!: (error: Error) => void
    const earlier = new Promise<typeof y | null>((_resolve, reject) => { rejectEarlier = reject })
    let reads = 0
    let callerSettled = false
    let callerOutcome: unknown
    const mixed = new AccountNotificationStore(() => {})
    process.on('unhandledRejection', onUnhandled)
    try {
      mixed.begin({
        getNotifications: async () => { reads++; return { nextPollAfterSeconds: 1, notifications: [y, z, later] } },
        getNotificationContent: id => {
          requests.push(id)
          if (id === y.id) return earlier
          throw syncFailure
        },
        reportNotificationEvent: async () => true,
      })
      await flush()
      void mixed.localeChanged().then(
        () => { callerSettled = true; callerOutcome = 'unexpected fulfillment' },
        error => { callerSettled = true; callerOutcome = error },
      )
      assert.deepEqual(requests, [y.id, z.id], 'requests start synchronously in order and stop at the throw')
      await flush()
      assert.equal(callerSettled, true, 'the explicit caller must not wait for the earlier pending request')
      assert.equal(callerOutcome, syncFailure, 'the explicit caller receives the original synchronous error')
      mock.timers.tick(1_000); await flush()
      assert.equal(reads, 2, 'polling continues while the earlier request is still pending')
      assert.deepEqual(requests, [y.id, z.id], 'a failed content drain does not restart its requests')
      mixed.begin({
        getNotifications: async () => ({ nextPollAfterSeconds: 90, notifications: [{ ...notice, id: 'replacement-after-failure' }] }),
        getNotificationContent: async () => null,
        reportNotificationEvent: async () => true,
      })
      await flush()
      rejectEarlier(lateFailure)
      // Use a real Node rejection turn; the notification clock stays controlled.
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(mixed.getSnapshot()?.orderId, 'replacement-after-failure', 'late failure cannot affect the replacement account')
      assert.deepEqual(unhandled, [], 'earlier request rejection is observed after a later synchronous throw')
      console.log('PASS mixed locale failure: immediate caller rejection, synchronous start order, continued polling, account fence, observed earlier promise')
    } finally {
      mixed.clear(); rejectEarlier(lateFailure)
      await new Promise<void>(resolve => setImmediate(resolve))
      process.off('unhandledRejection', onUnhandled)
    }
  }
  console.log('PASS controlled notification clock: interval, stale locale, unchanged snapshot, in-flight dismiss, pending dismissal, refresh reuse, dismiss fence ownership')
} finally { clockStore.clear(); mock.timers.reset() }

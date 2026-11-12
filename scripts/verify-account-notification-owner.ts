import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { WhaleCouponStore } from '../src/dsh-adapter/oauth/bonus.js'
import { Context } from '@deepseek-ai/cordis'
import * as oauth from '../src/dsh-adapter/oauth/index.js'
const ctx = new Context()
const coupons = new WhaleCouponStore()
let ownerReports = 0
ctx.provide('dshAuth', { coupons } as never)
ctx.provide('llm', { registerAdapter: () => () => {} } as never)
ctx.provide('commands', { register: () => () => {} } as never)
ctx.provide('deepseekAccount', {
  async *watch(signal: AbortSignal) { yield { type: 'snapshot', state: { status: 'credential-stored' } }; await new Promise(r => signal.addEventListener('abort', r, {once:true})) },
  getNotifications: async () => ({ nextPollAfterSeconds: 60, notifications: [{ id:'same',title:'hello',body:'body',displayUntil:null,actions:[] }] }),
  getNotificationContent: async () => null,
  reportNotificationEvent: async () => { ownerReports++; return true },
} as never)
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r))}
try {
const first = await ctx.plugin({apply:oauth.apply}, {providers:['openai-codex']})
await settle()
const oldCard = coupons.getSnapshot()!
const second = await ctx.plugin({apply:oauth.apply}, {providers:['openai-codex']})
await settle()
assert.equal(coupons.getSnapshot()?.orderId, 'same')
coupons.shown('same', oldCard)
assert.equal(ownerReports, 0, 'old painted callback cannot report for a new account lifetime')
coupons.dismiss('same', oldCard)
assert.equal(coupons.getSnapshot()?.orderId, 'same', 'old UI callback cannot dismiss same ID in a replacement lifetime')
await first.dispose();await settle()
assert.equal(coupons.getSnapshot()?.orderId, 'same', 'stale owner disposal cannot clear its successor')
await second.dispose()
assert.equal(coupons.getSnapshot(), null, 'current owner disposal clears its own card')
console.log('PASS notification exact owner: overlapping plugins and stale UI callbacks')
} finally {await ctx.fiber.dispose()}

// Real Cordis injection consumes credentials-changed, not every progress snapshot.
const changing = new Context()
const owned = new WhaleCouponStore()
let push!: (update: unknown) => void
let readCount = 0
let finishOld!: (value: unknown) => void
let currentTitle = 'Current account'
let contentReads = 0
let reports = 0
const currentNotice = () => ({id:'current',title:currentTitle,body:'Current account body',displayUntil:null,actions:[]})
changing.provide('dshAuth', {coupons:owned} as never)
changing.provide('llm', {registerAdapter:()=>()=>{}} as never)
changing.provide('commands', {register:()=>()=>{}} as never)
changing.provide('deepseekAccount', {
 async *watch(signal:AbortSignal) {
  yield {type:'snapshot',state:{status:'credential-stored'}}
  while(!signal.aborted) {
   const update = await new Promise(resolve=>{push=resolve;signal.addEventListener('abort',()=>resolve(undefined),{once:true})})
   if(update===undefined)return
   yield update
  }
 },
 getNotifications:async()=>{
  if(++readCount===1)return new Promise(resolve=>{finishOld=resolve})
  return {nextPollAfterSeconds:600,notifications:[currentNotice()]}
 },
 getNotificationContent:async()=>{contentReads++;return currentNotice()},
 reportNotificationEvent:async()=>{reports++;return true},
} as never)
try {
 const owner=await changing.plugin({apply:oauth.apply},{providers:['openai-codex']})
 await settle();assert.equal(readCount,1)
 push({type:'credentials-changed',state:{status:'credential-stored'}})
 await settle();assert.equal(owned.getSnapshot()?.orderId,'current')
 finishOld({nextPollAfterSeconds:1,notifications:[{...currentNotice(),id:'obsolete'}]})
 await settle();assert.equal(owned.getSnapshot()?.orderId,'current','old credential response is discarded')
 const retained=owned.getSnapshot()
 push({type:'snapshot',state:{status:'credential-stored'}})
 await settle();assert.equal(owned.getSnapshot(),retained,'progress snapshot preserves current card identity')
 assert.equal(readCount,2,'progress snapshot never restarts polling')
 owned.shown('current');assert.equal(reports,1)
 const {setLang,getLang}=await import('../src/i18n.js')
 const before=getLang();currentTitle='Localized account content';setLang(before==='en'?'zh':'en')
 await settle();assert.ok(contentReads>0)
 const localized=owned.getSnapshot()
 assert.equal(localized?.kind==='account-notification'&&localized.title,currentTitle)
 assert.equal(reports,1,'locale refresh does not report display again')
 setLang(before);await settle()
 push({type:'credentials-changed',state:{status:'signed-out'}})
 await settle();assert.equal(owned.getSnapshot(),null)
 assert.equal(reports,1,'credential cleanup does not report dismissal')
 await owner.dispose()
 console.log('PASS real account watch: credential replacement, progress snapshot, locale, sign-out')
} finally {await changing.fiber.dispose()}

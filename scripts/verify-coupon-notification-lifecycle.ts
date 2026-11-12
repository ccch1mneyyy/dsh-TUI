import './lib/fake-home.mjs'
import { mock } from 'node:test'
import { WhaleCouponStore } from '../src/dsh-adapter/oauth/bonus.js'
const reports:string[]=[]
const notice={id:'same-notification',createdAt:'2026-01-01T00:00:00Z',displayUntil:null,title:'Account grant',body:'Server copy',actions:[],data:{campaign:'dsh_login_bonus',amount:'6.00',currency:'CNY',expiresAt:'2099-01-01T00:00:00Z'}}
const account={getNotificationContent:async()=>notice,getNotifications:async()=>({nextPollAfterSeconds:600,notifications:[notice]}),reportNotificationEvent:async(_id:string,event:string)=>{reports.push(event);return true}}
const store=new WhaleCouponStore();const off=store.subscribe(()=>{});let failed=0
const check=(name:string,pass:boolean,actual:unknown)=>{console.log(JSON.stringify({name,pass,actual}));if(!pass)failed++}
try{
 await store.refresh(account)
 check('read does not acknowledge',reports.length===0,reports)
 store.dismiss(notice.id)
 check('closing before presentation reports dismissed only',reports.join(',')==='dismissed',[...reports])
 store.clear();reports.length=0
 mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-11-12T00:00:00Z')})
 await store.refresh({...account,getNotifications:async()=>({nextPollAfterSeconds:600,notifications:[{...notice,displayUntil:new Date(Date.now()+1000).toISOString()}]})})
 check('pre-expiry card exists',store.getSnapshot()!==null,store.getSnapshot())
 mock.timers.tick(1000);await Promise.resolve()
 check('visible card retires at display deadline without interaction',store.getSnapshot()===null,store.getSnapshot())
 check('expiry emits no fake reports',reports.length===0,reports)
 mock.timers.reset();store.clear();reports.length=0
 await store.refresh(account);store.shown(notice.id);store.dismiss(notice.id);await Promise.resolve();await Promise.resolve()
 await store.refresh(account)
 check('server may offer a previously closed notification again',store.getSnapshot()!==null,store.getSnapshot())
 store.clear();reports.length=0
 mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-11-12T00:00:00Z')})
 // Keep one account identity: a spread would clear the cards and test a newly
 // loaded card instead of a deadline update on the retained, displayed one.
 let deadline: string | null = null
 const deadlineAccount={
  getNotificationContent:async()=>notice,
  getNotifications:async()=>({nextPollAfterSeconds:600,notifications:[{...notice,displayUntil:deadline}]}),
  reportNotificationEvent:async(_id:string,event:string)=>{reports.push(event);return true},
 }
 await store.refresh(deadlineAccount)
 store.shown(notice.id)
 check('retained card starts without a deadline',store.getSnapshot()!==null,store.getSnapshot())
 deadline=new Date(Date.now()+1000).toISOString()
 await store.refresh(deadlineAccount)
 check('retained card keeps its identity while the deadline updates',store.getSnapshot()!==null,store.getSnapshot())
 mock.timers.tick(1000)
 check('server deadline update also retires the existing card',store.getSnapshot()===null,store.getSnapshot())
 mock.timers.reset()
 store.clear();reports.length=0
 await store.refresh(account);const previous=store.getSnapshot()!
 store.clear();await store.refresh(account)
 store.shown(notice.id,previous);store.dismiss(notice.id,previous)
 check('retired UI callbacks cannot consume a replacement same-ID card',reports.length===0&&store.getSnapshot()!==null,reports)
}finally{store.clear();off();mock.timers.reset()}
if(failed)process.exitCode=1

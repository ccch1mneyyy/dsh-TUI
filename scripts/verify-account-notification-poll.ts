import './lib/fake-home.mjs'
import { mock } from 'node:test'
import { WhaleCouponStore } from '../src/dsh-adapter/oauth/bonus.js'
const store=new WhaleCouponStore();store.subscribe(()=>{});let reads=0
const notice={id:'plain',createdAt:'2026-01-01T00:00:00Z',displayUntil:null,title:'Server login result',body:'No amount metadata required',actions:[]}
const account={getNotifications:async()=>{reads++;return{nextPollAfterSeconds:2,notifications:[notice]}},getNotificationContent:async()=>notice,reportNotificationEvent:async()=>true}
mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-11-12T00:00:00Z')})
try{await store.refresh(account);const visible=store.getSnapshot();mock.timers.tick(2000);for(let i=0;i<10;i++)await Promise.resolve();console.log(JSON.stringify({visible,reads,expected:'server content visible; server-paced second read'}));if(visible===null||reads!==2)process.exitCode=1}finally{store.clear();mock.timers.reset()}

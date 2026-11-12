/** Unchanged actual Ink commits must not re-arm notification write receipts. */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import {Writable,PassThrough} from 'node:stream'
import React from 'react'
import {createRoot,ThemeProvider,Box,Text} from '../src/ui.js'
import {WhaleCouponPrompt} from '../src/components/StarPrompt.js'
import {settled} from './lib/term-test.mjs'
const coupon={orderId:'stable',amount:'6.00',currency:'CNY' as const,expiresAt:'2099-01-01T00:00:00Z'}
const server={kind:'account-notification' as const,orderId:'stable',title:'Server title',body:'Server body',displayUntil:null,actions:[]}
for(const [name,notice] of [['none',null],['legacy',coupon],['metadata',{...server,...coupon}],['server-copy',server]] as const){
 let writes=0,empty=0,shown=0,complete:(()=>void)|undefined
 class Output extends Writable {
  columns=80;rows=24;isTTY=true
  _write(chunk:Buffer,_encoding:BufferEncoding,done:()=>void){writes++;if(chunk.length===0)empty++;done()}
 }
 const output=new Output(),input=Object.assign(new PassThrough(),{isTTY:true,setRawMode(){},ref(){},unref(){}})
 const root=await createRoot({stdout:output as never,stdin:input as never,stderr:output as never,terminalImages:false,patchConsole:false,exitOnCtrlC:false,onFrame:()=>complete?.()})
 const onShown=()=>{shown++},onClose=()=>{}
 const paint=async()=>{
  const frame=new Promise<void>(resolve=>{complete=resolve})
  root.render(<ThemeProvider theme="dark"><Box width={80} height={24}>
   {notice===null?<Text>Stable ordinary output</Text>:<WhaleCouponPrompt notice={notice} onShown={onShown} onClose={onClose}/>}
  </Box></ThemeProvider>)
  await frame;await new Promise(resolve=>setImmediate(resolve))
 }
 try{
  await paint()
  if(notice!==null)assert.equal(await settled(()=>shown===1),true,'first card is presented')
  writes=0;empty=0;shown=0
  for(let i=0;i<10;i++)await paint()
  assert.equal(writes,0,name+': unchanged commits produce no extra output writes')
  assert.equal(empty,0,name+': unchanged commits produce no completion-barrier empty writes')
  assert.equal(shown,0,name+': stable card does not repeatedly invoke onShown')
  console.log(`PASS ${name}: 10 unchanged commits, 0 writes, 0 empty writes, 0 repeated shown`)
 }finally{complete=undefined;await root.unmount()}
}

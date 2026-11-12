import './lib/fake-home.mjs'
import { createDshTranslator } from '../src/dsh-adapter/backend/translate.js'
const source={kind:'agent-message',form:'relay',senderSessionId:'sender-id'}
for(const [name,framing] of [['legacy','Team message from reviewer:'],['rc2','Agent reviewer sent a message: ']]){
 const translator=createDshTranslator({tools:()=>undefined,scope:()=>({}),attachments:()=>undefined})
 const output=translator.translateEvent({type:'user/message',seq:1,time:1,data:{id:'message',source,content:[{type:'text',text:framing},{type:'text',text:'Review result visible to recipient'}]}} as never)
 console.log(JSON.stringify({name,output}))
 if(!output.some(x=>x.type==='user.message'&&x.source==='team-message'&&x.text==='Review result visible to recipient'))process.exitCode=1
}

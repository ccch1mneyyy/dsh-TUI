/** Actual Chat + xterm account-card screen scenarios. No real account/model.
 * SOURCE_ROOT=final exact tree; SCREEN_RESULT=JSON; SCREEN_RAW=raw terminal log.
 * Twelve independent roots (long/short document, close-during-stream/keep-open): inline/fullscreen × 80x24/36x16, each resized to the
 * other geometry. Long CJK/emoji/path/Markdown transcript, streamed updates,
 * open/hidden/restored/scrolled/closed account card. Assertions read xterm.
 */
// Match the product entry: external NODE_ENV=test must not select Ink's
// synchronous testing renderer, which paints before layout effects.
import '../src/force-production-react.js'
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import {settled,viewportLines} from './lib/term-test.mjs'
process.env.FORCE_COLOR='3';process.env.DSH_TUI_THEME='dark';process.env.DSH_TUI_LANG='zh'
const [{PassThrough,Writable},React,{Terminal},{writeFileSync},{pathToFileURL,fileURLToPath}]=await Promise.all([
 import('node:stream'),import('react'),import('@xterm/headless'),import('node:fs'),import('node:url'),
])
const sourceRoot=process.env.SOURCE_ROOT ?? fileURLToPath(new URL('../',import.meta.url))
const load=(path:string)=>import(pathToFileURL(sourceRoot+'/src/'+path).href)
const [{render,AlternateScreen,ThemeProvider,useTerminalSize},{Chat},{QuestionStore},{WhaleCouponStore},{LOCAL_COMMANDS,completeCommands}]=await Promise.all([
 load('ui.ts'),load('screens/Chat.tsx'),load('dsh-adapter/questions.ts'),load('dsh-adapter/oauth/bonus.ts'),load('commands.ts'),
])
const {activateModernEmojiWidths}=await load('../scripts/lib/modern-widths.mjs');
const snapshots:any[]=[];const raw:string[]=[];const errors:any[]=[]
for(const scenario of [{short:false,closeDuringStream:true},{short:false,closeDuringStream:false},{short:true,closeDuringStream:false}])
for(const fullscreen of [false,true])for(const initialColumns of [80,36]){
 const initialRows=initialColumns===80?24:16
 const term=new Terminal({cols:initialColumns,rows:initialRows,scrollback:2000,allowProposedApi:true})
 activateModernEmojiWidths(term);
 let frames=0,writes=0,committedVersion=-1,renderedVersion=-1
 class Output extends Writable {columns=initialColumns;rows=initialRows;isTTY=true;_write(chunk:unknown,_e:BufferEncoding,done:()=>void){const text=String(chunk);writes++;raw.push(text);term.write(text,done)}}
 class Input extends PassThrough {isTTY=true;setRawMode(){return this};ref(){return this};unref(){return this}}
 const stdout=new Output(),stdin=new Input(),stderr=new Writable({write(_c,_e,done){done()}})
 const rows:any[]=[]
 // Unique end marker on the final assistant row only: if Chat drops that row,
 // an earlier row cannot satisfy the transcript assertion by accident.
 const assistantRows=scenario.short?1:20
 for(let i=0;i<assistantRows;i++){rows.push({id:i*2+1,kind:'user',text:`中文提问🐳 ${i} /workspace/项目/长路径/文件.ts`});rows.push({id:i*2+2,kind:'assistant',text:`## 回复 ${i} 🦀\n${'没有空白的长消息'.repeat(scenario.short?1:i===assistantRows-1?100:2)}\n\n\`\`\`ts\nconst emoji = "🐳中文"\n\`\`\`${i===assistantRows-1?'\nTRANSCRIPT_END':''}`})}
 const listeners=new Set<()=>void>()
 const channel:any={whaleIdle:false,version:0,rows,status:'idle',sessionTitle:'通知回归🐳',agentId:'screen-test',model:'deepseek-v4-flash',provider:'deepseek',reasoningEffort:'max',effortLevels:[],tokens:{input:0,output:0},cwd:'/tmp/demo',displayCwd:'/tmp/demo',gitBranch:'main',working:false,spinnerMode:'requesting',responseChars:0,activeToolCount:0,turnStart:0,pending:[],commandList:LOCAL_COMMANDS,notifications:[],mode:{plan:false,sandbox:undefined},activityFrames:'moon8',agentPreset:undefined,subagents:[],lastUserText:'中文提问',scrollGutter:'timeline',subscribe(fn:()=>void){listeners.add(fn);return()=>listeners.delete(fn)},submit(){},cancel(){},clear(){},notify(){},listModels:async()=>[],listSessions:async()=>[],deleteSession:async()=>true,renameSessionTo:async()=>true,setResumeTarget(){},loadOlder(){},mcpStatus:()=>[],pushLocal(){},commandCompletions:(input:string)=>completeCommands(input)}
 const emit=()=>{channel.version++;for(const fn of listeners)fn()}
 const coupons=new WhaleCouponStore(),events:string[]=[]
 let resizeOnOffer=false
 const commits:any[]=[],reports:any[]=[]
 // Publish the new offer and resize before React's store subscriber runs.
 const unsubscribeResize=coupons.subscribe(()=>{
  if(!resizeOnOffer||coupons.getSnapshot()===null)return
  resizeOnOffer=false;stdout.columns=stdout.columns===80?36:80;stdout.rows=stdout.columns===80?24:16
  term.resize(stdout.columns,stdout.rows);stdout.emit('resize')
 })
 // The distinctive part of the server title: a card showing only the generic
 // `账号通知` label must not satisfy appearance/resize assertions.
 const marker='SCREEN_NOTICE';
 const title='账号通知🐳 SCREEN_NOTICE'
 const notice={id:'screen-notice',createdAt:'2026-01-01T00:00:00Z',displayUntil:null,title,body:Array.from({length:45},(_,i)=>`消息 ${i} 中文🦀 /very/long/path/`+'连续长文本'.repeat(4)).join('\n')+'\nEND_NOTICE_BODY',actions:[{label:'关闭',style:'secondary',target:{type:'dismiss'}}]}
 const account={getNotifications:async()=>({nextPollAfterSeconds:600,notifications:[notice]}),getNotificationContent:async()=>notice,reportNotificationEvent:async(id:string,event:string)=>{events.push(event);reports.push({id,event,screen:viewportLines(term).join('\n')});return true}}
 // Observe the exact subsequent no-change commit without adding layout nodes.
 function CommitProbe({children}:{children:React.ReactNode}){
  const version=React.useSyncExternalStore(channel.subscribe,()=>channel.version,()=>channel.version)
  const currentNotice=React.useSyncExternalStore(coupons.subscribe,coupons.getSnapshot,coupons.getSnapshot)
  const size=useTerminalSize()
  React.useLayoutEffect(()=>{committedVersion=version;commits.push({notice:currentNotice,physical:[stdout.columns,stdout.rows],context:[size.columns,size.rows],version})})
  return children
 }
 const content=<CommitProbe><ThemeProvider theme="dark"><Chat channel={channel} questionStore={new QuestionStore()} fullscreen={fullscreen} bonusNotices={coupons}/></ThemeProvider></CommitProbe>
 const app=await render(fullscreen?<AlternateScreen>{content}</AlternateScreen>:content,{stdout:stdout as never,stdin:stdin as never,stderr:stderr as never,patchConsole:false,exitOnCtrlC:false,terminalImages:false,onFrame:()=>{frames++;renderedVersion=committedVersion}})
 const screen=()=>viewportLines(term).join('\n')
 const save=(phase:string)=>snapshots.push({scenario,fullscreen,initialColumns,columns:stdout.columns,rows:stdout.rows,phase,screen:screen(),events:[...events],frames,writes,committedVersion,renderedVersion,commits:[...commits],reports:[...reports],unicodeProvider:term.unicode.activeVersion})
 try {
  assert.equal(await settled(()=>screen().includes('TRANSCRIPT_END')),true,'long transcript reaches viewport')
  save('transcript')
  await coupons.refresh(account)
  assert.equal(await settled(()=>screen().includes(marker)),true,'server copy appears in existing account-card lane')
  if(initialColumns===80)assert.equal(await settled(()=>screen().includes(title)),true,'wide card renders the full server-authored title')
  assert.equal(await settled(()=>events.filter(event=>event==='displayed').length===1),true,'first presentation reports displayed exactly once')
  save('open')
  channel.working=true;channel.status='running';emit()
  assert.equal(screen().includes(marker),true,'account card remains readable over a running transcript')
  for(let i=0;i<8;i++){
   rows.at(-1).text+=`
流式🐳 CHUNK_${i}`;channel.responseChars+=20;emit();await new Promise(resolve=>setImmediate(resolve))
   if(i===3&&scenario.closeDuringStream){stdin.write('\x1b');assert.equal(await settled(()=>coupons.getSnapshot()===null&&!screen().includes(marker)),true,'modal closes while streaming continues');assert.equal(events.filter(event=>event==='dismissed').length,1,'streaming close reports dismissed exactly once');save('closed-during-stream')}
  }
  const idleBefore=frames;channel.working=false;channel.status='idle';emit()
  assert.equal(await settled(()=>frames>idleBefore&&!screen().includes('准备中')),true,'idle layout settled before reopening');save('idle-before-reopen')
  if(!scenario.closeDuringStream){
   assert.equal(await settled(()=>screen().includes(marker)),true,'same card title survives working-to-idle shrink');
   stdin.write('\x1b');assert.equal(await settled(()=>coupons.getSnapshot()===null&&!screen().includes(marker)),true,'close after idle');
   assert.equal(events.filter(event=>event==='dismissed').length,1,'idle close reports dismissed exactly once');
  }
  const displayedBeforeRestore=events.filter(event=>event==='displayed').length
  await coupons.refresh(account)
  assert.equal(await settled(()=>screen().includes(marker)),true,'server can offer the closed notice again after streaming')
  assert.equal(await settled(()=>events.filter(event=>event==='displayed').length===displayedBeforeRestore+1),true,'new server offer adds exactly one displayed report')
  save('stream-restored')
  const before=frames,beforeResizeWrites=writes
  stdout.columns=initialColumns===80?36:80;stdout.rows=initialColumns===80?16:24
  term.resize(stdout.columns,stdout.rows);stdout.emit('resize')
  assert.equal(await settled(()=>frames>before&&screen().includes(marker)),true,'notice survives resize')
  if(!fullscreen&&!scenario.short){
   // A later no-change Chat commit must not consume a redundant resize reanchor.
   // Long restored history skips the logo intro; the idle card has no animation.
   emit();const expectedVersion=channel.version;
   assert.equal(await settled(()=>committedVersion===expectedVersion&&renderedVersion===expectedVersion),true,'exact unchanged Chat version committed and rendered after resize');
   await new Promise<void>(resolve=>term.write('',()=>resolve()));
   assert.equal(writes-beforeResizeWrites,1,'one resize repaint; no deferred duplicate viewport write');
   assert.equal(screen().includes(marker),true,'title remains visible after no-change post-resize commit');
  }
  save('resized')
  for(let i=0;i<40&&!screen().includes('END_NOTICE_BODY');i++){
   stdin.write('\x1b[6~')
   await new Promise(resolve=>setTimeout(resolve,20)) // 固定窗:pacing 真实按键解析与节流帧之间的输入节奏
  }
  assert.equal(screen().includes('END_NOTICE_BODY'),true,'long server message scrolls to its final line')
  save('scrolled')
  const dismissedBeforeClose=events.filter(event=>event==='dismissed').length
  stdin.write('\x1b')
  assert.equal(await settled(()=>coupons.getSnapshot()===null&&!screen().includes(marker)),true,'explicit close removes modal')
  assert.equal(events.filter(event=>event==='dismissed').length,dismissedBeforeClose+1,'final close adds exactly one dismissed report')
  assert.equal(events.filter(event=>event==='cta_clicked').length,0)
  save('closed')
  if(!fullscreen&&!scenario.short){
   coupons.clear();emit();let expectedVersion=channel.version
   assert.equal(await settled(()=>committedVersion===expectedVersion&&renderedVersion===expectedVersion),true)
   await new Promise<void>(resolve=>term.write('',resolve))
   const beforeWrites=writes,beforeCommits=commits.length
   notice.id='same-commit-resize-offer';resizeOnOffer=true;await coupons.refresh(account)
   const offered=coupons.getSnapshot();assert.ok(offered)
   assert.equal(await settled(()=>commits.slice(beforeCommits).some(c=>c.notice===offered)),true)
   const first=commits.slice(beforeCommits).find(c=>c.notice===offered)
   assert.deepEqual(first.physical,[stdout.columns,stdout.rows])
   assert.deepEqual(first.context,[stdout.columns,stdout.rows],'first visible offer commit already has resized context')
   assert.equal(await settled(()=>reports.some(r=>r.id===notice.id&&r.event==='displayed')),true)
   emit();expectedVersion=channel.version
   assert.equal(await settled(()=>committedVersion===expectedVersion&&renderedVersion===expectedVersion),true)
   await new Promise<void>(resolve=>term.write('',resolve))
   const displayed=reports.filter(r=>r.id===notice.id&&r.event==='displayed')
   assert.equal(displayed.length,1,'new offer has exactly one identity-matched receipt')
   assert.ok(displayed[0].screen.includes(marker)&&displayed[0].screen.includes('消息 0'),'receipt sees title and body after simultaneous appearance/resize')
   assert.ok(screen().includes(marker),'title survives the subsequent unchanged commit')
   assert.equal(writes-beforeWrites,1,'simultaneous appearance/resize has one repaint, no deferred reanchor')
   save('same-commit-appearance-resize')
   stdin.write('\x1b');assert.equal(await settled(()=>coupons.getSnapshot()===null&&!screen().includes(marker)),true)
  }
 }catch(error){save("failure");errors.push({scenario,fullscreen,initialColumns,error:String(error)});console.error(scenario,fullscreen,initialColumns,error)}finally{
 if(process.env.SCREEN_RESULT)writeFileSync(process.env.SCREEN_RESULT,JSON.stringify({sourceRoot,node:process.version,snapshots},null,2));if(process.env.SCREEN_RAW)writeFileSync(process.env.SCREEN_RAW,raw.join(""))
 unsubscribeResize();coupons.clear();await app.unmount();term.dispose()
 }
}
if(process.env.SCREEN_RESULT)writeFileSync(process.env.SCREEN_RESULT,JSON.stringify({sourceRoot,node:process.version,snapshots},null,2))
if(process.env.SCREEN_RAW)writeFileSync(process.env.SCREEN_RAW,raw.join(''))
if(errors.length){console.error(JSON.stringify(errors));process.exit(1)}
console.log('PASS account notice Chat geometry (12 scenarios): inline/fullscreen, 80/36 columns, resize, CJK/emoji, stream, scroll, close')

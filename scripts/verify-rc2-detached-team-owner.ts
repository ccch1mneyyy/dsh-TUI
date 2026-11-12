import './lib/fake-home.mjs'
import { createTeamRosterStore } from '../src/dsh-adapter/team-roster.js'
const root={id:'loaded-root',header:{origin:'root'}}
const detached={id:'detached-child',header:{origin:'subagent',parentSession:root.id}}
const rootAgent={session:root};const childAgent={session:detached}
const ctx={get(name:string){if(name==='agents')return{list:()=>[rootAgent,childAgent]};if(name==='agentTeams')return{};if(name==='subagents')return{rootOf(agent:object){if(agent===childAgent)throw Object.assign(new Error('agent has no active runtime owner'),{code:'UNAUTHORIZED'});return rootAgent}}},on:()=>()=>{},inject(){},logger:{warn(){}}}
const store=createTeamRosterStore(ctx as never)
store.attachRegistry({snapshot:(session:unknown)=>({values:{agentTeam:{enabled:true,tasks:[],failure:session===root?'root-only-diagnostic':undefined}}})} as never)
store.seed(detached)
const visible=store.teamOf(detached.id)
console.log(JSON.stringify({expected:'no team for independently restored delegated session',visible:visible??null}))
if(visible!==undefined)process.exitCode=1

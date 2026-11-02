import test from 'node:test'
import assert from 'node:assert/strict'
import { createScheduler, normalizeScheduler } from '../scheduler.js'
import { schedulerContext } from '../scheduler-context.js'
import { buildAdvisorTranscript } from '../transcript.js'
import { createAdviceEngine } from '../advice.js'
import { createDialogueStore } from '../dialogue.js'
import { normalizeConfig } from '../config.js'
const env={K:'synthetic-only'}
const cfg=normalizeScheduler({kind:'decisions',openaiApiKeyEnv:'K',timeoutMs:1000})
const answer=()=>({ok:true,status:200,json:async()=>({answers:[{name:'boundary',type:'predicate',probability:.1},{name:'stuck',type:'predicate',probability:.1}]})})
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const text=n=>Array.from({length:n},(_,i)=>`source ${i}\n${'useful evidence '.repeat(190)}\n\n`).join('')

// These assertions observe the next actual request, not private ledger internals.
test('successful endpoints survive large appends; failed responses never replace them',async()=>{
 let fail=false;const calls=[]
 const engine=createScheduler({env,openaiFetchImpl:async(_url,init)=>{calls.push(JSON.parse(init.body));return fail?{ok:false,status:400}:answer()}})
 const first=text(35),second=text(50)
 await engine.decide({scheduler:cfg,state:first,sessionId:'s'})
 fail=true;await engine.decide({scheduler:cfg,state:second,sessionId:'s'});fail=false
 const result=await engine.decide({scheduler:cfg,state:second+'next',sessionId:'s'})
 assert.equal(result.cache.previousEndpointRetained,true)
 let end=0;assert.ok(calls.at(-1).input[1].content.some(p=>{end+=p.text.length;return end===first.length&&p.prompt_cache_breakpoint}))
 assert.equal(JSON.stringify(result).includes(first.slice(0,200)),false)
})

test('out-of-order responses, Stop, clear and configuration scopes cannot revive stale checkpoints',async()=>{
 const waiting=[];let hold=true
 const engine=createScheduler({env,openaiFetchImpl:async()=>{if(!hold)return answer();const d=deferred();waiting.push(d);return d.promise}})
 const a=text(34),b=text(42),c=text(50)
 const p1=engine.decide({scheduler:cfg,state:a,sessionId:'s'})
 const p2=engine.decide({scheduler:cfg,state:b,sessionId:'s'})
 waiting[1].resolve(answer());await p2;waiting[0].resolve(answer());await p1;hold=false
 const result=await engine.decide({scheduler:cfg,state:c,sessionId:'s'})
 assert.equal(result.cache.sharedPrefixChars,b.length)
 assert.equal((await engine.decide({scheduler:cfg,state:c,sessionId:'other'})).cache.previousEndpointRetained,false)
 assert.equal((await engine.decide({scheduler:{...cfg,stateChars:256000},state:c,sessionId:'s'})).cache.previousEndpointRetained,false)
 hold=true;const controller=new AbortController();const stopped=engine.decide({scheduler:cfg,state:c+'stopped',sessionId:'s',signal:controller.signal})
 controller.abort(new Error('stop'));waiting.at(-1).resolve(answer());await assert.rejects(stopped,/stop/)
 engine.clear('s');hold=false
 assert.equal((await engine.decide({scheduler:cfg,state:c,sessionId:'s'})).cache.previousEndpointRetained,false)
 hold=true;const late=engine.decide({scheduler:cfg,state:c+'late',sessionId:'s'});engine.clear('s');waiting.at(-1).resolve(answer());await late;hold=false
 assert.equal((await engine.decide({scheduler:cfg,state:c,sessionId:'s'})).cache.previousEndpointRetained,false)
 engine.close()
})

test('JEV selects official long-context opt-in without inventing cache counters',async()=>{
 const requests=[]
 const engine=createScheduler({env,fetchImpl:async(_url,init)=>{requests.push(init);return{ok:true,status:200,json:async()=>({model:'jev-1.14.0',answers:{boundary:{noul:.1},stuck:{noul:.2}},usage:{input_tokens:40001}})}}})
 const long=schedulerContext([{serialized:text(40),realUser:true},...Array.from({length:7},(_,i)=>({serialized:`tool ${i} ${text(5)}`}))])
 assert.ok(long.text.length>100000)
 const result=await engine.decide({scheduler:normalizeScheduler({kind:'jev',apiKeyEnv:'K'}),state:long})
 assert.equal(requests[0].headers['TypeSafe-Danger-Zone-Long-Context'],'true')
 assert.equal(JSON.parse(requests[0].body).state,long.text)
 assert.equal(result.context.inputChars,long.text.length)
 assert.equal(result.cache.reported,false)
 await engine.decide({scheduler:normalizeScheduler({kind:'jev',apiKeyEnv:'K'}),state:'short'})
 assert.equal(requests[1].headers['TypeSafe-Danger-Zone-Long-Context'],undefined)
})

const msg=(id,content,role='tool')=>({id,role,source:{kind:role==='user'?'user':role},content})
async function harness({asyncRef=false,judge}={}){
 const history=[msg('goal','Inspect the modules and assess a completed stage.','user')]
 const session={header:{id:'long-context-engine'},seq:1,eventAt(){return{type:'model/selection',data:{provider:'moa',model:'test'}}},deriveMessages:()=>history}
 const preset={id:'test',fanout:'smart',scheduler:{...cfg,minGap:1,maxGap:20},references:[{id:'r',provider:'fake',model:'ref',async:asyncRef}],aggregator:{provider:'fake',model:'actor'},referenceTimeoutMs:5000,deadlineMs:5000}
 const config=normalizeConfig({enabled:true,persistentTags:[],defaultPreset:'test',maxTranscriptChars:15000})
 const store=createDialogueStore({persistentTags:[],kv:null});await store.load()
 const gate=deferred();let references=0,judges=0,clears=0
 const runtime={stream(){references++;return(async function*(){if(asyncRef)await gate.promise;yield{type:'text-delta',text:'Evidence-based review.'};yield{type:'finish',reason:{kind:'stop'}}})()}}
 const scheduler={async decide(input){judges++;return judge?judge(input):{due:false,reason:'continue',context:input.state.context}},clear(){clears++}}
 const engine=createAdviceEngine({runtime,store,presets:new Map([['test',preset]]),config,scheduler});await engine.load()
 const step=n=>engine.preStep({agent:{session},turn:1,step:n,signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}))
 return{history,session,engine,step,gate,counts:()=>({references,judges,clears})}
}

test('pending async reference is checked before the paid judge and harvested without judging',async()=>{
 const h=await harness({asyncRef:true});await h.step(1)
 h.history.push(msg('running','Related command is still running.'));await h.step(2)
 assert.equal(h.counts().judges,0)
 h.gate.resolve();await new Promise(r=>setTimeout(r,10))
 h.history.push(msg('completed','Reference has completed.'));await h.step(3)
 assert.equal(h.counts().judges,0)
 h.history.push(msg('next','Next tool result.'));await h.step(4)
 assert.equal(h.counts().judges,1)
 await h.engine.close()
})

test('judge receives over100k from full structured records even when advisor view is much smaller',async()=>{
 let received;const h=await harness({judge:async input=>{received=input.state;return{due:false,reason:'continue',context:input.state.context}}})
 await h.step(1)
 for(let i=0;i<15;i++)h.history.push(msg(`t${i}`,`Read ${i}\n${'meaningful source evidence '.repeat(330)}`))
 await h.step(2)
 assert.ok(received.text.length>100000)
 assert.ok(received.text.length<=128000)
 assert.ok(received.text.endsWith(buildAdvisorTranscript([h.history.at(-1)]).source))
 assert.equal(h.engine.recentRuns().find(r=>r.kind==='schedule').context.inputChars,received.text.length)
 await h.engine.close()
})

test('clear and configuration cancellation release an uncooperative judge and discard late intervention',async()=>{
 for(const action of ['clear','cancelAll']){
  const gate=deferred();const h=await harness({judge:()=>gate.promise});await h.step(1)
  h.history.push(msg('pending','New result to classify.'));const pending=h.step(2)
  await new Promise(r=>setTimeout(r,5));await h.engine[action]()
  const timeout=setTimeout(()=>gate.resolve({due:true,reason:'late'}),200)
  await pending;clearTimeout(timeout)
  assert.equal(h.counts().references,1)
  assert.ok(h.counts().clears>0)
  assert.equal(h.engine.stats().activeJudges,0)
  gate.resolve({due:true,reason:'late'});await new Promise(r=>setTimeout(r,5))
  assert.equal(h.counts().references,1)
  await h.engine.close()
 }
})

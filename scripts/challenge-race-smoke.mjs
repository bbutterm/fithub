// Execute the actual component handlers with controlled deferred promises.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const src=fs.readFileSync(new URL('../apps/webapp/src/screens/Challenges.tsx',import.meta.url),'utf8');
const pick=src.slice(src.indexOf('  async function pick('),src.indexOf('  async function start(')).replace('templateId: string','templateId');
const cancel=src.slice(src.indexOf('  function cancelPick()'),src.indexOf('  function reload('));
function harness(){
 const state={picked:null,check:null,error:''}; const pending={};
 const api={challengeFeasibility:id=>new Promise((resolve,reject)=>{pending[id]={resolve,reject};})};
 const handlers=new Function('api','selectionRequest','setPicked','setCheck','setError',`${cancel}\n${pick}\nreturn {pick,cancelPick};`)(api,{current:0},x=>state.picked=x,x=>state.check=x,x=>state.error=x);
 return {state,pending,...handlers};
}
for(const staleError of [false,true]){
 const h=harness();const a=h.pick('A'),b=h.pick('B');
 h.pending.B.resolve({suggestedValue:20});await b;
 if(staleError)h.pending.A.reject(new Error('old failure'));else h.pending.A.resolve({suggestedValue:999});
 await a;assert.equal(h.state.picked,'B');assert.equal(h.state.check.suggestedValue,20);assert.equal(h.state.error,'');
}
for(const failure of [false,true]){
 const h=harness();const p=h.pick('A');h.cancelPick();
 if(failure)h.pending.A.reject(new Error('cancelled'));else h.pending.A.resolve({suggestedValue:999});
 await p;assert.equal(h.state.picked,null);assert.equal(h.state.check,null);assert.equal(h.state.error,'');
}
console.log('PASS: 4 controlled challenge selection/cancellation races (actual source handlers)');

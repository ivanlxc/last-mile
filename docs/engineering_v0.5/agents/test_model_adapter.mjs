// Run with Node 24: node --experimental-transform-types agents/test_model_adapter.mjs
// Offline runtime smoke test only; does not replace TypeScript compiler checks.
import {MockModelAdapter,HttpJsonModelAdapter} from './modelAdapter.ts';
import {writeFile} from 'node:fs/promises';
const adapter=new MockModelAdapter(async request=>({ok:true,structured:{echo:request.role},usage:{inputTokens:1,outputTokens:1},providerRequestId:null}));
const response=await adapter.generateStructured({role:'advisor',model:'mock',systemPrompt:'test',input:{},schema:{},requestKey:'00000000-0000-0000-0000-000000000001',maxOutputTokens:1,timeoutMs:10});
if(!response.ok||response.structured.echo!=='advisor')throw Error('mock failed');
let rejected=false;try{new HttpJsonModelAdapter('http://remote.example/endpoint','unused-test-placeholder',false);}catch{rejected=true;}
if(!rejected)throw Error('HTTP endpoint allowed');
const report={mockCall:'PASS',nonTLSRemoteRejected:'PASS',liveNetworkCalls:0,typescriptStaticTypecheck:'NOT_RUN'};
await writeFile(new URL('./adapter-validation-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));

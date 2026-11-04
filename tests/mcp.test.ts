import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {after,test} from "node:test";
import {fileURLToPath,pathToFileURL} from "node:url";
import ts from "typescript";
import type {McpDependencies} from "../app/mcp/route";

const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),temporary=mkdtempSync(join(tmpdir(),"avia-mcp-"));
const code=ts.transpileModule(readFileSync(join(root,"app/mcp/route.ts"),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
writeFileSync(join(temporary,"route.mjs"),code);
const {handleMcp}=await import(pathToFileURL(join(temporary,"route.mjs")).href) as typeof import("../app/mcp/route");
after(()=>rmSync(temporary,{recursive:true,force:true}));
const request=(method:string,params?:unknown,id:unknown=1)=>new Request("https://site.example/mcp",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
type RpcPayload={result:{supportedVersions:string[];tools:{name:string}[];structuredContent:{pending?:number;sent?:number};isError:boolean};error:{code:number}};
const payload=async(response:Response)=>await response.json() as RpcPayload;
function dependencies(role:string|null="admin"){
 let processing=0,reading=0,auth=0;
 const deps:McpDependencies={
  async getUser(){auth++;return role?{role}:null;},
  async notificationStatus(){reading++;return {pending:3,delivered:7,failed:1,last_delivery_at:"2026-11-03T16:00:00Z"};},
  async processNotifications(){processing++;return {queued:2,sent:1,failed:0,configured:true};},
 };
 return {deps,counts:()=>({processing,reading,auth})};
}

test("MCP discovery/list expose metadata without authorizing or running queue",async()=>{
 const fixture=dependencies(null);
 const discover=await payload(await handleMcp(request("server/discover"),fixture.deps));
 assert.deepEqual(discover.result.supportedVersions,["2026-07-28"]);
 const list=await payload(await handleMcp(request("tools/list"),fixture.deps));
 assert.deepEqual(list.result.tools.map((tool:{name:string})=>tool.name),["notification_status","process_notifications"]);
 assert.deepEqual(fixture.counts(),{processing:0,reading:0,auth:0});
});
test("anonymous, analyst and manager cannot run global notifications or read queue",async()=>{
 for(const role of [null,"analyst","manager"]){
  const fixture=dependencies(role);
  for(const name of ["process_notifications","notification_status"]){
   const response=await handleMcp(request("tools/call",{name,arguments:{}}),fixture.deps);
   assert.equal(response.status,403);assert.equal((await payload(response)).error.code,-32001);
  }
  assert.deepEqual(fixture.counts(),{processing:0,reading:0,auth:2});
 }
});
test("admin read-only status cannot send; admin writer queues/sends exactly once",async()=>{
 const fixture=dependencies();
 const status=await payload(await handleMcp(request("tools/call",{name:"notification_status",arguments:{}}),fixture.deps));
 assert.equal(status.result.structuredContent.pending,3);
 assert.deepEqual(fixture.counts(),{processing:0,reading:1,auth:1});
 const process=await payload(await handleMcp(request("tools/call",{name:"process_notifications",arguments:{}}),fixture.deps));
 assert.equal(process.result.structuredContent.sent,1);assert.equal(process.result.isError,false);
 assert.deepEqual(fixture.counts(),{processing:1,reading:1,auth:2});
});
test("credential arguments, unknown tools and absent request ids cannot invoke services",async()=>{
 const fixture=dependencies();
 for(const params of [{name:"process_notifications",arguments:{BOT_TOKEN:"offline-dummy"}},{name:"unknown",arguments:{}},{name:"process_notifications",arguments:[]}] ){
  const response=await handleMcp(request("tools/call",params),fixture.deps);assert.equal((await payload(response)).error.code,-32602);
 }
 const notification=new Request("https://site.example/mcp",{method:"POST",body:JSON.stringify({jsonrpc:"2.0",method:"tools/call",params:{name:"process_notifications",arguments:{}}})});
 assert.equal((await payload(await handleMcp(notification,fixture.deps))).error.code,-32602);
 assert.deepEqual(fixture.counts(),{processing:0,reading:0,auth:0});
});
test("parse errors, batches and oversized bodies never authorize or execute",async()=>{
 const fixture=dependencies();
 for(const body of ["{",JSON.stringify([]),JSON.stringify({jsonrpc:"1.0",method:"tools/list"}),JSON.stringify({jsonrpc:"2.0",method:"tools/list",id:true})," ".repeat(17000)]){
  const response=await handleMcp(new Request("https://site.example/mcp",{method:"POST",body}),fixture.deps);assert.ok(response.status>=400);
 }
 assert.deepEqual(fixture.counts(),{processing:0,reading:0,auth:0});
 const get=await handleMcp(new Request("https://site.example/mcp"),fixture.deps);assert.equal(get.status,405);
});
test("secret-bearing transport/SQL exception is replaced with generic Russian error",async()=>{
 const fixture=dependencies();fixture.deps.processNotifications=async()=>{throw new Error("https://api.telegram.org/botoffline-dummy/sendMessage");};
 const response=await handleMcp(request("tools/call",{name:"process_notifications"}),fixture.deps);
 const text=await response.text();assert.ok(!text.includes("offline-dummy"));assert.ok(text.includes("Не удалось обработать уведомления"));
 assert.equal(JSON.parse(text).result.isError,true);
});

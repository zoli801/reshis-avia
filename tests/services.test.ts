import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServices, handleApi, pendingDeliveries, processNotifications, queueDigests } from "../lib/server/services.ts";
import { now, type AppEnv, type UserRecord } from "../lib/server/db.ts";
import { seedData } from "../lib/aviation/seed.ts";
import { exportRoutesCsv } from "../lib/aviation/csv.ts";
import { signIn } from "../lib/server/auth.ts";

/** Exercise generated production SQL rather than recreating table definitions. */
function fixture(){
  const sqlite=new DatabaseSync(":memory:");sqlite.exec("PRAGMA foreign_keys=ON");
  for(const file of readdirSync(new URL("../drizzle/",import.meta.url)).filter(file=>file.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL("../drizzle/"+file,import.meta.url),"utf8"));
  const prepare=(sql:string,values:unknown[]=[])=>({
    bind(...next:unknown[]){return prepare(sql,next);},
    async first<T>(){return (sqlite.prepare(sql).get(...values as (string|number|null)[])??null) as T|null;},
    async all<T>(){return {results:sqlite.prepare(sql).all(...values as (string|number|null)[]) as T[],success:true};},
    async run(){const result=sqlite.prepare(sql).run(...values as (string|number|null)[]);return {meta:{changes:Number(result.changes)},success:true};},
  });
  let transaction=Promise.resolve();
  const db={prepare,async batch(statements:{run:()=>Promise<unknown>}[]){const task=transaction.then(async()=>{sqlite.exec("BEGIN");try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec("COMMIT");return results;}catch(error){sqlite.exec("ROLLBACK");throw error;}});transaction=task.then(()=>{},()=>{});return task;}} as unknown as D1Database;
  const objects=new Map<string,string>();
  const bucket={async put(key:string,value:string){if(!objects.has(key))objects.set(key,value);return null;}} as unknown as R2Bucket;
  const env={DB:db,BUCKET:bucket,BOT_ID:"9144995775",BOT_USERNAME:"offline_fixture_bot"} as AppEnv;
  const user=(id:string,role:UserRecord['role']="analyst",telegramId:number|null=null):UserRecord=>{const row={id,email:id+"@example.test",name:id,role,telegram_id:telegramId,chat_id:telegramId,openai_id:id,created_at:now()};sqlite.prepare("INSERT INTO users(id,email,name,role,telegram_id,chat_id,openai_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run(...Object.values(row));return row;};
  return {sqlite,db,env,objects,user,close:()=>sqlite.close()};
}
async function call(env:AppEnv,path:string,method="GET",payload?:unknown,user?:UserRecord|null){const request=new Request("https://avia.example.test/api/"+path,{method,headers:{Origin:"https://avia.example.test",...(payload!==undefined?{"Content-Type":"application/json"}:{})},...(payload!==undefined?{body:JSON.stringify(payload)}:{})});return handleApi(request,path,env,user);}
const input={route:"MOW-AER",date:"2026-06-01",price:9000};
type Json={ [key:string]:unknown };

test("public analytics preserves selected-price forecast and rejects unavailable pairs/dates; bot diagnostics are protected",async()=>{
  const f=fixture();try{
    const response=await call(f.env,"analytics","POST",input,null);
    const value=await response.json() as {timeline:{date:string;demand:number;sales:number;capacity:number}[];selected:{contribution_delta:number};summary:{days:number}};
    assert.equal(response.status,200);assert.equal(value.summary.days,31);
    assert.deepEqual(value.timeline.find(day=>day.date===input.date)&&{demand:value.timeline[0].demand,sales:value.timeline[0].sales,capacity:value.timeline[0].capacity},{demand:843,sales:843,capacity:900});
    assert.equal(value.selected.contribution_delta,0);
    assert.equal((await call(f.env,"analytics","POST",{...input,route:"AER-MOW"},null)).status,404);
    assert.equal((await call(f.env,"analytics","POST",{...input,date:"2026-11-04"},null)).status,404);
    assert.equal((await call(f.env,"analytics","POST",{...input,price:-1},null)).status,422);
    assert.equal((await call(f.env,"bot/diagnostics")).status,403);
    assert.equal((await call(f.env,"admin/telegram/diagnostics","POST",{},null)).status,401);
    assert.equal((await call(f.env,"admin/telegram/diagnostics","POST",{},f.user("guest-operator"))).status,403);
  }finally{f.close();}
});

test("public calculator uses the sealed seed and exact clipping; unsupported input never invents a route",async()=>{
  const f=fixture();try{
    const response=await call(f.env,"forecast","POST",input,null),value=await response.json() as {demand:number;sales:number;capacity:number;quantiles:{q:number;demand:number}[]};
    assert.equal(response.status,200);assert.equal(value.demand,843);assert.equal(value.sales,843);assert.equal(value.capacity,900);assert.equal(value.quantiles[4].demand,value.demand);
    const costly=await (await call(f.env,"forecast","POST",{...input,price:1e6},null)).json() as {sales:number;empty_seats:number};assert.equal(costly.sales,0);assert.equal(costly.empty_seats,900);
    assert.equal((await call(f.env,"forecast","POST",{...input,route:"AER-MOW"},null)).status,404);
    assert.equal((await call(f.env,"forecast","POST",{...input,price:-1},null)).status,422);
    const oversized=new Request("https://avia.example.test/api/forecast",{method:"POST",headers:{Origin:"https://avia.example.test"},body:JSON.stringify({...input,excess:"x".repeat(70000)})});
    assert.equal((await handleApi(oversized,"forecast",f.env,null)).status,413);
  }finally{f.close();}
});

test("scenario ownership and approval persist in D1; analyst cannot read another user or rewrite approval",async()=>{
  const f=fixture();try{
    const alice=f.user("alice"),bob=f.user("bob"),manager=f.user("manager","manager");
    assert.equal((await call(f.env,"scenarios","POST",{...input,title:"Решение"},null)).status,401);
    const created=await call(f.env,"scenarios","POST",{...input,title:"Решение",alternatives:[9589]},alice),scenario=await created.json() as {id:string;owner_id:string;result:Json;result_json?:unknown};
    assert.equal(created.status,201);assert.equal(scenario.owner_id,alice.id);assert.equal(scenario.result_json,undefined);
    assert.equal((await call(f.env,"scenarios/"+scenario.id,"GET",undefined,bob)).status,404);
    assert.equal((await call(f.env,"scenarios/"+scenario.id,"DELETE",undefined,bob)).status,404);
    assert.equal((await call(f.env,"scenarios/"+scenario.id,"PATCH",{status:"approved"},alice)).status,403);
    assert.equal((await call(f.env,"scenarios/"+scenario.id,"PATCH",{status:"approved"},manager)).status,200);
    assert.equal((await call(f.env,"scenarios/"+scenario.id,"PATCH",{note:"Подмена"},alice)).status,403);
    const saved=await (await call(f.env,"scenarios/"+scenario.id,"GET",undefined,alice)).json() as {status:string;history:unknown[]};assert.equal(saved.status,"approved");assert.equal(saved.history.length,2);
  }finally{f.close();}
});

test("new CSV activates a version and archives originals without changing a saved report snapshot",async()=>{
  const f=fixture();try{
    const alice=f.user("alice"),admin=f.user("admin","admin");
    const original=await (await call(f.env,"scenarios","POST",{...input,title:"Исходный расчёт",alternatives:[9589]},alice)).json() as {id:string;dataset_id:string;result:{demand:number}};
    const rows=structuredClone(seedData.rows);for(const key of Object.keys(rows[0]))if(key.endsWith("_base_demand"))rows[0][key as keyof typeof rows[0]]=Number(rows[0][key as keyof typeof rows[0]])+100 as never;
    const fields=Object.keys(rows[0]),csv=[fields.join(','),...rows.map(row=>fields.map(key=>row[key as keyof typeof row]).join(','))].join('\n');
    const form=new FormData();form.set("forecast",new File([csv],"new.csv",{type:"text/csv"}));form.set("routes",new File([exportRoutesCsv(seedData.routes)],"routes.csv"));
    const response=await handleApi(new Request("https://avia.example.test/api/admin/import",{method:"POST",headers:{Origin:"https://avia.example.test"},body:form}),"admin/import",f.env,admin);
    assert.equal(response.status,200);const imported=await response.json() as {changed:boolean;dataset:{id:string}};assert.equal(imported.changed,true);assert.notEqual(imported.dataset.id,original.dataset_id);assert.equal(f.objects.size,2);
    const current=await (await call(f.env,"forecast","POST",input,null)).json() as {demand:number};assert.equal(current.demand,original.result.demand+100);
    const saved=await (await call(f.env,"scenarios/"+original.id,"GET",undefined,alice)).json() as typeof original;assert.equal(saved.result.demand,original.result.demand);assert.equal(saved.dataset_id,original.dataset_id);
    const report=await call(f.env,`scenarios/${original.id}/report`,"GET",undefined,alice),html=await report.text();assert.equal(report.status,200);assert.ok(html.includes(original.dataset_id));assert.ok(html.includes('data-quantile="0.5"'));assert.ok(!html.includes(imported.dataset.id));
  }finally{f.close();}
});

test("daily digest opt-in is independent of change alerts, deduplicated, and unsubscribe clears pending deliveries",async()=>{
  const f=fixture();try{
    const user=f.user("digest-user","analyst",42);
    const settings={enabled:false,digest_enabled:true,digest_hour:0,quiet_start:0,quiet_end:0,timezone:"UTC",routes:[],change_threshold:5};
    assert.equal((await call(f.env,"notifications","PUT",settings,user)).status,200);
    assert.equal(await queueDigests(f.env),1);assert.equal(await queueDigests(f.env),0);
    const pending=await pendingDeliveries(f.env);assert.equal(pending.length,1);assert.equal(pending[0].kind,"digest");
    await createServices(f.env).unsubscribe(42);assert.equal((await pendingDeliveries(f.env)).length,0);
    const row=f.sqlite.prepare("SELECT settings_json FROM notification_preferences WHERE user_id=?").get(user.id) as {settings_json:string};assert.equal(JSON.parse(row.settings_json).digest_enabled,false);
  }finally{f.close();}
});

test("delivery leases and known rate limits prevent duplicate sends; uncertain send is not retried",async()=>{
  const f=fixture(),originalFetch=globalThis.fetch;try{
    const user=f.user("delivery-user","analyst",42),settings={enabled:true,digest_enabled:false,digest_hour:0,quiet_start:0,quiet_end:0,timezone:"UTC",routes:[],change_threshold:5};
    await call(f.env,"notifications","PUT",settings,user);f.env.BOT_TOKEN="offline-synthetic-token";
    f.sqlite.prepare("INSERT INTO deliveries(id,user_id,chat_id,text,kind,created_at) VALUES('first',?,42,'Тест','change',?)").run(user.id,now());
    let sends=0;globalThis.fetch=async()=>{sends++;return Response.json({ok:true,result:{message_id:1}});};
    const [left,right]=await Promise.all([processNotifications(f.env),processNotifications(f.env)]);assert.equal(left.sent+right.sent,1);assert.equal(sends,1);
    f.sqlite.prepare("INSERT INTO deliveries(id,user_id,chat_id,text,kind,created_at) VALUES('rate',?,42,'Тест','change',?)").run(user.id,now());
    globalThis.fetch=async()=>{sends++;return Response.json({ok:false,parameters:{retry_after:120}},{status:429});};await processNotifications(f.env);assert.equal((await pendingDeliveries(f.env)).length,0);
    f.sqlite.prepare("INSERT INTO deliveries(id,user_id,chat_id,text,kind,created_at) VALUES('uncertain',?,42,'Тест','change',?)").run(user.id,now());
    globalThis.fetch=async()=>{sends++;throw new Error("offline synthetic network loss");};await processNotifications(f.env);const before=sends;await processNotifications(f.env);assert.equal(sends,before);
    const uncertain=f.sqlite.prepare("SELECT sent_at,last_error FROM deliveries WHERE id='uncertain'").get() as {sent_at:number;last_error:string};assert.ok(uncertain.sent_at);assert.equal(uncertain.last_error,"delivery_uncertain");
  }finally{globalThis.fetch=originalFetch;f.close();}
});

test("Telegram account linking fits the start payload limit and is single-use",async()=>{
  const f=fixture();try{
    const owner=f.user("owner");const response=await call(f.env,"auth/telegram/link","POST",{},owner),link=await response.json() as {code:string;url:string};assert.equal(response.status,200);assert.ok(new URL(link.url).searchParams.get('start')!.length<=64);
    const services=createServices(f.env);await services.link({code:link.code,telegram_id:42,chat_id:42,name:"Тест"});
    const user=f.sqlite.prepare("SELECT telegram_id,chat_id,role FROM users WHERE id=?").get(owner.id) as {telegram_id:number;chat_id:number;role:string};assert.equal(user.telegram_id,42);assert.equal(user.chat_id,42);assert.equal(user.role,"analyst");
    await assert.rejects(()=>services.link({code:link.code,telegram_id:43,chat_id:43,name:"Подмена"}));
  }finally{f.close();}
});

test("two browser guests keep independent persistent profiles and cannot see or modify each other's decisions",async()=>{
  const f=fixture();try{
    const browserCall=(path:string,method="GET",payload?:unknown,cookie?:string)=>handleApi(new Request("https://avia.example.test/api/"+path,{method,headers:{Origin:"https://avia.example.test",...(cookie?{Cookie:cookie}:{}),...(payload!==undefined?{"Content-Type":"application/json"}:{})},...(payload!==undefined?{body:JSON.stringify(payload)}:{})}),path,f.env);
    const first=await browserCall("auth/guest","POST",{}),second=await browserCall("auth/guest","POST",{});
    assert.equal(first.status,200);assert.equal(second.status,200);
    const alice=await first.json() as {user:{id:string;role:string;auth_provider:string;telegram_id:number|null}},bob=await second.json() as typeof alice;
    const aliceCookie=first.headers.get("set-cookie")!.split(';')[0],bobCookie=second.headers.get("set-cookie")!.split(';')[0];
    assert.notEqual(alice.user.id,bob.user.id);assert.notEqual(aliceCookie,bobCookie);assert.equal(alice.user.role,"analyst");assert.equal(alice.user.auth_provider,"guest");assert.equal(alice.user.telegram_id,null);
    const repeated=await (await browserCall("auth/guest","POST",{},aliceCookie)).json() as typeof alice;assert.equal(repeated.user.id,alice.user.id);
    const current=await (await browserCall("auth/me","GET",undefined,aliceCookie)).json() as typeof alice;assert.equal(current.user.id,alice.user.id);assert.equal(current.user.auth_provider,"guest");
    const created=await browserCall("scenarios","POST",{...input,title:"Гостевое решение"},aliceCookie);assert.equal(created.status,201);const scenario=await created.json() as {id:string;owner_id:string};assert.equal(scenario.owner_id,alice.user.id);
    const others=await (await browserCall("scenarios","GET",undefined,bobCookie)).json() as {items:unknown[]};assert.deepEqual(others.items,[]);
    for(const path of [`scenarios/${scenario.id}`,`scenarios/${scenario.id}/report`,`scenarios/${scenario.id}/export.csv`])assert.equal((await browserCall(path,"GET",undefined,bobCookie)).status,404);
    assert.equal((await browserCall(`scenarios/${scenario.id}`,"PATCH",{note:"Чужая правка"},bobCookie)).status,404);
    assert.equal((await browserCall(`scenarios/${scenario.id}`,"DELETE",undefined,bobCookie)).status,404);
    assert.equal((await browserCall(`scenarios/${scenario.id}/report`,"GET",undefined,aliceCookie)).status,200);
    assert.equal((await browserCall("notifications","PUT",{enabled:false,digest_enabled:false,timezone:"UTC"},aliceCookie)).status,200);
    assert.equal((await browserCall("auth/guest","GET")).status,405);
    const noOrigin=new Request("https://avia.example.test/api/auth/guest",{method:"POST",body:"{}"});assert.equal((await handleApi(noOrigin,"auth/guest",f.env)).status,403);
  }finally{f.close();}
});

test("guest provisioning cannot claim an administrator or Telegram identity and never exposes Telegram-owned records",async()=>{
  const f=fixture();try{
    const telegram=f.user("telegram-profile","analyst",42);f.sqlite.prepare("UPDATE users SET email=NULL,openai_id=NULL WHERE id=?").run(telegram.id);telegram.email=null;telegram.openai_id=null;
    const tgSaved=await (await call(f.env,"scenarios","POST",{...input,title:"Личное решение Telegram"},telegram)).json() as {id:string};
    const guestResponse=await call(f.env,"auth/guest","POST",{role:"admin",telegram_id:42,openai_id:"owner",email:"owner@example.test"});
    assert.equal(guestResponse.status,200);const guest=await guestResponse.json() as {user:{id:string;role:string;telegram_id:number|null;auth_provider:string}},cookie=guestResponse.headers.get("set-cookie")!.split(';')[0];
    assert.equal(guest.user.role,"analyst");assert.equal(guest.user.telegram_id,null);assert.equal(guest.user.auth_provider,"guest");assert.notEqual(guest.user.id,telegram.id);
    const browserCall=(path:string,method="GET",payload?:unknown)=>handleApi(new Request("https://avia.example.test/api/"+path,{method,headers:{Origin:"https://avia.example.test",Cookie:cookie},...(payload!==undefined?{body:JSON.stringify(payload)}:{})}),path,f.env);
    for(const path of ["admin/users","admin/audit"])assert.equal((await browserCall(path)).status,403);
    assert.equal((await browserCall("admin/import","POST",{})).status,403);
    assert.equal((await browserCall("admin/notifications/process","POST",{})).status,403);
    assert.equal((await browserCall(`scenarios/${tgSaved.id}`)).status,404);assert.equal((await browserCall(`scenarios/${tgSaved.id}/report`)).status,404);
    assert.deepEqual((await (await browserCall("scenarios")).json() as {items:unknown[]}).items,[]);
    assert.equal((await browserCall("scenarios","POST",{...input,title:"Попытка смены владельца",owner_id:telegram.id})).status,422);
    const unchanged=f.sqlite.prepare("SELECT telegram_id,role FROM users WHERE id=?").get(guest.user.id) as {telegram_id:number|null;role:string};assert.equal(unchanged.telegram_id,null);assert.equal(unchanged.role,"analyst");
  }finally{f.close();}
});

test("mixed browser cookies select independent web and Telegram documents without bypassing ownership",async()=>{
  const f=fixture();try{
    const telegram=f.user("document-telegram","analyst",42);f.sqlite.prepare("UPDATE users SET email=NULL,openai_id=NULL WHERE id=?").run(telegram.id);telegram.email=null;telegram.openai_id=null;
    const tgSession=await signIn(telegram,f.db),tgCookie=tgSession.headers.get("set-cookie")!.split(';')[0];
    const guestResponse=await call(f.env,"auth/guest","POST",{}),webCookie=guestResponse.headers.get("set-cookie")!.split(';')[0],guest=await guestResponse.json() as {user:{id:string}};
    const cookies=webCookie+"; "+tgCookie;
    const request=(path:string,method="GET",payload?:unknown,telegramContext=false,documentSelector=false,cookie=cookies)=>handleApi(new Request("https://avia.example.test/api/"+path+(documentSelector?"?avia_client=telegram":""),{method,headers:{Origin:"https://avia.example.test",Cookie:cookie,...(telegramContext?{"X-Avia-Client":"telegram"}:{})},...(payload!==undefined?{body:JSON.stringify(payload)}:{})}),path,f.env);
    const webScenario=await (await request("scenarios","POST",{...input,title:"Решение сайта"})).json() as {id:string;owner_id:string};
    const tgScenario=await (await request("scenarios","POST",{...input,title:"Решение Mini App"},true)).json() as {id:string;owner_id:string};
    assert.equal(webScenario.owner_id,guest.user.id);assert.equal(tgScenario.owner_id,telegram.id);assert.notEqual(webScenario.owner_id,tgScenario.owner_id);
    for(const suffix of ["report","export.csv"]){
      assert.equal((await request(`scenarios/${webScenario.id}/${suffix}`)).status,200);
      assert.equal((await request(`scenarios/${tgScenario.id}/${suffix}`)).status,404);
      assert.equal((await request(`scenarios/${tgScenario.id}/${suffix}`,"GET",undefined,false,true)).status,200);
      assert.equal((await request(`scenarios/${webScenario.id}/${suffix}`,"GET",undefined,false,true)).status,404);
      assert.equal((await request(`scenarios/${tgScenario.id}/${suffix}`,"GET",undefined,false,true,webCookie)).status,401);
    }
    // The query selector is narrowly limited to read-only document navigation.
    const regularList=await (await request("scenarios","GET",undefined,false,true)).json() as {items:{owner_id:string}[]};assert.deepEqual(regularList.items.map(s=>s.owner_id),[guest.user.id]);
    assert.equal((await request("auth/guest","POST",{},true)).status,400);
  }finally{f.close();}
});

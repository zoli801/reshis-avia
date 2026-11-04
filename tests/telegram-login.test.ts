import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getUser, WEB_SESSION_COOKIE } from "../lib/server/auth.ts";
import { beginTelegramLoginConfirmation, cancelTelegramWebsiteLogin, finishTelegramLoginConfirmation, pollTelegramWebsiteLogin, startTelegramWebsiteLogin } from "../lib/server/telegram-login.ts";
import { handleTelegram, type TelegramServices } from "../lib/server/telegram.ts";
import type { AppEnv } from "../lib/server/db.ts";
import { sha256, unixNow } from "../lib/server/security.ts";

const origin="https://avia.test",syntheticToken="123456:"+"offline_fake_".repeat(4),webhookSecret="offline-webhook-secret-123456789";
type Started={login_id:string;browser_secret:string;url:string;expires_at:string;verification_code:string};
function fixture(){
  const sqlite=new DatabaseSync(":memory:");
  for(const file of readdirSync(new URL("../drizzle/",import.meta.url)).filter(x=>x.endsWith(".sql")).sort())sqlite.exec(readFileSync(new URL("../drizzle/"+file,import.meta.url),"utf8"));
  const prepare=(sql:string,values:unknown[]=[])=>({
    bind(...next:unknown[]){return prepare(sql,next);},
    async first<T>(){return (sqlite.prepare(sql).get(...values as (string|number|null)[])??null) as T|null;},
    async all<T>(){return {results:sqlite.prepare(sql).all(...values as (string|number|null)[]) as T[],success:true};},
    async run(){const r=sqlite.prepare(sql).run(...values as (string|number|null)[]);return {meta:{changes:Number(r.changes)},success:true};},
  });
  let transaction=Promise.resolve();
  const db={prepare,async batch(statements:{run:()=>Promise<unknown>}[]){const task=transaction.then(async()=>{sqlite.exec("BEGIN");try{const result=[];for(const statement of statements)result.push(await statement.run());sqlite.exec("COMMIT");return result;}catch(error){sqlite.exec("ROLLBACK");throw error;}});transaction=task.then(()=>{},()=>{});return task;}} as unknown as D1Database;
  const env={DB:db,BOT_TOKEN:syntheticToken,BOT_USERNAME:"offline_fixture_bot",TELEGRAM_WEBHOOK_SECRET:webhookSecret,PUBLIC_URL:origin} as AppEnv;
  function addUser(id:number,role="analyst"){sqlite.prepare("INSERT INTO users(id,email,name,role,telegram_id,chat_id,openai_id,created_at) VALUES(?,NULL,?,?,?, ?,NULL,?)").run("telegram-"+id,"User "+id,role,id,id,unixNow());}
  return {db,sqlite,env,addUser,close:()=>sqlite.close()};
}
function req(path:string,payload:unknown={},headers:Record<string,string>={}){return new Request(origin+"/api/"+path,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json",...headers},body:JSON.stringify(payload)});}
async function start(f:ReturnType<typeof fixture>){const response=await startTelegramWebsiteLogin(req("auth/telegram/start"),f.db,f.env);assert.equal(response.status,200);return response.json() as Promise<Started>;}
const poll=(f:ReturnType<typeof fixture>,login:Started,headers:Record<string,string>={})=>pollTelegramWebsiteLogin(req("auth/telegram/poll",{login_id:login.login_id,browser_secret:login.browser_secret},headers),f.db,f.env);
const cancel=(f:ReturnType<typeof fixture>,login:Started,headers:Record<string,string>={})=>cancelTelegramWebsiteLogin(req("auth/telegram/cancel",{login_id:login.login_id,browser_secret:login.browser_secret},headers),f.db,f.env);

test("Telegram website challenge separates browser and bot secrets and stores only their hashes",async()=>{
  const f=fixture();try{
    const login=await start(f),url=new URL(login.url);
    assert.equal(url.origin,"https://t.me");assert.equal(url.pathname,"/offline_fixture_bot");assert.equal(url.searchParams.get("start"),"login_"+login.login_id);
    assert.match(login.login_id,/^[a-f0-9]{32}$/);assert.match(login.browser_secret,/^[a-f0-9]{64}$/);assert.match(login.verification_code,/^\d{6}$/);
    assert.ok(!login.url.includes(login.browser_secret));assert.ok(Date.parse(login.expires_at)>Date.now());
    const row=f.sqlite.prepare("SELECT * FROM telegram_login_challenges").get() as Record<string,unknown>;
    assert.equal(row.code_hash,await sha256(login.login_id));assert.equal(row.browser_hash,await sha256(login.browser_secret));
    assert.ok(!JSON.stringify(row).includes(login.login_id));assert.ok(!JSON.stringify(row).includes(login.browser_secret));
    assert.deepEqual(await (await poll(f,login)).json(),{status:"pending"});
  }finally{f.close();}
});

test("only explicit confirmation authenticates website; Mini App cookie and guest profile stay independent",async()=>{
  const f=fixture();try{
    f.addUser(42,"admin");const login=await start(f);
    const opened=await beginTelegramLoginConfirmation(f.db,login.login_id,42);assert.equal(opened.verification_code,login.verification_code);
    assert.equal((await poll(f,login)).headers.get("set-cookie"),null);
    assert.deepEqual(await (await poll(f,login)).json(),{status:"pending"});
    await finishTelegramLoginConfirmation(f.db,login.login_id,42,true);
    const response=await poll(f,login),body=await response.json() as {status:string;user:{id:string;role:string;auth_provider:string}};
    assert.equal(response.status,200);assert.equal(body.status,"authenticated");assert.equal(body.user.id,"telegram-42");assert.equal(body.user.role,"admin");assert.equal(body.user.auth_provider,"telegram");
    const cookie=response.headers.get("set-cookie")!;assert.ok(cookie.startsWith(WEB_SESSION_COOKIE+"="));assert.ok(cookie.includes("HttpOnly"));assert.ok(cookie.includes("SameSite=Lax"));assert.ok(cookie.includes("Secure"));
    const pair=cookie.split(";")[0];
    assert.equal((await getUser(new Request(origin+"/api/auth/me",{headers:{Cookie:pair}}),f.db,f.env))?.id,"telegram-42");
    assert.equal(await getUser(new Request(origin+"/api/auth/me",{headers:{Cookie:pair,"X-Avia-Client":"telegram"}}),f.db,f.env),null);
    assert.equal((await poll(f,login)).status,410);
  }finally{f.close();}
});

test("forwarded login links, spoofed confirmation, missing browser secret and expired challenges cannot sign in",async()=>{
  const f=fixture();try{
    const login=await start(f);await beginTelegramLoginConfirmation(f.db,login.login_id,42);
    await assert.rejects(()=>beginTelegramLoginConfirmation(f.db,login.login_id,99));
    await assert.rejects(()=>finishTelegramLoginConfirmation(f.db,login.login_id,99,true));
    const wrong=await pollTelegramWebsiteLogin(req("auth/telegram/poll",{login_id:login.login_id,browser_secret:"0".repeat(64)}),f.db,f.env);assert.equal(wrong.status,401);
    assert.equal((await pollTelegramWebsiteLogin(req("auth/telegram/poll",{login_id:login.login_id}),f.db,f.env)).status,401);
    f.sqlite.prepare("UPDATE telegram_login_challenges SET expires_at=?").run(unixNow()-1);
    await assert.rejects(()=>finishTelegramLoginConfirmation(f.db,login.login_id,42,true));
    assert.equal((await poll(f,login)).status,410);
  }finally{f.close();}
});

test("Telegram cancellation is final and concurrent successful polls consume once",async()=>{
  const f=fixture();try{
    f.addUser(42);const cancelled=await start(f);await beginTelegramLoginConfirmation(f.db,cancelled.login_id,42);await finishTelegramLoginConfirmation(f.db,cancelled.login_id,42,false);
    await assert.rejects(()=>finishTelegramLoginConfirmation(f.db,cancelled.login_id,42,true));assert.equal((await poll(f,cancelled)).status,410);
    const login=await start(f);await beginTelegramLoginConfirmation(f.db,login.login_id,42);await finishTelegramLoginConfirmation(f.db,login.login_id,42,true);
    const responses=await Promise.all([poll(f,login),poll(f,login)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,410]);
    assert.equal((f.sqlite.prepare("SELECT count(*) count FROM sessions").get() as {count:number}).count,1);
  }finally{f.close();}
});

test("browser cancellation is authenticated and idempotent before or after Telegram confirmation",async()=>{
  const f=fixture();try{
    f.addUser(42);
    const pending=await start(f);
    const wrong=await cancelTelegramWebsiteLogin(req("auth/telegram/cancel",{login_id:pending.login_id,browser_secret:"0".repeat(64)}),f.db,f.env);assert.equal(wrong.status,401);
    assert.deepEqual(await (await poll(f,pending)).json(),{status:"pending"});
    const first=await cancel(f,pending);assert.equal(first.status,200);assert.equal(first.headers.get("set-cookie"),null);assert.deepEqual(await first.json(),{ok:true});
    assert.equal((await cancel(f,pending)).status,200);assert.equal((await poll(f,pending)).status,410);
    await assert.rejects(()=>beginTelegramLoginConfirmation(f.db,pending.login_id,42));
    const confirmed=await start(f);await beginTelegramLoginConfirmation(f.db,confirmed.login_id,42);await finishTelegramLoginConfirmation(f.db,confirmed.login_id,42,true);
    assert.equal((await cancel(f,confirmed)).status,200);assert.equal((await poll(f,confirmed)).status,410);
    assert.equal((f.sqlite.prepare("SELECT count(*) count FROM sessions").get() as {count:number}).count,0);
  }finally{f.close();}
});

test("browser cancellation cannot revoke a consumed session and rejects cross-origin, Mini App and malformed requests",async()=>{
  const f=fixture();try{
    f.addUser(42);const login=await start(f);await beginTelegramLoginConfirmation(f.db,login.login_id,42);await finishTelegramLoginConfirmation(f.db,login.login_id,42,true);
    const signed=await poll(f,login);assert.equal(signed.status,200);
    const pair=signed.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await cancel(f,login)).status,200);
    assert.equal((await getUser(new Request(origin+"/api/auth/me",{headers:{Cookie:pair}}),f.db,f.env))?.id,"telegram-42");
    assert.equal((await cancel(f,login,{Origin:"https://attacker.test"})).status,403);
    assert.equal((await cancel(f,login,{"X-Avia-Client":"telegram"})).status,400);
    assert.equal((await cancelTelegramWebsiteLogin(new Request(origin+"/api/auth/telegram/cancel"),f.db,f.env)).status,405);
    assert.equal((await cancelTelegramWebsiteLogin(req("auth/telegram/cancel",{login_id:login.login_id}),f.db,f.env)).status,401);
  }finally{f.close();}
});

test("browser cancellation wins over a poll that already read confirmed identity but has not consumed the challenge",async()=>{
  const f=fixture();let release!:()=>void,selected!:()=>void;
  const paused=new Promise<void>(resolve=>release=resolve),read=new Promise<void>(resolve=>selected=resolve);
  try{
    f.addUser(42);const login=await start(f);await beginTelegramLoginConfirmation(f.db,login.login_id,42);await finishTelegramLoginConfirmation(f.db,login.login_id,42,true);
    const gatedDb={...f.db,prepare(sql:string){
      const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>sql==="SELECT * FROM users WHERE telegram_id=?"?{...statement,bind(...args:unknown[]){return wrap(statement.bind(...args));},async first<T>(){const user=await statement.first<T>();selected();await paused;return user;}} as D1PreparedStatement:statement;
      return wrap(f.db.prepare(sql));
    }} as D1Database;
    const inFlight=pollTelegramWebsiteLogin(req("auth/telegram/poll",{login_id:login.login_id,browser_secret:login.browser_secret}),gatedDb,f.env);
    await read;assert.equal((await cancel(f,login)).status,200);release();
    assert.equal((await inFlight).status,410);assert.equal((f.sqlite.prepare("SELECT count(*) count FROM sessions").get() as {count:number}).count,0);
  }finally{release();f.close();}
});

test("arbitrary forged poll and cancellation secrets cannot allocate persistent rate-limit buckets",async()=>{
  const f=fixture();try{
    const login=await start(f),before=(f.sqlite.prepare("SELECT count(*) count FROM auth_rate_limits").get() as {count:number}).count;
    for(let index=0;index<8;index++){
      const forged={login_id:login.login_id,browser_secret:index.toString(16).padStart(64,"0")};
      assert.equal((await pollTelegramWebsiteLogin(req("auth/telegram/poll",forged),f.db,f.env)).status,401);
      assert.equal((await cancelTelegramWebsiteLogin(req("auth/telegram/cancel",forged),f.db,f.env)).status,401);
    }
    assert.equal((f.sqlite.prepare("SELECT count(*) count FROM auth_rate_limits").get() as {count:number}).count,before);
  }finally{f.close();}
});

test("website login validates origin, method, Mini App context, body size and configured bot; starts are rate limited",async()=>{
  const f=fixture();try{
    assert.equal((await startTelegramWebsiteLogin(req("auth/telegram/start",{}, {Origin:"https://attacker.test"}),f.db,f.env)).status,403);
    assert.equal((await startTelegramWebsiteLogin(new Request(origin+"/api/auth/telegram/start"),f.db,f.env)).status,405);
    assert.equal((await startTelegramWebsiteLogin(req("auth/telegram/start",{}, {"X-Avia-Client":"telegram"}),f.db,f.env)).status,400);
    assert.equal((await startTelegramWebsiteLogin(req("auth/telegram/start",{data:"x".repeat(3000)}),f.db,f.env)).status,413);
    assert.equal((await startTelegramWebsiteLogin(req("auth/telegram/start"),f.db,{...f.env,BOT_TOKEN:undefined})).status,503);
    for(let i=0;i<10;i++)await start(f);
    assert.equal((await startTelegramWebsiteLogin(req("auth/telegram/start"),f.db,f.env)).status,429);
  }finally{f.close();}
});

const services:TelegramServices={async meta(){return {};},async forecast(){return {};},async scenarios(){return {items:[]};},async digest(){return {text:""};},async unsubscribe(){return {};},async link(){return {};}};
function webhook(updateId:number,text:string,callback?:string,sender=42){const base={message_id:123,chat:{id:sender,type:"private"},from:{id:sender,first_name:"Тест"},text};return new Request(origin+"/api/telegram/webhook",{method:"POST",headers:{"Content-Type":"application/json","X-Telegram-Bot-Api-Secret-Token":webhookSecret},body:JSON.stringify({update_id:updateId,...(callback?{callback_query:{id:"callback-"+updateId,from:base.from,message:base,data:callback}}:{message:base})})});}

test("real private webhook requires confirmation button and shows browser verification code without browser secret",async()=>{
  const f=fixture(),original=globalThis.fetch,sent:Record<string,unknown>[]=[];
  globalThis.fetch=async(_input,init)=>{sent.push(JSON.parse(String(init?.body)));return Response.json({ok:true,result:{message_id:123}});};
  try{
    const login=await start(f);
    assert.equal((await handleTelegram(webhook(100,"/start login_"+login.login_id),f.env,f.db,services)).status,200);
    const content=JSON.stringify(sent);assert.ok(content.includes(login.verification_code));assert.ok(!content.includes(login.browser_secret));assert.ok(content.includes("Подтверждайте, только если вы сами начали вход"));
    const buttons=sent[0].reply_markup as {inline_keyboard:{callback_data:string}[][]};
    assert.equal(buttons.inline_keyboard[0][0].callback_data,"login_confirm:"+login.login_id);assert.equal(buttons.inline_keyboard[1][0].callback_data,"login_cancel:"+login.login_id);
    assert.deepEqual(await (await poll(f,login)).json(),{status:"pending"});
    assert.equal((await handleTelegram(webhook(101,"Подтвердите вход","login_confirm:"+login.login_id),f.env,f.db,services)).status,200);
    const signed=await poll(f,login);assert.equal(signed.status,200);assert.equal((await signed.json() as {user:{role:string}}).user.role,"analyst");
    assert.equal((await poll(f,login)).status,410);
  }finally{globalThis.fetch=original;f.close();}
});

test("verified webhook grants configured numeric owner privileges and never trusts matching Telegram names",async()=>{
  const f=fixture(),original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({ok:true,result:{message_id:123}});
  try{
    const configured={...f.env,ADMIN_TELEGRAM_ID:"42"};
    assert.equal((await handleTelegram(webhook(200,"/start",undefined,42),configured,f.db,services)).status,200);
    assert.equal((f.sqlite.prepare("SELECT role FROM users WHERE telegram_id=42").get() as {role:string}).role,"admin");
    assert.equal((await handleTelegram(webhook(201,"/start",undefined,99),configured,f.db,services)).status,200);
    assert.equal((f.sqlite.prepare("SELECT role FROM users WHERE telegram_id=99").get() as {role:string}).role,"analyst");
    // An explicitly linked administrator remains an administrator after the
    // numeric configuration is absent; this is an existing trusted DB role.
    assert.equal((await handleTelegram(webhook(202,"/start",undefined,42),f.env,f.db,services)).status,200);
    assert.equal((f.sqlite.prepare("SELECT role FROM users WHERE telegram_id=42").get() as {role:string}).role,"admin");
  }finally{globalThis.fetch=original;f.close();}
});

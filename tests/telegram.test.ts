import test from "node:test";
import assert from "node:assert/strict";
import { handleTelegram, sendTelegram, telegramRuntimeDiagnostic, TelegramDeliveryError, type TelegramServices } from "../lib/server/telegram.ts";
import type { AppEnv } from "../lib/server/db.ts";
import { safeAppUrl, safeError } from "../lib/server/security.ts";
import { testDatabase } from "./auth-support.ts";

const syntheticToken="123456:"+"offline-not-real_".repeat(3),webhookSecret="offline-webhook-secret-123456789";
const services:TelegramServices={
  async meta(){return {routes:[{route:"MOW-AER",name:"Москва — Сочи",price_min:1000,price_max:20000}],dates:["2026-06-01","2026-07-01"]};},
  async forecast(input){return {...input,capacity:900,demand:850.5,sales:850.5,empty_seats:49.5,contribution:123456.78};},
  async scenarios(){return {items:[{title:"<script>Тест</script>",route:"MOW-AER",date:"2026-06-01",price:9500}]};},
  async digest(){return {text:"Сводка: <Тест>"};},async unsubscribe(){return {ok:true};},async link(){return {ok:true};},
};
function env(db:D1Database):AppEnv{return {DB:db,BOT_TOKEN:syntheticToken,TELEGRAM_WEBHOOK_SECRET:webhookSecret,PUBLIC_URL:"https://avia.test"};}
function request(updateId:number,text:string,secret=webhookSecret):Request {
  return new Request("https://avia.test/api/telegram/webhook",{method:"POST",headers:{"Content-Type":"application/json","X-Telegram-Bot-Api-Secret-Token":secret},body:JSON.stringify({update_id:updateId,message:{message_id:updateId,chat:{id:42,type:"private"},from:{id:42,first_name:"<Юзер>"},text}})});
}

test("webhook requires separate secret and never makes a Telegram request for untrusted input",async()=>{
  const store=testDatabase(),original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error("must not call");};
  try{
    const result=await handleTelegram(request(1,"/start","wrong-secret"),env(store.db),store.db,services);
    assert.equal(result.status,403);assert.equal(calls,0);
    assert.equal((await store.db.prepare("SELECT count(*) count FROM telegram_updates").first<{count:number}>())?.count,0);
  }finally{globalThis.fetch=original;store.close();}
});

test("start escapes identity, offers HTTPS inline Mini App, and deduplicates updates",async()=>{
  const store=testDatabase(),original=globalThis.fetch;const sent:{url:string;body:Record<string,unknown>}[]=[];
  globalThis.fetch=async(input,init)=>{sent.push({url:String(input),body:JSON.parse(String(init?.body))});return Response.json({ok:true,result:{message_id:100}});};
  try{
    const first=await handleTelegram(request(1,"/start"),env(store.db),store.db,services);
    const duplicate=await handleTelegram(request(1,"/start"),env(store.db),store.db,services);
    assert.equal(first.status,200);assert.equal((await duplicate.json() as {duplicate:boolean}).duplicate,true);assert.equal(sent.length,1);
    assert.equal(new URL(sent[0].url).origin,"https://api.telegram.org");
    assert.ok(sent[0].url.endsWith("/sendMessage"));
    assert.ok(String(sent[0].body.text).includes("&lt;Юзер&gt;"));
    assert.ok(String(sent[0].body.text).includes("Сравните варианты"));
    const markup=sent[0].body.reply_markup as {inline_keyboard:{web_app:{url:string}}[][]};
    assert.equal(markup.inline_keyboard[0][0].web_app.url,"https://avia.test/");
    assert.ok(!JSON.stringify(await first.json()).includes(syntheticToken));
  }finally{globalThis.fetch=original;store.close();}
});

test("durable guest flow validates dataset dates and obtains final forecast through injected services",async()=>{
  const store=testDatabase(),original=globalThis.fetch;const texts:string[]=[];let calculations=0;
  globalThis.fetch=async(_input,init)=>{texts.push(JSON.parse(String(init?.body)).text);return Response.json({ok:true,result:{message_id:100}});};
  const fake={...services,async forecast(input:{route:string;date:string;price:number}){calculations++;assert.deepEqual(input,{route:"MOW-AER",date:"2026-06-01",price:9500.5});return services.forecast(input);}};
  try{
    for(const [index,text] of ["/forecast","MOW-AER","2026-06-02","01.06.2026","9 500,50"].entries())assert.equal((await handleTelegram(request(index+1,text),env(store.db),store.db,fake)).status,200);
    assert.ok(texts.some(text=>text.includes("На эту дату нет прогноза")));
    assert.equal(calculations,1);assert.ok(texts.at(-1)?.includes("850,5"));assert.ok(texts.at(-1)?.includes("Маржинальный доход"));
    assert.equal((await store.db.prepare("SELECT state FROM bot_states WHERE telegram_id=42").first<{state:string}>())?.state,"idle");
  }finally{globalThis.fetch=original;store.close();}
});

test("known Telegram rate rejection releases update for retry without committing FSM transition",async()=>{
  const store=testDatabase(),original=globalThis.fetch;let attempts=0,delivered=0;
  globalThis.fetch=async()=>{attempts++;if(attempts===1)return Response.json({ok:false,parameters:{retry_after:2}},{status:429});delivered++;return Response.json({ok:true,result:{message_id:100}});};
  try{
    const first=await handleTelegram(request(10,"/forecast"),env(store.db),store.db,services);
    assert.equal(first.status,503);assert.equal(first.headers.get("retry-after"),"2");
    const record=await store.db.prepare("SELECT status FROM telegram_updates WHERE update_id=10").first<{status:string}>();assert.equal(record?.status,"pending");
    assert.equal(await store.db.prepare("SELECT state FROM bot_states WHERE telegram_id=42").first(),null);
    await store.db.prepare("UPDATE telegram_updates SET lease_until=0 WHERE update_id=10").run();
    assert.equal((await handleTelegram(request(10,"/forecast"),env(store.db),store.db,services)).status,200);
    assert.equal(delivered,1);assert.equal(attempts,2);
    assert.equal((await store.db.prepare("SELECT state FROM bot_states WHERE telegram_id=42").first<{state:string}>())?.state,"route");
  }finally{globalThis.fetch=original;store.close();}
});

test("uncertain transport failures cannot leak token and suppress duplicate private sends",async()=>{
  const store=testDatabase(),original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error(`URL=https://api.telegram.org/bot${syntheticToken}/sendMessage`);};
  try{
    const first=await handleTelegram(request(12,"/start"),env(store.db),store.db,services);
    assert.equal(first.status,200);assert.ok(!(await first.text()).includes(syntheticToken));
    const duplicate=await handleTelegram(request(12,"/start"),env(store.db),store.db,services);
    assert.equal((await duplicate.json() as {duplicate:boolean}).duplicate,true);assert.equal(calls,1);
    const safe=safeError(new Error(`secret=${syntheticToken}`));assert.ok(!(await safe.text()).includes(syntheticToken));
  }finally{globalThis.fetch=original;store.close();}
});

test("Telegram client rejects methods and app URL injection; failed API descriptions stay private",async()=>{
  const store=testDatabase(),original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({ok:false,description:`token=${syntheticToken}`},{status:403});};
  try{
    await assert.rejects(()=>sendTelegram(env(store.db),"setWebhook" as "sendMessage",{url:"https://attacker.test"}));assert.equal(calls,0);
    assert.throws(()=>safeAppUrl(request(1,"/start"),{PUBLIC_URL:"javascript:alert(1)"}));
    assert.throws(()=>safeAppUrl(request(1,"/start"),{PUBLIC_URL:`https://example.test?token=${syntheticToken}`,BOT_TOKEN:syntheticToken}));
    try{await sendTelegram(env(store.db),"sendMessage",{chat_id:42,text:"Пример"});assert.fail("expected rejection");}
    catch(error){assert.ok(error instanceof TelegramDeliveryError);assert.equal(error.permanent,true);assert.ok(!error.message.includes(syntheticToken));}
  }finally{globalThis.fetch=original;store.close();}
});

test("verified private bot commands create an independent Telegram profile without linking",async()=>{
  const store=testDatabase(),original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({ok:true,result:{message_id:100}});
  let seenUser=false;
  const standalone={...services,async scenarios(id:number){
    const user=await store.db.prepare("SELECT * FROM users WHERE telegram_id=?").bind(id).first<{role:string;chat_id:number;email:string|null;openai_id:string|null}>();
    assert.equal(user?.role,"analyst");assert.equal(user?.chat_id,42);assert.equal(user?.email,null);assert.equal(user?.openai_id,null);seenUser=true;return {items:[]};
  }};
  try{
    const response=await handleTelegram(request(40,"/saved"),env(store.db),store.db,standalone);
    assert.equal(response.status,200);assert.equal(seenUser,true);
    await handleTelegram(request(41,"/start"),env(store.db),store.db,standalone);
    assert.equal((await store.db.prepare("SELECT count(*) AS count FROM users WHERE telegram_id=42").first<{count:number}>())?.count,1);
  }finally{globalThis.fetch=original;store.close();}
});

test("known unsent button and HTML rejections fall back once, with safe telemetry and durable deduplication",async()=>{
  const original=globalThis.fetch,originalWarn=console.warn;
  try{
    for(const [index,description] of ["Bad Request: BUTTON_TYPE_INVALID","Bad Request: can't parse entities: unsupported start tag"].entries()){
      const store=testDatabase(),payloads:Record<string,unknown>[]=[],logs:string[]=[];let delivered=0;
      console.warn=(...args)=>logs.push(args.join(" "));
      globalThis.fetch=async(_input,init)=>{
        payloads.push(JSON.parse(String(init?.body)));
        if(payloads.length===1)return Response.json({ok:false,description:description+" "+syntheticToken},{status:400});
        delivered++;return Response.json({ok:true,result:{message_id:100}});
      };
      try{
        const result=await handleTelegram(request(60+index,"/start"),env(store.db),store.db,services);
        assert.equal(result.status,200);assert.equal(payloads.length,2);assert.equal(delivered,1);
        const fallback=payloads[1];
        assert.equal("parse_mode" in fallback,false);
        assert.ok(String(fallback.text).includes("<Юзер>"));
        assert.ok(String(fallback.text).includes("Telegram узнаёт вас автоматически"));
        assert.ok(String(fallback.text).includes("отдельный гостевой профиль"));
        assert.ok(String(fallback.text).includes("Синхронизация с Telegram доступна по желанию"));
        const button=(fallback.reply_markup as {inline_keyboard:Record<string,unknown>[][]}).inline_keyboard[0][0];
        assert.equal(button.url,"https://avia.test/");assert.equal("web_app" in button,false);
        assert.equal((await store.db.prepare("SELECT state FROM bot_states WHERE telegram_id=42").first<{state:string}>())?.state,"idle");
        assert.equal((await handleTelegram(request(60+index,"/start"),env(store.db),store.db,services)).status,200);assert.equal(payloads.length,2);
        const text=logs.join("\n");assert.ok(text.includes("fallback_delivered"));assert.ok(text.includes('"http_status":400'));
        for(const secret of [syntheticToken,description,"api.telegram.org","Юзер"])assert.equal(text.includes(secret),false);
      }finally{store.close();}
    }
  }finally{globalThis.fetch=original;console.warn=originalWarn;}
});

test("forbidden and uncertain delivery failures are classified without unsafe fallback retries",async()=>{
  const store=testDatabase(),original=globalThis.fetch,originalWarn=console.warn;const logs:string[]=[];let calls=0;
  console.warn=(...args)=>logs.push(args.join(" "));
  try{
    globalThis.fetch=async()=>{calls++;return Response.json({ok:false,description:`Forbidden: ${syntheticToken}`},{status:403});};
    assert.equal((await handleTelegram(request(80,"/start"),env(store.db),store.db,services)).status,200);
    assert.equal(calls,1);assert.ok(logs.some(line=>line.includes('"classification":"forbidden"')&&line.includes('"http_status":403')));
    globalThis.fetch=async()=>{calls++;throw new Error(`https://api.telegram.org/bot${syntheticToken}/sendMessage`);};
    assert.equal((await handleTelegram(request(81,"/start"),env(store.db),store.db,services)).status,200);
    assert.equal(calls,2);assert.ok(logs.some(line=>line.includes("transport_uncertain")));
    assert.equal((await handleTelegram(request(81,"/start"),env(store.db),store.db,services)).status,200);assert.equal(calls,2);
    assert.equal(logs.join("\n").includes(syntheticToken),false);
  }finally{globalThis.fetch=original;console.warn=originalWarn;store.close();}
});

test("runtime diagnostic has one fixed read-only method and returns only allowlisted fields",async()=>{
  const store=testDatabase(),original=globalThis.fetch;let calls=0;
  try{
    globalThis.fetch=async(input,init)=>{
      calls++;const url=new URL(String(input));assert.equal(url.origin,"https://api.telegram.org");assert.ok(url.pathname.endsWith("/getMe"));assert.equal(init?.redirect,"manual");
      return Response.json({ok:true,result:{is_bot:true,username:"CU_AviGo_app",private_secret:syntheticToken}});
    };
    assert.deepEqual(await telegramRuntimeDiagnostic(env(store.db)),{classification:"ok",http_status:200,username:"CU_AviGo_app"});
    assert.deepEqual(await telegramRuntimeDiagnostic({}),{classification:"not_configured",http_status:null,username:null});assert.equal(calls,1);
    globalThis.fetch=async()=>Response.json({ok:false,description:syntheticToken},{status:401});
    assert.deepEqual(await telegramRuntimeDiagnostic(env(store.db)),{classification:"authentication_failed",http_status:401,username:null});
    globalThis.fetch=async()=>{throw new Error(syntheticToken);};
    const unavailable=await telegramRuntimeDiagnostic(env(store.db));assert.deepEqual(unavailable,{classification:"transport_uncertain",http_status:null,username:null});
    assert.equal(JSON.stringify(unavailable).includes(syntheticToken),false);
  }finally{globalThis.fetch=original;store.close();}
});

test("malformed Telegram success response is uncertain and cannot trigger a second send",async()=>{
  const store=testDatabase(),original=globalThis.fetch,originalWarn=console.warn;let calls=0;
  console.warn=()=>{};
  globalThis.fetch=async()=>{calls++;return Response.json(null);};
  try{
    assert.equal((await handleTelegram(request(90,"/start"),env(store.db),store.db,services)).status,200);
    assert.equal((await handleTelegram(request(90,"/start"),env(store.db),store.db,services)).status,200);assert.equal(calls,1);
  }finally{globalThis.fetch=original;console.warn=originalWarn;store.close();}
});

test("explicit webhook response mode persists before returning one fixed sendMessage without token or external calls",async()=>{
  const store=testDatabase(),original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error("outbound must not run");};
  try{
    const configured={...env(store.db),TELEGRAM_DELIVERY_MODE:"webhook"};
    const response=await handleTelegram(request(100,"/start"),configured,store.db,services);
    assert.equal(response.status,200);const payload=await response.json() as Record<string,unknown>;
    assert.equal(payload.method,"sendMessage");assert.equal(payload.chat_id,42);assert.equal(payload.parse_mode,"HTML");
    assert.ok(String(payload.text).includes("Telegram узнаёт вас автоматически"));
    assert.equal(JSON.stringify(payload).includes(syntheticToken),false);assert.equal(JSON.stringify(payload).includes(webhookSecret),false);
    assert.deepEqual(Object.keys(payload).sort(),["chat_id","method","parse_mode","reply_markup","text"]);
    const update=await store.db.prepare("SELECT status FROM telegram_updates WHERE update_id=100").first<{status:string}>();assert.equal(update?.status,"done");
    assert.equal((await store.db.prepare("SELECT state FROM bot_states WHERE telegram_id=42").first<{state:string}>())?.state,"idle");
    const duplicate=await handleTelegram(request(100,"/start"),configured,store.db,services);
    const duplicateBody=await duplicate.json() as Record<string,unknown>;assert.equal(duplicateBody.ok,true);assert.equal("method" in duplicateBody,false);
    assert.equal(calls,0);
  }finally{globalThis.fetch=original;store.close();}
});

test("webhook response mode advances callback state without an outbound callback acknowledgement",async()=>{
  const store=testDatabase(),original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error("outbound must not run");};
  try{
    const configured={...env(store.db),TELEGRAM_DELIVERY_MODE:"webhook"};
    const forecast=await handleTelegram(request(110,"/forecast"),configured,store.db,services);
    assert.equal((await forecast.json() as {method:string}).method,"sendMessage");
    assert.equal((await store.db.prepare("SELECT state FROM bot_states WHERE telegram_id=42").first<{state:string}>())?.state,"route");
    const callback=new Request("https://avia.test/api/telegram/webhook",{method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":webhookSecret,"Content-Type":"application/json"},body:JSON.stringify({update_id:111,callback_query:{id:"offline-callback",data:"route:MOW-AER",from:{id:42,first_name:"Тест"},message:{chat:{id:42,type:"private"},text:"Выберите направление"}}})});
    const selected=await handleTelegram(callback,configured,store.db,services),body=await selected.json() as {method:string;text:string};
    assert.equal(body.method,"sendMessage");assert.ok(body.text.includes("Выберите дату"));
    assert.equal((await store.db.prepare("SELECT state FROM bot_states WHERE telegram_id=42").first<{state:string}>())?.state,"date");
    assert.equal(calls,0);
  }finally{globalThis.fetch=original;store.close();}
});

test("direct methods use Workers-compatible manual redirect handling instead of unsupported error mode",async()=>{
  const store=testDatabase(),original=globalThis.fetch;const methods:string[]=[];
  globalThis.fetch=async(input,init)=>{
    if(init?.redirect==="error")throw new TypeError("Workers does not support redirect:error");
    assert.equal(init?.redirect,"manual");const url=new URL(String(input));assert.equal(url.origin,"https://api.telegram.org");methods.push(url.pathname.split("/").at(-1)!);
    return Response.json({ok:true,result:url.pathname.endsWith("/getMe")?{is_bot:true,username:"CU_AviGo_app"}:{message_id:100}});
  };
  try{
    assert.equal((await telegramRuntimeDiagnostic(env(store.db))).classification,"ok");
    assert.deepEqual(await sendTelegram(env(store.db),"sendMessage",{chat_id:42,text:"Проверка"}),{message_id:100});
    assert.deepEqual(methods,["getMe","sendMessage"]);
  }finally{globalThis.fetch=original;store.close();}
});

test("manual mode rejects redirects without following or exposing the redirected URL",async()=>{
  const store=testDatabase(),original=globalThis.fetch;let calls=0;
  globalThis.fetch=async(_input,init)=>{calls++;assert.equal(init?.redirect,"manual");return new Response(null,{status:302,headers:{Location:`https://attacker.test/${syntheticToken}`}});};
  try{
    assert.deepEqual(await telegramRuntimeDiagnostic(env(store.db)),{classification:"redirect_rejected",http_status:302,username:null});
    try{await sendTelegram(env(store.db),"sendMessage",{chat_id:42,text:"Проверка"});assert.fail("redirect should be rejected");}
    catch(error){assert.ok(error instanceof TelegramDeliveryError);assert.equal(error.classification,"redirect_rejected");assert.equal(error.permanent,true);assert.equal(error.message.includes(syntheticToken),false);}
    assert.equal(calls,2);
  }finally{globalThis.fetch=original;store.close();}
});

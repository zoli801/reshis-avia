import test from "node:test";
import assert from "node:assert/strict";
import { authTelegram, ensureGuestSession, getUser, SESSION_COOKIE, signIn, signOut, verifyTelegramInitData } from "../lib/server/auth.ts";
import { assertSameOrigin, encode, hmac, sha256, toHex } from "../lib/server/security.ts";
import type { AppEnv, UserRecord } from "../lib/server/db.ts";
import { testDatabase } from "./auth-support.ts";

const token="123456:"+"synthetic_secret_".repeat(3),now=1_800_000_000;
async function signedHmac(user:Record<string,unknown>={id:42,first_name:"Тест"},date=now){
  const values=new URLSearchParams({auth_date:String(date),user:JSON.stringify(user),query_id:"offline-fixture"});
  const check=[...values.keys()].sort().map(k=>`${k}=${values.get(k)}`).join("\n");
  values.set("hash",toHex(await hmac(await hmac(encode("WebAppData"),token),check)));
  return values;
}

test("Telegram HMAC validates signed identity, rejects tampering, duplicates and old/future data",async()=>{
  const params=await signedHmac();
  assert.equal((await verifyTelegramInitData(params.toString(),{BOT_TOKEN:token},{now})).id,42);
  const bad=new URLSearchParams(params);bad.set("user",JSON.stringify({id:99,first_name:"Подмена"}));
  await assert.rejects(()=>verifyTelegramInitData(bad.toString(),{BOT_TOKEN:token},{now}));
  await assert.rejects(()=>verifyTelegramInitData(params+"&user=x",{BOT_TOKEN:token},{now}));
  for(const date of [now-601,now+31])await assert.rejects(async()=>verifyTelegramInitData((await signedHmac(undefined,date)).toString(),{BOT_TOKEN:token},{now}));
});

test("Ed25519 binds bot id and payload; invalid Ed25519 never downgrades to valid HMAC",async()=>{
  const keys=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]);
  const publicKeyHex=toHex(await crypto.subtle.exportKey("raw",keys.publicKey));
  const params=await signedHmac();
  const check="9144995775:WebAppData\n"+[...params.keys()].filter(k=>k!=="hash").sort().map(k=>`${k}=${params.get(k)}`).join("\n");
  const signature=await crypto.subtle.sign("Ed25519",keys.privateKey,encode(check));
  params.set("signature",Buffer.from(signature).toString("base64url"));
  assert.equal((await verifyTelegramInitData(params.toString(),{BOT_ID:"9144995775"},{now,publicKeyHex})).id,42);
  await assert.rejects(()=>verifyTelegramInitData(params.toString(),{BOT_ID:"999999"},{now,publicKeyHex}));
  params.set("signature","a".repeat(86));
  await assert.rejects(()=>verifyTelegramInitData(params.toString(),{BOT_TOKEN:token},{now,publicKeyHex}));
});

test("Sites identity provisions ordinary users and grants admin only to verified configured owner",async()=>{
  const store=testDatabase();
  try{
    const request=new Request("https://avia.test/api/auth/me",{headers:{"oai-authenticated-user-id":"site-stable-id","oai-authenticated-user-email":"owner@example.test","oai-authenticated-user-full-name":encodeURIComponent("Дмитрий"),"oai-authenticated-user-full-name-encoding":"percent-encoded-utf-8"}});
    const user=await getUser(request,store.db,{});
    assert.equal(user?.role,"analyst");assert.equal(user?.auth_provider,"chatgpt");
    const admin=await getUser(request,store.db,{ADMIN_EMAIL:"owner@example.test"});
    assert.equal(admin?.role,"admin");assert.equal(admin?.name,"Дмитрий");assert.equal(admin?.auth_provider,"chatgpt");
    assert.equal((await getUser(request,store.db,{}))?.id,admin?.id);
    const anon=await getUser(new Request("https://avia.test/api/auth/me"),store.db,{ADMIN_EMAIL:"owner@example.test"});assert.equal(anon,null);
  }finally{store.close();}
});

test("obsolete private bootstrap flag cannot provision administrators or affect Telegram",async()=>{
  const store=testDatabase();
  try{
    const env={DB:store.db,BOT_TOKEN:token,PRIVATE_OWNER_BOOTSTRAP:"enabled"} as AppEnv;
    assert.equal(await getUser(new Request("https://avia.test/api/auth/me"),store.db,env),null);
    const platform=new Request("https://avia.test/api/auth/me",{headers:{"oai-authenticated-user-id":"owner-only-private","oai-authenticated-user-email":"owner@private.test"}});
    assert.equal((await getUser(platform,store.db,env))?.role,"analyst");
    const params=await signedHmac(undefined,Math.floor(Date.now()/1000));
    const response=await authTelegram(new Request("https://avia.test/api/auth/telegram",{method:"POST",body:JSON.stringify({init_data:params.toString()})}),store.db,env);
    const body=await response.json() as {user:{role:string}};
    assert.equal(response.status,200);assert.equal(body.user.role,"analyst");
  }finally{store.close();}
});

test("opaque Telegram sessions store only SHA256, expire, and use secure iframe-compatible cookies",async()=>{
  const store=testDatabase();
  try{
    const user={id:"tg-user",email:null,name:"Тест",role:"analyst",telegram_id:42,chat_id:42,openai_id:null,created_at:now} as UserRecord;
    await store.db.prepare("INSERT INTO users(id,email,name,role,telegram_id,chat_id,openai_id,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(user.id,null,user.name,user.role,42,42,null,now).run();
    const response=await signIn(user,store.db);const cookie=response.headers.get("set-cookie")!;
    const publicUser=(await response.json() as {user:Record<string,unknown>}).user;
    assert.equal(publicUser.telegram_delivery_ready,true);
    assert.equal(publicUser.auth_provider,"telegram");
    assert.equal("openai_id" in publicUser,false);
    assert.equal("chat_id" in publicUser,false);
    for(const item of ["HttpOnly","Secure","SameSite=None","Path=/"])assert.ok(cookie.includes(item));
    const sessionToken=cookie.split(";")[0].split("=")[1];
    const row=await store.db.prepare("SELECT id FROM sessions").first<{id:string}>();assert.equal(row?.id,await sha256(sessionToken));assert.notEqual(row?.id,sessionToken);
    const request=new Request("https://avia.test/api/auth/me",{headers:{Cookie:`${SESSION_COOKIE}=${sessionToken}`,"X-Avia-Client":"telegram"}});
    assert.equal((await getUser(request,store.db))?.id,user.id);
    await store.db.prepare("UPDATE sessions SET expires_at=0").run();assert.equal(await getUser(request,store.db),null);
    const signout=await signOut(new Request(request.url,{headers:{Cookie:`${SESSION_COOKIE}=${sessionToken}`,"oai-authenticated-user-id":"platform"}}),store.db);
    assert.equal((await signout.json() as {redirect_url:string}).redirect_url,"/signout-with-chatgpt?return_to=/");
  }finally{store.close();}
});

test("same-origin write guard rejects foreign and missing origins",()=>{
  assert.doesNotThrow(()=>assertSameOrigin(new Request("https://avia.test/api/scenarios",{headers:{Origin:"https://avia.test"}})));
  assert.throws(()=>assertSameOrigin(new Request("https://avia.test/api/scenarios",{headers:{Origin:"https://attacker.test"}})));
  assert.throws(()=>assertSameOrigin(new Request("https://avia.test/api/scenarios")));
});

test("Telegram chat delivery is connected only after signed permission or proven private interaction",async()=>{
  const store=testDatabase();
  try{
    const env={DB:store.db,BOT_TOKEN:token} as AppEnv;
    const login=async(user:Record<string,unknown>)=>authTelegram(new Request("https://avia.test/api/auth/telegram",{method:"POST",body:JSON.stringify({init_data:(await signedHmac(user,Math.floor(Date.now()/1000))).toString()})}),store.db,env);
    const without=await login({id:43,first_name:"Без чата"});
    assert.equal((await without.json() as {user:{telegram_delivery_ready:boolean}}).user.telegram_delivery_ready,false);
    const permitted=await login({id:44,first_name:"Разрешён",allows_write_to_pm:true});
    assert.equal((await permitted.json() as {user:{telegram_delivery_ready:boolean}}).user.telegram_delivery_ready,true);
    await store.db.prepare("INSERT INTO bot_states(telegram_id,state,data,updated_at) VALUES(42,'idle','{}',?)").bind(now).run();
    const prior=await login({id:42,first_name:"Начал бот"});
    assert.equal((await prior.json() as {user:{telegram_delivery_ready:boolean}}).user.telegram_delivery_ready,true);
  }finally{store.close();}
});

test("auth rejects oversized streamed body before signature parsing or database writes",async()=>{
  const store=testDatabase();
  try{
    const response=await authTelegram(new Request("https://avia.test/api/auth/telegram",{method:"POST",body:JSON.stringify({init_data:"x".repeat(41000)})}),store.db,{DB:store.db,BOT_TOKEN:token});
    assert.equal(response.status,413);
    assert.equal((await store.db.prepare("SELECT count(*) AS count FROM users").first<{count:number}>())?.count,0);
  }finally{store.close();}
});

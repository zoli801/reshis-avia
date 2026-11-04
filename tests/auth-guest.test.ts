import test from "node:test";
import assert from "node:assert/strict";
import { ensureGuestSession, getUser, isTelegramRequest, SESSION_COOKIE, WEB_SESSION_COOKIE, signIn, signOut } from "../lib/server/auth.ts";
import { sha256 } from "../lib/server/security.ts";
import type { UserRecord } from "../lib/server/db.ts";
import { testDatabase } from "./auth-support.ts";

type SafeUser={id:string;name:string;role:string;email:string|null;telegram_id:number|null;telegram_delivery_ready:boolean;auth_provider:string};
const headers=(cookie?:string,telegram=false)=>({Origin:"https://avia.test",...(cookie?{Cookie:cookie}:{}),...(telegram?{"X-Avia-Client":"telegram"}:{})});
const guestRequest=(cookie?:string)=>new Request("https://avia.test/api/auth/guest",{method:"POST",headers:headers(cookie)});
const cookiePair=(response:Response)=>response.headers.get("set-cookie")!.split(";")[0];
async function userBody(response:Response){return (await response.json() as {user:SafeUser}).user;}

test("guest creation is explicit, secure, hashed, 180 days and reusable without external identity",async()=>{
  const store=testDatabase();
  try{
    for(const path of ["auth/me","admin/users","telegram/webhook","mcp"]){
      assert.equal(await getUser(new Request("https://avia.test/api/"+path),store.db),null);
    }
    assert.equal((await store.db.prepare("SELECT count(*) AS count FROM users").first<{count:number}>())?.count,0);
    const response=await ensureGuestSession(guestRequest(),store.db),cookie=cookiePair(response),user=await userBody(response);
    assert.equal(user.name,"Гость");assert.equal(user.role,"analyst");assert.equal(user.email,null);assert.equal(user.telegram_id,null);assert.equal(user.telegram_delivery_ready,false);assert.equal(user.auth_provider,"guest");
    assert.ok(cookie.startsWith(WEB_SESSION_COOKIE+"="));
    for(const bit of ["Max-Age=15552000","HttpOnly","Secure","SameSite=Lax"])assert.ok(response.headers.get("set-cookie")!.includes(bit));
    const row=await store.db.prepare("SELECT id,expires_at-created_at AS ttl FROM sessions").first<{id:string;ttl:number}>();
    assert.equal(row?.id,await sha256(cookie.split("=")[1]));assert.equal(row?.ttl,15552000);
    const reused=await ensureGuestSession(guestRequest(cookie),store.db);
    assert.equal((await userBody(reused)).id,user.id);assert.equal(reused.headers.get("set-cookie"),null);
    assert.equal((await getUser(new Request("https://avia.test/api/auth/me",{headers:headers(cookie)}),store.db))?.id,user.id);
  }finally{store.close();}
});

test("two browsers and expired cookies remain isolated; no guest identity is created on invalid requests",async()=>{
  const store=testDatabase();
  try{
    for(const request of [new Request("https://avia.test/api/auth/guest"),new Request("https://avia.test/api/auth/guest",{method:"POST"}),new Request("https://avia.test/api/auth/guest",{method:"POST",headers:headers(undefined,true)})])assert.ok((await ensureGuestSession(request,store.db)).status>=400);
    assert.equal((await store.db.prepare("SELECT count(*) AS count FROM users").first<{count:number}>())?.count,0);
    const a=await ensureGuestSession(guestRequest(),store.db),cookieA=cookiePair(a),userA=await userBody(a);
    const b=await ensureGuestSession(guestRequest(),store.db),userB=await userBody(b);assert.notEqual(userA.id,userB.id);
    await store.db.prepare("UPDATE sessions SET expires_at=0 WHERE user_id=?").bind(userA.id).run();
    assert.equal(await getUser(new Request("https://avia.test/api/auth/me",{headers:headers(cookieA)}),store.db),null);
    const renewed=await ensureGuestSession(guestRequest(cookieA),store.db),userC=await userBody(renewed);
    assert.notEqual(userC.id,userA.id);assert.notEqual(userC.id,userB.id);
  }finally{store.close();}
});

test("shared browser cookie jar never merges web, Telegram or trusted Sites owner identities",async()=>{
  const store=testDatabase();
  try{
    const web=await ensureGuestSession(guestRequest(),store.db),webCookie=cookiePair(web),webUser=await userBody(web);
    const tg={id:"independent-tg",email:null,name:"Telegram",role:"analyst",telegram_id:42,chat_id:42,openai_id:null,created_at:1} as UserRecord;
    await store.db.prepare("INSERT INTO users(id,email,name,role,telegram_id,chat_id,openai_id,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(tg.id,null,tg.name,tg.role,42,42,null,1).run();
    const signed=await signIn(tg,store.db),tgCookie=cookiePair(signed),both=webCookie+"; "+tgCookie;
    assert.ok(tgCookie.startsWith(SESSION_COOKIE+"="));assert.ok(signed.headers.get("set-cookie")!.includes("Max-Age=604800"));
    const webRequest=new Request("https://avia.test/api/auth/me",{headers:headers(both)});
    assert.equal((await getUser(webRequest,store.db))?.id,webUser.id);
    const tgRequest=new Request(webRequest.url,{headers:headers(both,true)});
    assert.equal((await getUser(tgRequest,store.db))?.id,tg.id);
    const ownerHeaders={...headers(both,true),"oai-authenticated-user-id":"owner","oai-authenticated-user-email":"owner@example.test"};
    assert.equal((await getUser(new Request(webRequest.url,{headers:ownerHeaders}),store.db,{ADMIN_EMAIL:"owner@example.test"}))?.id,tg.id);
    assert.equal(await getUser(new Request(webRequest.url,{headers:headers(webCookie,true)}),store.db),null);
    assert.equal(await getUser(new Request(webRequest.url,{headers:headers(tgCookie)}),store.db),null);
    const reused=await ensureGuestSession(guestRequest(both),store.db);assert.equal((await userBody(reused)).id,webUser.id);
    // Explicit synchronization may attach a Telegram id later, but browser
    // identity still reports its own context instead of changing providers.
    await store.db.prepare("UPDATE users SET telegram_id=99,chat_id=99 WHERE id=?").bind(webUser.id).run();
    assert.equal((await getUser(webRequest,store.db))?.auth_provider,"guest");
  }finally{store.close();}
});

test("logout clears only its namespace and Sites admin sign-out preserves the guest cookie",async()=>{
  const store=testDatabase();
  try{
    const web=await ensureGuestSession(guestRequest(),store.db),webCookie=cookiePair(web),webUser=await userBody(web);
    const user={id:"tg",email:null,name:"Тест",role:"analyst",telegram_id:42,chat_id:42,openai_id:null,created_at:1} as UserRecord;
    await store.db.prepare("INSERT INTO users(id,email,name,role,telegram_id,chat_id,openai_id,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(user.id,null,user.name,user.role,42,42,null,1).run();
    const tg=await signIn(user,store.db),tgCookie=cookiePair(tg),both=webCookie+"; "+tgCookie;
    const adminOut=await signOut(new Request("https://avia.test/api/auth/logout",{method:"POST",headers:{...headers(both),"oai-authenticated-user-id":"owner"}}),store.db);
    assert.equal(adminOut.headers.get("set-cookie"),null);
    assert.equal((await getUser(new Request("https://avia.test/api/auth/me",{headers:headers(both)}),store.db))?.id,webUser.id);
    const tgOut=await signOut(new Request("https://avia.test/api/auth/logout",{method:"POST",headers:headers(both,true)}),store.db);
    assert.ok(tgOut.headers.get("set-cookie")!.startsWith(SESSION_COOKIE+"="));
    assert.equal(await getUser(new Request("https://avia.test/api/auth/me",{headers:headers(both,true)}),store.db),null);
    assert.equal((await getUser(new Request("https://avia.test/api/auth/me",{headers:headers(both)}),store.db))?.id,webUser.id);
    const webOut=await signOut(new Request("https://avia.test/api/auth/logout",{method:"POST",headers:headers(webCookie)}),store.db);
    assert.ok(webOut.headers.get("set-cookie")!.startsWith(WEB_SESSION_COOKIE+"="));
  }finally{store.close();}
});

test("document query is a narrow cookie selector, never an authentication bypass",async()=>{
  const store=testDatabase();
  try{
    for(const path of ["/api/scenarios/id/report","/api/scenarios/id/export.csv"]){
      const request=new Request("https://avia.test"+path+"?avia_client=telegram");assert.equal(isTelegramRequest(request),true);assert.equal(await getUser(request,store.db),null);
    }
    for(const path of ["/api/auth/me","/api/scenarios","/api/admin/users","/api/scenarios/id","/mcp"]){
      assert.equal(isTelegramRequest(new Request("https://avia.test"+path+"?avia_client=telegram")),false);
    }
    assert.equal(isTelegramRequest(new Request("https://avia.test/api/scenarios/id/report?avia_client=telegram",{method:"POST"})),false);
  }finally{store.close();}
});

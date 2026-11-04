import test from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../lib/server/services.ts";
import { encode, hmac, toHex, unixNow } from "../lib/server/security.ts";
import { testDatabase } from "./auth-support.ts";
import type { AppEnv } from "../lib/server/db.ts";

const origin="https://avia-http.test",password="A unique account password 2026",newPassword="A replacement account password 2027";
const botToken="123456:offline_http_test_token_only",internalSecret="offline-http-internal-secret-"+"x".repeat(32);
const ownerHeaders={"oai-authenticated-user-id":"verified-owner-subject","oai-authenticated-user-email":"owner@example.test"};
const normalHeaders={"oai-authenticated-user-id":"verified-ordinary-subject","oai-authenticated-user-email":"ordinary@example.test"};
const cookie=(response:Response)=>response.headers.get("set-cookie")!.split(";")[0];
type PublicUser={id:string;name:string;username:string|null;email:string|null;role:string;auth_provider:string;telegram_id:number|null};
const resultUser=async(response:Response)=>(await response.json() as {user:PublicUser}).user;
const flight={route:"MOW-AER",date:"2026-06-01",price:9000};

function fixture(){
  const store=testDatabase();
  const env:AppEnv={DB:store.db,PASSWORD_PEPPER:"offline-http-password-pepper-"+"x".repeat(40),ADMIN_EMAIL:"owner@example.test",BOT_TOKEN:botToken,BOT_ID:"123456",BOT_USERNAME:"offline_http_bot",BOT_INTERNAL_SECRET:internalSecret,TELEGRAM_WEBHOOK_SECRET:"offline-webhook-secret-"+"x".repeat(32)};
  async function call(path:string,method="GET",body?:unknown,session?:string,headers:Record<string,string>={}){
    return handleApi(new Request(origin+"/api/"+path,{method,headers:{Origin:origin,"CF-Connecting-IP":"192.0.2.200",...(body!==undefined?{"Content-Type":"application/json"}:{}),...(session?{Cookie:session}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})}),path.split("?")[0],env);
  }
  return {...store,env,call};
}
async function telegramData(id=42,name="Telegram user"){
  const params=new URLSearchParams({auth_date:String(unixNow()),user:JSON.stringify({id,first_name:name}),query_id:"offline-http-fixture"});
  const check=[...params.keys()].sort().map(key=>`${key}=${params.get(key)}`).join("\n");
  params.set("hash",toHex(await hmac(await hmac(encode("WebAppData"),botToken),check)));
  return params.toString();
}

test("HTTP registration/login/password/logout preserve scenarios, rotate sessions and expose only safe user fields",async()=>{
  const f=fixture();try{
    const guest=await f.call("auth/guest","POST",{}),guestCookie=cookie(guest),guestUser=await resultUser(guest);
    const saved=await f.call("scenarios","POST",{...flight,title:"Гостевое решение"},guestCookie);assert.equal(saved.status,201);
    const registration=await f.call("auth/register","POST",{username:"Http.Traveller",password,name:"Путешественник",import_guest:true},guestCookie);assert.equal(registration.status,201);
    const registeredCookie=cookie(registration),registered=await resultUser(registration);assert.equal(registered.id,guestUser.id);assert.equal(registered.username,"http.traveller");assert.equal(registered.role,"analyst");assert.equal(registered.auth_provider,"password");
    assert.equal("password_hash" in registered,false);assert.equal("openai_id" in registered,false);assert.equal("chat_id" in registered,false);
    const me=await f.call("auth/me","GET",undefined,registeredCookie);assert.deepEqual(await resultUser(me),registered);
    assert.equal((await (await f.call("scenarios","GET",undefined,registeredCookie)).json() as {items:unknown[]}).items.length,1);
    assert.equal((await f.call("scenarios","GET",undefined,guestCookie)).status,401);
    const second=await f.call("auth/login","POST",{username:"HTTP.TRAVELLER",password});assert.equal(second.status,200);const secondCookie=cookie(second);
    assert.equal((await resultUser(second)).id,registered.id);
    const changed=await f.call("auth/password","POST",{current_password:password,new_password:newPassword},secondCookie);assert.equal(changed.status,200);const changedCookie=cookie(changed);
    assert.equal((await f.call("scenarios","GET",undefined,registeredCookie)).status,401);assert.equal((await f.call("scenarios","GET",undefined,secondCookie)).status,401);
    assert.equal((await f.call("auth/login","POST",{username:"http.traveller",password})).status,401);
    assert.equal((await f.call("scenarios","GET",undefined,changedCookie)).status,200);
    const out=await f.call("auth/logout","POST",{},changedCookie);assert.equal(out.status,200);assert.match(out.headers.get("set-cookie")!,/Max-Age=0/);
    assert.equal((await f.call("scenarios","GET",undefined,changedCookie)).status,401);
    const again=await f.call("auth/login","POST",{username:"http.traveller",password:newPassword});assert.equal(again.status,200);assert.equal((await resultUser(again)).id,registered.id);
  }finally{f.close();}
});

test("HTTP ChatGPT login permits ordinary users, reserves owner administration and rejects privilege fields",async()=>{
  const f=fixture();try{
    const ordinary=await f.call("auth/chatgpt","POST",{},undefined,normalHeaders);assert.equal(ordinary.status,200);const ordinaryCookie=cookie(ordinary);assert.equal((await resultUser(ordinary)).role,"analyst");
    assert.equal((await f.call("admin/users","GET",undefined,ordinaryCookie,normalHeaders)).status,403);
    const owner=await f.call("auth/chatgpt","POST",{},undefined,ownerHeaders);assert.equal(owner.status,200);const ownerCookie=cookie(owner);assert.equal((await resultUser(owner)).role,"admin");
    assert.equal((await f.call("admin/users","GET",undefined,ownerCookie,ownerHeaders)).status,200);
    assert.equal((await f.call("admin/users","GET",undefined,ownerCookie)).status,401);
    const forged=await f.call("auth/register","POST",{username:"owner",password,email:"owner@example.test",role:"admin",openai_id:"verified-owner-subject"});assert.equal(forged.status,422);
    const native=await f.call("auth/register","POST",{username:"owner",password,name:"owner@example.test"},undefined,ownerHeaders);assert.equal(native.status,201);const nativeCookie=cookie(native);assert.equal((await resultUser(native)).role,"analyst");
    assert.equal((await f.call("admin/users","GET",undefined,nativeCookie,ownerHeaders)).status,403);
    const selected=await f.call("auth/chatgpt","POST",{},nativeCookie,ownerHeaders);assert.equal((await resultUser(selected)).role,"admin");
  }finally{f.close();}
});

test("HTTP website and Mini App remain separate and cannot read each other's scenarios by changing client context",async()=>{
  const f=fixture();try{
    const web=await f.call("auth/register","POST",{username:"independent_web",password}),webCookie=cookie(web),webUser=await resultUser(web);
    const telegram=await f.call("auth/telegram","POST",{init_data:await telegramData(42,"owner@example.test")},undefined,{"X-Avia-Client":"telegram"});assert.equal(telegram.status,200);
    const tgCookie=cookie(telegram),tgUser=await resultUser(telegram),both=webCookie+"; "+tgCookie;assert.notEqual(tgUser.id,webUser.id);assert.equal(tgUser.role,"analyst");
    assert.equal((await resultUser(await f.call("auth/me","GET",undefined,both))).id,webUser.id);
    assert.equal((await resultUser(await f.call("auth/me","GET",undefined,both,{"X-Avia-Client":"telegram",...ownerHeaders}))).id,tgUser.id);
    const a=await f.call("scenarios","POST",{...flight,title:"Website only"},both),b=await f.call("scenarios","POST",{...flight,title:"Telegram only"},both,{"X-Avia-Client":"telegram"});
    const webScenario=await a.json() as {id:string},tgScenario=await b.json() as {id:string};assert.equal(a.status,201);assert.equal(b.status,201);
    assert.equal((await f.call("scenarios/"+tgScenario.id,"GET",undefined,webCookie)).status,404);
    assert.equal((await f.call("scenarios/"+webScenario.id,"GET",undefined,tgCookie,{"X-Avia-Client":"telegram"})).status,404);
    assert.equal((await f.call("scenarios","GET",undefined,webCookie,{"X-Avia-Client":"telegram"})).status,401);
    assert.equal((await f.call("scenarios","GET",undefined,tgCookie)).status,401);
    const tampered=new URLSearchParams(await telegramData());tampered.set("user",JSON.stringify({id:999,first_name:"Owner",role:"admin"}));
    assert.equal((await f.call("auth/telegram","POST",{init_data:tampered.toString()},undefined,{"X-Avia-Client":"telegram"})).status,401);
    assert.equal((await f.call("admin/users","GET",undefined,both,{"X-Avia-Client":"telegram"})).status,403);
  }finally{f.close();}
});

test("HTTP owner can explicitly link a verified Telegram account; unlinked Telegram users never inherit owner rights",async()=>{
  const f=fixture();try{
    const initial=await f.call("auth/telegram","POST",{init_data:await telegramData(42)},undefined,{"X-Avia-Client":"telegram"});assert.equal((await resultUser(initial)).role,"analyst");
    const owner=await f.call("auth/chatgpt","POST",{},undefined,ownerHeaders),ownerCookie=cookie(owner),ownerUser=await resultUser(owner);
    const link=await f.call("auth/telegram/link","POST",{},ownerCookie,ownerHeaders);assert.equal(link.status,200);const code=(await link.json() as {code:string}).code;
    const body={code,telegram_id:42,chat_id:42,name:"Verified Telegram owner"};
    assert.equal((await f.call("bot/link","POST",body)).status,403);
    const confirmed=await f.call("bot/link","POST",body,undefined,{"x-bot-secret":internalSecret});assert.equal(confirmed.status,200);
    const ownerTg=await f.call("auth/telegram","POST",{init_data:await telegramData(42)},undefined,{"X-Avia-Client":"telegram"});const linked=await resultUser(ownerTg);assert.equal(linked.role,"admin");assert.equal(linked.id,ownerUser.id);
    const stranger=await f.call("auth/telegram","POST",{init_data:await telegramData(43,"Verified Telegram owner")},undefined,{"X-Avia-Client":"telegram"});assert.equal((await resultUser(stranger)).role,"analyst");
  }finally{f.close();}
});

test("HTTP auth endpoints enforce origins/methods and return English errors when requested",async()=>{
  const f=fixture();try{
    assert.equal((await f.call("auth/register","GET")).status,405);
    assert.equal((await f.call("auth/register","POST",{username:"new_user",password},undefined,{Origin:"https://untrusted.test"})).status,403);
    const en=await f.call("auth/login","POST",{username:"missing_user",password},undefined,{"Accept-Language":"en"});assert.equal(en.status,401);assert.equal(en.headers.get("Content-Language"),"en");assert.deepEqual(await en.json(),{detail:"Incorrect username or password."});
    const ru=await f.call("auth/login?lang=ru","POST",{username:"missing_user",password},undefined,{"Accept-Language":"en"});assert.deepEqual(await ru.json(),{detail:"Неверный логин или пароль."});
  }finally{f.close();}
});

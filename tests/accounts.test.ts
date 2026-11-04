import assert from "node:assert/strict";
import test from "node:test";
import { authLogin, authRegister, changePassword } from "../lib/server/accounts.ts";
import { authChatGPT, consumeAuthRateLimit, ensureGuestSession, getUser, issueWebsiteSession, signOut } from "../lib/server/auth.ts";
import { hashPassword, verifyPassword } from "../lib/server/passwords.ts";
import { PublicError, sha256, unixNow } from "../lib/server/security.ts";
import { testDatabase } from "./auth-support.ts";

const origin="https://avia.test",password="Correct horse battery 2026",pepper="offline-test-pepper-only-"+"x".repeat(40);
const env={PASSWORD_PEPPER:pepper,ADMIN_EMAIL:"owner@example.test"};
const pair=(response:Response)=>response.headers.get("set-cookie")!.split(";")[0];
const request=(body:unknown,cookie?:string,extra:Record<string,string>={})=>new Request(origin+"/api/auth/register",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","CF-Connecting-IP":"192.0.2.11",...(cookie?{Cookie:cookie}:{}),...extra},body:JSON.stringify(body)});
const me=(cookie:string,extra:Record<string,string>={})=>new Request(origin+"/api/auth/me",{headers:{Cookie:cookie,...extra}});
const identity={"oai-authenticated-user-id":"verified-owner-id","oai-authenticated-user-email":"owner@example.test"};

test("password hashes are salted, pepper-bound and never plaintext; missing pepper fails closed",async()=>{
  const a=await hashPassword(password,env),b=await hashPassword(password,env);
  assert.notEqual(a,b);assert.ok(!a.includes(password));assert.ok(!a.includes(pepper));
  assert.equal(await verifyPassword(password,a,env),true);
  assert.equal(await verifyPassword("wrong password",a,env),false);
  assert.equal(await verifyPassword(password,a,{PASSWORD_PEPPER:"other-secret-"+"y".repeat(40)}),false);
  assert.equal(await verifyPassword(password,null,env),false);
  await assert.rejects(()=>hashPassword(password,{}),error=>error instanceof PublicError&&error.status===503);
});

test("registration creates ordinary case-insensitive username accounts and rejects owner/role injection",async()=>{
  const store=testDatabase();try{
    const forged=await authRegister(request({username:"intruder",password,email:"owner@example.test",role:"admin"}),store.db,env);
    assert.equal(forged.status,422);
    const registered=await authRegister(request({username:"Alice.Test",password,name:"Алиса"},undefined,identity),store.db,env);
    assert.equal(registered.status,201);
    const data=await registered.json() as {user:{id:string;username:string;role:string;auth_provider:string;email:string|null}};
    assert.equal(data.user.username,"alice.test");assert.equal(data.user.role,"analyst");assert.equal(data.user.email,null);assert.equal(data.user.auth_provider,"password");
    const cookie=pair(registered);
    for(const flag of ["HttpOnly","Secure","SameSite=Lax","Max-Age=604800"])assert.ok(registered.headers.get("set-cookie")!.includes(flag));
    const persisted=await getUser(me(cookie,identity),store.db,env);
    assert.equal(persisted?.id,data.user.id);assert.equal(persisted?.auth_provider,"password");assert.equal(persisted?.role,"analyst");
    const duplicate=await authRegister(request({username:"ALICE.TEST",password}),store.db,env);assert.equal(duplicate.status,409);
    const row=store.sqlite.prepare("SELECT id FROM sessions WHERE user_id=?").get(data.user.id) as {id:string};
    assert.equal(row.id,await sha256(cookie.split("=")[1]));
    assert.equal("password_hash" in data.user,false);
  }finally{store.close();}
});

test("login works across devices and unknown user/wrong password have identical public errors",async()=>{
  const store=testDatabase();try{
    const registered=await authRegister(request({username:"traveller",password}),store.db,env),original=pair(registered);
    const login=await authLogin(request({username:"TRAVELLER",password}),store.db,env),second=pair(login);
    assert.equal(login.status,200);assert.notEqual(original,second);
    assert.equal((await getUser(me(original),store.db,env))?.id,(await getUser(me(second),store.db,env))?.id);
    const incorrect=await authLogin(request({username:"traveller",password:"wrong-password"}),store.db,env),unknown=await authLogin(request({username:"not_registered",password:"wrong-password"}),store.db,env);
    assert.equal(incorrect.status,401);assert.equal(unknown.status,401);assert.deepEqual(await incorrect.json(),await unknown.json());
    await signOut(request({},second),store.db);assert.equal(await getUser(me(second),store.db,env),null);assert.ok(await getUser(me(original),store.db,env));
  }finally{store.close();}
});

test("guest upgrade requires opt-in and rotates its session while retaining saved ownership",async()=>{
  const store=testDatabase();try{
    const guest=await ensureGuestSession(request({}),store.db),guestCookie=pair(guest),guestId=(await guest.json() as {user:{id:string}}).user.id;
    const registration=await authRegister(request({username:"preserve",password,import_guest:true},guestCookie),store.db,env);
    const result=await registration.json() as {user:{id:string}};assert.equal(result.user.id,guestId);
    assert.notEqual(pair(registration),guestCookie);assert.equal(await getUser(me(guestCookie),store.db,env),null);
    const independentGuest=await ensureGuestSession(request({}),store.db),independentId=(await independentGuest.json() as {user:{id:string}}).user.id;
    const fresh=await authRegister(request({username:"separate",password},pair(independentGuest)),store.db,env);
    assert.notEqual((await fresh.json() as {user:{id:string}}).user.id,independentId);
  }finally{store.close();}
});

test("login guest import moves only explicitly confirmed guest scenarios into the authenticated account",async()=>{
  const store=testDatabase();try{
    const registered=await authRegister(request({username:"returning",password}),store.db,env),userId=(await registered.json() as {user:{id:string}}).user.id;
    const guest=await ensureGuestSession(request({}),store.db),guestCookie=pair(guest),guestId=(await guest.json() as {user:{id:string}}).user.id;
    store.sqlite.prepare("INSERT INTO datasets(id,filename,imported_at,sha256,rows_json,routes_json) VALUES('fixture','test.csv',0,'hash','[]','[]')").run();
    store.sqlite.prepare("INSERT INTO scenarios(id,owner_id,title,route,date,price,dataset_id,result_json,created_at,updated_at) VALUES('guest-scenario',?,'Guest','MOW-AER','2026-06-01',9000,'fixture','{}',0,0)").run(guestId);
    const without=await authLogin(request({username:"returning",password},guestCookie),store.db,env);assert.equal(without.status,200);
    assert.equal((store.sqlite.prepare("SELECT owner_id FROM scenarios").get() as {owner_id:string}).owner_id,guestId);
    // The other original guest session proves ownership for this explicit import.
    const guest2=await ensureGuestSession(request({}),store.db),cookie2=pair(guest2),id2=(await guest2.json() as {user:{id:string}}).user.id;
    store.sqlite.prepare("UPDATE scenarios SET owner_id=?").run(id2);
    const imported=await authLogin(request({username:"returning",password,import_guest:true},cookie2),store.db,env);assert.equal(imported.status,200);
    assert.equal((store.sqlite.prepare("SELECT owner_id FROM scenarios").get() as {owner_id:string}).owner_id,userId);
    assert.equal(await getUser(me(cookie2),store.db,env),null);
  }finally{store.close();}
});

test("changing password verifies old secret, revokes every old session and issues a fresh session",async()=>{
  const store=testDatabase();try{
    const registered=await authRegister(request({username:"password_change",password}),store.db,env),a=pair(registered);
    const second=await authLogin(request({username:"password_change",password}),store.db,env),b=pair(second);
    const wrong=await changePassword(request({current_password:"wrong",new_password:"A safer replacement 2027"},a),store.db,env);assert.equal(wrong.status,401);
    const changed=await changePassword(request({current_password:password,new_password:"A safer replacement 2027"},a),store.db,env);assert.equal(changed.status,200);
    assert.equal(await getUser(me(a),store.db,env),null);assert.equal(await getUser(me(b),store.db,env),null);assert.ok(await getUser(me(pair(changed)),store.db,env));
    assert.equal((await authLogin(request({username:"password_change",password}),store.db,env)).status,401);
    assert.equal((await authLogin(request({username:"password_change",password:"A safer replacement 2027"}),store.db,env)).status,200);
  }finally{store.close();}
});

test("ChatGPT choice switches explicitly from native login and remains bound to platform identity",async()=>{
  const store=testDatabase();try{
    const registered=await authRegister(request({username:"native_choice",password}),store.db,env),nativeCookie=pair(registered);
    const prior=await getUser(me(nativeCookie,identity),store.db,env);assert.equal(prior?.auth_provider,"password");
    const chosen=await authChatGPT(request({},nativeCookie,identity),store.db,env);assert.equal(chosen.status,200);
    const chosenCookie=pair(chosen),data=await chosen.json() as {user:{role:string;auth_provider:string}};
    assert.equal(data.user.role,"admin");assert.equal(data.user.auth_provider,"chatgpt");assert.equal(await getUser(me(nativeCookie),store.db,env),null);
    assert.equal((await getUser(me(chosenCookie,identity),store.db,env))?.role,"admin");
    assert.equal(await getUser(me(chosenCookie),store.db,env),null);
    const other={"oai-authenticated-user-id":"other-verified-user","oai-authenticated-user-email":"ordinary@example.test"};
    const ordinary=await authChatGPT(request({},undefined,other),store.db,env);assert.equal((await ordinary.json() as {user:{role:string}}).user.role,"analyst");
  }finally{store.close();}
});

test("stale password verification cannot restore a session after a concurrent credential change",async()=>{
  const store=testDatabase();try{
    const registered=await authRegister(request({username:"race_guard",password}),store.db,env),cookie=pair(registered),user=await getUser(me(cookie),store.db,env);
    assert.ok(user);
    const previous=(store.sqlite.prepare("SELECT password_hash FROM auth_accounts WHERE user_id=?").get(user.id) as {password_hash:string}).password_hash;
    const current=await hashPassword("New password after concurrent reset",env);
    // Simulate a committed credential update while another request retains the
    // old verifier; the old session is deliberately left in storage as well.
    store.sqlite.prepare("UPDATE auth_accounts SET password_hash=? WHERE user_id=?").run(current,user.id);
    assert.equal(await getUser(me(cookie),store.db,env),null);
    await assert.rejects(()=>issueWebsiteSession(user,store.db,"password",{expectedPasswordHash:previous}),error=>error instanceof PublicError&&error.status===409);
    const attempted=await hashPassword("Losing concurrent password update",env);
    await assert.rejects(()=>issueWebsiteSession(user,store.db,"password",{expectedPasswordHash:attempted,changeFromHash:previous}),error=>error instanceof PublicError&&error.status===409);
    assert.equal((store.sqlite.prepare("SELECT password_hash FROM auth_accounts WHERE user_id=?").get(user.id) as {password_hash:string}).password_hash,current);
    assert.equal((store.sqlite.prepare("SELECT count(*) AS n FROM sessions").get() as {n:number}).n,1);
    const fresh=await issueWebsiteSession(user,store.db,"password",{expectedPasswordHash:current});assert.ok(await getUser(me(pair(fresh)),store.db,env));
  }finally{store.close();}
});

test("durable auth limits are atomic, stored as hashes and reset only after expiry",async()=>{
  const store=testDatabase();try{
    const req=request({});
    await consumeAuthRateLimit(req,store.db,"test","username",{limit:2,seconds:900});await consumeAuthRateLimit(req,store.db,"test","username",{limit:2,seconds:900});
    await assert.rejects(()=>consumeAuthRateLimit(req,store.db,"test","username",{limit:2,seconds:900}),error=>error instanceof PublicError&&error.status===429);
    const persisted=store.sqlite.prepare("SELECT key,attempts FROM auth_rate_limits").get() as {key:string;attempts:number};assert.equal(persisted.key,await sha256("test:username"));assert.equal(persisted.attempts,3);
    store.sqlite.prepare("UPDATE auth_rate_limits SET expires_at=?").run(unixNow()-1);
    await consumeAuthRateLimit(req,store.db,"test","username",{limit:2,seconds:900});
    assert.equal((store.sqlite.prepare("SELECT attempts FROM auth_rate_limits").get() as {attempts:number}).attempts,1);
  }finally{store.close();}
});

test("registration rejects CSRF, weak passwords, forged Mini App context and oversized input",async()=>{
  const store=testDatabase();try{
    assert.equal((await authRegister(request({username:"test",password},undefined,{Origin:"https://evil.test"}),store.db,env)).status,403);
    assert.equal((await authRegister(request({username:"test",password:"short"}),store.db,env)).status,422);
    assert.equal((await authRegister(request({username:"test",password},undefined,{"X-Avia-Client":"telegram"}),store.db,env)).status,400);
    assert.equal((await authRegister(request({username:"test",password,name:"x".repeat(9000)}),store.db,env)).status,413);
    assert.equal((await authRegister(request({username:"test",password}),store.db,{})).status,503);
    assert.equal((store.sqlite.prepare("SELECT count(*) AS n FROM auth_accounts").get() as {n:number}).n,0);
  }finally{store.close();}
});

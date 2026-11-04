/** Independent browser/Mini App sessions and verified external identities. */
import type { AppEnv, Role, UserRecord } from "./db.ts";
import { PublicError, assertSameOrigin, constantTimeEqual, encode, fromHex, hmac, randomToken, readLimitedText, safeError, sha256, toHex, unixNow } from "./security.ts";
export { consumeAuthRateLimit } from "./auth-rate-limit.ts";

export type AuthProvider="guest"|"chatgpt"|"telegram"|"password";
export type User = UserRecord & {auth_provider?: AuthProvider};
export const SESSION_COOKIE="__Host-avia_session";
export const WEB_SESSION_COOKIE="__Host-avia_web_session";
const SESSION_SECONDS=7*24*60*60;
const GUEST_SESSION_SECONDS=180*24*60*60;
export const TELEGRAM_PRODUCTION_KEY="e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d";
export function isTelegramRequest(request:Request):boolean {
  if(request.headers.get("X-Avia-Client")==="telegram")return true;
  if(request.method!=="GET")return false;
  const url=new URL(request.url);
  return url.searchParams.get("avia_client")==="telegram"&&/^\/api\/scenarios\/[^/]+\/(?:report|export\.csv)$/.test(url.pathname);
}

export interface TelegramIdentity {id:number;first_name:string;last_name?:string;username?:string;allows_write_to_pm?:boolean;}
interface VerifyOptions {now?:number; publicKeyHex?:string;}

export async function verifyTelegramInitData(raw: string, env: Pick<AppEnv,"BOT_ID"|"BOT_TOKEN">, options: VerifyOptions={}): Promise<TelegramIdentity> {
  if(typeof raw!=="string" || !raw || raw.length>32768) throw new PublicError(401,"Откройте мини-приложение через кнопку Telegram.");
  const values=new URLSearchParams(raw); const keys=[...values.keys()];
  if(keys.some((key,index)=>!/^\w+$/.test(key)||keys.indexOf(key)!==index)) throw new PublicError(401,"Данные Telegram недействительны.");
  const now=options.now??unixNow(); const date=Number(values.get("auth_date"));
  if(!Number.isSafeInteger(date)||date<=0||date>now+30||now-date>600) throw new PublicError(401,"Сеанс Telegram устарел. Откройте приложение заново.");
  const botId=String(env.BOT_ID || "9144995775");
  if(!/^\d{5,20}$/.test(botId)) throw new PublicError(503,"Вход через Telegram пока не настроен.");
  if(values.has("signature")) {
    const signature=values.get("signature")!;
    if(!/^[A-Za-z0-9_-]{85,88}={0,2}$/.test(signature)) throw new PublicError(401,"Подпись Telegram недействительна.");
    const check=botId+":WebAppData\n"+keys.filter(k=>k!=="hash"&&k!=="signature").sort().map(k=>`${k}=${values.get(k)}`).join("\n");
    try {
      const bytes=Uint8Array.from(atob(signature.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(signature.length/4)*4,"=")),c=>c.charCodeAt(0));
      if(bytes.length!==64) throw new Error();
      const key=await crypto.subtle.importKey("raw",fromHex(options.publicKeyHex??TELEGRAM_PRODUCTION_KEY) as BufferSource,"Ed25519",false,["verify"]);
      if(!await crypto.subtle.verify("Ed25519",key,bytes,encode(check))) throw new Error();
    } catch {throw new PublicError(401,"Подпись Telegram недействительна.");}
    // Never downgrade an invalid Ed25519 signature to the bot-token method.
  } else {
    const received=values.get("hash")??"";
    if(!env.BOT_TOKEN || !/^[a-fA-F0-9]{64}$/.test(received)) throw new PublicError(401,"Подпись Telegram отсутствует. Откройте приложение заново.");
    const check=keys.filter(k=>k!=="hash").sort().map(k=>`${k}=${values.get(k)}`).join("\n");
    const secret=await hmac(encode("WebAppData"),env.BOT_TOKEN);
    const expected=toHex(await hmac(secret,check));
    if(!await constantTimeEqual(received.toLowerCase(),expected)) throw new PublicError(401,"Подпись Telegram недействительна.");
  }
  let user: TelegramIdentity;
  try {user=JSON.parse(values.get("user")??"");} catch {throw new PublicError(401,"Не удалось определить пользователя Telegram.");}
  if(!user||!Number.isSafeInteger(user.id)||user.id<=0||typeof user.first_name!=="string"||user.first_name.length>128) throw new PublicError(401,"Не удалось определить пользователя Telegram.");
  return user;
}

export function cookieToken(request: Request,cookieName=SESSION_COOKIE): string|null {
  const cookies=(request.headers.get("Cookie")??"").split(";").map(s=>s.trim());
  const matches=cookies.filter(c=>c.startsWith(cookieName+"="));
  if(matches.length!==1) return null;
  const value=matches[0].slice(cookieName.length+1);
  return /^[a-f0-9]{64}$/.test(value)?value:null;
}
const cookie=(value:string,maxAge:number,name=SESSION_COOKIE)=>`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${name===WEB_SESSION_COOKIE?"Lax":"None"}; Max-Age=${maxAge}`;

export function publicUser(user:UserRecord,provider:AuthProvider){return {id:user.id,email:user.email,name:user.name,username:user.username??null,role:user.role,telegram_id:user.telegram_id,telegram_delivery_ready:user.chat_id!==null,auth_provider:provider};}
async function sessionUser(request:Request,db:D1Database,cookieName:string,provider:AuthProvider):Promise<User|null> {
  const token=cookieToken(request,cookieName); if(!token) return null;
  const user=await db.prepare("SELECT users.*,auth_accounts.username,auth_accounts.password_hash AS current_password_hash,sessions.auth_provider AS session_provider,sessions.credential_version FROM sessions JOIN users ON users.id=sessions.user_id LEFT JOIN auth_accounts ON auth_accounts.user_id=users.id WHERE sessions.id=? AND sessions.expires_at>? AND sessions.created_at<=?")
    .bind(await sha256(token),unixNow(),unixNow()+30).first<UserRecord&{session_provider:string;credential_version:string|null;current_password_hash:string|null}>();
  if(provider==="telegram"&&user?.telegram_id==null)return null;
  if(!user)return null;
  const resolved=cookieName===WEB_SESSION_COOKIE&&["password","telegram","chatgpt"].includes(user.session_provider)?user.session_provider as AuthProvider:provider;
  if(resolved==="password"&&(!user.username||!user.current_password_hash||!user.credential_version||!await constantTimeEqual(user.credential_version,await sha256(user.current_password_hash))))return null;
  if(resolved==="telegram"&&user.telegram_id==null)return null;
  // Sites owns SSO lifetime. A local selector never substitutes for its identity.
  if(resolved==="chatgpt"&&(!user.openai_id||request.headers.get("oai-authenticated-user-id")!==user.openai_id))return null;
  const {session_provider:_provider,credential_version:_version,current_password_hash:_hash,...record}=user;
  return {...record,auth_provider:resolved};
}

export function configuredTelegramOwnerId(env:Partial<AppEnv>):number|null {
  const value=String(env.ADMIN_TELEGRAM_ID??"");
  const id=Number(value);
  return /^\d{1,16}$/.test(value)&&Number.isSafeInteger(id)&&id>0?id:null;
}
export function telegramRole(existing:UserRecord|null,telegramId:number,env:Partial<AppEnv>):Role {
  if(configuredTelegramOwnerId(env)===telegramId)return "admin";
  return existing?.role??"analyst";
}

async function sitesIdentity(request:Request,db:D1Database,env:Partial<AppEnv>):Promise<User|null> {
  const openaiId=request.headers.get("oai-authenticated-user-id");
  const email=request.headers.get("oai-authenticated-user-email");
  if(openaiId && email && openaiId.length<=256 && email.length<=320) {
    const owner=String(env.ADMIN_EMAIL||env.SITE_OWNER_EMAIL||"").trim().toLowerCase();
    const existing=await db.prepare("SELECT * FROM users WHERE openai_id=?").bind(openaiId).first<UserRecord>();
    const admin=(!!owner&&email.toLowerCase()===owner)||existing?.role==="admin";
    let name=email;
    const encoded=request.headers.get("oai-authenticated-user-full-name");
    if(encoded && request.headers.get("oai-authenticated-user-full-name-encoding")==="percent-encoded-utf-8") {
      try {name=decodeURIComponent(encoded).slice(0,200)||email;} catch {name=email;}
    }
    // Identity is keyed by Sites' stable ID, never merged by an unverified email.
    await db.prepare("INSERT INTO users(id,email,name,role,openai_id,telegram_id,chat_id,created_at) VALUES(?,?,?,?,?,NULL,NULL,?) ON CONFLICT(openai_id) DO UPDATE SET name=excluded.name,email=excluded.email,role=excluded.role")
      .bind(crypto.randomUUID(),email,name,admin?"admin":existing?.role??"analyst",openaiId,unixNow()).run();
    const user=await db.prepare("SELECT users.*,auth_accounts.username FROM users LEFT JOIN auth_accounts ON auth_accounts.user_id=users.id WHERE openai_id=?").bind(openaiId).first<UserRecord>();
    return user?{...user,auth_provider:"chatgpt"}:null;
  }
  return null;
}

export async function getUser(request: Request, db: D1Database, env: Partial<AppEnv>={}): Promise<User|null> {
  // Client context selects only a cookie namespace, never an identity.
  if(isTelegramRequest(request))return sessionUser(request,db,SESSION_COOKIE,"telegram");
  const website=await sessionUser(request,db,WEB_SESSION_COOKIE,"guest");
  // An explicit native login remains selected even while Sites has an SSO cookie.
  if(website&&website.auth_provider!=="guest")return website;
  return await sitesIdentity(request,db,env)??website;
}

export async function issueWebsiteSession(user:UserRecord,db:D1Database,provider:Exclude<AuthProvider,"guest">="password",options:{replaceToken?:string;status?:number;expectedPasswordHash?:string;changeFromHash?:string}={}):Promise<Response> {
  const token=randomToken(),current=unixNow(),statements:D1PreparedStatement[]=[];
  if(provider==="password"&&!options.expectedPasswordHash)throw new PublicError(503,"Не удалось проверить сеанс входа. Войдите заново.");
  if(provider==="password"&&options.changeFromHash){
    // The compare-and-swap, revocation and replacement session share one D1
    // transaction. A concurrent old-password request cannot restore a session.
    statements.push(db.prepare("UPDATE auth_accounts SET password_hash=?,updated_at=? WHERE user_id=? AND password_hash=?").bind(options.expectedPasswordHash!,current,user.id,options.changeFromHash));
    statements.push(db.prepare("DELETE FROM sessions WHERE user_id=? AND EXISTS(SELECT 1 FROM auth_accounts WHERE user_id=? AND password_hash=?)").bind(user.id,user.id,options.expectedPasswordHash!));
  }
  if(options.replaceToken&&/^[a-f0-9]{64}$/.test(options.replaceToken))statements.push(db.prepare("DELETE FROM sessions WHERE id=?").bind(await sha256(options.replaceToken)));
  if(provider==="password")statements.push(db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,auth_provider,credential_version) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM auth_accounts WHERE user_id=? AND password_hash=?)").bind(await sha256(token),user.id,current+SESSION_SECONDS,current,provider,await sha256(options.expectedPasswordHash!),user.id,options.expectedPasswordHash!));
  else statements.push(db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at,auth_provider) VALUES(?,?,?,?,?)").bind(await sha256(token),user.id,current+SESSION_SECONDS,current,provider));
  const results=await db.batch(statements);
  if(!results.at(-1)?.meta.changes)throw new PublicError(409,"Пароль был изменён. Войдите заново.");
  return Response.json({user:publicUser(user,provider)},{status:options.status??200,headers:{"Set-Cookie":cookie(token,SESSION_SECONDS,WEB_SESSION_COOKIE),"Cache-Control":"no-store"}});
}

export async function authChatGPT(request:Request,db:D1Database,env:Partial<AppEnv>):Promise<Response> {
  try{
    if(request.method!=="POST"||isTelegramRequest(request))throw new PublicError(400,"Вход ChatGPT доступен на отдельном сайте.");
    assertSameOrigin(request);
    const user=await sitesIdentity(request,db,env);
    if(!user)throw new PublicError(401,"Сначала войдите через ChatGPT.");
    return issueWebsiteSession(user,db,"chatgpt",{replaceToken:cookieToken(request,WEB_SESSION_COOKIE)??undefined});
  }catch(error){return safeError(error);}
}

export async function signIn(user: UserRecord, db: D1Database): Promise<Response> {
  const token=randomToken(); const now=unixNow();
  await db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)").bind(await sha256(token),user.id,now+SESSION_SECONDS,now).run();
  return Response.json({user:publicUser(user,"telegram")},{headers:{"Set-Cookie":cookie(token,SESSION_SECONDS),"Cache-Control":"no-store"}});
}

export async function ensureGuestSession(request:Request,db:D1Database):Promise<Response> {
  try{
    if(request.method!=="POST")throw new PublicError(405,"Для создания гостевого пространства используйте POST.");
    assertSameOrigin(request);
    if(isTelegramRequest(request))throw new PublicError(400,"Откройте мини-приложение кнопкой Telegram. Гостевой режим предназначен для отдельного сайта.");
    const existing=await sessionUser(request,db,WEB_SESSION_COOKIE,"guest");
    if(existing)return Response.json({user:publicUser(existing,existing.auth_provider??"guest")},{headers:{"Cache-Control":"no-store"}});
    const now=unixNow(),token=randomToken(),id=crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT INTO users(id,email,name,role,telegram_id,chat_id,openai_id,created_at) VALUES(?,NULL,'Гость','analyst',NULL,NULL,NULL,?)").bind(id,now),
      db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)").bind(await sha256(token),id,now+GUEST_SESSION_SECONDS,now),
    ]);
    const user=await db.prepare("SELECT * FROM users WHERE id=?").bind(id).first<UserRecord>();
    if(!user)throw new PublicError(503,"Не удалось создать гостевое пространство. Попробуйте позже.");
    return Response.json({user:publicUser(user,"guest")},{headers:{"Set-Cookie":cookie(token,GUEST_SESSION_SECONDS,WEB_SESSION_COOKIE),"Cache-Control":"no-store"}});
  }catch(error){return safeError(error);}
}
export const authGuest=(request:Request,db:D1Database,_env?:Partial<AppEnv>)=>ensureGuestSession(request,db);

export async function authTelegram(request: Request, db: D1Database, env: AppEnv): Promise<Response> {
  try {
    const text=await readLimitedText(request,40000);
    let body: {init_data?:string};
    try {body=JSON.parse(text);if(!body||typeof body!=="object"||Array.isArray(body))throw new Error();} catch {throw new PublicError(400,"Не удалось прочитать данные входа.");}
    const tg=await verifyTelegramInitData(body.init_data??"",env);
    const name=[tg.first_name,tg.last_name].filter(Boolean).join(" ").slice(0,200);
    const priorPrivateChat=await db.prepare("SELECT telegram_id FROM bot_states WHERE telegram_id=?").bind(tg.id).first();
    const chatId=tg.allows_write_to_pm===true||priorPrivateChat?tg.id:null;
    const prior=await db.prepare("SELECT * FROM users WHERE telegram_id=?").bind(tg.id).first<UserRecord>();
    await db.prepare("INSERT INTO users(id,email,name,role,telegram_id,chat_id,openai_id,created_at) VALUES(?,NULL,?,?,?,?,NULL,?) ON CONFLICT(telegram_id) DO UPDATE SET chat_id=COALESCE(users.chat_id,excluded.chat_id),role=excluded.role").bind(crypto.randomUUID(),name,telegramRole(prior,tg.id,env),tg.id,chatId,unixNow()).run();
    const user=await db.prepare("SELECT * FROM users WHERE telegram_id=?").bind(tg.id).first<UserRecord>();
    if(!user) throw new PublicError(503,"Не удалось создать сеанс. Попробуйте позже.");
    return await signIn(user,db);
  } catch(error) {return safeError(error);}
}

export async function signOut(request: Request, db: D1Database): Promise<Response> {
  const telegram=isTelegramRequest(request);
  const cookieName=telegram?SESSION_COOKIE:WEB_SESSION_COOKIE;
  const website=telegram?null:await sessionUser(request,db,WEB_SESSION_COOKIE,"guest");
  const platform=!telegram&&!!request.headers.get("oai-authenticated-user-id");
  // A guest cookie beneath optional platform identity is a separate workspace.
  if(platform&&website?.auth_provider==="guest")return Response.json({ok:true,redirect_url:"/signout-with-chatgpt?return_to=/"},{headers:{"Cache-Control":"no-store"}});
  const token=cookieToken(request,cookieName);
  if(token) await db.prepare("DELETE FROM sessions WHERE id=?").bind(await sha256(token)).run();
  return Response.json(platform?{ok:true,redirect_url:"/signout-with-chatgpt?return_to=/"}:{ok:true},{headers:{"Set-Cookie":cookie("",0,cookieName),"Cache-Control":"no-store"}});
}

/** Browser Telegram login: two independent secrets and an explicit private-chat confirmation. */
import type { AppEnv, UserRecord } from "./db.ts";
import { consumeAuthRateLimit, isTelegramRequest, issueWebsiteSession } from "./auth.ts";
import { PublicError, assertSameOrigin, constantTimeEqual, randomToken, readLimitedText, safeError, sha256, unixNow } from "./security.ts";

type Challenge={code_hash:string;browser_hash:string;expires_at:number;created_at:number;telegram_id:number|null;confirmed_at:number|null;cancelled_at:number|null;consumed_at:number|null;verification_code:string};
const codePattern=/^[a-f0-9]{32}$/;
const secretPattern=/^[a-f0-9]{64}$/;
const invalid=()=>new PublicError(401,"Запрос входа недействителен. Начните вход заново на сайте.");
const unavailable=()=>new PublicError(410,"Запрос входа истёк, отменён или уже использован. Начните вход заново на сайте.");

function assertWebsite(request:Request){
  if(request.method!=="POST")throw new PublicError(405,"Для входа используйте POST.");
  assertSameOrigin(request);
  if(isTelegramRequest(request))throw new PublicError(400,"В мини-приложении вход Telegram выполняется автоматически.");
}
async function readBody(request:Request):Promise<Record<string,unknown>>{
  const text=await readLimitedText(request,2048);
  try {const value:unknown=JSON.parse(text||"{}");if(!value||typeof value!=="object"||Array.isArray(value))throw new Error();return value as Record<string,unknown>;}
  catch {throw new PublicError(400,"Не удалось прочитать данные входа.");}
}

export async function startTelegramWebsiteLogin(request:Request,db:D1Database,env:Partial<AppEnv>):Promise<Response>{
  try{
    assertWebsite(request);await readBody(request);
    const username=String(env.BOT_USERNAME||"CU_AviGo_app").replace(/^@/,"");
    if(!/^[A-Za-z0-9_]{5,32}$/.test(username)||!env.BOT_TOKEN||!env.TELEGRAM_WEBHOOK_SECRET)throw new PublicError(503,"Вход через Telegram пока не настроен.");
    await consumeAuthRateLimit(request,db,"telegram-login-start",undefined,{limit:10,seconds:600});
    const code=randomToken(16),secret=randomToken(),now=unixNow(),expires=now+300;
    // The short code is a visual comparison aid, never an authentication factor.
    const verification=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");
    await db.batch([
      db.prepare("DELETE FROM telegram_login_challenges WHERE expires_at<?").bind(now-86400),
      db.prepare("INSERT INTO telegram_login_challenges(code_hash,browser_hash,expires_at,created_at,verification_code) VALUES(?,?,?,?,?)").bind(await sha256(code),await sha256(secret),expires,now,verification),
    ]);
    return Response.json({login_id:code,browser_secret:secret,url:`https://t.me/${username}?start=login_${code}`,expires_at:new Date(expires*1000).toISOString(),verification_code:verification},{headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
  }catch(error){return safeError(error);}
}

export async function pollTelegramWebsiteLogin(request:Request,db:D1Database,_env?:Partial<AppEnv>):Promise<Response>{
  try{
    assertWebsite(request);
    const input=await readBody(request);
    if(typeof input.login_id!=="string"||!codePattern.test(input.login_id)||typeof input.browser_secret!=="string"||!secretPattern.test(input.browser_secret))throw invalid();
    const [codeHash,browserHash]=await Promise.all([sha256(input.login_id),sha256(input.browser_secret)]);
    const row=await db.prepare("SELECT * FROM telegram_login_challenges WHERE code_hash=?").bind(codeHash).first<Challenge>();
    if(!row||!await constantTimeEqual(browserHash,row.browser_hash))throw invalid();
    // Only existing authenticated challenges can create per-request counters.
    await consumeAuthRateLimit(request,db,"telegram-login-poll",browserHash,{limit:200,seconds:600});
    const now=unixNow();
    if(row.expires_at<=now||row.cancelled_at!==null||row.consumed_at!==null)throw unavailable();
    if(row.confirmed_at===null||row.telegram_id===null)return Response.json({status:"pending"},{headers:{"Cache-Control":"no-store"}});
    const user=await db.prepare("SELECT * FROM users WHERE telegram_id=?").bind(row.telegram_id).first<UserRecord>();
    if(!user)throw new PublicError(503,"Не удалось создать сеанс. Начните вход заново.");
    const claim=await db.prepare("UPDATE telegram_login_challenges SET consumed_at=? WHERE code_hash=? AND browser_hash=? AND confirmed_at IS NOT NULL AND cancelled_at IS NULL AND consumed_at IS NULL AND expires_at>?").bind(now,codeHash,browserHash,now).run();
    if(claim.meta.changes!==1)throw unavailable();
    // Signing in deliberately chooses this Telegram account. It never merges
    // any guest scenarios or changes the independent Mini App cookie.
    const signed=await issueWebsiteSession(user,db,"telegram");
    return Response.json({...await signed.json() as Record<string,unknown>,status:"authenticated"},{status:signed.status,headers:signed.headers});
  }catch(error){return safeError(error);}
}

/** Closing the browser login dialog invalidates even an already-confirmed request. */
export async function cancelTelegramWebsiteLogin(request:Request,db:D1Database,_env?:Partial<AppEnv>):Promise<Response>{
  try{
    assertWebsite(request);
    const input=await readBody(request);
    if(typeof input.login_id!=="string"||!codePattern.test(input.login_id)||typeof input.browser_secret!=="string"||!secretPattern.test(input.browser_secret))throw invalid();
    const [codeHash,browserHash]=await Promise.all([sha256(input.login_id),sha256(input.browser_secret)]);
    const row=await db.prepare("SELECT browser_hash FROM telegram_login_challenges WHERE code_hash=?").bind(codeHash).first<{browser_hash:string}>();
    if(!row||!await constantTimeEqual(browserHash,row.browser_hash))throw invalid();
    await consumeAuthRateLimit(request,db,"telegram-login-cancel",browserHash,{limit:30,seconds:600});
    // Confirmation does not make cancellation too late. Only the atomic
    // consumption that issues a session wins over a concurrent cancellation.
    await db.prepare("UPDATE telegram_login_challenges SET cancelled_at=? WHERE code_hash=? AND browser_hash=? AND cancelled_at IS NULL AND consumed_at IS NULL").bind(unixNow(),codeHash,browserHash).run();
    return Response.json({ok:true},{headers:{"Cache-Control":"no-store"}});
  }catch(error){return safeError(error);}
}

/** Call only after the webhook has verified its secret and a private sender. */
export async function beginTelegramLoginConfirmation(db:D1Database,code:string,telegramId:number):Promise<{verification_code:string;expires_at:number}>{
  if(!codePattern.test(code)||!Number.isSafeInteger(telegramId)||telegramId<=0)throw invalid();
  const hash=await sha256(code),now=unixNow();
  const claim=await db.prepare("UPDATE telegram_login_challenges SET telegram_id=? WHERE code_hash=? AND (telegram_id IS NULL OR telegram_id=?) AND confirmed_at IS NULL AND cancelled_at IS NULL AND consumed_at IS NULL AND expires_at>?").bind(telegramId,hash,telegramId,now).run();
  if(claim.meta.changes!==1)throw unavailable();
  const row=await db.prepare("SELECT verification_code,expires_at FROM telegram_login_challenges WHERE code_hash=?").bind(hash).first<{verification_code:string;expires_at:number}>();
  if(!row)throw unavailable();
  return row;
}

/** A button click from that same verified sender is required; /start alone never authenticates. */
export async function finishTelegramLoginConfirmation(db:D1Database,code:string,telegramId:number,approve:boolean):Promise<void>{
  if(!codePattern.test(code)||!Number.isSafeInteger(telegramId)||telegramId<=0)throw invalid();
  const now=unixNow(),field=approve?"confirmed_at":"cancelled_at";
  const changed=await db.prepare(`UPDATE telegram_login_challenges SET ${field}=? WHERE code_hash=? AND telegram_id=? AND confirmed_at IS NULL AND cancelled_at IS NULL AND consumed_at IS NULL AND expires_at>?`).bind(now,await sha256(code),telegramId,now).run();
  if(changed.meta.changes!==1)throw unavailable();
}

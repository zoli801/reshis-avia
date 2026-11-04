/** Optional first-party accounts. No email is accepted as proof of ownership. */
import { cookieToken, getUser, isTelegramRequest, issueWebsiteSession, WEB_SESSION_COOKIE, type User } from "./auth.ts";
import { consumeAuthRateLimit } from "./auth-rate-limit.ts";
import type { AppEnv, UserRecord } from "./db.ts";
import { hashPassword, validateNewPassword, verifyPassword } from "./passwords.ts";
import { assertSameOrigin, PublicError, readLimitedText, safeError, unixNow } from "./security.ts";

interface Credentials {user_id:string;username:string;password_hash:string;created_at:number;updated_at:number;}

async function payload(request:Request,allowed:string[]):Promise<Record<string,unknown>> {
  if(request.method!=="POST")throw new PublicError(405,"Используйте POST для входа или регистрации.");
  assertSameOrigin(request);
  if(isTelegramRequest(request))throw new PublicError(400,"Вход по логину доступен на отдельном сайте. Mini App использует Telegram.");
  let value:unknown;
  try{value=JSON.parse(await readLimitedText(request,8192));}catch(error){if(error instanceof PublicError)throw error;throw new PublicError(422,"Проверьте формат данных входа.");}
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new PublicError(422,"Проверьте поля формы входа.");
  const body=value as Record<string,unknown>;
  if(body.import_guest!==undefined&&typeof body.import_guest!=="boolean")throw new PublicError(422,"Подтвердите перенос гостевых решений.");
  return body;
}

export function normalizeUsername(value:unknown):string {
  if(typeof value!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(value.trim()))throw new PublicError(422,"Логин: от 3 до 32 латинских букв, цифр, точек, дефисов или подчёркиваний.");
  return value.trim().toLowerCase();
}

function loginPassword(value:unknown):string {
  if(typeof value!=="string"||value.length===0||[...value].length>128||new TextEncoder().encode(value).byteLength>512)throw new PublicError(422,"Введите логин и пароль.");
  return value;
}

async function adoptableGuest(request:Request,db:D1Database):Promise<User|null> {
  // Resolve only the existing browser cookie: ambient ChatGPT identity cannot
  // make a new unverified password account an owner or merge it implicitly.
  const headers=new Headers(request.headers);
  for(const key of ["oai-authenticated-user-id","oai-authenticated-user-email","oai-authenticated-user-full-name"])headers.delete(key);
  const user=await getUser(new Request(request.url,{headers}),db,{});
  return user?.auth_provider==="guest"&&user.role==="analyst"&&!user.openai_id&&!user.telegram_id&&!user.username?user:null;
}

async function throttle(request:Request,db:D1Database,action:string,username:string):Promise<void> {
  await consumeAuthRateLimit(request,db,`accounts:${action}:network`,undefined,{limit:action==="register"?10:60,seconds:action==="register"?3600:900});
  await consumeAuthRateLimit(request,db,`accounts:${action}:username`,username,{limit:action==="register"?6:15,seconds:900});
}

export async function authRegister(request:Request,db:D1Database,env:Partial<AppEnv>):Promise<Response> {
  try{
    const body=await payload(request,["username","password","name","import_guest"]),username=normalizeUsername(body.username),password=validateNewPassword(body.password);
    const name=body.name===undefined?username:typeof body.name==="string"?body.name.trim():"";
    if(!name||[...name].length>80||/[\u0000-\u001f\u007f]/.test(name))throw new PublicError(422,"Имя должно содержать от 1 до 80 символов.");
    await throttle(request,db,"register",username);
    // Still hash before returning a duplicate-name result; no password is logged.
    const passwordHash=await hashPassword(password,env);
    if(await db.prepare("SELECT user_id FROM auth_accounts WHERE username=?").bind(username).first())throw new PublicError(409,"Этот логин уже занят. Выберите другой.");
    const guest=body.import_guest===true?await adoptableGuest(request,db):null,id=guest?.id??crypto.randomUUID(),current=unixNow();
    const statements:D1PreparedStatement[]=[];
    if(guest)statements.push(db.prepare("UPDATE users SET name=? WHERE id=?").bind(name,id),db.prepare("DELETE FROM sessions WHERE user_id=?").bind(id));
    else statements.push(db.prepare("INSERT INTO users(id,email,name,role,telegram_id,chat_id,openai_id,created_at) VALUES(?,NULL,?,'analyst',NULL,NULL,NULL,?)").bind(id,name,current));
    statements.push(db.prepare("INSERT INTO auth_accounts(user_id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)").bind(id,username,passwordHash,current,current));
    try{await db.batch(statements);}catch(error){if(await db.prepare("SELECT user_id FROM auth_accounts WHERE username=?").bind(username).first())throw new PublicError(409,"Этот логин уже занят. Выберите другой.");throw error;}
    const user=await db.prepare("SELECT users.*,auth_accounts.username FROM users JOIN auth_accounts ON auth_accounts.user_id=users.id WHERE users.id=?").bind(id).first<UserRecord>();
    if(!user)throw new PublicError(503,"Не удалось создать аккаунт. Повторите попытку.");
    // New credentials always get a fresh opaque session, including guest upgrades.
    return await issueWebsiteSession(user,db,"password",{replaceToken:cookieToken(request,WEB_SESSION_COOKIE)??undefined,status:201,expectedPasswordHash:passwordHash});
  }catch(error){return safeError(error);}
}

export async function authLogin(request:Request,db:D1Database,env:Partial<AppEnv>):Promise<Response> {
  try{
    const body=await payload(request,["username","password","import_guest"]),username=normalizeUsername(body.username),password=loginPassword(body.password);
    await throttle(request,db,"login",username);
    const account=await db.prepare("SELECT * FROM auth_accounts WHERE username=?").bind(username).first<Credentials>();
    if(!await verifyPassword(password,account?.password_hash??null,env)||!account)throw new PublicError(401,"Неверный логин или пароль.");
    const user=await db.prepare("SELECT users.*,auth_accounts.username FROM users JOIN auth_accounts ON auth_accounts.user_id=users.id WHERE users.id=?").bind(account.user_id).first<UserRecord>();
    if(!user)throw new PublicError(401,"Неверный логин или пароль.");
    const guest=body.import_guest===true?await adoptableGuest(request,db):null;
    if(guest&&guest.id!==user.id)await db.batch([
      db.prepare("UPDATE scenarios SET owner_id=? WHERE owner_id=?").bind(user.id,guest.id),
      db.prepare("DELETE FROM sessions WHERE user_id=?").bind(guest.id),
    ]);
    return await issueWebsiteSession(user,db,"password",{replaceToken:cookieToken(request,WEB_SESSION_COOKIE)??undefined,expectedPasswordHash:account.password_hash});
  }catch(error){return safeError(error);}
}

export async function changePassword(request:Request,db:D1Database,env:Partial<AppEnv>):Promise<Response> {
  try{
    const body=await payload(request,["current_password","new_password"]),currentPassword=loginPassword(body.current_password),nextPassword=validateNewPassword(body.new_password);
    const user=await getUser(request,db,env);
    if(!user||user.auth_provider!=="password")throw new PublicError(401,"Для смены пароля войдите по логину и паролю.");
    await consumeAuthRateLimit(request,db,"accounts:change-password",user.id,{limit:10,seconds:900});
    const account=await db.prepare("SELECT * FROM auth_accounts WHERE user_id=?").bind(user.id).first<Credentials>();
    if(!account||!await verifyPassword(currentPassword,account.password_hash,env))throw new PublicError(401,"Текущий пароль указан неверно.");
    if(currentPassword===nextPassword)throw new PublicError(422,"Новый пароль должен отличаться от текущего.");
    const passwordHash=await hashPassword(nextPassword,env);
    return await issueWebsiteSession(user,db,"password",{expectedPasswordHash:passwordHash,changeFromHash:account.password_hash});
  }catch(error){return safeError(error);}
}

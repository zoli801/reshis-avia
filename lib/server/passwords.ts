/** Server-only password hashing. Workers supports at most 100,000 PBKDF2 iterations. */
import type { AppEnv } from "./db.ts";
import { constantTimeEqual, encode, fromHex, hmac, PublicError, randomToken, toHex } from "./security.ts";

const ITERATIONS=100_000;
const FORMAT="pbkdf2-sha256-hmac-v1";
const DUMMY_SALT="0".repeat(64);

function pepper(env:Partial<AppEnv>):string {
  const value=env.PASSWORD_PEPPER;
  if(typeof value!=="string"||value.length<32)throw new PublicError(503,"Вход по паролю временно недоступен. Используйте ChatGPT или Telegram.");
  return value;
}

export function validateNewPassword(value:unknown):string {
  if(typeof value!=="string"||[...value].length<12||[...value].length>128||encode(value).byteLength>512)throw new PublicError(422,"Пароль должен содержать от 12 до 128 символов.");
  return value;
}

async function digest(password:string,salt:string,secret:string):Promise<string> {
  const key=await crypto.subtle.importKey("raw",encode(password),"PBKDF2",false,["deriveBits"]);
  const derived=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:fromHex(salt) as BufferSource,iterations:ITERATIONS},key,256);
  // A database dump alone must not be sufficient to test password guesses.
  return toHex(await hmac(encode(secret),`${FORMAT}:${salt}:${toHex(derived)}`));
}

export async function hashPassword(password:string,env:Partial<AppEnv>):Promise<string> {
  validateNewPassword(password);
  const secret=pepper(env),salt=randomToken(32);
  return `${FORMAT}$${ITERATIONS}$${salt}$${await digest(password,salt,secret)}`;
}

export async function verifyPassword(password:string,stored:string|null,env:Partial<AppEnv>):Promise<boolean> {
  const secret=pepper(env),parts=stored?.split("$")??[];
  const valid=parts.length===4&&parts[0]===FORMAT&&parts[1]===String(ITERATIONS)&&/^[a-f0-9]{64}$/.test(parts[2])&&/^[a-f0-9]{64}$/.test(parts[3]);
  // Missing users incur the same expensive KDF as known users.
  const computed=await digest(password,valid?parts[2]:DUMMY_SALT,secret);
  return await constantTimeEqual(computed,valid?parts[3]:"0".repeat(64))&&valid;
}

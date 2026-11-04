export type Role = "analyst"|"manager"|"admin";
export interface UserRecord { id:string; email:string|null; name:string; role:Role; telegram_id:number|null; chat_id:number|null; openai_id:string|null; created_at:number; username?:string|null; }
export interface AppEnv { DB:D1Database; BUCKET?:R2Bucket; BOT_TOKEN?:string; BOT_USERNAME?:string; BOT_ID?:string; BOT_INTERNAL_SECRET?:string; TELEGRAM_WEBHOOK_SECRET?:string; SITE_OWNER_EMAIL?:string; ADMIN_EMAIL?:string; ADMIN_TELEGRAM_ID?:string; PASSWORD_PEPPER?:string; [key:string]:unknown; }
export const now = ()=>Math.floor(Date.now()/1000);
export const iso = (value:number)=>new Date(value*1000).toISOString();
export async function first<T>(db:D1Database,sql:string,...values:unknown[]):Promise<T|null>{return db.prepare(sql).bind(...values).first<T>();}
export async function all<T>(db:D1Database,sql:string,...values:unknown[]):Promise<T[]>{return (await db.prepare(sql).bind(...values).all<T>()).results;}
export async function run(db:D1Database,sql:string,...values:unknown[]){return db.prepare(sql).bind(...values).run();}
export function json<T>(value:string):T{return JSON.parse(value) as T;}
export async function audit(db:D1Database,user:Pick<UserRecord,"id">|null,action:string,details:Record<string,unknown>={}){
  await run(db,"INSERT INTO audit_events(id,user_id,action,details_json,created_at) VALUES(?,?,?,?,?)",crypto.randomUUID(),user?.id??null,action,JSON.stringify(details),now());
}

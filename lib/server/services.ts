import { z, ZodError } from "zod";
import { classify, DataError, evaluate, type Forecast, type ForecastRow, type RouteInfo, type SeedDataset } from "../aviation/domain.ts";
import { datasetHash, exportRoutesCsv, exportScenarioCsv, parseForecast, parseRoutes, sha256 } from "../aviation/csv.ts";
import { renderReport } from "../aviation/reports.ts";
import { seedData } from "../aviation/seed.ts";
import { analyzeRoute } from "../aviation/analytics.ts";
import { all, audit, first, iso, json, now, run, type AppEnv, type UserRecord } from "./db.ts";
import { authChatGPT, authTelegram, ensureGuestSession, getUser, publicUser, signOut } from "./auth.ts";
import { authLogin, authRegister, changePassword } from "./accounts.ts";
import { cancelTelegramWebsiteLogin, pollTelegramWebsiteLogin, startTelegramWebsiteLogin } from "./telegram-login.ts";
import { requestLanguage, translateApiError } from "../aviation/language.ts";
import { assertSameOrigin, constantTimeEqual, PublicError, randomToken } from "./security.ts";

interface DatasetRow { id:string;filename:string;imported_at:number;active:number;sha256:string;rows_json:string;routes_json:string;warnings_json:string;raw_key:string|null;routes_raw_key:string|null; }
interface Dataset extends SeedDataset { imported_at:string; warnings:string[]; active:boolean; }
interface ScenarioRow { id:string;owner_id:string;title:string;note:string;route:string;date:string;price:number;status:"draft"|"review"|"approved";dataset_id:string;result_json:string;alternatives_json:string;history_json:string;created_at:number;updated_at:number; }
export interface Scenario { id:string;owner_id:string;title:string;note:string;route:string;date:string;price:number;status:"draft"|"review"|"approved";dataset_id:string;result:Forecast;alternatives:number[];history:Record<string,unknown>[];created_at:string;updated_at:string; }
export interface Preferences {enabled:boolean;digest_enabled:boolean;digest_hour:number;quiet_start:number;quiet_end:number;timezone:string;routes:string[];change_threshold:number;}
interface PreferenceRow {user_id:string;settings_json:string;last_digest_date:string|null;}
interface DeliveryRow {id:string;user_id:string;chat_id:number;text:string;scenario_id:string|null;kind:string;created_at:number;sent_at:number|null;claimed_until:number;attempts:number;}
const warnings=["Учебный прогноз из CSV. Фактические бронирования и текущие цены авиакомпаний не подключены."];
export const defaultPreferences:Preferences={enabled:false,digest_enabled:false,digest_hour:9,quiet_start:22,quiet_end:8,timezone:"Asia/Novosibirsk",routes:[],change_threshold:5};
const forecastSchema=z.object({route:z.string().trim().min(1).max(40),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),price:z.number().finite().min(0).max(1e9),capacity:z.number().int().positive().max(1e6).nullable().optional(),demand_multiplier:z.number().finite().positive().max(10).default(1)}).strict();
const scenarioSchema=forecastSchema.extend({title:z.string().trim().min(1).max(150),note:z.string().max(5000).default(""),alternatives:z.array(z.number().finite().min(0).max(1e9)).max(5).default([])});
const patchSchema=z.object({title:z.string().trim().min(1).max(150).optional(),note:z.string().max(5000).optional(),status:z.enum(["draft","review","approved"]).optional()}).strict();
const preferenceSchema=z.object({enabled:z.boolean().default(false),digest_enabled:z.boolean().default(false),digest_hour:z.number().int().min(0).max(23).default(9),quiet_start:z.number().int().min(0).max(23).default(22),quiet_end:z.number().int().min(0).max(23).default(8),timezone:z.string().max(80).default("Asia/Novosibirsk"),routes:z.array(z.string().max(40)).max(100).default([]),change_threshold:z.number().finite().min(.1).max(100).default(5)}).strict();
const userView=(u:UserRecord&{auth_provider?:"guest"|"telegram"|"chatgpt"|"password"})=>publicUser(u,u.auth_provider??(u.username?"password":u.openai_id?"chatgpt":u.telegram_id!==null?"telegram":"guest"));
const scenarioView=(s:ScenarioRow):Scenario=>({id:s.id,owner_id:s.owner_id,title:s.title,note:s.note,route:s.route,date:s.date,price:s.price,status:s.status,dataset_id:s.dataset_id,result:json<Forecast>(s.result_json),alternatives:json<number[]>(s.alternatives_json),history:json<Record<string,unknown>[]>(s.history_json),created_at:iso(s.created_at),updated_at:iso(s.updated_at)});
function decodeDataset(row:DatasetRow):Dataset {const rows=json<ForecastRow[]>(row.rows_json),dates=rows.map(r=>r.date).sort();return {id:row.id,filename:row.filename,sha256:row.sha256,rows,routes:json<RouteInfo[]>(row.routes_json),imported_at:iso(row.imported_at),start_date:dates[0],end_date:dates.at(-1)!,warnings:json<string[]>(row.warnings_json),active:!!row.active};}
export function passport(d:Dataset){return {id:d.id,filename:d.filename,sha256:d.sha256,imported_at:d.imported_at,start_date:d.start_date,end_date:d.end_date,rows:d.rows.length,route_count:new Set(d.rows.map(r=>r.route)).size,warnings:d.warnings,active:d.active};}
function requireUser(user:UserRecord|null):UserRecord{if(!user)throw new PublicError(401,"Не удалось определить сеанс. Обновите страницу сайта или заново откройте Mini App.");return user;}
function requireAdmin(user:UserRecord|null):UserRecord{const u=requireUser(user);if(u.role!=="admin")throw new PublicError(403,"Действие доступно администратору.");return u;}
async function body(request:Request):Promise<unknown>{
  // The public calculator must not allocate an unbounded JSON body, including
  // requests without a trustworthy Content-Length header.
  const reader=request.body?.getReader();if(!reader)throw new PublicError(422,"Проверьте формат отправленных данных.");
  const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>65536){await reader.cancel();throw new PublicError(413,"Данные запроса слишком велики.");}chunks.push(item.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw new PublicError(422,"Проверьте формат отправленных данных.");}
}
function response(value:unknown,status=200){return Response.json(value,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});}

export async function ensureSeed(env:AppEnv){
  await run(env.DB,"INSERT OR IGNORE INTO datasets(id,filename,imported_at,active,sha256,rows_json,routes_json,warnings_json) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM datasets)",seedData.id,seedData.filename,now(),1,seedData.sha256,JSON.stringify(seedData.rows),JSON.stringify(seedData.routes),JSON.stringify(warnings));
}
export async function activeDataset(env:AppEnv):Promise<Dataset>{
  let row=await first<DatasetRow>(env.DB,"SELECT * FROM datasets WHERE active=1 ORDER BY imported_at DESC,id DESC LIMIT 1");
  if(!row){await ensureSeed(env);row=await first<DatasetRow>(env.DB,"SELECT * FROM datasets WHERE active=1 ORDER BY imported_at DESC,id DESC LIMIT 1");}
  if(!row)throw new PublicError(503,"Прогноз ещё не загружен. Обратитесь к администратору.");return decodeDataset(row);
}
function calculate(dataset:Dataset,input:z.infer<typeof forecastSchema>):Forecast{
  const row=dataset.rows.find(r=>r.route===input.route&&r.date===input.date),info=dataset.routes.find(r=>r.route===input.route);
  if(!row||!info)throw new PublicError(404,"Для этого направления и даты нет прогноза. Выберите доступную дату.");
  return evaluate(row,info,input.price,dataset.id,input.capacity,input.demand_multiplier);
}
async function scenarioAccess(env:AppEnv,id:string,user:UserRecord):Promise<ScenarioRow>{const row=await first<ScenarioRow>(env.DB,"SELECT * FROM scenarios WHERE id=?",id);if(!row||(row.owner_id!==user.id&&!['manager','admin'].includes(user.role)))throw new PublicError(404,"Сценарий не найден или недоступен.");return row;}
async function preference(env:AppEnv,user:Pick<UserRecord,"id">):Promise<Preferences>{const row=await first<PreferenceRow>(env.DB,"SELECT * FROM notification_preferences WHERE user_id=?",user.id);return row?{...defaultPreferences,...json<Preferences>(row.settings_json)}:{...defaultPreferences,routes:[]};}
async function telegramUser(env:AppEnv,id:number):Promise<UserRecord>{const user=await first<UserRecord>(env.DB,"SELECT * FROM users WHERE telegram_id=?",id);if(!user)throw new PublicError(404,"Отправьте боту /start, затем повторите действие.");return user;}

export function createServices(env:AppEnv){return {
  async meta():Promise<Record<string,unknown>> {const d=await activeDataset(env);return {app_name:"Решись Авиа",routes:d.routes,dates:[...new Set(d.rows.map(r=>r.date))].sort(),dataset:passport(d),bot_username:String(env.BOT_USERNAME||"CU_AviGo_app").replace(/^@/,""),telegram_enabled:!!env.BOT_ID,auth_methods:["guest","password","chatgpt","telegram"],registration_required:false};},
  async forecast(input:{route:string;date:string;price:number}):Promise<Forecast&Record<string,unknown>> {return {...calculate(await activeDataset(env),forecastSchema.parse(input))};},
  async link(input:{code:string;telegram_id:number;chat_id:number;name:string}){return linkTelegram(env,input);},
  async scenarios(telegramId:number):Promise<{items:Record<string,unknown>[]}>{const user=await telegramUser(env,telegramId);return {items:(await all<ScenarioRow>(env.DB,"SELECT * FROM scenarios WHERE owner_id=? ORDER BY created_at DESC LIMIT 20",user.id)).map(s=>({...scenarioView(s)}))};},
  async digest(telegramId:number):Promise<{text:string}>{return {text:await digestText(env,await telegramUser(env,telegramId))};},
  async unsubscribe(telegramId:number){const user=await telegramUser(env,telegramId),settings=await preference(env,user);await env.DB.batch([env.DB.prepare("INSERT INTO notification_preferences(user_id,settings_json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json").bind(user.id,JSON.stringify({...settings,enabled:false,digest_enabled:false})),env.DB.prepare("DELETE FROM deliveries WHERE user_id=? AND sent_at IS NULL").bind(user.id)]);await audit(env.DB,user,"Отключены уведомления через бота");return {ok:true,text:"Уведомления отключены. Включить их снова можно в профиле приложения."};},
};}

export async function linkTelegram(env:AppEnv,input:{code:string;telegram_id:number;chat_id:number;name:string}){
  const valid=z.object({code:z.string().min(8).max(128),telegram_id:z.number().int().positive().safe(),chat_id:z.number().int().safe(),name:z.string().max(100)}).parse(input);
  const hash=await sha256(valid.code),link=await first<{user_id:string;expires_at:number}>(env.DB,"SELECT * FROM telegram_link_codes WHERE code_hash=?",hash);
  if(!link||link.expires_at<=now())throw new PublicError(400,"Ссылка устарела или уже использована. Получите новую в профиле.");
  const owner=await first<UserRecord>(env.DB,"SELECT * FROM users WHERE id=?",link.user_id);if(!owner)throw new PublicError(404,"Аккаунт не найден.");
  if(owner.telegram_id&&owner.telegram_id!==valid.telegram_id)throw new PublicError(409,"К этому аккаунту уже привязан другой Telegram.");
  const attached=await first<UserRecord>(env.DB,"SELECT * FROM users WHERE telegram_id=? AND id<>?",valid.telegram_id,owner.id);
  if(attached&&(attached.openai_id||attached.email||attached.role!=="analyst"||await first(env.DB,"SELECT user_id FROM auth_accounts WHERE user_id=?",attached.id)))throw new PublicError(409,"Этот Telegram уже связан с другим аккаунтом. Войдите в него перед связыванием.");
  // D1 batch is a transaction. The conditional single-use claim is established
  // before merging identities; the consumed marker remains until expiry cleanup.
  const claim=await run(env.DB,"UPDATE telegram_link_codes SET expires_at=0 WHERE code_hash=? AND expires_at>?",hash,now());
  if(!claim.meta.changes)throw new PublicError(400,"Ссылка уже использована.");
  const statements:D1PreparedStatement[]=[];
  if(attached){
    statements.push(env.DB.prepare("UPDATE scenarios SET owner_id=? WHERE owner_id=?").bind(owner.id,attached.id),env.DB.prepare("UPDATE deliveries SET user_id=? WHERE user_id=?").bind(owner.id,attached.id),env.DB.prepare("INSERT OR IGNORE INTO notification_preferences(user_id,settings_json,last_digest_date) SELECT ?,settings_json,last_digest_date FROM notification_preferences WHERE user_id=?").bind(owner.id,attached.id),env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(attached.id),env.DB.prepare("DELETE FROM telegram_link_codes WHERE user_id=?").bind(attached.id),env.DB.prepare("DELETE FROM notification_preferences WHERE user_id=?").bind(attached.id),env.DB.prepare("DELETE FROM users WHERE id=?").bind(attached.id));
  }
  statements.push(env.DB.prepare("UPDATE users SET telegram_id=?,chat_id=? WHERE id=?").bind(valid.telegram_id,valid.chat_id,owner.id));
  await env.DB.batch(statements);await audit(env.DB,owner,"Связан Telegram");
  return {user:userView({...owner,telegram_id:valid.telegram_id,chat_id:valid.chat_id}),text:"Аккаунт связан. Сохранённые сценарии доступны в Telegram."};
}

export async function digestText(env:AppEnv,user:UserRecord,route?:string){
  const dataset=await activeDataset(env),settings=await preference(env,user),selected=route?[route]:settings.routes;
  if(route&&!dataset.routes.some(r=>r.route===route))throw new PublicError(404,"Направление не найдено.");
  const rows=dataset.rows.filter(r=>!selected.length||selected.includes(r.route));
  const results=rows.map(row=>evaluate(row,dataset.routes.find(r=>r.route===row.route)!,dataset.routes.find(r=>r.route===row.route)!.base_price,dataset.id));
  const count=await first<{n:number}>(env.DB,"SELECT count(*) AS n FROM scenarios WHERE owner_id=?",user.id);
  return `Решись Авиа · сводка учебного прогноза\nПериод: ${dataset.start_date} — ${dataset.end_date}.\nНаправлений-дней: ${rows.length}. Дефицит мест по медиане: ${results.filter(r=>r.demand>r.capacity).length}. Загрузка ниже 65%: ${results.filter(r=>r.load_factor<.65).length}.\nВаших сохранённых сценариев: ${count?.n??0}.\nДанные фиксированы в CSV; это не текущие бронирования.`;
}
export function localTime(timezone:string,date=new Date()):{day:string;hour:number}{const parts=new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(date);const part=(name:string)=>parts.find(p=>p.type===name)?.value||"";return {day:`${part('year')}-${part('month')}-${part('day')}`,hour:Number(part('hour'))};}
export function inQuietHours(settings:Preferences,hour:number){const start=settings.quiet_start,end=settings.quiet_end;return start<end?hour>=start&&hour<end:start>end?hour>=start||hour<end:false;}
export async function queueDigests(env:AppEnv){
  const rows=await all<PreferenceRow&UserRecord>(env.DB,"SELECT p.user_id,p.settings_json,p.last_digest_date,u.* FROM notification_preferences p JOIN users u ON u.id=p.user_id WHERE u.chat_id IS NOT NULL AND json_extract(p.settings_json,'$.digest_enabled')=1 ORDER BY COALESCE(p.last_digest_date,''),p.user_id LIMIT 100");let queued=0;
  for(const row of rows){const settings={...defaultPreferences,...json<Preferences>(row.settings_json)};if(!settings.digest_enabled)continue;const local=localTime(settings.timezone);if(local.hour<settings.digest_hour||inQuietHours(settings,local.hour)||row.last_digest_date===local.day)continue;
    const key=await sha256(`digest:${row.id}:${local.day}`),text=await digestText(env,row);
    const results=await env.DB.batch([env.DB.prepare("INSERT OR IGNORE INTO deliveries(id,user_id,chat_id,text,kind,created_at) VALUES(?,?,?,?,?,?)").bind(key,row.id,row.chat_id,text,"digest",now()),env.DB.prepare("UPDATE notification_preferences SET last_digest_date=? WHERE user_id=?").bind(local.day,row.id)]);queued+=Number(results[0].meta.changes||0);
  }return queued;
}
async function queueChanges(env:AppEnv,before:Dataset,after:Dataset){
  const saved=await all<ScenarioRow&{chat_id:number;settings_json:string}>(env.DB,"SELECT s.*,u.chat_id,p.settings_json FROM scenarios s JOIN users u ON s.owner_id=u.id JOIN notification_preferences p ON p.user_id=u.id WHERE u.chat_id IS NOT NULL LIMIT 500");
  const statements:D1PreparedStatement[]=[];
  for(const s of saved){const settings={...defaultPreferences,...json<Preferences>(s.settings_json)};if(!settings.enabled||(settings.routes.length&&!settings.routes.includes(s.route)))continue;const snapshot=json<Forecast>(s.result_json),input=forecastSchema.parse({route:s.route,date:s.date,price:s.price,capacity:snapshot.capacity_override,demand_multiplier:snapshot.demand_multiplier??1});
    let oldResult:Forecast,newResult:Forecast;try{oldResult=calculate(before,input);newResult=calculate(after,input);}catch{continue;}
    const delta=(newResult.load_factor-oldResult.load_factor)*100;if(Math.abs(delta)+1e-9<settings.change_threshold)continue;
    const key=await sha256(`change:${after.id}:${s.id}:${s.owner_id}`),text=`Обновился учебный прогноз: ${s.title}\n${s.route}, ${s.date}. Загрузка при цене ${s.price.toLocaleString('ru-RU')} ₽: ${(oldResult.load_factor*100).toFixed(1)}% → ${(newResult.load_factor*100).toFixed(1)}% (${delta>=0?'+':''}${delta.toFixed(1)} п.п.).\nСохранённый сценарий остался в прежней версии. Откройте приложение для сравнения.`;
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO deliveries(id,user_id,chat_id,text,scenario_id,kind,created_at) VALUES(?,?,?,?,?,?,?)").bind(key,s.owner_id,s.chat_id,text,s.id,"change",now()));
    if(statements.length===50)await env.DB.batch(statements.splice(0));
  }if(statements.length)await env.DB.batch(statements);
}

async function importDataset(env:AppEnv,request:Request,user:UserRecord){
  const form=await request.formData(),forecast=form.get("forecast"),routesFile=form.get("routes");
  if(!(forecast instanceof File))throw new PublicError(422,"Выберите CSV-файл прогноза.");
  if(forecast.size>10*1024*1024||(routesFile instanceof File&&routesFile.size>10*1024*1024))throw new PublicError(413,"Размер одного файла не должен превышать 10 МБ.");
  const before=await activeDataset(env),forecastRaw=await forecast.text(),routesRaw=routesFile instanceof File&&routesFile.size?await routesFile.text():exportRoutesCsv(before.routes);
  const routes=parseRoutes(routesRaw),rows=parseForecast(forecastRaw,routes),rowsJson=JSON.stringify(rows),routesJson=JSON.stringify(routes);
  if(new TextEncoder().encode(rowsJson).length+new TextEncoder().encode(routesJson).length>1_800_000)throw new PublicError(413,"Для демонстрационной базы объём разобранного прогноза должен быть меньше 1,8 МБ.");
  if(JSON.stringify(before.rows)===rowsJson&&JSON.stringify(before.routes)===routesJson)return {dataset:passport(before),changed:false};
  const id=await datasetHash(forecastRaw,routesRaw),hash=await sha256(forecastRaw),existing=await first<DatasetRow>(env.DB,"SELECT * FROM datasets WHERE id=?",id),rawKey=`datasets/${id}/forecast.csv`,routesKey=`datasets/${id}/routes.csv`;
  if(!env.BUCKET)throw new PublicError(503,"Архив данных временно недоступен. Повторите импорт позже.");
  await Promise.all([env.BUCKET.put(rawKey,forecastRaw,{onlyIf:{etagDoesNotMatch:"*"},httpMetadata:{contentType:"text/csv; charset=utf-8"}}),env.BUCKET.put(routesKey,routesRaw,{onlyIf:{etagDoesNotMatch:"*"},httpMetadata:{contentType:"text/csv; charset=utf-8"}})]);
  const filename=forecast.name.split(/[\\/]/).at(-1)!.slice(0,255)||"forecast.csv",timestamp=now();
  await env.DB.batch([env.DB.prepare("UPDATE datasets SET active=0 WHERE active=1"),env.DB.prepare("INSERT INTO datasets(id,filename,imported_at,active,sha256,rows_json,routes_json,warnings_json,raw_key,routes_raw_key) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=1").bind(id,existing?.filename??filename,existing?.imported_at??timestamp,1,hash,rowsJson,routesJson,JSON.stringify(warnings),rawKey,routesKey)]);
  const after=decodeDataset((await first<DatasetRow>(env.DB,"SELECT * FROM datasets WHERE id=?",id))!);
  await audit(env.DB,user,existing?"Возвращена версия прогноза":"Загружена версия прогноза",{dataset_id:id,rows:rows.length});await queueChanges(env,before,after);return {dataset:passport(after),changed:true};
}

async function botAuthorized(request:Request,env:AppEnv){const expected=String(env.BOT_INTERNAL_SECRET||""),supplied=request.headers.get("x-bot-secret")||"";if(expected.length<24||!supplied||!await constantTimeEqual(expected,supplied))throw new PublicError(403,"Служебный доступ запрещён.");}

export async function handleApi(request:Request,path:string,env:AppEnv,providedUser?:UserRecord|null):Promise<Response>{
  const result=await dispatchApi(request,path,env,providedUser);
  if(requestLanguage(request)!=="en")return result;
  const headers=new Headers(result.headers);headers.set("Content-Language","en");headers.set("Vary","Accept-Language");
  if(result.status>=400&&result.headers.get("Content-Type")?.includes("application/json")){
    const data=await result.json() as {detail?:unknown};
    if(typeof data.detail==="string")data.detail=translateApiError(data.detail);
    return Response.json(data,{status:result.status,headers});
  }
  return new Response(result.body,{status:result.status,headers});
}

async function dispatchApi(request:Request,path:string,env:AppEnv,providedUser?:UserRecord|null):Promise<Response>{
  try{
    if(!env.DB)throw new PublicError(503,"База данных временно недоступна.");
    const method=request.method,url=new URL(request.url);path=path.replace(/^\/+|\/+$/g,"");
    const contentLength=Number(request.headers.get("content-length")||0);if(Number.isFinite(contentLength)&&contentLength>22*1024*1024)throw new PublicError(413,"Размер запроса превышает 22 МБ.");
    if(path==="telegram/webhook"){const {handleTelegram}=await import("./telegram.ts");return handleTelegram(request,env,env.DB,createServices(env));}
    const isBot=path.startsWith("bot/");if(isBot)await botAuthorized(request,env);else if(!["GET","HEAD","OPTIONS"].includes(method))assertSameOrigin(request);
    if(path==="auth/guest"){if(method!=="POST")throw new PublicError(405,"Для создания гостевого профиля используйте POST.");return ensureGuestSession(request,env.DB);}
    if(path==="auth/telegram"&&method==="POST")return authTelegram(request,env.DB,env);
    if(path==="auth/telegram/start")return startTelegramWebsiteLogin(request,env.DB,env);
    if(path==="auth/telegram/poll")return pollTelegramWebsiteLogin(request,env.DB,env);
    if(path==="auth/telegram/cancel")return cancelTelegramWebsiteLogin(request,env.DB,env);
    if(path==="auth/register")return authRegister(request,env.DB,env);
    if(path==="auth/login")return authLogin(request,env.DB,env);
    if(path==="auth/password")return changePassword(request,env.DB,env);
    if(path==="auth/chatgpt")return authChatGPT(request,env.DB,env);
    if(path==="auth/logout"&&method==="POST")return signOut(request,env.DB);
    if(path==="health"&&method==="GET"){await first(env.DB,"SELECT 1 AS ok");return response({status:"ok",dataset_loaded:!!await first(env.DB,"SELECT id FROM datasets LIMIT 1"),storage:"cloudflare-d1"});}
    if(path==="meta"&&method==="GET")return response(await createServices(env).meta());
    if(path==="forecast"&&method==="POST")return response(calculate(await activeDataset(env),forecastSchema.parse(await body(request))));
    if(path==="analytics"&&method==="POST"){
      const input=forecastSchema.parse(await body(request)),dataset=await activeDataset(env);
      calculate(dataset,input);
      return response(analyzeRoute(dataset,input));
    }
    if(path==="overview"&&method==="GET"){
      const dataset=await activeDataset(env),route=url.searchParams.get("route");if(route&&!dataset.routes.some(r=>r.route===route))throw new PublicError(404,"Направление не найдено.");
      const items=dataset.rows.filter(r=>!route||r.route===route).map(row=>{const result=evaluate(row,dataset.routes.find(r=>r.route===row.route)!,dataset.routes.find(r=>r.route===row.route)!.base_price,dataset.id),[status,reason]=classify(result);const {price_curve:curve,explanation,...summary}=result;void curve;void explanation;return {...summary,status,reason};});
      const totals={capacity:0,sales:0,empty_seats:0,revenue:0,contribution:0,load_factor:0,count:items.length,deficit_count:0,low_count:0};for(const r of items){for(const key of ['capacity','sales','empty_seats','revenue','contribution'] as const)totals[key]+=r[key];if(r.status==='deficit')totals.deficit_count++;if(r.status==='low')totals.low_count++;}totals.load_factor=totals.capacity?totals.sales/totals.capacity:0;return response({items,totals,dataset_id:dataset.id});
    }
    if(path==="datasets"&&method==="GET"){await ensureSeed(env);return response({items:(await all<DatasetRow>(env.DB,"SELECT * FROM datasets ORDER BY imported_at DESC LIMIT 100")).map(d=>passport(decodeDataset(d)))});}
    if(isBot){const services=createServices(env),id=Number(url.searchParams.get("telegram_id"));
      if(path==="bot/diagnostics"&&method==="GET"){const {telegramRuntimeDiagnostic}=await import("./telegram.ts");return response(await telegramRuntimeDiagnostic(env));}
      if(path==="bot/link"&&method==="POST")return response(await services.link(await body(request) as Parameters<typeof services.link>[0]));
      if(path==="bot/scenarios"&&method==="GET")return response(await services.scenarios(id));
      if(path==="bot/digest"&&method==="GET")return response({text:await digestText(env,await telegramUser(env,id),url.searchParams.get("route")||undefined)});
      if(path==="bot/unsubscribe"&&method==="POST"){const input=z.object({telegram_id:z.number().int().positive()}).parse(await body(request));return response(await services.unsubscribe(input.telegram_id));}
      if(path==="bot/deliveries"&&method==="GET"){await queueDigests(env);return response({items:await pendingDeliveries(env)});}
      const ack=path.match(/^bot\/deliveries\/([^/]+)\/ack$/);if(ack&&method==="POST"){await run(env.DB,"UPDATE deliveries SET sent_at=? WHERE id=?",now(),ack[1]);return response({ok:true});}
      throw new PublicError(404,"Служебный метод не найден.");
    }
    const user=providedUser===undefined?await getUser(request,env.DB,env):providedUser;
    if(path==="auth/me"&&method==="GET")return response({user:user?userView(user):null});
    if(path==="admin/telegram/diagnostics"&&method==="POST"){requireAdmin(user);const {telegramRuntimeDiagnostic}=await import("./telegram.ts");return response(await telegramRuntimeDiagnostic(env));}
    if(path==="auth/telegram/link"&&method==="POST"){const u=requireUser(user),code=randomToken(24),expires=now()+600;await env.DB.batch([env.DB.prepare("DELETE FROM telegram_link_codes WHERE user_id=?").bind(u.id),env.DB.prepare("INSERT INTO telegram_link_codes(code_hash,user_id,expires_at) VALUES(?,?,?)").bind(await sha256(code),u.id,expires)]);return response({code,url:`https://t.me/${String(env.BOT_USERNAME||'CU_AviGo_app').replace(/^@/,'')}?start=link_${code}`,expires_at:iso(expires)});}
    if(path==="scenarios"&&method==="GET"){const u=requireUser(user);return response({items:(await all<ScenarioRow>(env.DB,["manager","admin"].includes(u.role)?"SELECT * FROM scenarios ORDER BY created_at DESC LIMIT 500":"SELECT * FROM scenarios WHERE owner_id=? ORDER BY created_at DESC LIMIT 500",...(["manager","admin"].includes(u.role)?[]:[u.id]))).map(scenarioView)});}
    if(path==="scenarios"&&method==="POST"){
      const u=requireUser(user),input=scenarioSchema.parse(await body(request)),dataset=await activeDataset(env),result=calculate(dataset,input);result.alternative_results=input.alternatives.map(price=>calculate(dataset,{...input,price}));const id=crypto.randomUUID(),timestamp=now(),history=[{at:iso(timestamp),action:"Создан сценарий",by:u.name,status:"draft"}];
      await run(env.DB,"INSERT INTO scenarios(id,owner_id,title,note,route,date,price,status,dataset_id,result_json,alternatives_json,history_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",id,u.id,input.title,input.note,input.route,input.date,input.price,"draft",dataset.id,JSON.stringify(result),JSON.stringify(input.alternatives),JSON.stringify(history),timestamp,timestamp);await audit(env.DB,u,"Сохранён сценарий",{scenario_id:id});return response(scenarioView((await first<ScenarioRow>(env.DB,"SELECT * FROM scenarios WHERE id=?",id))!),201);
    }
    const scenarioPath=path.match(/^scenarios\/([^/]+)(?:\/(export\.csv|report))?$/);
    if(scenarioPath){const u=requireUser(user),item=await scenarioAccess(env,scenarioPath[1],u),suffix=scenarioPath[2];
      if(suffix==="export.csv"&&method==="GET")return new Response(exportScenarioCsv(scenarioView(item),requestLanguage(request)),{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="scenario-${item.id}.csv"`,"Cache-Control":"no-store"}});
      if(suffix==="report"&&method==="GET"){const datasetRow=await first<DatasetRow>(env.DB,"SELECT * FROM datasets WHERE id=?",item.dataset_id);if(!datasetRow)throw new PublicError(404,"Версия исходных данных не найдена.");const prefs=await preference(env,u);return new Response(renderReport(scenarioView(item),decodeDataset(datasetRow),prefs.timezone,requestLanguage(request)),{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});}
      if(suffix)throw new PublicError(405,"Действие не поддерживается.");
      if(method==="GET")return response(scenarioView(item));
      if((method==="PATCH"||method==="DELETE")&&item.status==="approved"&&u.role==="analyst")throw new PublicError(403,"Согласованное решение может изменить руководитель или администратор.");
      if(method==="DELETE"){await run(env.DB,"DELETE FROM scenarios WHERE id=?",item.id);await audit(env.DB,u,"Удалён сценарий",{scenario_id:item.id});return response({ok:true});}
      if(method==="PATCH"){const patch=patchSchema.parse(await body(request));if(patch.status==="approved"&&u.role==="analyst")throw new PublicError(403,"Согласовать решение может руководитель или администратор.");const history=json<Record<string,unknown>[]>(item.history_json);history.push({at:iso(now()),action:"Изменён сценарий",by:u.name,status:patch.status??item.status,fields:Object.keys(patch)});await run(env.DB,"UPDATE scenarios SET title=?,note=?,status=?,history_json=?,updated_at=? WHERE id=?",patch.title??item.title,patch.note??item.note,patch.status??item.status,JSON.stringify(history),now(),item.id);await audit(env.DB,u,"Изменён сценарий",{scenario_id:item.id,fields:Object.keys(patch)});return response(scenarioView((await first<ScenarioRow>(env.DB,"SELECT * FROM scenarios WHERE id=?",item.id))!));}
    }
    if(path==="notifications"&&method==="GET")return response(await preference(env,requireUser(user)));
    if(path==="notifications"&&method==="PUT"){const u=requireUser(user),settings=preferenceSchema.parse(await body(request));try{localTime(settings.timezone);}catch{throw new PublicError(422,"Неизвестный часовой пояс.");}const dataset=await activeDataset(env);if(settings.routes.some(r=>!dataset.routes.some(x=>x.route===r)))throw new PublicError(422,"Выбрано неизвестное направление.");await env.DB.batch([env.DB.prepare("INSERT INTO notification_preferences(user_id,settings_json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json").bind(u.id,JSON.stringify(settings)),env.DB.prepare("DELETE FROM deliveries WHERE user_id=? AND sent_at IS NULL AND ((kind='change' AND ?=0) OR (kind='digest' AND ?=0))").bind(u.id,Number(settings.enabled),Number(settings.digest_enabled))]);await audit(env.DB,u,"Изменены настройки уведомлений");return response(settings);}
    if(path.startsWith("admin/")){const u=requireAdmin(user);
      if(path==="admin/users"&&method==="GET")return response({items:(await all<UserRecord>(env.DB,"SELECT * FROM users ORDER BY created_at LIMIT 500")).map(userView)});
      const rolePath=path.match(/^admin\/users\/([^/]+)$/);if(rolePath&&method==="PATCH"){const {role}=z.object({role:z.enum(['analyst','manager','admin'])}).strict().parse(await body(request));if(rolePath[1]===u.id&&role!=="admin")throw new PublicError(409,"Администратор не может снять собственные права в текущем аккаунте.");if(!await first(env.DB,"SELECT id FROM users WHERE id=?",rolePath[1]))throw new PublicError(404,"Пользователь не найден.");await run(env.DB,"UPDATE users SET role=? WHERE id=?",role,rolePath[1]);await audit(env.DB,u,"Изменена роль пользователя",{target_user_id:rolePath[1],role});return response({user:userView((await first<UserRecord>(env.DB,"SELECT * FROM users WHERE id=?",rolePath[1]))!)});}
      if(path==="admin/import"&&method==="POST")return response(await importDataset(env,request,u));
      if(path==="admin/audit"&&method==="GET")return response({items:(await all<{id:string;user_id:string|null;action:string;details_json:string;created_at:number}>(env.DB,"SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200")).map(a=>({...a,details:json(a.details_json),created_at:iso(a.created_at)}))});
      if(path==="admin/notifications/process"&&method==="POST")return response(await processNotifications(env));
    }
    throw new PublicError(404,"Метод API не найден.");
  }catch(error){if(error instanceof PublicError)return response({detail:error.message},error.status);if(error instanceof DataError)return response({detail:error.message},422);if(error instanceof ZodError)return response({detail:"Проверьте формат и допустимые значения введённых данных.",fields:error.issues.map(i=>i.path.join('.'))},422);console.error("Ошибка API:",error instanceof Error?error.name:"UnknownError");return response({detail:"Сервис временно недоступен. Повторите попытку позже."},500);}
}

export async function pendingDeliveries(env:AppEnv):Promise<DeliveryRow[]>{
  const eligible:DeliveryRow[]=[];let cursorTime=-1,cursorId="";
  // Page past quiet recipients rather than letting the first quiet page block
  // every later user. Work remains bounded for scheduled invocations.
  for(let page=0;page<4&&eligible.length<50;page++){
    const rows=await all<DeliveryRow&{settings_json:string}>(env.DB,"SELECT d.*,p.settings_json FROM deliveries d JOIN notification_preferences p ON p.user_id=d.user_id WHERE d.sent_at IS NULL AND d.claimed_until<=? AND (d.created_at>? OR (d.created_at=? AND d.id>?)) ORDER BY d.created_at,d.id LIMIT 50",now(),cursorTime,cursorTime,cursorId);
    for(const row of rows){const settings={...defaultPreferences,...json<Preferences>(row.settings_json)};if((row.kind==="digest"?settings.digest_enabled:settings.enabled)&&!inQuietHours(settings,localTime(settings.timezone).hour))eligible.push(row);}
    if(rows.length<50)break;const last=rows.at(-1)!;cursorTime=last.created_at;cursorId=last.id;
  }return eligible.slice(0,50);
}
export async function processNotifications(env:AppEnv){
  const deadline=Date.now()+20_000;await ensureSeed(env);const queued=await queueDigests(env);if(!env.BOT_TOKEN)return {queued,sent:0,failed:0,configured:false};
  const rows=(await pendingDeliveries(env)).slice(0,10);let sent=0,failed=0;
  for(const row of rows){if(Date.now()>=deadline)break;const claim=await run(env.DB,"UPDATE deliveries SET claimed_until=?,attempts=attempts+1 WHERE id=? AND sent_at IS NULL AND claimed_until<=?",now()+120,row.id,now());if(!claim.meta.changes)continue;
    try{
      const result=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:row.chat_id,text:row.text.slice(0,3800),disable_web_page_preview:true}),signal:AbortSignal.timeout(Math.max(1,Math.min(8000,deadline-Date.now())))});
      const payload=await result.json() as {ok?:boolean;parameters?:{retry_after?:number}};
      if(result.ok&&payload.ok){await run(env.DB,"UPDATE deliveries SET sent_at=?,claimed_until=0,last_error=NULL WHERE id=?",now(),row.id);sent++;}
      else if(result.status===429){const retry=Math.max(1,Math.min(3600,Number(payload.parameters?.retry_after)||60));await run(env.DB,"UPDATE deliveries SET claimed_until=?,last_error='rate_limit' WHERE id=?",now()+retry,row.id);failed++;}
      else{await run(env.DB,"UPDATE deliveries SET sent_at=?,claimed_until=0,last_error='telegram_rejected' WHERE id=?",now(),row.id);failed++;}
    }catch{ // An uncertain send is not repeated automatically: Telegram has no idempotency key.
      await run(env.DB,"UPDATE deliveries SET sent_at=?,claimed_until=0,last_error='delivery_uncertain' WHERE id=?",now(),row.id);failed++;
    }
  }return {queued,sent,failed,configured:true};
}

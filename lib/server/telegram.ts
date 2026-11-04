/** Hosted Telegram webhook. No browser-accessible token proxy or arbitrary URL. */
import type { AppEnv, UserRecord } from "./db.ts";
import { telegramRole } from "./auth.ts";
import { beginTelegramLoginConfirmation, finishTelegramLoginConfirmation } from "./telegram-login.ts";
import { PublicError, constantTimeEqual, html, readLimitedText, safeAppUrl, safeError, unixNow } from "./security.ts";

type Obj=Record<string,unknown>;
export interface TelegramServices {
  meta():Promise<Obj>;
  forecast(input:{route:string;date:string;price:number}):Promise<Obj>;
  scenarios(telegramId:number):Promise<{items:Obj[]}>;
  digest(telegramId:number):Promise<{text:string}>;
  unsubscribe(telegramId:number):Promise<unknown>;
  link(input:{code:string;telegram_id:number;chat_id:number;name:string}):Promise<unknown>;
}
export interface BotState {state:"route"|"date"|"price"|"idle";data:Obj;updated_at:number;}
type Markup={inline_keyboard:Obj[][]}|{keyboard:Obj[][];resize_keyboard:true};
interface Plan {text:string;markup?:Markup;state?:BotState;}
export type TelegramDiagnosticCode="ok"|"not_configured"|"invalid_button"|"invalid_format"|"chat_not_found"|"forbidden"|"authentication_failed"|"rate_limited"|"telegram_unavailable"|"bad_request"|"api_rejected"|"redirect_rejected"|"transport_uncertain"|"response_uncertain"|"handler_failure"|"fallback_delivered";
export interface TelegramDiagnostic {classification:TelegramDiagnosticCode;http_status:number|null;username:string|null;}
export class TelegramDeliveryError extends Error {
  retryAfter:number;uncertain:boolean;permanent:boolean;classification:TelegramDiagnosticCode;httpStatus:number|null;
  constructor(retryAfter=5,uncertain=false,permanent=false,classification:TelegramDiagnosticCode="api_rejected",httpStatus:number|null=null) {super("Не удалось доставить сообщение Telegram.");this.retryAfter=retryAfter;this.uncertain=uncertain;this.permanent=permanent;this.classification=classification;this.httpStatus=httpStatus;this.name="TelegramDeliveryError";}
}

function configuredToken(env:Pick<AppEnv,"BOT_TOKEN">):boolean {return typeof env.BOT_TOKEN==="string"&&/^\d+:[A-Za-z0-9_-]{20,}$/.test(env.BOT_TOKEN);}
function rejectionCode(status:number,result:Obj):TelegramDiagnosticCode {
  // Raw descriptions stay within this classifier and are never returned or logged.
  const text=typeof result.description==="string"?result.description.toLowerCase():"";
  if(status===429)return "rate_limited";
  if(status===401||status===404)return "authentication_failed";
  if(status===403)return "forbidden";
  if(status>=500)return "telegram_unavailable";
  if(status===400){
    if(/button_(?:url|type)_invalid|web_app|web app|url.*invalid|wrong.*url|https.*url/.test(text))return "invalid_button";
    if(/can't parse entities|cannot parse entities|unsupported start tag|entity.*(?:invalid|parse)/.test(text))return "invalid_format";
    if(/chat not found/.test(text))return "chat_not_found";
    return "bad_request";
  }
  return "api_rejected";
}
function telemetry(stage:"delivery"|"fallback"|"handler",classification:TelegramDiagnosticCode,httpStatus:number|null):void {
  // Only fixed enums and a numeric status cross this boundary. No raw errors,
  // request URL, token, sender/chat identifiers or API descriptions are logged.
  console.warn("Telegram diagnostic",JSON.stringify({stage,classification,http_status:httpStatus}));
}

/** Caller must enforce administrator access. This API has no method/URL inputs. */
export async function telegramRuntimeDiagnostic(env:Pick<AppEnv,"BOT_TOKEN">):Promise<TelegramDiagnostic> {
  if(!configuredToken(env))return {classification:"not_configured",http_status:null,username:null};
  let response:Response;
  // Workers rejects redirect:'error' before network I/O. Manual mode is the
  // supported way to forbid following redirects to another destination.
  try {response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}",redirect:"manual",signal:AbortSignal.timeout(8000)});}
  catch{return {classification:"transport_uncertain",http_status:null,username:null};}
  if(response.status>=300&&response.status<400)return {classification:"redirect_rejected",http_status:response.status,username:null};
  let result:Obj;
  try{result=obj(await response.json());}catch{return {classification:"response_uncertain",http_status:response.status,username:null};}
  if(typeof result.ok!=="boolean")return {classification:"response_uncertain",http_status:response.status,username:null};
  if(!response.ok||result.ok!==true)return {classification:rejectionCode(response.status,result),http_status:response.status,username:null};
  const identity=obj(result.result);
  if(identity.is_bot!==true||typeof identity.username!=="string"||!/^\w{5,32}$/.test(identity.username))return {classification:"response_uncertain",http_status:response.status,username:null};
  return {classification:"ok",http_status:response.status,username:identity.username};
}

export async function sendTelegram(env: Pick<AppEnv,"BOT_TOKEN">, method:"sendMessage"|"answerCallbackQuery", payload:Obj):Promise<unknown> {
  if(method!=="sendMessage"&&method!=="answerCallbackQuery") throw new PublicError(403,"Этот метод Telegram недоступен.");
  if(!configuredToken(env)) throw new PublicError(503,"Бот пока не настроен.");
  let response:Response;
  try {
    response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),redirect:"manual",signal:AbortSignal.timeout(12000),
    });
  } catch {throw new TelegramDeliveryError(5,true,false,"transport_uncertain");}
  if(response.status>=300&&response.status<400)throw new TelegramDeliveryError(5,false,true,"redirect_rejected",response.status);
  let result:Obj={};
  try {result=obj(await response.json());} catch {throw new TelegramDeliveryError(5,true,false,"response_uncertain",response.status);}
  if(typeof result.ok!=="boolean")throw new TelegramDeliveryError(5,true,false,"response_uncertain",response.status);
  if(!response.ok||result.ok!==true) {
    const parameters=obj(result.parameters); const delay=Number(parameters.retry_after);
    throw new TelegramDeliveryError(Number.isFinite(delay)?Math.max(1,Math.min(delay,3600)):5,false,response.status===403||response.status===400,rejectionCode(response.status,result),response.status);
  }
  return result.result;
}
const obj=(value:unknown):Obj=>value&&typeof value==="object"&&!Array.isArray(value)?value as Obj:{};
const list=(value:unknown):Obj[]=>Array.isArray(value)?value.map(obj):[];
const num=(value:unknown,digits=0)=>Number.isFinite(Number(value))?new Intl.NumberFormat("ru-RU",{maximumFractionDigits:digits,minimumFractionDigits:digits}).format(Number(value)):"—";
const displayDate=(value:unknown)=>/^\d{4}-\d{2}-\d{2}$/.test(String(value))?String(value).split("-").reverse().join("."):"—";
const reset=():BotState=>({state:"idle",data:{},updated_at:unixNow()});
function mainKeyboard():Markup {return {keyboard:[[{text:"Открыть мини-приложение"}],[{text:"Быстрый расчёт"},{text:"Мои сценарии"}],[{text:"Сводка"},{text:"Уведомления"}],[{text:"Остановить уведомления"},{text:"Помощь"}]],resize_keyboard:true};}
function appButton(request:Request,env:AppEnv,params:Obj={},text="Открыть мини-приложение"):Markup {
  return {inline_keyboard:[[{text,web_app:{url:safeAppUrl(request,env,params)}}]]};
}
export function welcome(name:string):string {
  return `Здравствуйте${name?", "+html(name):""}!\n\n<b>Я — помощник «Решись Авиа».</b> Помогу оценить спрос и сравнить цены авиабилетов.\n\n<b>Начните с мини-приложения:</b>\n1. Выберите направление и дату.\n2. Укажите цену билета.\n3. Посмотрите прогноз продаж, загрузку и график спроса.\n4. Сравните варианты и сохраните решение.\n\nTelegram узнаёт вас автоматически: пароль и вход через ChatGPT не нужны. Сайт в обычном браузере использует отдельный гостевой профиль. Синхронизация с Telegram доступна по желанию в профиле сайта.\n\nНажмите <b>«Открыть мини-приложение»</b> под сообщением.\n\n/forecast — расчёт прямо в чате без регистрации\n/saved — ваши сценарии\n/help — все команды\n/cancel — отмена ввода\n\nДанные учебные: прогноз не является фактическим наличием билетов.`;
}

function plainText(value:string):string {
  return value.replace(/<\/?[a-z][^>]*>/gi,"").replace(/&(?:amp|lt|gt|quot|#39);/g,part=>({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&#39;":"'"}[part]!));
}
function fallbackMessage(plan:Plan,chatId:unknown):Obj {
  const rows=plan.markup&&"inline_keyboard" in plan.markup?plan.markup.inline_keyboard:[];
  const web=rows.flat().map(button=>obj(button.web_app)).find(button=>typeof button.url==="string");
  const url=typeof web?.url==="string"?web.url:null;
  const text=plainText(plan.text)+(url?"\n\nКнопка мини-приложения временно недоступна. По ссылке ниже откроется сайт с отдельным гостевым профилем.":"");
  return {chat_id:chatId,text,...(url?{reply_markup:{inline_keyboard:[[{text:"Открыть сайт",url}]]}}:{}),disable_web_page_preview:true};
}
function help():string {return "<b>Возможности бота</b>\n/app — мини-приложение\n/forecast — расчёт спроса по маршруту, дате и цене\n/saved — ваши сценарии\n/digest — сводка\n/notifications — настройки уведомлений\n/stop — отключить уведомления\n/cancel — отменить ввод\n/help — справка\n\nБот работает самостоятельно. Telegram определяется по проверенной подписи. Сценарии Telegram и гостевого браузера хранятся отдельно: привязка для работы не нужна. Спрос — желание купить билет, продажи ограничены вместимостью. Непроданные места — прогноз, а не остаток в системе бронирования.";}

export function formatForecast(result:Obj,route:string,date:string,price:number):string {
  const qs=list(result.quantiles),low=qs.find(x=>Number(x.q)===.1),high=qs.find(x=>Number(x.q)===.9);
  return `<b>Расчёт спроса</b>\n${html(route)} · ${displayDate(date)}\nЦена: <b>${num(price,2)} ₽</b>\n\nВместимость: ${num(result.capacity)} мест\n${Number(result.demand)<0?"Оценка модели (медиана)":"Спрос, медиана"}: ${num(result.demand,1)} чел.\nПрогноз продаж: <b>${num(result.sales,1)} бил.</b>\nПрогноз непроданных мест: ${num(result.empty_seats,1)}\nМаржинальный доход: ${num(result.contribution,2)} ₽`+
    (low&&high?`\nСпрос P10–P90: ${num(low.demand,1)}–${num(high.demand,1)} чел.`:"")+(Number(result.demand)<0?"\nОтрицательная линейная оценка означает нулевой прогноз покупок.":"")+"\n\nЭто прогноз, а не фактические продажи. Дробные значения — результат модели. Маржинальный доход не включает постоянные расходы рейса.";
}

async function loadState(db:D1Database,telegramId:number):Promise<BotState> {
  const row=await db.prepare("SELECT state,data,updated_at FROM bot_states WHERE telegram_id=?").bind(telegramId).first<{state:BotState["state"];data:string;updated_at:number}>();
  if(!row||unixNow()-row.updated_at>1800) return reset();
  try {return {state:row.state,data:obj(JSON.parse(row.data)),updated_at:row.updated_at};} catch {return reset();}
}
function datesFrom(meta:Obj):string[] {return Array.isArray(meta.dates)?meta.dates.filter((d):d is string=>typeof d==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(d)).sort():[];}
function routesFrom(meta:Obj):Obj[] {return list(meta.routes).filter(x=>/^[A-Z]{3}-[A-Z]{3}$/.test(String(x.route)));}
async function persistPlan(db:D1Database,updateId:number,telegramId:unknown,state?:BotState):Promise<void> {
  const statements=[db.prepare("UPDATE telegram_updates SET status='done',lease_until=0 WHERE update_id=?").bind(updateId)];
  if(state)statements.push(db.prepare("INSERT INTO bot_states(telegram_id,state,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET state=excluded.state,data=excluded.data,updated_at=excluded.updated_at").bind(telegramId,state.state,JSON.stringify(state.data),unixNow()));
  await db.batch(statements);
}

async function makePlan(request:Request,env:AppEnv,db:D1Database,services:TelegramServices,sender:Obj,text:string,callback:string|undefined,current:BotState):Promise<Plan> {
  const id=Number(sender.id); const command=text.split(/\s+/)[0].split("@")[0].toLowerCase();
  if(callback?.startsWith("login_confirm:")||callback?.startsWith("login_cancel:")){
    const approve=callback.startsWith("login_confirm:");
    await finishTelegramLoginConfirmation(db,callback.slice(callback.indexOf(":")+1),id,approve);
    return {text:approve?"Вход подтверждён. Вернитесь в ту вкладку сайта, где начинали вход: она откроет ваш профиль автоматически. Гостевые решения не объединяются с Telegram без отдельного согласия.":"Вход на сайт отменён. Ваш профиль Telegram и мини-приложение продолжают работать отдельно.",state:reset()};
  }
  if(command==="/start") {
    const argument=text.split(/\s+/)[1]??"";
    if(argument.startsWith("login_")){
      const code=argument.slice(6),challenge=await beginTelegramLoginConfirmation(db,code,id);
      const host=new URL(safeAppUrl(request,env)).hostname;
      return {text:`<b>Подтвердите вход на сайт</b>\n${html(host)}\n\nКод проверки: <b>${challenge.verification_code}</b>\n\nСравните код с кодом в своей вкладке сайта. Подтверждайте, только если вы сами начали вход. Вход откроет на сайте ваш профиль Telegram; гостевые решения автоматически не объединяются.\n\nЕсли запрос прислал другой человек или код не совпадает, нажмите «Отменить». Запрос действует не более 5 минут.`,markup:{inline_keyboard:[[{text:"Подтвердить вход",callback_data:"login_confirm:"+code}],[{text:"Отменить",callback_data:"login_cancel:"+code}]]},state:reset()};
    }
    if(argument.startsWith("link_")) {
      const code=argument.slice(5);
      if(!/^[A-Za-z0-9_-]{8,128}$/.test(code)) return {text:"Ссылка привязки недействительна. Получите новую в профиле сайта.",state:reset()};
      await services.link({code,telegram_id:id,chat_id:id,name:[sender.first_name,sender.last_name].filter(x=>typeof x==="string").join(" ").slice(0,200)});
      return {text:"Telegram привязан к вашему аккаунту. Теперь здесь доступны ваши сценарии и сводка. Уведомления включаются отдельно в настройках.",markup:appButton(request,env),state:reset()};
    }
    return {text:welcome(String(sender.first_name??"").slice(0,128)),markup:appButton(request,env),state:reset()};
  }
  if(command==="/app"||text==="Открыть мини-приложение"||text==="Открыть приложение") return {text:"Откройте мини-приложение: выберите направление, дату и цену, посмотрите графики, сравните варианты и сохраните решение.",markup:appButton(request,env),state:reset()};
  if(command==="/help"||text==="Помощь") return {text:help(),markup:mainKeyboard(),state:reset()};
  if(command==="/cancel") return {text:"Расчёт отменён. Выберите действие.",markup:mainKeyboard(),state:reset()};
  if(command==="/notifications"||text==="Уведомления") return {text:"Выберите сценарий и значимое изменение в настройках приложения. Для отключения всех уведомлений: /stop. Учебные прогнозы статичны; сообщения возникают при обновлении данных или тестовом запуске.",markup:appButton(request,env,{tab:"settings"}),state:reset()};
  if(command==="/stop"||text==="Остановить уведомления") {
    await services.unsubscribe(id);return {text:"Уведомления отключены. Бот продолжает отвечать на команды. Включить правила снова можно в приложении.",markup:mainKeyboard(),state:reset()};
  }
  if(command==="/digest"||text==="Сводка") {const data=await services.digest(id);return {text:html(data.text.slice(0,3000)),markup:appButton(request,env,{tab:"overview"}),state:reset()};}
  if(command==="/saved"||text==="Мои сценарии") {
    const data=await services.scenarios(id);
    const lines=data.items.slice(0,8).map(x=>`<b>${html(String(x.title||"Без названия").slice(0,120))}</b>\n${html(x.route)} · ${displayDate(x.date)} · ${num(x.price,2)} ₽`);
    return {text:lines.length?"<b>Ваши сценарии</b>\n\n"+lines.join("\n\n"):"Сохранённых сценариев пока нет. Создайте расчёт в приложении и сохраните решение.",markup:appButton(request,env,{tab:"scenarios"}),state:reset()};
  }
  if(command==="/forecast"||text==="Быстрый расчёт") {
    const meta=await services.meta(),routes=routesFrom(meta),dates=datesFrom(meta);
    if(!routes.length||!dates.length) throw new PublicError(503,"Доступных прогнозов пока нет. Попробуйте позже.");
    return {text:"Выберите направление. Для отмены: /cancel.",markup:{inline_keyboard:routes.map(x=>[{text:String(x.name||x.route).slice(0,64),callback_data:"route:"+x.route}])},state:{state:"route",data:{routes,dates},updated_at:unixNow()}};
  }
  if(current.state==="route") {
    const route=callback?.startsWith("route:")?callback.slice(6):text.trim().toUpperCase();
    const item=list(current.data.routes).find(x=>x.route===route);
    if(!item) return {text:"Выберите доступное направление кнопкой или начните заново: /forecast."};
    const dates=current.data.dates as string[],buttons=dates.map(d=>({text:displayDate(d).slice(0,5),callback_data:"date:"+d}));
    const rows=[];for(let i=0;i<buttons.length;i+=5)rows.push(buttons.slice(i,i+5));
    return {text:`Маршрут: ${html(item.name||route)}.\nВыберите дату с ${displayDate(dates[0])} по ${displayDate(dates.at(-1))}. Можно написать ДД.ММ.ГГГГ.`,markup:{inline_keyboard:rows},state:{state:"date",data:{...current.data,route,route_info:item},updated_at:unixNow()}};
  }
  if(current.state==="date") {
    let date=callback?.startsWith("date:")?callback.slice(5):text.trim();
    if(/^\d{2}\.\d{2}\.\d{4}$/.test(date))date=date.split(".").reverse().join("-");
    if(!Array.isArray(current.data.dates)||!current.data.dates.includes(date)) return {text:"На эту дату нет прогноза. Выберите дату из доступного списка."};
    const info=obj(current.data.route_info);
    return {text:`Дата: ${displayDate(date)}. Введите цену одного билета в рублях, например 9500.\nДопустимый диапазон: ${num(info.price_min)}–${num(info.price_max)} ₽.`,state:{state:"price",data:{...current.data,date},updated_at:unixNow()}};
  }
  if(current.state==="price") {
    const input=text.replace(/[\s\u00a0\u202f]/g,"").replace(",",".");
    const price=Number(input),info=obj(current.data.route_info);
    if(!/^\d{1,9}(\.\d{1,2})?$/.test(input)||!Number.isFinite(price)||price<=0||price<Number(info.price_min)||price>Number(info.price_max)) return {text:"Введите положительную цену в допустимом диапазоне, например 9500 или 9500,50."};
    const route=String(current.data.route),date=String(current.data.date),result=await services.forecast({route,date,price});
    return {text:formatForecast(result,route,date,price),markup:appButton(request,env,{route,date,price},"График и сравнение цен"),state:reset()};
  }
  return {text:callback?"Этот выбор устарел. Начните новый расчёт: /forecast.":"Выберите действие кнопкой или начните расчёт: /forecast. Список команд: /help.",markup:mainKeyboard()};
}

export async function handleTelegram(request:Request,env:AppEnv,db:D1Database,services:TelegramServices):Promise<Response> {
  if(request.method!=="POST") return Response.json({detail:"Метод недоступен."},{status:405});
  const secret=env.TELEGRAM_WEBHOOK_SECRET;
  if(typeof secret!=="string"||!/^[A-Za-z0-9_-]{24,256}$/.test(secret)) return Response.json({detail:"Приём Telegram пока не настроен."},{status:503});
  if(!await constantTimeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token")??"",secret)) return Response.json({detail:"Запрос Telegram не подтверждён."},{status:403});
  if(Number(request.headers.get("Content-Length")||0)>65536) return Response.json({detail:"Запрос слишком велик."},{status:413});
  let update:Obj;
  try {update=obj(JSON.parse(await readLimitedText(request,65536)));}catch(error){return error instanceof PublicError?safeError(error):Response.json({detail:"Некорректный запрос Telegram."},{status:400});}
  const updateId=Number(update.update_id);
  if(!Number.isSafeInteger(updateId)||updateId<0)return Response.json({detail:"Некорректное обновление Telegram."},{status:400});
  const callback=obj(update.callback_query),message=obj(callback.message||update.message),sender=obj(callback.from||message.from),chat=obj(message.chat);
  if(chat.type!=="private"||!Number.isSafeInteger(sender.id)||Number(sender.id)<=0||Number(chat.id)!==sender.id)return Response.json({ok:true});
  const now=unixNow();
  const inserted=await db.prepare("INSERT OR IGNORE INTO telegram_updates(update_id,created_at,status,lease_until,attempts) VALUES(?,?,'processing',?,1)").bind(updateId,now,now+60).run();
  if(!inserted.meta.changes) {
    const row=await db.prepare("SELECT status,lease_until,attempts FROM telegram_updates WHERE update_id=?").bind(updateId).first<{status:string;lease_until:number;attempts:number}>();
    if(row?.status==="done")return Response.json({ok:true,duplicate:true});
    if(!row||row.lease_until>now)return Response.json({detail:"Повторите обновление позже."},{status:503,headers:{"Retry-After":"10"}});
    const claim=await db.prepare("UPDATE telegram_updates SET status='processing',lease_until=?,attempts=attempts+1 WHERE update_id=? AND status!='done' AND lease_until<=?").bind(now+60,updateId,now).run();
    if(!claim.meta.changes)return Response.json({detail:"Повторите обновление позже."},{status:503});
  }
  let sent=false;
  try {
    // Bot identity is independent of browser guests and needs no website link.
    // Only this verified private webhook may provision the Telegram profile.
    const name=[sender.first_name,sender.last_name].filter(value=>typeof value==="string").join(" ").slice(0,200)||"Пользователь Telegram";
    const existing=await db.prepare("SELECT * FROM users WHERE telegram_id=?").bind(sender.id).first<UserRecord>();
    const role=telegramRole(existing,Number(sender.id),env);
    await db.prepare("INSERT INTO users(id,email,name,role,telegram_id,chat_id,openai_id,created_at) VALUES(?,NULL,?,?,?,?,NULL,?) ON CONFLICT(telegram_id) DO UPDATE SET chat_id=excluded.chat_id,role=excluded.role,name=CASE WHEN users.openai_id IS NULL THEN excluded.name ELSE users.name END").bind(crypto.randomUUID(),name,role,sender.id,chat.id,unixNow()).run();
    const current=await loadState(db,Number(sender.id));
    let plan:Plan;
    try {plan=await makePlan(request,env,db,services,sender,String(message.text??"").slice(0,4000),typeof callback.data==="string"?callback.data:undefined,current);}
    catch(error) {
      let markup:Markup|undefined;
      try{markup=appButton(request,env);}catch{telemetry("handler","not_configured",null);}
      plan={text:error instanceof PublicError?html(error.message):"Не удалось выполнить действие. Повторите команду позже.",...(markup?{markup}:{})};
    }
    if(env.TELEGRAM_DELIVERY_MODE==="webhook"){
      // Explicit operator-selected mode, never an automatic fallback after an
      // uncertain direct send. Telegram executes this fixed method from the
      // webhook response; the Bot API provides no delivery result in this mode.
      // Persist first so duplicate updates do not execute sendMessage again.
      // Callback acknowledgement is intentionally omitted: the response can
      // request only the new message without an additional outbound API call.
      await persistPlan(db,updateId,sender.id,plan.state);
      return Response.json({method:"sendMessage",chat_id:chat.id,text:plan.text,parse_mode:"HTML",...(plan.markup?{reply_markup:plan.markup}:{})},{headers:{"Cache-Control":"no-store"}});
    }
    if(typeof callback.id==="string") {try{await sendTelegram(env,"answerCallbackQuery",{callback_query_id:callback.id});}catch{/* Expired callback acknowledgements do not block the actual response. */}}
    try{
      await sendTelegram(env,"sendMessage",{chat_id:chat.id,text:plan.text,parse_mode:"HTML",...(plan.markup?{reply_markup:plan.markup}:{})});
    }catch(error){
      const eligible=error instanceof TelegramDeliveryError&&error.httpStatus===400&&(error.classification==="invalid_button"||error.classification==="invalid_format");
      if(!eligible)throw error;
      telemetry("delivery",error.classification,error.httpStatus);
      // A Bot API 400 rejection is known not to have sent the first message.
      // Retry once with plain text and an ordinary website URL button only.
      await sendTelegram(env,"sendMessage",fallbackMessage(plan,chat.id));
      telemetry("fallback","fallback_delivered",200);
    }
    sent=true;
    await persistPlan(db,updateId,sender.id,plan.state);
    return Response.json({ok:true});
  }catch(error) {
    const delivery=error instanceof TelegramDeliveryError?error:null;
    telemetry(delivery?"delivery":"handler",delivery?.classification??(error instanceof PublicError?"not_configured":"handler_failure"),delivery?.httpStatus??null);
    if(sent||delivery?.uncertain||delivery?.permanent) {
      // Telegram sendMessage has no idempotency key. Once a send may have
      // succeeded, suppress retries rather than duplicate a private message.
      await db.prepare("UPDATE telegram_updates SET status='done',lease_until=0 WHERE update_id=?").bind(updateId).run();
      return Response.json({ok:true});
    }
    await db.prepare("UPDATE telegram_updates SET status='pending',lease_until=? WHERE update_id=?").bind(unixNow()+(delivery?.retryAfter??5),updateId).run();
    return error instanceof PublicError?safeError(error):Response.json({detail:"Повторите обновление позже."},{status:503,headers:{"Retry-After":String(delivery?.retryAfter??5)}});
  }
}

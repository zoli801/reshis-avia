import type {AppEnv} from "../../lib/server/db";

export const dynamic="force-dynamic";
const VERSION="2026-07-28";
type JsonId=string|number|null;
type Counts={pending:number;delivered:number;failed:number;last_delivery_at:string|null};
type ProcessResult={queued:number;sent:number;failed:number;configured:boolean};
export interface McpDependencies {
  getUser:()=>Promise<{role:string}|null>;
  notificationStatus:()=>Promise<Counts>;
  processNotifications:()=>Promise<ProcessResult>;
}

const tools=[
  {name:"notification_status",title:"Состояние уведомлений",description:"Проверить общие счётчики очереди и время последней успешной отправки. Доступно администратору; личные данные не возвращаются.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  {name:"process_notifications",title:"Обработать уведомления",description:"Поставить в очередь сводки, срок которых наступил, и отправить готовые уведомления Telegram. Соблюдает подписки, тихие часы и защиту от повторов. Доступно администратору; ключи и токены передавать не нужно.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
];
const response=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
const rpcError=(id:JsonId,code:number,message:string,status=200)=>response({jsonrpc:"2.0",id,error:{code,message}},status);
const isObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const result=(id:JsonId,value:unknown)=>response({jsonrpc:"2.0",id,result:value});

/** Pure request boundary; injected dependencies allow access checks to be tested offline. */
export async function handleMcp(request:Request,dependencies:McpDependencies):Promise<Response>{
  if(request.method!=="POST")return new Response("Разрешён только POST.",{status:405,headers:{Allow:"POST","Cache-Control":"no-store"}});
  let input:unknown;
  try{
    const raw=await request.text();
    if(new TextEncoder().encode(raw).length>16384)return rpcError(null,-32600,"Запрос слишком велик.",413);
    input=JSON.parse(raw);
  }catch{return rpcError(null,-32700,"Не удалось прочитать JSON-запрос.",400);}
  if(!isObject(input)||input.jsonrpc!=="2.0"||typeof input.method!=="string")return rpcError(null,-32600,"Неверный формат JSON-RPC.",400);
  const id=input.id===undefined?null:input.id;
  if(id!==null&&typeof id!=="string"&&(typeof id!=="number"||!Number.isFinite(id)))return rpcError(null,-32600,"Неверный идентификатор запроса.",400);
  const rpcId=id as JsonId;
  if(input.method==="notifications/initialized")return new Response(null,{status:204,headers:{"Cache-Control":"no-store"}});
  if(input.method==="server/discover")return result(rpcId,{supportedVersions:[VERSION],capabilities:{tools:{}},serverInfo:{name:"reshis-avia",version:"1.0.0"}});
  // Compatibility for clients that establish a session with initialize first.
  if(input.method==="initialize")return result(rpcId,{protocolVersion:VERSION,capabilities:{tools:{}},serverInfo:{name:"reshis-avia",version:"1.0.0"},instructions:"Инструменты уведомлений доступны только администратору. Учётные данные передавать не нужно."});
  if(input.method==="ping")return result(rpcId,{});
  if(input.method==="tools/list")return result(rpcId,{tools});
  if(input.method!=="tools/call")return rpcError(rpcId,-32601,"Метод MCP не найден.");
  const params=input.params;
  if(input.id===undefined||!isObject(params)||typeof params.name!=="string"||!tools.some(tool=>tool.name===params.name))return rpcError(rpcId,-32602,"Укажите поддерживаемый инструмент и идентификатор запроса.");
  const args=params.arguments??{};
  if(!isObject(args)||Object.keys(args).length)return rpcError(rpcId,-32602,"Этот инструмент не принимает аргументы или учётные данные.");
  try{
    const user=await dependencies.getUser();
    if(!user||user.role!=="admin")return rpcError(rpcId,-32001,"Для этого инструмента нужны права администратора.",403);
    if(params.name==="notification_status"){
      const counts=await dependencies.notificationStatus();
      const text=`Ожидают отправки: ${counts.pending}. Успешно доставлены: ${counts.delivered}. Ошибок: ${counts.failed}. Последняя успешная отправка: ${counts.last_delivery_at??"ещё не было"}.`;
      return result(rpcId,{content:[{type:"text",text}],structuredContent:counts,isError:false});
    }
    const counts=await dependencies.processNotifications();
    const text=counts.configured?`Поставлено в очередь: ${counts.queued}. Отправлено: ${counts.sent}. Ошибок отправки: ${counts.failed}.`:"Отправка Telegram пока не настроена. Уведомления сохранены в очереди.";
    return result(rpcId,{content:[{type:"text",text}],structuredContent:counts,isError:!counts.configured});
  }catch{
    // Neither SQL/transport errors nor secret-bearing Telegram URLs reach MCP callers.
    return result(rpcId,{content:[{type:"text",text:"Не удалось обработать уведомления. Повторите попытку позже."}],isError:true});
  }
}

async function runtimeDependencies(request:Request):Promise<McpDependencies>{
  const {env}=await import("cloudflare:workers");
  const appEnv=env as unknown as AppEnv;
  return {
    async getUser(){
      const {getUser}=await import("../../lib/server/auth");
      return getUser(request,appEnv.DB,appEnv);
    },
    async notificationStatus(){
      const counts=await appEnv.DB.prepare("SELECT SUM(CASE WHEN sent_at IS NULL THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN sent_at IS NOT NULL AND last_error IS NULL THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failed, MAX(CASE WHEN sent_at IS NOT NULL AND last_error IS NULL THEN sent_at ELSE NULL END) AS last_delivery_at FROM deliveries").first<{pending:number|null;delivered:number|null;failed:number|null;last_delivery_at:number|null}>();
      return {pending:Number(counts?.pending??0),delivered:Number(counts?.delivered??0),failed:Number(counts?.failed??0),last_delivery_at:counts?.last_delivery_at?new Date(counts.last_delivery_at*1000).toISOString():null};
    },
    async processNotifications(){const {processNotifications}=await import("../../lib/server/services");return processNotifications(appEnv);},
  };
}

export async function POST(request:Request):Promise<Response>{
  try{
    const dependencies=await runtimeDependencies(request);
    return handleMcp(request,dependencies);
  }catch{return rpcError(null,-32603,"Сервис уведомлений временно недоступен.",503);}
}
export async function GET():Promise<Response>{return new Response("Используйте POST для запросов MCP.",{status:405,headers:{Allow:"POST","Cache-Control":"no-store"}});}

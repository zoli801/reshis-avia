/** Server-only primitives. Never include runtime secrets in errors or logs. */
export class PublicError extends Error {
  status:number;
  constructor(status: number, message: string) { super(message); this.status=status; this.name = "PublicError"; }
}

export const unixNow = () => Math.floor(Date.now() / 1000);
export const encode = (value: string) => new TextEncoder().encode(value);
export const toHex = (value: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(value)).map(v => v.toString(16).padStart(2,"0")).join("");
export function fromHex(value: string): Uint8Array {
  if (!/^(?:[a-fA-F0-9]{2})+$/.test(value)) throw new PublicError(401,"Подпись Telegram недействительна.");
  return Uint8Array.from(value.match(/../g)!.map(v=>parseInt(v,16)));
}
export async function sha256(value: string): Promise<string> { return toHex(await crypto.subtle.digest("SHA-256", encode(value))); }
export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left,right] = await Promise.all([crypto.subtle.digest("SHA-256",encode(a)),crypto.subtle.digest("SHA-256",encode(b))]);
  const aa=new Uint8Array(left), bb=new Uint8Array(right); let result=0;
  for(let i=0;i<aa.length;i++) result |= aa[i]^bb[i];
  return result===0 && a.length===b.length;
}
export async function hmac(key: Uint8Array, text: string): Promise<Uint8Array> {
  const imported=await crypto.subtle.importKey("raw",key as BufferSource,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC",imported,encode(text)));
}
export function html(value: unknown): string {
  return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
}
export function safeError(error: unknown): Response {
  const known=error instanceof PublicError;
  return Response.json({detail:known?error.message:"Не удалось выполнить действие. Попробуйте позже."},{status:known?error.status:500,headers:{"Cache-Control":"no-store"}});
}
export async function readLimitedText(request:Request,limit:number):Promise<string> {
  if(Number(request.headers.get("Content-Length")||0)>limit)throw new PublicError(413,"Запрос слишком велик.");
  if(!request.body)return "";
  const reader=request.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new PublicError(413,"Запрос слишком велик.");}parts.push(value);}
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  return new TextDecoder().decode(bytes);
}
export function assertSameOrigin(request: Request): void {
  const origin=request.headers.get("Origin");
  if(origin===new URL(request.url).origin) return;
  if(!origin && request.headers.get("Sec-Fetch-Site")==="same-origin") return;
  throw new PublicError(403,"Запрос должен быть отправлен из приложения.");
}
export function safeAppUrl(request: Request, env: Record<string,unknown>, params: Record<string,unknown> = {}): string {
  const configured=env.WEBAPP_URL || env.APP_URL || env.PUBLIC_URL;
  let url: URL;
  try {url=new URL(typeof configured==="string" && configured ? configured : new URL(request.url).origin);}
  catch {throw new PublicError(503,"Адрес мини-приложения пока не настроен.");}
  if(url.protocol!=="https:" || url.username || url.password || url.hash) throw new PublicError(503,"Для мини-приложения нужен HTTPS-адрес.");
  for(const secret of [env.BOT_TOKEN,env.TELEGRAM_WEBHOOK_SECRET,env.BOT_INTERNAL_SECRET]) {
    if(typeof secret==="string" && secret && (url.href.includes(secret)||url.href.includes(encodeURIComponent(secret)))) throw new PublicError(503,"Адрес мини-приложения настроен некорректно.");
  }
  for(const [key,value] of Object.entries(params)) if(value!==undefined && value!==null) url.searchParams.set(key,String(value));
  return url.toString();
}

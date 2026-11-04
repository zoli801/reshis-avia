import {getLanguage,locale,t} from './i18n.ts';
export type Route = { route: string; name: string; origin: string; destination: string; base_price: number; cost_per_passenger: number; price_sensitivity: number; price_min: number; price_max: number };
export type Dataset = { id: string|number; filename: string; imported_at: string; rows: number; route_count: number; start_date: string; end_date: string; sha256: string; warnings: string[] };
export type Meta = { app_name: string; routes: Route[]; dates: string[]; dataset: Dataset; bot_username?: string; telegram_enabled: boolean };
export type User = { id: string; email: string|null; name: string; role: 'analyst'|'manager'|'admin'; telegram_id?: string|number|null; telegram_delivery_ready:boolean; auth_provider:'guest'|'telegram'|'chatgpt'|'password'; username?:string|null; has_password?:boolean };
export type Forecast = { route: string; date: string; price: number; base_price: number; capacity: number; demand: number; sales: number; empty_seats: number; load_factor: number; revenue: number; contribution: number; quantiles: {q:number; demand:number; sales:number}[]; reference_price: number; recommended_price: number; price_curve: {price:number;sales:number;revenue:number;contribution:number}[]; explanation: string[]; dataset_id: string|number; is_experiment: boolean; demand_multiplier:number; capacity_override:number|null };
export type TimelinePoint = {date:string;demand:number;sales:number;capacity:number;load_factor:number;p10:number;p90:number;sales_p10:number;sales_p90:number;revenue:number;contribution:number;recommended_price:number};
export type Analytics = {dataset_id:string|number;route:string;price:number;selected_date:string;is_experiment:boolean;timeline:TimelinePoint[];selected:{base_contribution:number;contribution_delta:number;contribution_delta_pct:number|null;recommended_contribution:number;improvement_to_recommended:number;demand_above_capacity:number;sales_p10:number;sales_p90:number};summary:{days:number;total_sales:number;total_capacity:number;total_revenue:number;total_contribution:number;avg_load_factor:number;days_deficit:number;days_low:number;best_day:string|null;worst_day:string|null}};
export type Scenario = { id: string; title:string; note:string; route:string; date:string; price:number; status:'draft'|'review'|'approved'; created_at:string; dataset_id:string|number; result:Forecast; alternatives:number[]; history?:{at?:string;action?:string;created_at?:string;description?:string}[]; owner_id?:string };
export type Preferences = { enabled:boolean; digest_enabled:boolean; digest_hour:number; quiet_start:number; quiet_end:number; timezone:string; routes:string[]; change_threshold:number };
export const isTelegramClient=()=>typeof window!=='undefined'&&!!(window as unknown as {Telegram?:{WebApp?:{initData?:string}}}).Telegram?.WebApp?.initData;
/** Document navigation cannot carry a custom header; this selector grants no authentication. */
export const documentUrl=(path:string)=>{const url=new URL('/api'+path,typeof location==='undefined'?'https://avia.local':location.origin);url.searchParams.set('lang',getLanguage());if(isTelegramClient())url.searchParams.set('avia_client','telegram');return url.pathname+url.search;};
export async function api<T>(path:string, init:RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-Avia-Client',isTelegramClient()?'telegram':'web');
  headers.set('Accept-Language',getLanguage());
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type','application/json');
  const response = await fetch('/api'+path,{...init,headers,credentials:'same-origin'});
  if (!response.ok) {
    let message='Не удалось выполнить запрос. Попробуйте ещё раз.';
    try { const body=await response.json() as {detail?:unknown;message?:unknown}; if(typeof body.detail==='string')message=body.detail; else if(typeof body.message==='string')message=body.message; } catch { /* preserve friendly fallback */ }
    throw new Error(t(message));
  }
  if(response.status===204)return undefined as T;
  return response.json();
}
export const post = <T>(path:string,body:unknown) => api<T>(path,{method:'POST',body:JSON.stringify(body)});
/** Website and Telegram establish separate sessions; a failed signed login never creates a guest. */
export async function initializeUser(telegramInitData?:string,request:typeof api=api):Promise<User>{
  if(telegramInitData){
    const result=await request<{user:User}>('/auth/telegram',{method:'POST',body:JSON.stringify({init_data:telegramInitData})});
    return result.user;
  }
  if(typeof location!=='undefined'&&new URLSearchParams(location.search).get('auth')==='chatgpt'){
    const signed=await request<{user:User}>('/auth/chatgpt',{method:'POST',body:'{}'});
    const url=new URL(location.href);url.searchParams.delete('auth');history.replaceState(null,'',url.pathname+url.search+url.hash);
    return signed.user;
  }
  const existing=await request<{user:User|null}>('/auth/me');
  if(existing.user)return existing.user;
  const created=await request<{user:User}>('/auth/guest',{method:'POST',body:'{}'});
  return created.user;
}
export const money = (value:number,short=false) => new Intl.NumberFormat(locale(),{style:'currency',currency:'RUB',maximumFractionDigits:short?1:0,...(short?{notation:'compact' as const}:{})}).format(value);
export const number = (value:number,decimals=0) => new Intl.NumberFormat(locale(),{maximumFractionDigits:decimals}).format(value);
export const day = (value:string,long=false) => new Date(value+'T12:00:00').toLocaleDateString(locale(),{day:'numeric',month:long?'long':'short'});
export const timestamp = (value:string) => new Date(value).toLocaleString(locale(),{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});

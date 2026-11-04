import assert from 'node:assert/strict';
import test from 'node:test';
import {cityName,canonicalCity,getLanguage,locale,routeName,setLanguage,t,tf} from '../app/avia/i18n.ts';
import {api,day,documentUrl,initializeUser,money,number,type User} from '../app/avia/api.ts';

test('language switching updates system copy, dates and figures while preserving stored user text',()=>{
 try{
  setLanguage('ru');assert.equal(getLanguage(),'ru');assert.equal(t('Прогноз спроса'),'Прогноз спроса');assert.equal(locale(),'ru-RU');
  const original={title:'Мой сценарий №7',note:'Клиент просит сохранить цену',route:'MOW-LED'};
  const snapshot=JSON.stringify(original),ruMoney=money(9000);
  setLanguage('en');assert.equal(t('Прогноз спроса'),'Demand forecast');assert.equal(t('Светлая'),'Light');assert.equal(t('Все графики'),'All charts');
  assert.equal(number(1234.5,1),'1,234.5');assert.equal(day('2026-06-01',true),'1 June');assert.notEqual(money(9000),ruMoney);
  assert.equal(t(original.title),original.title);assert.equal(t(original.note),original.note);assert.equal(JSON.stringify(original),snapshot);
  setLanguage('ru');assert.equal(t('Demand forecast'),'Прогноз спроса');assert.equal(money(9000),ruMoney);
 }finally{setLanguage('ru');}
});

test('English route labels and input aliases preserve canonical CSV city names',()=>{
 try{
  setLanguage('en');assert.equal(cityName('Москва'),'Moscow');assert.equal(routeName('Москва — Санкт-Петербург'),'Moscow — Saint Petersburg');
  assert.equal(canonicalCity('Moscow'),'Москва');assert.equal(canonicalCity('Saint Petersburg'),'Санкт-Петербург');assert.equal(canonicalCity('st. petersburg'),'Санкт-Петербург');
  assert.equal(canonicalCity('MOW'),'MOW');assert.equal(canonicalCity('Unknown city'),'Unknown city');
  setLanguage('ru');assert.equal(cityName('Москва'),'Москва');assert.equal(routeName('Москва — Сочи'),'Москва — Сочи');
 }finally{setLanguage('ru');}
});

test('translated templates preserve parameters as plain text and known server messages stay readable',()=>{
 try{
  setLanguage('en');assert.equal(tf('Роль пользователя {0}',['<b>Alex</b>']),'Role for <b>Alex</b>');
  assert.equal(tf('Девять квантилей при одной цене {0}. Вместимость ограничивает продажи.',['RUB 9,000']),'Nine quantiles at one price, RUB 9,000. Capacity limits sales.');
  assert.equal(t('Медианная загрузка ниже 65%.'),'Median load factor is below 65%.');
  assert.equal(t('Учебный прогноз из CSV. Фактические бронирования и текущие цены авиакомпаний не подключены.'),'An educational CSV forecast. Live bookings and current airline prices are not connected.');
  assert.equal(t('Связан Telegram'),'Telegram connected');
  assert.equal(t('Войти','Sign in'),'Sign in');
  setLanguage('ru');assert.equal(t('Войти','Sign in'),'Войти');
 }finally{setLanguage('ru');}
});

test('API requests negotiate language and document links preserve their query and namespace',async()=>{
 const originalFetch=globalThis.fetch;
 try{
  setLanguage('en');let requestHeaders:Headers|null=null;
  globalThis.fetch=async(_input,init)=>{requestHeaders=new Headers(init?.headers);return Response.json({ok:true});};
  assert.deepEqual(await api('/health'),{ok:true});assert.equal(requestHeaders!.get('Accept-Language'),'en');assert.equal(requestHeaders!.get('X-Avia-Client'),'web');
  assert.equal(documentUrl('/scenarios/one/report?view=print'),'/api/scenarios/one/report?view=print&lang=en');
  setLanguage('ru');assert.equal(documentUrl('/scenarios/one/export.csv'),'/api/scenarios/one/export.csv?lang=ru');
 }finally{globalThis.fetch=originalFetch;setLanguage('ru');}
});

test('ChatGPT return establishes an explicit web session and removes only the auth marker',async()=>{
 const originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location'),originalHistory=Object.getOwnPropertyDescriptor(globalThis,'history');
 const user={id:'chatgpt-user',name:'Visitor',email:'visitor@example.test',role:'analyst',telegram_delivery_ready:false,auth_provider:'chatgpt'} as User;
 const calls:string[]=[],paths:string[]=[];
 try{
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://avia.test/?auth=chatgpt&route=MOW-AER#profile',search:'?auth=chatgpt&route=MOW-AER'}});
  Object.defineProperty(globalThis,'history',{configurable:true,value:{replaceState:(_state:unknown,_title:string,path:string)=>paths.push(path)}});
  const request=async<T>(path:string,init?:RequestInit):Promise<T>=>{calls.push(path);assert.equal(init?.method,'POST');return {user} as T;};
  assert.equal((await initializeUser(undefined,request)).id,user.id);assert.deepEqual(calls,['/auth/chatgpt']);assert.deepEqual(paths,['/?route=MOW-AER#profile']);
 }finally{
  if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation);else Reflect.deleteProperty(globalThis,'location');
  if(originalHistory)Object.defineProperty(globalThis,'history',originalHistory);else Reflect.deleteProperty(globalThis,'history');
 }
});

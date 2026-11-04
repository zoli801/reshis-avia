import assert from 'node:assert/strict';
import test from 'node:test';
import {requestLanguage,translateApiError} from '../lib/aviation/language.ts';
import {demandSvg,escapeHtml,renderReport} from '../lib/aviation/reports.ts';
import {evaluate,type ReportScenario} from '../lib/aviation/domain.ts';
import {seedData} from '../lib/aviation/seed.ts';
import {handleApi} from '../lib/server/services.ts';
import type {AppEnv,UserRecord} from '../lib/server/db.ts';
import {testDatabase} from './auth-support.ts';

const row=seedData.rows.find(item=>item.route==='MOW-AER'&&item.date==='2026-06-01')!;
const route=seedData.routes.find(item=>item.route===row.route)!;
const fixture=(price=9000):ReportScenario=>({
 id:'locale-report',title:'Авторский заголовок <сохранён>',note:'Моя заметка: исходные условия\n<script>не выполнять</script>',route:row.route,date:row.date,price,status:'draft',created_at:'2026-11-04T10:00:00Z',dataset_id:seedData.id,
 result:{...evaluate(row,route,price,seedData.id),alternative_results:[evaluate(row,route,5400,seedData.id)]},
});

test('English report translates every static section while preserving and escaping authored title and notes',()=>{
 const scenario=fixture(),snapshot=JSON.stringify(scenario);
 const html=renderReport(scenario,{...seedData,imported_at:'2026-11-04T09:00:00Z'},'Europe/Moscow','en');
 assert.match(html,/<html lang="en">/);assert.match(html,/Moscow — Sochi/);assert.match(html,/1 Jun 2026/);
 for(const text of ['Results at the selected price','Forecast sales','Demand distribution at','Saved price comparison','Decision rationale','Calculation parameters','Model and assumptions','Saved dataset version','Print / save as PDF'])assert.ok(html.includes(text),text);
 assert.ok(html.includes(escapeHtml(scenario.title)));assert.ok(html.includes(escapeHtml(scenario.note!).replaceAll('\n','<br>')));assert.ok(!html.includes('<script>не выполнять</script>'));
 const systemOnly=html.split(escapeHtml(scenario.title)).join('').split(escapeHtml(scenario.note!).replaceAll('\n','<br>')).join('');
 assert.doesNotMatch(systemOnly,/[А-Яа-яЁё]/);assert.equal(JSON.stringify(scenario),snapshot);
 const russian=renderReport(scenario,seedData,'Europe/Moscow','ru');assert.match(russian,/<html lang="ru">/);assert.match(russian,/Результат при выбранной цене/);assert.match(russian,/Москва — Сочи/);
});

test('English chart preserves all raw quantiles, negative median and capacity with clipped sales',()=>{
 const scenario=fixture(18000),result=scenario.result;assert.ok(result.demand<0);assert.equal(result.sales,0);assert.equal(result.quantiles[4].demand,result.demand);
 const svg=demandSvg(result,'en');assert.equal([...svg.matchAll(/data-quantile=/g)].length,9);
 assert.ok(svg.includes('data-quantile="0.5" data-demand="'+result.demand+'"'));assert.ok(svg.includes('data-capacity="'+result.capacity+'"'));
 assert.match(svg,/Demand quantiles at the selected price/);assert.doesNotMatch(svg,/[А-Яа-яЁё]/);
 const html=renderReport(scenario,seedData,'UTC','en');assert.match(html,/Model estimate \(median\)/);assert.match(html,/0\.00 tickets/);assert.ok(html.includes('data-demand="'+result.demand+'"'));
});

test('explicit report language overrides request headers and unsupported language falls back safely',()=>{
 const make=(query:string,header?:string)=>new Request('https://avia.test/api/example'+query,{headers:header?{'Accept-Language':header}:{}});
 assert.equal(requestLanguage(make('')),'ru');assert.equal(requestLanguage(make('','en-GB,en;q=0.9')),'en');
 assert.equal(requestLanguage(make('?lang=ru','en-US')),'ru');assert.equal(requestLanguage(make('?lang=en','ru-RU')),'en');assert.equal(requestLanguage(make('?lang=xx','en')),'en');
 assert.equal(requestLanguage(make('?lang=%3Cscript%3E','ru')),'ru');assert.equal(translateApiError('Неверный логин или пароль.'),'Incorrect username or password.');
 assert.doesNotMatch(translateApiError('Неизвестное системное сообщение.'),/[А-Яа-яЁё]/);
});

test('hosted API serves English errors and report documents without changing calculations or authored content',async()=>{
 const store=testDatabase(),env={DB:store.db} as AppEnv;
 const user={id:'locale-user',email:null,name:'Читатель',role:'analyst',telegram_id:null,chat_id:null,openai_id:null,created_at:1} as UserRecord;
 const request=(path:string,method='GET',payload?:unknown,language='en')=>new Request('https://avia.test/api/'+path,{method,headers:{Origin:'https://avia.test','Accept-Language':language,...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
 try{
  await store.db.prepare('INSERT INTO users(id,email,name,role,telegram_id,chat_id,openai_id,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(user.id,null,user.name,user.role,null,null,null,1).run();
  const badInput={route:'MOW-AER',date:'2026-06-01',price:-1};
  const english=await handleApi(request('forecast','POST',badInput),'forecast',env,null);assert.equal(english.status,422);assert.equal(english.headers.get('Content-Language'),'en');assert.match(english.headers.get('Vary')??'',/Accept-Language/);
  const error=await english.json() as {detail:string};assert.doesNotMatch(error.detail,/[А-Яа-яЁё]/);
  const russian=await handleApi(request('forecast?lang=ru','POST',badInput),'forecast',env,null);assert.match((await russian.json() as {detail:string}).detail,/[А-Яа-яЁё]/);
  const saved=await handleApi(request('scenarios','POST',{route:row.route,date:row.date,price:9000,title:'Исходное название',note:'Исходная заметка',alternatives:[5400]}),'scenarios',env,user);assert.equal(saved.status,201);
  const scenario=await saved.json() as {id:string;title:string;note:string;result:{demand:number;quantiles:{q:number;demand:number}[]}};assert.equal(scenario.title,'Исходное название');assert.equal(scenario.note,'Исходная заметка');assert.equal(scenario.result.demand,843);assert.equal(scenario.result.quantiles[4].demand,843);
  const path='scenarios/'+scenario.id+'/report',report=await handleApi(request(path+'?lang=en','GET',undefined,'ru'),path,env,user);assert.equal(report.status,200);assert.equal(report.headers.get('Content-Language'),'en');
  const html=await report.text();assert.match(html,/<html lang="en">/);assert.match(html,/Results at the selected price/);assert.match(html,/Исходное название/);assert.match(html,/Исходная заметка/);
  const back=await handleApi(request(path+'?lang=ru','GET',undefined,'en'),path,env,user);assert.match(await back.text(),/<html lang="ru">/);
 }finally{store.close();}
});

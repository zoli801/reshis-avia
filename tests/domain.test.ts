import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {after,test} from "node:test";
import ts from "typescript";
import type {ForecastRow,ReportScenario} from "../lib/aviation/domain";

// Transpile just the dependency-free modules; no build, Worker or database is required.
const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),temporary=mkdtempSync(join(tmpdir(),"avia-domain-"));
for(const name of ["domain","csv","seed","reports","language"]){
  const source=readFileSync(join(root,"lib/aviation",name+".ts"),"utf8");
  const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replaceAll('"./domain"','"./domain.mjs"').replaceAll('"./domain.ts"','"./domain.mjs"').replaceAll('"./language.ts"','"./language.mjs"');
  writeFileSync(join(temporary,name+".mjs"),output);
}
const domain=await import(pathToFileURL(join(temporary,"domain.mjs")).href) as typeof import("../lib/aviation/domain");
const csv=await import(pathToFileURL(join(temporary,"csv.mjs")).href) as typeof import("../lib/aviation/csv");
const {seedData}=await import(pathToFileURL(join(temporary,"seed.mjs")).href) as typeof import("../lib/aviation/seed");
const report=await import(pathToFileURL(join(temporary,"reports.mjs")).href) as typeof import("../lib/aviation/reports");
after(()=>rmSync(temporary,{recursive:true,force:true}));
const row=seedData.rows[0],info=seedData.routes.find(r=>r.route===row.route)!;
const forecastCsv=(rows:ForecastRow[])=>[csv.FORECAST_FIELDS.join(","),...rows.map(r=>csv.FORECAST_FIELDS.map(k=>String(r[k as keyof ForecastRow])).join(","))].join("\r\n")+"\r\n";
const snapshot=():ReportScenario=>({id:"decision",title:"Сочи",note:"Комментарий",route:row.route,date:row.date,price:9000,status:"draft",created_at:"2026-11-03T16:15:00Z",dataset_id:seedData.id,result:domain.evaluate(row,info,9000,seedData.id)});

test("exact approved seed:155 unique route-days, five routes, original hashes",()=>{
 assert.equal(seedData.rows.length,155);assert.equal(seedData.routes.length,5);
 assert.equal(new Set(seedData.rows.map(r=>r.route+":"+r.date)).size,155);
 assert.equal(new Set(seedData.rows.map(r=>r.date)).size,31);
 assert.equal(seedData.start_date,"2026-06-01");assert.equal(seedData.end_date,"2026-07-01");
 assert.equal(seedData.sha256,"40dc4508cbde3413ee21286f6e8884bb1a0844dca80d61befaccc295168a075a");
 assert.equal(seedData.id,"1746908952b67e8de76c5f0883963202ca87aa3029cebffbdb981e7fb1496364");
 assert.equal(seedData.filename,"Chekhlov_Dmitrii_Olegovich_my_forecast.csv");
});
test("real AER June1 median, uncapped demand, profit objective",()=>{
 const result=domain.evaluate(row,info,9000,seedData.id);
 assert.equal(result.demand,843);assert.equal(result.sales,843);assert.equal(result.capacity,900);
 assert.equal(result.empty_seats,57);assert.equal(result.revenue,7587000);assert.equal(result.contribution,4046400);
 assert.ok(Math.abs(result.recommended_price-9589.36170212766)<1e-8);
 assert.equal(result.quantiles[0].demand,737);assert.equal(result.quantiles[8].demand,949);
 assert.equal(result.quantiles[4].demand,result.demand);
 const high=domain.evaluate(row,info,12000,seedData.id);assert.ok(Math.abs(high.sales-420)<1e-9);
});
test("all quantiles shift at one chosen price, clipped sales preserve raw demand",()=>{
 const a=domain.evaluate(row,info,9000,"v"),b=domain.evaluate(row,info,10000,"v");
 a.quantiles.forEach((q,i)=>assert.ok(Math.abs(q.demand-b.quantiles[i].demand-141)<1e-8));
 const high=domain.evaluate(row,info,1e6,"v");assert.ok(high.demand<0);assert.equal(high.sales,0);
 assert.equal(high.quantiles[4].demand,high.demand);
 const low=domain.evaluate(row,info,0,"v");assert.equal(low.sales,low.capacity);
 const custom=domain.evaluate(row,info,9000,"v",100,2);assert.equal(custom.demand,1686);assert.equal(custom.sales,100);assert.equal(custom.capacity_override,100);assert.ok(custom.is_experiment);
});
test("all155 bounded recommended prices maximize median contribution against dense grid",()=>{
 for(const r of seedData.rows){
  const route=seedData.routes.find(i=>i.route===r.route)!;
  const baseline=domain.evaluate(r,route,route.base_price,"v"),price=baseline.recommended_price;
  assert.ok(price>=route.price_min&&price<=route.price_max);
  const best=domain.evaluate(r,route,price,"v");
  for(const point of baseline.price_curve)assert.ok(best.contribution+1e-6>=point.contribution);
  assert.ok(best.quantiles.every(q=>q.sales>=0&&q.sales<=best.capacity));
 }
});
test("invalid forecast inputs rejected",()=>{
 for(const price of [-1,NaN,Infinity,1e10])assert.throws(()=>domain.evaluate(row,info,price,"v"),domain.DataError);
 for(const capacity of [0,-1,1.5,1e7])assert.throws(()=>domain.evaluate(row,info,9000,"v",capacity),domain.DataError);
 for(const multiplier of [0,-1,NaN,11])assert.throws(()=>domain.evaluate(row,info,9000,"v",undefined,multiplier),domain.DataError);
});
test("genuine CSV quotes, doubled quotes, Unicode, CRLF and embedded newline",()=>{
 const copy={...info,name:'Москва — "Тест, город\nвнутри"'};
 const parsed=csv.parseRoutes("\ufeff"+csv.exportRoutesCsv([copy]));assert.equal(parsed[0].name,copy.name);
 assert.deepEqual(csv.parseCsv('a,b\r\n"x,y","line1\nline2"\r\n'),[["a","b"],["x,y","line1\nline2"]]);
 assert.throws(()=>csv.parseCsv('a\n"unterminated'),domain.DataError);
 assert.throws(()=>csv.parseCsv('a\n"closed"text'),domain.DataError);
});
test("CSV schema, duplicate keys, dates, capacity and ordered quantiles",()=>{
 assert.deepEqual(csv.parseForecast(forecastCsv([row]),seedData.routes),[row]);
 assert.throws(()=>csv.parseForecast(forecastCsv([row,row]),seedData.routes),/повторная/);
 assert.throws(()=>csv.parseForecast(forecastCsv([{...row,date:"2026-02-30"}]),seedData.routes),/дата/);
 assert.throws(()=>csv.parseForecast(forecastCsv([{...row,seats:1.5}]),seedData.routes),/целым/);
 assert.throws(()=>csv.parseForecast(forecastCsv([{...row,"0.1_base_demand":99999}]),seedData.routes),/не упорядочены/);
 assert.throws(()=>csv.parseForecast(forecastCsv([{...row,route:"MOW-XXX"}]),seedData.routes),/неизвестный/);
 assert.throws(()=>csv.parseForecast("route,date,seats\nA,2026-06-01,10",seedData.routes),/столбцы/);
});
test("Worker WebCrypto hashes preserve rawCSV and zero delimiter",async()=>{
 assert.equal(await csv.sha256("abc"),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
 assert.equal(await csv.datasetHash("forecast\r\n","routes\n"),createHash("sha256").update("forecast\r\n\0routes\n").digest("hex"));
});
test("injection-safe CSV exports retain ordinary numeric columns",()=>{
 const scenario=snapshot();scenario.title='=SUM(1,2)';
 const exported=csv.exportScenarioCsv(scenario);assert.ok(exported.startsWith("\ufeff"));
 const parsed=csv.parseCsv(exported);assert.equal(parsed[1][0],"'=SUM(1,2)");assert.equal(parsed[1][3],"9000");
});
test("report uses saved quantiles/alternatives, original dataID and escaped user text",()=>{
 const scenario=snapshot();scenario.title='<img src=x onerror=alert(1)>';scenario.note='<script>alert(1)</script>';
 scenario.result.alternative_results=[domain.evaluate(row,info,9589,"v"),domain.evaluate(row,info,12000,"v")];
 const html=report.renderReport(scenario,{...seedData,imported_at:"2026-11-03T16:00:00Z"});
 assert.equal((html.match(/<circle data-quantile=/g)??[]).length,9);
 assert.ok(html.includes('data-quantile="0.5" data-demand="843"'));assert.ok(html.includes('data-capacity="900"'));
 assert.ok(html.includes("Альтернатива 1")&&html.includes("Альтернатива 2"));
 assert.ok(html.includes(seedData.id)&&html.includes(seedData.sha256));
 assert.ok(!html.includes('<script>alert(1)</script>'));assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
 assert.ok(!html.includes('<img src=x'));assert.ok(html.includes("80%-й интервал"));
});
test("report timezone is explicit and flight day never shifts",()=>{
 assert.equal(report.ruTimestamp("2026-11-03T16:15:00Z"),"03.11.2026 23:15 UTC+7 · Asia/Novosibirsk");
 assert.equal(report.ruTimestamp("2026-11-03T16:15:00Z","Europe/Moscow"),"03.11.2026 19:15 UTC+3 · Europe/Moscow");
 assert.equal(report.ruTimestamp("2026-11-03T16:15:00Z","Asia/Kolkata"),"03.11.2026 21:45 UTC+5:30 · Asia/Kolkata");
 assert.equal(report.ruDate("2026-06-01"),"01.06.2026");
});

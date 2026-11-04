import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeRoute} from '../lib/aviation/analytics.ts';
import {evaluate} from '../lib/aviation/domain.ts';
import {seedData} from '../lib/aviation/seed.ts';

test('timeline uses every real route-day at one selected price and matches the selected forecast exactly',()=>{
  for(const info of seedData.routes){
    const rows=seedData.rows.filter(row=>row.route===info.route).sort((a,b)=>a.date.localeCompare(b.date));
    const price=info.base_price*1.15;
    const result=analyzeRoute(seedData,{route:info.route,date:rows[7].date,price});
    assert.equal(result.timeline.length,31);assert.equal(result.selected_date,rows[7].date);
    for(let i=0;i<rows.length;i++){
      const expected=evaluate(rows[i],info,price,seedData.id),actual=result.timeline[i];
      assert.equal(actual.date,rows[i].date);assert.equal(actual.demand,expected.demand);
      assert.equal(actual.sales,expected.sales);assert.equal(actual.capacity,rows[i].seats);
      assert.equal(actual.p10,expected.quantiles[0].demand);assert.equal(actual.sales_p90,expected.quantiles[8].sales);
    }
    assert.equal(result.summary.total_sales,result.timeline.reduce((n,day)=>n+day.sales,0));
    assert.equal(result.summary.avg_load_factor,result.summary.total_sales/result.summary.total_capacity);
    assert.equal(result.timeline.find(day=>day.date===result.summary.best_day)?.contribution,Math.max(...result.timeline.map(day=>day.contribution)));
  }
});

test('analytics compares identical experiment parameters and preserves negative model estimates with zero sales',()=>{
  const input={route:'MOW-AER',date:'2026-06-01',price:18000,capacity:1200,demand_multiplier:1.2};
  const value=analyzeRoute(seedData,input),row=seedData.rows.find(row=>row.route===input.route&&row.date===input.date)!,info=seedData.routes.find(info=>info.route===input.route)!;
  const selected=evaluate(row,info,input.price,seedData.id,1200,1.2),base=evaluate(row,info,info.base_price,seedData.id,1200,1.2);
  assert.equal(value.is_experiment,true);assert.ok(value.timeline.every(day=>day.capacity===1200));
  assert.equal(value.timeline[0].demand,selected.demand);assert.ok(value.timeline[0].demand<0);assert.equal(value.timeline[0].sales,0);
  assert.equal(value.selected.contribution_delta,selected.contribution-base.contribution);
  assert.equal(value.selected.sales_p10,selected.quantiles[0].sales);
  const zeroBase={...seedData,routes:seedData.routes.map(item=>item.route===input.route?{...item,cost_per_passenger:item.base_price}:item)};
  const zero=analyzeRoute(zeroBase,{...input,price:9000});
  assert.equal(zero.selected.base_contribution,0);assert.equal(zero.selected.contribution_delta_pct,null);
});

test('analytics never fabricates missing departure pairs or unsupported flight dates',()=>{
  const base={route:'MOW-AER',date:'2026-06-01',price:9000};
  assert.throws(()=>analyzeRoute(seedData,{...base,route:'AER-MOW'}),/нет прогноза/);
  assert.throws(()=>analyzeRoute(seedData,{...base,date:'2026-11-04'}),/нет прогноза/);
  assert.throws(()=>analyzeRoute(seedData,{...base,price:NaN}),/Цена/);
});

import {DataError,evaluate,type SeedDataset} from './domain.ts';

export interface AnalyticsInput {route:string;date:string;price:number;capacity?:number|null;demand_multiplier?:number;}

/** Every day uses the same selected price and experiment parameters. */
export function analyzeRoute(dataset:SeedDataset,input:AnalyticsInput){
  const info=dataset.routes.find(item=>item.route===input.route);
  const rows=dataset.rows.filter(row=>row.route===input.route).sort((a,b)=>a.date.localeCompare(b.date));
  const selectedRow=rows.find(row=>row.date===input.date);
  if(!info||!selectedRow)throw new DataError('Для этого направления и даты нет прогноза. Выберите доступные данные.');
  const multiplier=input.demand_multiplier??1;
  const selected=evaluate(selectedRow,info,input.price,dataset.id,input.capacity,multiplier);
  const baseline=evaluate(selectedRow,info,info.base_price,dataset.id,input.capacity,multiplier);
  const recommended=evaluate(selectedRow,info,selected.recommended_price,dataset.id,input.capacity,multiplier);
  const timeline=rows.map(row=>{
    const value=evaluate(row,info,input.price,dataset.id,input.capacity,multiplier);
    return {date:row.date,demand:value.demand,sales:value.sales,capacity:value.capacity,load_factor:value.load_factor,
      p10:value.quantiles[0].demand,p90:value.quantiles[8].demand,
      sales_p10:value.quantiles[0].sales,sales_p90:value.quantiles[8].sales,
      revenue:value.revenue,contribution:value.contribution,recommended_price:value.recommended_price};
  });
  const sum=(key:'sales'|'capacity'|'revenue'|'contribution')=>timeline.reduce((total,item)=>total+item[key],0);
  const totalCapacity=sum('capacity');
  const ranked=[...timeline].sort((a,b)=>b.contribution-a.contribution||a.date.localeCompare(b.date));
  const delta=selected.contribution-baseline.contribution;
  return {dataset_id:dataset.id,route:input.route,price:input.price,selected_date:input.date,is_experiment:selected.is_experiment,
    timeline,
    selected:{base_contribution:baseline.contribution,contribution_delta:delta,
      contribution_delta_pct:baseline.contribution===0?null:delta/Math.abs(baseline.contribution)*100,
      recommended_contribution:recommended.contribution,improvement_to_recommended:recommended.contribution-selected.contribution,
      demand_above_capacity:Math.max(0,selected.demand-selected.capacity),
      sales_p10:selected.quantiles[0].sales,sales_p90:selected.quantiles[8].sales},
    summary:{days:timeline.length,total_sales:sum('sales'),total_capacity:totalCapacity,
      total_revenue:sum('revenue'),total_contribution:sum('contribution'),
      avg_load_factor:totalCapacity?sum('sales')/totalCapacity:0,
      days_deficit:timeline.filter(item=>item.demand>item.capacity).length,
      days_low:timeline.filter(item=>item.load_factor<.65).length,
      best_day:ranked[0]?.date??null,worst_day:ranked.at(-1)?.date??null}};
}

export type RouteAnalytics=ReturnType<typeof analyzeRoute>;

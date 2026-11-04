/** Deterministic case mathematics shared by the Worker, website and Telegram bot. */
export const QUANTILES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;
export type QuantileKey = "0.1"|"0.2"|"0.3"|"0.4"|"0.5"|"0.6"|"0.7"|"0.8"|"0.9";
export type ForecastRow = {route: string; date: string; seats: number} & Record<`${QuantileKey}_${"base_demand"|"price"|"price_demand"}`, number>;
export interface RouteInfo {
  route: string; name: string; origin: string; destination: string;
  base_price: number; cost_per_passenger: number; price_sensitivity: number;
  price_min: number; price_max: number;
}
export interface Forecast {
  route: string; date: string; price: number; base_price: number; capacity: number;
  demand: number; sales: number; empty_seats: number; load_factor: number;
  revenue: number; contribution: number;
  quantiles: {q: number; demand: number; sales: number}[];
  reference_price: number; recommended_price: number;
  price_curve: {price: number; sales: number; revenue: number; contribution: number}[];
  explanation: string[]; dataset_id: string; is_experiment: boolean;
  demand_multiplier: number; capacity_override: number|null;
  alternative_results?: Forecast[];
}
export interface SeedDataset {
  id: string; sha256: string; filename: string; rows: ForecastRow[]; routes: RouteInfo[];
  start_date: string; end_date: string; imported_at?: string; warnings?: string[];
}
export interface ReportScenario {
  id: string; title: string; note?: string; route: string; date: string; price: number;
  status: string; created_at: string; dataset_id: string; result: Forecast;
}
export class DataError extends Error {
  constructor(message: string) { super(message); this.name = "DataError"; }
}
const format = (value: number, digits=0) => new Intl.NumberFormat("ru-RU", {minimumFractionDigits:digits, maximumFractionDigits:digits}).format(value);

export function evaluate(row: ForecastRow, info: RouteInfo, price: number, datasetId: string, capacity?: number|null, demandMultiplier=1): Forecast {
  if (!Number.isFinite(price) || price < 0 || price > 1e9) throw new DataError("Цена должна быть числом от 0 до 1 000 000 000 ₽.");
  if (capacity != null && (!Number.isInteger(capacity) || capacity <= 0 || capacity > 1e6)) throw new DataError("Вместимость должна быть положительным целым числом не больше 1 000 000.");
  if (!Number.isFinite(demandMultiplier) || demandMultiplier <= 0 || demandMultiplier > 10) throw new DataError("Множитель спроса должен быть больше 0 и не больше 10.");
  const seats = capacity ?? row.seats;
  const slope = info.price_sensitivity, baseline = info.base_price, cost = info.cost_per_passenger;
  const quantiles = QUANTILES.map(q => {
    const key = `${q.toFixed(1)}_base_demand` as keyof ForecastRow;
    const demand = Number(row[key]) * demandMultiplier - slope * (price - baseline);
    return {q, demand, sales: Math.min(seats, Math.max(0,demand))};
  });
  const median = quantiles[4], baseDemand = row["0.5_base_demand"] * demandMultiplier;
  const optimum = Math.min(info.price_max, Math.max(info.price_min, (cost + baseline + baseDemand/slope)/2, baseline + (baseDemand-seats)/slope));
  const prices = new Set(Array.from({length:61}, (_,i) => info.price_min + (info.price_max-info.price_min)*i/60));
  prices.add(price); prices.add(optimum); prices.add(baseline);
  const curve = [...prices].sort((a,b)=>a-b).map(p => {
    const sales = Math.min(seats, Math.max(0,baseDemand-slope*(p-baseline)));
    return {price:p,sales,revenue:p*sales,contribution:(p-cost)*sales};
  });
  const explanation = [
    `Базовый медианный спрос: ${format(baseDemand,2)} чел. при цене ${format(baseline)} ₽.`,
    `Изменение цены на 1 000 ₽ меняет спрос на ${format(slope*1000,2)} чел.`,
    "Продажи ограничены вместимостью. Свободные места — прогноз, фактические бронирования не загружены.",
    "Маржинальная прибыль учитывает расходы на пассажира, но не постоянные расходы на рейсы.",
    "Рекомендованная цена максимизирует маржинальную прибыль по медиане в допустимом диапазоне.",
  ];
  const outside = price < info.price_min || price > info.price_max;
  if (outside) explanation.push("Введённая цена вне допустимого диапазона оптимизации; линейный прогноз показан как расчётный эксперимент.");
  return {route:row.route,date:row.date,price,base_price:baseline,capacity:seats,
    demand:median.demand,sales:median.sales,empty_seats:seats-median.sales,
    load_factor:median.sales/seats,revenue:price*median.sales,contribution:(price-cost)*median.sales,
    quantiles,reference_price:row["0.5_price"],recommended_price:optimum,price_curve:curve,
    explanation,dataset_id:datasetId,is_experiment:seats!==row.seats || demandMultiplier!==1 || outside,
    demand_multiplier:demandMultiplier,capacity_override:capacity ?? null};
}

export function classify(result: Forecast): ["deficit"|"low"|"uncertain"|"normal",string] {
  if (result.demand > result.capacity) return ["deficit","Медианный спрос превышает вместимость."];
  if (result.load_factor < .65) return ["low","Медианная загрузка ниже 65%."];
  if (result.quantiles[8].demand-result.quantiles[0].demand > result.capacity*.4) return ["uncertain","Широкий интервал прогноза: стоит сравнить сценарии."];
  return ["normal","Нет выбранных сигналов дефицита или низкой загрузки."];
}

import {DataError, QUANTILES, type ForecastRow, type ReportScenario, type RouteInfo} from "./domain.ts";
export {DataError} from "./domain.ts";
export const ROUTE_FIELDS = ["route","name","base_price","cost_per_passenger","price_sensitivity","price_min","price_max"] as const;
export const FORECAST_FIELDS = ["route","date","seats",...QUANTILES.flatMap(q=>["base_demand","price","price_demand"].map(field=>`${q.toFixed(1)}_${field}`))];

/** RFC4180-style CSV state machine: quoted commas/newlines, doubled quotes, BOM and CRLF. */
export function parseCsv(raw: string): string[][] {
  const text = raw.replace(/^\uFEFF/,"");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (quoted) {
      if (c==='"') {
        if(text[i+1]==='"'){field+='"';i++;} else {quoted=false;closed=true;}
      } else field+=c;
    } else if (c===',') {row.push(field);field="";closed=false;}
    else if(c==='\n'||c==='\r') {
      row.push(field);if(row.some(value=>value!==""))rows.push(row);
      row=[];field="";closed=false;if(c==='\r'&&text[i+1]==='\n')i++;
    } else if(c==='"'&&field===""&&!closed) quoted=true;
    else {
      if(closed || c==='"')throw new DataError("CSV: неверное оформление кавычек.");
      field+=c;
    }
  }
  if(quoted)throw new DataError("CSV: незакрытое поле в кавычках.");
  row.push(field);if(row.some(value=>value!==""))rows.push(row);
  return rows;
}

function readRecords(raw: string, expected: readonly string[], label: string): Record<string,string>[] {
  if(new TextEncoder().encode(raw).length>10*1024*1024)throw new DataError(`${label}: размер файла превышает 10 МБ.`);
  const rows=parseCsv(raw),header=rows.shift();
  if(!header || new Set(header).size!==header.length)throw new DataError(`${label}: пустой файл или повторяющиеся заголовки.`);
  if(header.length!==expected.length || expected.some(key=>!header.includes(key)))throw new DataError(`${label}: неверные столбцы.`);
  if(rows.length>100000)throw new DataError("В прогнозе больше 100 000 строк.");
  return rows.map((row,i)=>{
    if(row.length!==header.length)throw new DataError(`${label}, строка ${i+2}: неверное число полей.`);
    return Object.fromEntries(header.map((key,j)=>[key,row[j]]));
  });
}

function numeric(value: string, label: string, positive=false): number {
  if(value.trim()==="" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))throw new DataError(`${label}: требуется число.`);
  const result=Number(value);
  if(!Number.isFinite(result) || result<0 || (positive&&result<=0) || result>1e12)throw new DataError(`${label}: число вне допустимого диапазона.`);
  return result;
}

export function parseRoutes(raw: string): RouteInfo[] {
  const seen=new Set<string>();
  const result=readRecords(raw,ROUTE_FIELDS,"Справочник").map((record,i)=>{
    const route=record.route.trim(),name=record.name.trim(),line=i+2;
    if(!route || route.length>40 || seen.has(route))throw new DataError(`Справочник, строка ${line}: неверный или повторный маршрут.`);
    seen.add(route);
    const cities=name.includes(" — ")?name.split(" — "):name.split(" - ");
    const item={route,name,origin:cities[0],destination:cities[cities.length-1]} as RouteInfo;
    for(const field of ROUTE_FIELDS.slice(2) as (keyof Pick<RouteInfo,"base_price"|"cost_per_passenger"|"price_sensitivity"|"price_min"|"price_max">)[])item[field]=numeric(record[field],`Строка ${line}, ${field}`,["base_price","price_sensitivity","price_max"].includes(field));
    if(item.price_min>item.price_max || item.base_price<item.price_min || item.base_price>item.price_max)throw new DataError(`Справочник, строка ${line}: неверные границы цены.`);
    return item;
  });
  if(!result.length)throw new DataError("Справочник пуст.");
  return result;
}

export function parseForecast(raw: string, routes: RouteInfo[]): ForecastRow[] {
  const seen=new Set<string>(),known=new Set(routes.map(r=>r.route));
  const result=readRecords(raw,FORECAST_FIELDS,"Прогноз").map((record,i)=>{
    const route=record.route.trim(),day=record.date,line=i+2;
    const parsed=new Date(day+"T00:00:00Z");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0,10)!==day)throw new DataError(`Прогноз, строка ${line}: неверная дата.`);
    const key=JSON.stringify([route,day]);
    if(!known.has(route)||seen.has(key))throw new DataError(`Прогноз, строка ${line}: неизвестный маршрут или повторная дата.`);
    seen.add(key);
    const seats=numeric(record.seats,`Строка ${line}, места`,true);
    if(!Number.isInteger(seats)||seats>1e6)throw new DataError(`Прогноз, строка ${line}: число мест должно быть положительным целым.`);
    const item={route,date:day,seats} as ForecastRow;
    for(const field of FORECAST_FIELDS.slice(3)) (item as unknown as Record<string,string|number>)[field]=numeric(record[field],`Строка ${line}, ${field}`);
    for(const field of ["base_demand","price","price_demand"]){
      const values=QUANTILES.map(q=>Number(item[`${q.toFixed(1)}_${field}` as keyof ForecastRow]));
      if(values.some((v,j)=>j>0&&v<values[j-1]))throw new DataError(`Прогноз, строка ${line}: квантили ${field} не упорядочены.`);
    }
    return item;
  });
  if(!result.length)throw new DataError("Файл прогноза пуст.");
  return result;
}

export async function sha256(raw: string|Uint8Array): Promise<string> {
  const bytes=typeof raw==="string"?new TextEncoder().encode(raw):raw;
  const digest=await crypto.subtle.digest("SHA-256",bytes as BufferSource);
  return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,"0")).join("");
}
export async function datasetHash(forecast: string, routes: string): Promise<string> {return sha256(forecast+"\0"+routes);}
const cell=(value: unknown)=>'"'+String(value??"").replaceAll('"','""')+'"';
export const safeSpreadsheetText=(value: string)=>/^[=+\-@\t\r]/.test(value)?"'"+value:value;
export function exportScenarioCsv(scenario: ReportScenario,language:'ru'|'en'='ru'): string {
  const r=scenario.result;
  const header=language==='en'?["Title","Route","Date","Price, RUB","Capacity","Demand, median","Sales, median","Forecast unsold seats","Revenue, RUB","Contribution, RUB","Dataset version"]:["Название","Маршрут","Дата","Цена, ₽","Места","Спрос, медиана","Продажи, медиана","Прогноз свободных мест","Выручка, ₽","Маржинальная прибыль, ₽","Версия данных"];
  const row=[safeSpreadsheetText(scenario.title),safeSpreadsheetText(scenario.route),scenario.date,scenario.price,r.capacity,r.demand,r.sales,r.empty_seats,r.revenue,r.contribution,scenario.dataset_id];
  return "\uFEFF"+[header,row].map(line=>line.map(cell).join(",")).join("\r\n")+"\r\n";
}
export function exportRoutesCsv(routes: RouteInfo[]): string {return [ROUTE_FIELDS,...routes.map(route=>ROUTE_FIELDS.map(key=>route[key]))].map(row=>row.map(cell).join(",")).join("\r\n")+"\r\n";}

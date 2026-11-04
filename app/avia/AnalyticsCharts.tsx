import {t,tf,locale,routeName,cityName,canonicalCity,useLanguage} from './i18n';
import { useEffect, useId, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { BarChart3, CalendarDays, LayoutGrid, RefreshCw, Target, TrendingUp } from 'lucide-react';
import { day, money, number, type Analytics, type Forecast, type TimelinePoint } from './api';
const W = 820, H = 326, L = 82, R = 790, T = 53, B = 252;
const C = { demand: 'var(--chart-demand)', sales: 'var(--chart-sales)', capacity: 'var(--chart-capacity)', revenue: 'var(--chart-revenue)', contribution: 'var(--chart-contribution)', band: 'var(--chart-band)', text: 'var(--text)', grid: 'var(--chart-grid)' };
function extent(values: number[]) { const min = Math.min(0, ...values), max = Math.max(1, ...values), padding = (max - min) * .08; return [min < 0 ? min - padding : 0, max + padding] as const; }
const linear = (value: number, min: number, max: number, start: number, end: number) => start + (value - min) / (max - min || 1) * (end - start);
const ticks = (min: number, max: number, count = 5) => Array.from({ length: count }, (_, index) => min + (max - min) * index / (count - 1));
const line = (points: {
    x: number;
    y: number;
}[]) => points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
const compactMoney = (value: number) => Math.abs(value) >= 1e6 ? number(value / 1e6, 1) + t(" млн") : Math.abs(value) >= 1e3 ? number(value / 1e3, 0) + t(" тыс.") : number(value);
const signedMoney = (value: number) => (value >= .5 ? '+ ' : '') + money(Math.abs(value) < .5 ? 0 : value);
function pointerX(event: PointerEvent<SVGSVGElement>) { const rect = event.currentTarget.getBoundingClientRect(); return (event.clientX - rect.left) / rect.width * W; }
function nearest(values: number[], value: number) { let best = 0; for (let i = 1; i < values.length; i++)
    if (Math.abs(values[i] - value) < Math.abs(values[best] - value))
        best = i; return best; }
function moveIndex(event: KeyboardEvent<SVGSVGElement>, index: number, length: number, onChange: (value: number) => void) { const next = event.key === 'ArrowLeft' ? index - 1 : event.key === 'ArrowRight' ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : null; if (next === null)
    return; event.preventDefault(); onChange(Math.max(0, Math.min(length - 1, next))); }
function Legend({ items }: {
    items: {
        name: string;
        color: string;
        dashed?: boolean;
        band?: boolean;
    }[];
}) { return <div className="analytics-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 18px', padding: '0 24px 16px', color: 'var(--text-muted)', fontSize: 12 }}>{items.map(item => <span key={item.name} style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}><i aria-hidden style={{ display: 'inline-block', width: 18, height: item.band ? 10 : 0, background: item.band ? item.color : undefined, borderTop: item.band ? undefined : `3px ${item.dashed ? 'dashed' : 'solid'} ${item.color}`, borderRadius: item.band ? 2 : undefined }}/>{item.name}</span>)}</div>; }
function Tooltip({ title, children }: {
    title: string;
    children: ReactNode;
}) { return <div className="analytics-tooltip" role="status" aria-live="polite" style={{ position: 'static', width: 'auto', maxWidth: 'none', margin: '0 24px 16px', boxShadow: 'none' }}><strong>{title}</strong><div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 20px' }}>{children}</div></div>; }
function Card({ title, subtitle, children, action }: {
    title: string;
    subtitle: string;
    children: ReactNode;
    action?: ReactNode;
}) { return <section className="analytics-chart-card"><div className="analytics-chart-header"><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</div>{children}</section>; }
export function DemandChart({ result }: {
    result: Forecast;
}) {
    const [active, setActive] = useState(4), id = useId(), values = result.quantiles.map(q => q.demand), [min, max] = extent([...values, result.capacity]), x = (value: number) => linear(value, min, max, L, R), y = (q: number) => linear(q, .1, .9, B, T), point = result.quantiles[active] ?? result.quantiles[4];
    return <Card title={t("Насколько может измениться спрос")} subtitle={tf("Девять квантилей при одной цене {0}. Вместимость ограничивает продажи.", [money(result.price)])}><div className="analytics-chart-body"><svg className="analytics-plot" viewBox={`0 0 ${W} ${H}`} tabIndex={0} role="img" aria-labelledby={id + '-title'} onPointerMove={event => setActive(nearest(values, linear(pointerX(event), L, R, min, max)))} onKeyDown={event => moveIndex(event, active, values.length, setActive)}><title id={id + '-title'}><>{t("Квантили спроса: медиана")} </>{number(result.demand, 2)}<> {t("человек, вместимость")} </>{number(result.capacity)}<> {t("мест. Стрелки влево и вправо выбирают квантиль.")}</></title><rect x={x(values[0])} y={T} width={Math.max(0, x(values[8]) - x(values[0]))} height={B - T} fill={C.band}/><text x={L} y="21">{t("Уровень квантиля")}</text>{[.1, .3, .5, .7, .9].map(q => <g key={q}><line x1={L} x2={R} y1={y(q)} y2={y(q)} stroke={C.grid}/><text x={L - 14} y={y(q) + 5} textAnchor="end">{number(q * 100)}%</text></g>)}{ticks(min, max, 6).map(value => <g key={value}><line x1={x(value)} x2={x(value)} y1={T} y2={B} stroke={C.grid} opacity=".55"/><text x={x(value)} y={B + 25} textAnchor="middle">{number(value)}</text></g>)}<line x1={x(result.capacity)} x2={x(result.capacity)} y1={T - 9} y2={B} stroke={C.capacity} strokeWidth="2" strokeDasharray="6 5"/><text x={Math.min(R - 4, Math.max(L + 4, x(result.capacity)))} y="39" textAnchor={x(result.capacity) > R - 130 ? 'end' : 'start'}><>{t("Мест:")} </>{number(result.capacity)}</text><path d={line(result.quantiles.map(q => ({ x: x(q.demand), y: y(q.q) })))} fill="none" stroke={C.demand} strokeWidth="3" strokeLinejoin="round"/>{result.quantiles.map((q, index) => <circle key={q.q} cx={x(q.demand)} cy={y(q.q)} r={index === 4 ? 6 : 4} fill={index === 4 ? C.text : C.demand} stroke="var(--surface)" strokeWidth="2"/>)}<circle cx={x(point.demand)} cy={y(point.q)} r="8" fill="var(--surface)" stroke={C.demand} strokeWidth="3"/><text x={(L + R) / 2} y={H - 11} textAnchor="middle">{t("Расчётный спрос, чел.")}</text></svg></div><Legend items={[{ name: t("Квантили спроса"), color: C.demand }, { name: t("Медиана P50"), color: C.text }, { name: t("Вместимость"), color: C.capacity, dashed: true }, { name: t("Диапазон P10–P90"), color: C.band, band: true }]}/><Tooltip title={`P${number(point.q * 100)} · ${money(result.price)}`}><span><>{t("Спрос:")} </><b>{number(point.demand, 2)}<> {t("чел.")}</></b></span><span><>{t("Продажи:")} </><b>{number(point.sales, 2)}<> {t("билетов")}</></b></span></Tooltip><p className="analytics-note">{t("P10–P90 — центральный интервал квантильного прогноза. Линия соединяет известные квантили и не является плотностью распределения. Медиана совпадает с основным расчётом.")}</p></Card>;
}
export function FinancialChart({ result, onSelectPrice }: {
    result: Forecast;
    onSelectPrice: (value: number) => void;
}) {
    const points = result.price_curve, id = useId(), currentIndex = Math.max(0, points.findIndex(point => point.price === result.price)), [active, setActive] = useState(currentIndex);
    useEffect(() => setActive(currentIndex), [result.price, result.route, result.date]);
    if (!points.length)
        return null;
    const minP = points[0].price, maxP = points.at(-1)!.price, [minY, maxY] = extent(points.flatMap(point => [point.revenue, point.contribution])), x = (value: number) => linear(value, minP, maxP, L, R), y = (value: number) => linear(value, minY, maxY, B, T), point = points[Math.min(active, points.length - 1)];
    const optimum = points.find(p => Math.abs(p.price - result.recommended_price) < .001), same = Math.abs(result.price - result.recommended_price) < .01;
    return <Card title={t("Как цена влияет на финансовый результат")} subtitle={t("Выручка и маржинальный доход по медианному спросу. Постоянные расходы не учтены.")} action={<button type="button" className="text-btn" onClick={() => onSelectPrice(Number(result.recommended_price.toFixed(2)))}><Target size={15}/>{t("Выбрать оптимум")}</button>}><div className="analytics-chart-body"><svg className="analytics-plot" viewBox={`0 0 ${W} ${H}`} tabIndex={0} role="img" aria-labelledby={id + '-title'} onPointerMove={event => setActive(nearest(points.map(p => p.price), linear(pointerX(event), L, R, minP, maxP)))} onKeyDown={event => moveIndex(event, active, points.length, setActive)}><title id={id + '-title'}><>{t("Выручка и маржинальный доход в зависимости от цены. Выбранная цена")} </>{money(result.price)}<>{t(", оптимальная цена по медиане")} </>{money(result.recommended_price)}{t(". Стрелки выбирают точку.")}</title><text x={L} y="21">{t("Рубли")}</text>{ticks(minY, maxY).map(value => <g key={value}><line x1={L} x2={R} y1={y(value)} y2={y(value)} stroke={C.grid}/><text x={L - 12} y={y(value) + 5} textAnchor="end">{compactMoney(value)}</text></g>)}{ticks(minP, maxP, 6).map(value => <text key={value} x={x(value)} y={B + 25} textAnchor="middle">{number(value / 1000, 1)}</text>)}<path d={line(points.map(p => ({ x: x(p.price), y: y(p.revenue) })))} stroke={C.revenue} strokeWidth="3" fill="none"/><path d={line(points.map(p => ({ x: x(p.price), y: y(p.contribution) })))} stroke={C.contribution} strokeWidth="3" fill="none"/><line x1={x(result.price)} x2={x(result.price)} y1={T - 8} y2={B} stroke={C.text} strokeDasharray="4 5" opacity=".7"/><text x={x(result.price)} y="39" textAnchor={x(result.price) > R - 120 ? 'end' : x(result.price) < L + 120 ? 'start' : 'middle'}>{same ? t("Выбрана оптимальная цена") : t("Выбранная цена")}</text>{!same && <><line x1={x(result.recommended_price)} x2={x(result.recommended_price)} y1={T} y2={B} stroke={C.contribution} strokeWidth="2" strokeDasharray="7 5"/>{optimum && <circle cx={x(optimum.price)} cy={y(optimum.contribution)} r="7" fill="var(--surface)" stroke={C.contribution} strokeWidth="3"/>}</>}<circle cx={x(result.price)} cy={y(result.contribution)} r="6" fill={C.text} stroke="var(--surface)" strokeWidth="2"/><line x1={x(point.price)} x2={x(point.price)} y1={T} y2={B} stroke={C.grid} strokeDasharray="3 3"/><circle cx={x(point.price)} cy={y(point.revenue)} r="5" fill={C.revenue}/><circle cx={x(point.price)} cy={y(point.contribution)} r="5" fill={C.contribution}/><text x={(L + R) / 2} y={H - 11} textAnchor="middle">{t("Цена билета, тыс. ₽")}</text></svg></div><Legend items={[{ name: t("Выручка"), color: C.revenue }, { name: t("Маржинальный доход"), color: C.contribution }, { name: tf("Оптимум: {0}", [money(result.recommended_price)]), color: C.contribution, dashed: true }, { name: t("Выбранная цена"), color: C.text, dashed: true }]}/><Tooltip title={tf("При цене {0}", [money(point.price)])}><span><>{t("Продажи:")} </><b>{number(point.sales, 2)}</b></span><span><>{t("Выручка:")} </><b>{money(point.revenue)}</b></span><span><>{t("Маржа:")} </><b>{money(point.contribution)}</b></span></Tooltip></Card>;
}
export function TimelineChart({ analytics, onSelectDate }: {
    analytics: Analytics;
    onSelectDate: (value: string) => void;
}) {
    const rows = analytics.timeline, id = useId(), selectedIndex = Math.max(0, rows.findIndex(point => point.date === analytics.selected_date)), [active, setActive] = useState(selectedIndex);
    useEffect(() => setActive(selectedIndex), [analytics.selected_date, analytics.route, analytics.price]);
    if (!rows.length)
        return null;
    const minDate = Date.parse(rows[0].date + 'T12:00:00Z'), maxDate = Date.parse(rows.at(-1)!.date + 'T12:00:00Z'), [minY, maxY] = extent(rows.flatMap(p => [p.p10, p.p90, p.capacity, p.demand, p.sales])), x = (date: string) => linear(Date.parse(date + 'T12:00:00Z'), minDate, maxDate, L, R), y = (value: number) => linear(value, minY, maxY, B, T), point = rows[Math.min(active, rows.length - 1)];
    const groups: TimelinePoint[][] = [];
    for (const row of rows) {
        const last = groups.at(-1);
        if (!last || Date.parse(row.date + 'T12:00:00Z') - Date.parse(last.at(-1)!.date + 'T12:00:00Z') > 86400000)
            groups.push([row]);
        else
            last.push(row);
    }
    const dateTicks = [...new Set([0, ...Array.from({ length: 5 }, (_, i) => Math.round(i * (rows.length - 1) / 4)), rows.length - 1])];
    const selectAt = (coordinate: number) => nearest(rows.map(row => x(row.date)), coordinate);
    return <Card title={t("Спрос и продажи по датам")} subtitle={tf("Доступные даты: {0}. Одна цена {1}. Нажмите на дату, чтобы открыть её расчёт.", [analytics.summary.days, money(analytics.price)])}><div className="analytics-chart-body"><svg className="analytics-plot" viewBox={`0 0 ${W} ${H}`} tabIndex={0} role="img" aria-labelledby={id + '-title'} onPointerMove={event => setActive(selectAt(pointerX(event)))} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); onSelectDate(rows[selectAt((event.clientX - rect.left) / rect.width * W)].date); }} onKeyDown={event => { if (event.key === 'Enter') {
        event.preventDefault();
        onSelectDate(point.date);
    }
    else
        moveIndex(event, active, rows.length, setActive); }}><title id={id + '-title'}><>{t("Медианный спрос, продажи и вместимость по доступным датам, при одной выбранной цене")} </>{money(analytics.price)}{t(". Диапазон P10–P90 показывает неопределённость спроса. Стрелки выбирают дату, Enter открывает расчёт.")}</title><text x={L} y="21">{t("Пассажиры / места")}</text>{ticks(minY, maxY).map(value => <g key={value}><line x1={L} x2={R} y1={y(value)} y2={y(value)} stroke={C.grid}/><text x={L - 12} y={y(value) + 5} textAnchor="end">{number(value)}</text></g>)}{groups.map((group, index) => <g key={index}><path d={line([...group.map(p => ({ x: x(p.date), y: y(p.p90) })), ...[...group].reverse().map(p => ({ x: x(p.date), y: y(p.p10) }))]) + ' Z'} fill={C.band}/><path d={line(group.map(p => ({ x: x(p.date), y: y(p.demand) })))} stroke={C.demand} strokeWidth="2.5" strokeDasharray="6 4" fill="none"/><path d={line(group.map(p => ({ x: x(p.date), y: y(p.sales) })))} stroke={C.sales} strokeWidth="3" fill="none"/><path d={line(group.map(p => ({ x: x(p.date), y: y(p.capacity) })))} stroke={C.capacity} strokeWidth="2" strokeDasharray="7 5" fill="none"/></g>)}{dateTicks.map(index => <text key={index} x={x(rows[index].date)} y={B + 25} textAnchor="middle">{rows[index].date.slice(8, 10)}.{rows[index].date.slice(5, 7)}</text>)}<line x1={x(analytics.selected_date)} x2={x(analytics.selected_date)} y1={T} y2={B} stroke={C.text} strokeDasharray="3 5" opacity=".5"/><line x1={x(point.date)} x2={x(point.date)} y1={T} y2={B} stroke={C.grid}/><circle cx={x(point.date)} cy={y(point.sales)} r="6" fill={C.sales} stroke="var(--surface)" strokeWidth="2"/><circle cx={x(point.date)} cy={y(point.demand)} r="5" fill={C.demand} stroke="var(--surface)" strokeWidth="2"/><text x={(L + R) / 2} y={H - 11} textAnchor="middle"><>{t("Дата ·")} </>{rows[0].date.slice(0, 4)}<> {t("год")}</></text></svg></div><Legend items={[{ name: t("Спрос P50"), color: C.demand, dashed: true }, { name: t("Продажи P50"), color: C.sales }, { name: t("Вместимость"), color: C.capacity, dashed: true }, { name: t("Спрос P10–P90"), color: C.band, band: true }]}/><Tooltip title={new Date(point.date + 'T12:00:00Z').toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}><span><>{t("Спрос:")} </><b>{number(point.demand, 2)}</b></span><span><>{t("Продажи:")} </><b>{number(point.sales, 2)} / {number(point.capacity)}</b></span><span><>{t("Загрузка:")} </><b>{number(point.load_factor * 100, 1)}%</b></span><span>P10–P90: <b>{number(point.p10)}–{number(point.p90)}</b></span></Tooltip><div className="analytics-summary"><span><>{t("Продажи за период:")} </><strong>{number(analytics.summary.total_sales)}<> {t("билетов")}</></strong></span><span><>{t("Средняя загрузка:")} </><strong>{number(analytics.summary.avg_load_factor * 100, 1)}%</strong></span><span><>{t("Дней с дефицитом:")} </><strong>{analytics.summary.days_deficit}</strong></span></div><p className="analytics-note" style={{ paddingTop: 14 }}>{t("Для всех дат использованы одинаковые выбранная цена и экспериментальные допущения. Показаны только даты из CSV; пропуски не заполняются. Полоса относится к спросу, продажи ограничены вместимостью.")}</p></Card>;
}
export type ChartTab = 'demand' | 'finance' | 'timeline' | 'all';
export function AnalyticsPanel({ result, analytics, analyticsError, onSelectPrice, onSelectDate, onRetry, tab, onTabChange }: {
    result: Forecast;
    analytics: Analytics | null;
    analyticsError: string;
    onSelectPrice: (value: number) => void;
    onSelectDate: (value: string) => void;
    onRetry: () => void;
    tab: ChartTab;
    onTabChange: (value: ChartTab) => void;
}) {
    const id = useId(), setTab = onTabChange;
    const tabs = [{ key: 'demand', label: t("Спрос"), Icon: BarChart3 }, { key: 'finance', label: t("Доходность"), Icon: TrendingUp }, { key: 'timeline', label: t("По датам"), Icon: CalendarDays }, { key: 'all', label: t("Все графики"), Icon: LayoutGrid }] as const;
    return <div><div className="analytics-toolbar"><div className="analytics-tabs" role="tablist" aria-label={t("Графики прогноза")}>{tabs.map((item, index) => <button key={item.key} type="button" role="tab" id={id + '-' + item.key} aria-selected={tab === item.key} aria-controls={id + '-panel'} tabIndex={tab === item.key ? 0 : -1} onClick={() => setTab(item.key)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
        return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; setTab(tabs[next].key); document.getElementById(id + '-' + tabs[next].key)?.focus(); }}><item.Icon size={16}/>{item.label}</button>)}</div></div><div role="tabpanel" id={id + '-panel'} aria-labelledby={id + '-' + tab}>{(tab === 'demand' || tab === 'all') && <DemandChart result={result}/>}{(tab === 'finance' || tab === 'all') && <FinancialChart result={result} onSelectPrice={onSelectPrice}/>}{(tab === 'timeline' || tab === 'all') && (analytics ? <TimelineChart analytics={analytics} onSelectDate={onSelectDate}/> : <section className="analytics-chart-card"><div className="analytics-empty"><CalendarDays size={26}/><strong>{t("Динамика по датам пока недоступна")}</strong><p>{t(analyticsError) || t("Повторите расчёт, чтобы загрузить данные периода.")}</p><button type="button" className="btn btn-outline" onClick={onRetry}><RefreshCw size={16}/>{t("Повторить")}</button></div></section>)}</div>{analytics && <div className="analytics-stats"><div><span>{t("Маржа к базовой цене")}</span><strong>{signedMoney(analytics.selected.contribution_delta)}</strong><small>{analytics.selected.contribution_delta_pct === null ? t("Сравнение по медиане") : tf("{0}% по медиане", [number(analytics.selected.contribution_delta_pct, 1)])}</small></div><div><span>{t("Переход к рекомендации")}</span><strong>{signedMoney(analytics.selected.improvement_to_recommended)}</strong><small>{t("изменение маржи в допустимом диапазоне")}</small></div><div><span>{t("Продажи P10–P90")}</span><strong>{number(analytics.selected.sales_p10)}–{number(analytics.selected.sales_p90)}</strong><small>{t("билетов при выбранной цене")}</small></div><div><span>{t("Спрос сверх вместимости")}</span><strong>{number(analytics.selected.demand_above_capacity)}</strong><small>{t("человек по медиане")}</small></div></div>}</div>;
}

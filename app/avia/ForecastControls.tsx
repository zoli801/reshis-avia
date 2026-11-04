import {t,tf,locale,routeName,cityName,canonicalCity,useLanguage} from './i18n';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Plane, Target } from 'lucide-react';
import type { Route } from './api';
export type CitySuggestion = {
    name: string;
    code: string;
};
const normalize = (value: string) => value.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/\s+/g, ' ');
export function knownCities(routes: Route[]): CitySuggestion[] {
    const result = new Map<string, CitySuggestion>();
    for (const route of routes) {
        const [originCode, destinationCode] = route.route.split('-');
        for (const city of [{ name: route.origin, code: originCode }, { name: route.destination, code: destinationCode }])
            if (city.name && !result.has(normalize(city.name)))
                result.set(normalize(city.name), city);
    }
    return [...result.values()];
}
export function matchingRoute(routes: Route[], origin: string, destination: string): Route | undefined {
    const matches = (value: string, name: string, code: string) => normalize(canonicalCity(value)) === normalize(name) || normalize(value) === normalize(code) || normalize(value) === normalize(`${name} · ${code}`) || normalize(value) === normalize(`${cityName(name)} · ${code}`);
    return routes.find(route => { const [from, to] = route.route.split('-'); return matches(origin, route.origin, from) && matches(destination, route.destination, to); });
}
export function CityField({ label, value, onChange, cities, kind }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    cities: CitySuggestion[];
    kind: 'origin' | 'destination';
}) {
    const id = useId(), Icon = kind === 'origin' ? Plane : Target;
    return <label className="city-field" htmlFor={id}>{label}<div className="input-wrap"><Icon size={17}/><input id={id} list={id + '-cities'} aria-label={kind === 'origin' ? t("Пункт отправления") : t("Пункт назначения")} value={cityName(value)} onChange={event => onChange(canonicalCity(event.target.value))} autoComplete="off" placeholder={t("Введите город или код")} required spellCheck={false} maxLength={100}/><ChevronDown size={15}/></div><datalist id={id + '-cities'}>{cities.map(city => <option key={city.code} value={cityName(city.name)}>{city.code}</option>)}</datalist></label>;
}
function validDay(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z')); }
function dateText(value: string, full = true) { if (!validDay(value))
    return t("Выберите дату"); return new Date(value + 'T12:00:00Z').toLocaleDateString(locale(), { day: 'numeric', month: full ? 'long' : 'short', year: full ? 'numeric' : undefined, timeZone: 'UTC' }); }
function monthLabel(month: string) { return new Date(month + '-01T12:00:00Z').toLocaleDateString(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }); }
function shiftDay(value: string, days: number) { const date = new Date(value + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function shiftMonth(month: string, delta: number) { const date = new Date(month + '-01T12:00:00Z'); date.setUTCMonth(date.getUTCMonth() + delta); return date.toISOString().slice(0, 7); }
export function DateControl({ value, onChange, availableDates }: {
    value: string;
    onChange: (value: string) => void;
    availableDates: string[];
}) {
    const dates = [...new Set(availableDates)].filter(validDay).sort(), first = dates[0], last = dates.at(-1), selectedIndex = dates.indexOf(value), enabled = new Set(dates);
    const initialMonth = (validDay(value) && first && value >= first && last && value <= last ? value : first)?.slice(0, 7) || '2026-06';
    const [open, setOpen] = useState(false), [month, setMonth] = useState(initialMonth), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), id = useId();
    useEffect(() => { if (validDay(value) && first && value >= first && last && value <= last)
        setMonth(value.slice(0, 7)); }, [value, first, last]);
    useEffect(() => { if (!open)
        return; const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node))
        setOpen(false); }; document.addEventListener('pointerdown', outside); const timer = requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-date="${enabled.has(value) ? value : dates.find(day => day.startsWith(month)) || first}"]`)?.focus()); return () => { document.removeEventListener('pointerdown', outside); cancelAnimationFrame(timer); }; }, [open]);
    const choose = (day: string) => { if (!enabled.has(day))
        return; onChange(day); setOpen(false); trigger.current?.focus(); };
    const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, day: string) => { const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]; if (delta === undefined)
        return; event.preventDefault(); const next = shiftDay(day, delta); if (!enabled.has(next))
        return; setMonth(next.slice(0, 7)); requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus()); };
    const year = Number(month.slice(0, 4)), monthNumber = Number(month.slice(5)), offset = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7, daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return <div className="date-control" ref={root}><label id={id + '-label'}>{t("Дата вылета")}</label><button type="button" ref={trigger} aria-labelledby={id + '-label'} aria-label={t("Дата вылета: ") + dateText(value)} aria-expanded={open} aria-controls={id + '-calendar'} onClick={() => { if (!open)
        setMonth(initialMonth); setOpen(!open); }}><CalendarDays size={17}/><span>{dateText(value)}</span><ChevronDown size={15}/></button><div className="date-navigation" style={{ marginTop: 8 }}><button type="button" disabled={selectedIndex <= 0} onClick={() => onChange(dates[selectedIndex - 1])} aria-label={t("Предыдущая доступная дата")}><ChevronLeft size={17}/></button><small>{dates.length}<> {t("доступных дат")}</></small><button type="button" disabled={selectedIndex < 0 || selectedIndex >= dates.length - 1} onClick={() => onChange(dates[selectedIndex + 1])} aria-label={t("Следующая доступная дата")}><ChevronRight size={17}/></button></div><p className="date-range-help"><>{t("Данные CSV:")} </>{first && dateText(first, false)} — {last && dateText(last)}.</p>{open && <div id={id + '-calendar'} className="date-popover" role="dialog" aria-label={t("Выбор даты из прогноза")} onKeyDown={event => { if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
    } }}><div className="date-popover-head"><button type="button" className="icon-btn" aria-label={t("Предыдущий месяц")} disabled={!first || month <= first.slice(0, 7)} onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={18}/></button><span>{monthLabel(month)}</span><button type="button" className="icon-btn" aria-label={t("Следующий месяц")} disabled={!last || month >= last.slice(0, 7)} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={18}/></button></div><div className="date-grid">{[t("Пн"), t("Вт"), t("Ср"), t("Чт"), t("Пт"), t("Сб"), t("Вс")].map(day => <span className="date-weekday" key={day}>{day}</span>)}{Array.from({ length: offset }, (_, index) => <span key={'blank' + index}/>)}{Array.from({ length: daysInMonth }, (_, index) => { const day = month + '-' + String(index + 1).padStart(2, '0'), available = enabled.has(day); return <button type="button" key={day} data-date={day} className={'date-day' + (day === value ? ' is-selected' : '') + (!available ? ' is-disabled' : '')} disabled={!available} aria-pressed={day === value} aria-label={dateText(day)} tabIndex={day === (value.startsWith(month) && enabled.has(value) ? value : dates.find(d => d.startsWith(month))) ? 0 : -1} onClick={() => choose(day)} onKeyDown={event => moveFocus(event, day)}>{index + 1}</button>; })}</div><p className="date-range-help">{t("Можно выбрать только даты из загруженного прогноза. Стрелки на клавиатуре перемещают по дням.")}</p></div>}</div>;
}

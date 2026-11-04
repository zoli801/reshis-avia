import {t,tf,locale,routeName,cityName,canonicalCity,useLanguage} from './i18n';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3, Bell, Bookmark, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Copy, Database, Download, ExternalLink, FileText, GitCompareArrows, LayoutDashboard, LogIn, LogOut, Menu, Plane, Plus, RefreshCw, Save, Send, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Target, TrendingUp, Users, X, AlertTriangle, Clock, Search } from 'lucide-react';
import { api, post, initializeUser, documentUrl, money, number, day, timestamp, type Meta, type Forecast, type User, type Scenario, type Preferences, type Analytics } from './api';
import { AnalyticsPanel, type ChartTab } from './AnalyticsCharts';
import { CityField, DateControl, knownCities, matchingRoute } from './ForecastControls';
import { ThemeControl, useAppTheme } from './ThemeControl';
import {LanguageControl} from './LanguageControl';
import {AccountAccess} from './AccountAccess';
import {VoxelActivity,VoxelBoot,VoxelWelcome,VoxelPlaneIcon} from './VoxelDecor';
type Page = 'forecast' | 'overview' | 'scenarios' | 'reports' | 'data' | 'profile' | 'admin';
const labels: Record<Page, string> = { forecast: 'Прогноз спроса', overview: 'Обзор направлений', scenarios: 'Мои решения', reports: 'Отчёты', data: 'Данные и модель', profile: 'Профиль', admin: 'Управление' };
const roles = { analyst: 'Аналитик', manager: 'Руководитель', admin: 'Администратор' };
const statuses = { draft: 'Черновик', review: 'На рассмотрении', approved: 'Согласовано' };
const nav = [['overview', LayoutDashboard], ['forecast', SlidersHorizontal], ['scenarios', Bookmark], ['reports', FileText], ['data', Database]] as const;
const defaultPrefs: Preferences = { enabled: false, digest_enabled: false, digest_hour: 9, quiet_start: 22, quiet_end: 8, timezone: 'Asia/Novosibirsk', routes: [], change_threshold: 5 };
const getPage = (): Page => { const hash = location.hash.slice(1); const tab = new URLSearchParams(location.search).get('tab'); const p = hash || (tab === 'settings' ? 'profile' : tab) || (new URLSearchParams(location.search).get('admin') === '1' ? 'admin' : null); return p && Object.keys(labels).includes(p) ? p as Page : 'forecast'; };
const errorText = (e: unknown) => e instanceof Error ? t(e.message) : t("Не удалось выполнить действие.");
function IconNote({ children, warning = false }: {
    children: ReactNode;
    warning?: boolean;
}) { return <div className={'notice ' + (warning ? 'warning' : '')}><span>{warning ? <AlertTriangle size={17}/> : <CircleHelp size={17}/>}</span><div>{children}</div></div>; }
function Empty({ icon: Icon = Bookmark, title, text, action }: {
    icon?: typeof Bookmark;
    title: string;
    text: string;
    action?: ReactNode;
}) { return <div className="empty"><div className="empty-icon"><Icon size={30}/></div><h3>{title}</h3><p>{text}</p>{action}</div>; }
function Modal({ title, onClose, children, wide = false }: {
    title: string;
    onClose: () => void;
    children: ReactNode;
    wide?: boolean;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => { const old = document.activeElement as HTMLElement; const node = ref.current; const focusable = () => Array.from(node?.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href]') || []).filter(e => !e.hasAttribute('disabled')); focusable()[0]?.focus(); const handle = (e: KeyboardEvent) => { if (e.key === 'Escape')
        onClose(); if (e.key === 'Tab') {
        const list = focusable();
        if (!list.length)
            return;
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        }
        else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    } }; document.addEventListener('keydown', handle); const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.removeEventListener('keydown', handle); document.body.style.overflow = overflow; old?.focus(); }; }, [onClose]);
    return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget)
        onClose(); }}><div ref={ref} className={'modal ' + (wide ? 'wide' : '')} role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><h2>{title}</h2><button className="icon-btn" aria-label={t("Закрыть")} onClick={onClose}><X size={21}/></button></div>{children}</div></div>;
}
function Metrics({ result }: {
    result: Forecast;
}) { return <div className="metrics"><div className="metric"><div className="metric-label">{result.demand < 0 ? t("Оценка модели") : t("Желающих купить")} <Users size={17}/></div><strong>{number(result.demand)}</strong><small>{result.demand < 0 ? t("отрицательная оценка → 0 покупок") : t("медианный спрос")}</small></div><div className="metric"><div className="metric-label"><>{t("Прогноз продаж")} </><Plane size={17}/></div><strong>{number(result.sales)}<span> / {number(result.capacity)}</span></strong><small>{t("билетов на направление за день")}</small></div><div className="metric"><div className="metric-label"><>{t("Прогноз загрузки")} </><BarChart3 size={17}/></div><strong>{number(result.load_factor * 100, 1)}<span>%</span></strong><div className="progress"><i style={{ width: Math.max(0, Math.min(100, result.load_factor * 100)) + '%' }}/></div></div><div className="metric"><div className="metric-label"><>{t("Непроданные места")} </><Target size={17}/></div><strong>{number(result.empty_seats)}</strong><small>{t("прогноз, не фактический остаток")}</small></div></div>; }
export default function App() {
    useLanguage();
    const theme = useAppTheme();
    const [meta, setMeta] = useState<Meta | null>(null), [user, setUser] = useState<User | null>(null), [page, setPage] = useState<Page>(getPage), [menu, setMenu] = useState(false);
    const [route, setRoute] = useState('MOW-AER'), [date, setDate] = useState('2026-06-01'), [price, setPrice] = useState(9000), [capacity, setCapacity] = useState(''), [multiplier, setMultiplier] = useState('1'), [experiment, setExperiment] = useState(false);
    const [result, setResult] = useState<Forecast | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [toast, setToast] = useState(''), [saving, setSaving] = useState(false), [detail, setDetail] = useState<Scenario | null>(null), [revision, setRevision] = useState(0), [analytics, setAnalytics] = useState<Analytics | null>(null), [analyticsError, setAnalyticsError] = useState(''), [chartTab, setChartTab] = useState<ChartTab>('demand');
    const [comparisons, setComparisons] = useState<Forecast[]>([]), [overview, setOverview] = useState<(Forecast & {
        status: string;
        reason: string;
    })[]>([]), [scenarios, setScenarios] = useState<Scenario[]>([]), [filter, setFilter] = useState('all'), [prefs, setPrefs] = useState<Preferences>(defaultPrefs), [dataHistory, setDataHistory] = useState<Record<string, unknown>[]>([]), [adminUsers, setAdminUsers] = useState<User[]>([]), [audit, setAudit] = useState<Record<string, unknown>[]>([]), [modalBusy, setModalBusy] = useState(false), [telegramLink, setTelegramLink] = useState(''), [attentionLimit, setAttentionLimit] = useState(20);
    const identityEpoch = useRef(0), previousIdentity = useRef(user?.id);
    if(previousIdentity.current!==user?.id){previousIdentity.current=user?.id;identityEpoch.current++;}
    const seq = useRef(0), calcRef = useRef<() => void>(() => { }), sessionTask = useRef<Promise<User> | null>(null), deepLinkOpened = useRef(false);
    const [sessionError, setSessionError] = useState(''), [sessionAttempt, setSessionAttempt] = useState(0), [sessionBusy, setSessionBusy] = useState(true);
    const acceptUser=(value:User)=>{
        identityEpoch.current++;setDetail(null);setSaving(false);setModalBusy(false);setError('');setToast('');setSessionError('');setSessionBusy(false);setScenarios([]);setPrefs({...defaultPrefs});setTelegramLink('');setAdminUsers([]);setAudit([]);
        setUser(value);sessionTask.current=Promise.resolve(value);setRevision(current=>current+1);
    };

    const adminMode = new URLSearchParams(location.search).get('admin') === '1';
    const isGuest = user?.auth_provider === 'guest';
    const displayName = isGuest ? t("Гость") : user?.name || t("Рабочее пространство");
    const displaySubtitle = isGuest ? t("Решения в этом браузере") : user?.auth_provider === 'telegram' ? t("Профиль Telegram") : user?.username ? tf('Логин: {0}',[user.username],'Username: {0}') : user?.email || t("Подготавливаем сохранения");
    const retrySession = () => { sessionTask.current = null; setSessionAttempt(v => v + 1); };
    const [originInput, setOriginInput] = useState('Москва'), [destinationInput, setDestinationInput] = useState('Сочи');
    const cities = knownCities(meta?.routes || []);
    const selectedRoute = meta?.routes.find(r => r.route === route);
    const matchedRoute = meta ? matchingRoute(meta.routes, originInput, destinationInput) : undefined;
    const validPair = !!selectedRoute && matchedRoute?.route === route;
    const validDate = !!meta?.dates.includes(date);
    const routeProblem = !originInput.trim() || !destinationInput.trim() ? t("Укажите город отправления и назначения.") : !validPair ? tf("Для направления {0} — {1} в загруженном CSV нет прогноза.", [cityName(originInput), cityName(destinationInput)]) : '';
    useEffect(() => { const item = meta?.routes.find(r => r.route === route); if (item) {
        setOriginInput(item.origin);
        setDestinationInput(item.destination);
    } }, [route, meta?.dataset.id]);
    const isCurrent = validPair && validDate && !!result && result.route === route && result.date === date && result.price === price && result.dataset_id === meta?.dataset.id && result.capacity_override === (experiment ? Number(capacity) : null) && result.demand_multiplier === (experiment ? Number(multiplier) : 1);
    const canEditDetail = !!detail && !(detail.status === 'approved' && user?.role === 'analyst');
    const notify = (s: string) => setToast(s);
    const navigate = (p: Page) => { setPage(p); location.hash = p; setMenu(false); setFilter('all'); setAttentionLimit(20); setError(''); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    const loadMeta = useCallback(async () => { try {
        const m = await api<Meta>('/meta');
        setMeta(m);
        const params = new URLSearchParams(location.search);
        const requestedRoute = params.get('route');
        if (requestedRoute) {
            if (m.routes.some(r => r.route === requestedRoute))
                setRoute(requestedRoute);
            else {
                setRoute('');
                const [from, to] = requestedRoute.split('-');
                const suggestions = knownCities(m.routes);
                setOriginInput(suggestions.find(city => city.code === from)?.name || from || '');
                setDestinationInput(suggestions.find(city => city.code === to)?.name || to || '');
            }
        }
        const requestedDate = params.get('date');
        if (requestedDate)
            setDate(/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : '');
        const requestedPrice = Number(params.get('price'));
        if (params.has('price') && Number.isFinite(requestedPrice) && requestedPrice >= 0)
            setPrice(requestedPrice);
    }
    catch (e) {
        setError(errorText(e));
    } }, []);
    useEffect(() => { loadMeta(); const handler = () => setPage(getPage()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, [loadMeta]);
    useEffect(() => { let active = true; const epoch=identityEpoch.current;const tg = (window as unknown as {
        Telegram?: {
            WebApp?: {
                initData?: string;
                platform?: string;
                ready: () => void;
                expand: () => void;
                setHeaderColor?: (color: string) => void;
                setBackgroundColor?: (color: string) => void;
            };
        };
    }).Telegram?.WebApp; const telegramContext = !!tg?.initData || !!(tg?.platform && tg.platform !== 'unknown'); setSessionBusy(true); setSessionError(''); if (telegramContext) {
        tg?.ready();
        tg?.expand();
    } if (!sessionTask.current)
        sessionTask.current = telegramContext && !tg?.initData ? Promise.reject(new Error(t("Откройте мини-приложение кнопкой в боте."))) : initializeUser(tg?.initData); sessionTask.current.then(value => { if (active&&epoch===identityEpoch.current)acceptUser(value); }).catch(e => { if (active&&epoch===identityEpoch.current){setSessionError(errorText(e));setSessionBusy(false);} }); return () => { active = false; }; }, [sessionAttempt]);
    useEffect(() => { if (!toast)
        return; const t = setTimeout(() => setToast(''), 4500); return () => clearTimeout(t); }, [toast]);
    const calculate = useCallback(async () => {
        if (!meta)
            return;
        const id = ++seq.current;
        if (!validPair || !validDate) {
            setBusy(false);
            setResult(null);
            setAnalytics(null);
            setComparisons([]);
            return;
        }
        if (!Number.isFinite(price) || price < 0 || (experiment && (!Number.isInteger(Number(capacity)) || Number(capacity) <= 0 || !Number.isFinite(Number(multiplier)) || Number(multiplier) <= 0))) {
            setError(t("Проверьте цену и экспериментальные условия."));
            setBusy(false);
            setResult(null);
            setAnalytics(null);
            return;
        }
        setBusy(true);
        setComparisons([]);
        setAnalytics(null);
        setAnalyticsError('');
        const input = { route, date, price, ...(experiment ? { capacity: Number(capacity), demand_multiplier: Number(multiplier) } : {}) };
        try {
            const [forecastResponse, analyticsResponse] = await Promise.allSettled([post<Forecast>('/forecast', input), post<Analytics>('/analytics', input)]);
            if (id !== seq.current)
                return;
            if (forecastResponse.status === 'rejected')
                throw forecastResponse.reason;
            const current = forecastResponse.value;
            if (current.dataset_id !== meta.dataset.id) {
                await loadMeta();
                throw new Error(t("Версия данных обновилась. Повторяем расчёт по актуальному прогнозу."));
            }
            setResult(current);
            setError('');
            if (analyticsResponse.status === 'fulfilled' && analyticsResponse.value.dataset_id === current.dataset_id && analyticsResponse.value.route === current.route && analyticsResponse.value.selected_date === current.date && analyticsResponse.value.price === current.price)
                setAnalytics(analyticsResponse.value);
            else
                setAnalyticsError(analyticsResponse.status === 'rejected' ? errorText(analyticsResponse.reason) : t("Версия аналитики обновилась. Повторите расчёт."));
        }
        catch (e) {
            if (id === seq.current) {
                setError(errorText(e));
                setResult(null);
                setAnalytics(null);
            }
        }
        finally {
            if (id === seq.current)
                setBusy(false);
        }
    }, [meta, route, date, price, experiment, capacity, multiplier, validPair, validDate, loadMeta]);
    calcRef.current = calculate;
    useEffect(() => { if (!meta)
        return; const t = setTimeout(() => calcRef.current(), 220); return () => clearTimeout(t); }, [meta?.dataset.id, route, date, price, experiment, capacity, multiplier]);
    useEffect(() => { if (!result || !isCurrent)
        return; let cancelled = false; const prices = Array.from(new Set([result.base_price, Number(result.recommended_price.toFixed(2)), result.price])).slice(0, 3); Promise.all(prices.map(p => post<Forecast>('/forecast', { route: result.route, date: result.date, price: p, ...(result.is_experiment ? { capacity: result.capacity, demand_multiplier: result.demand_multiplier } : {}) }))).then(r => { if (!cancelled)
        setComparisons(r); }).catch(() => { }); return () => { cancelled = true; }; }, [result, isCurrent]);
    useEffect(() => {
        let active=true;const epoch=identityEpoch.current;
        const current=()=>active&&epoch===identityEpoch.current;
        const fail=(reason:unknown)=>{if(current())setError(errorText(reason));};
        if(page==='overview')api<{items:(Forecast&{status:string;reason:string})[]}>('/overview').then(response=>{if(current())setOverview(response.items);}).catch(fail);
        if((page==='scenarios'||page==='reports')&&user)api<{items:Scenario[]}>('/scenarios').then(response=>{if(current())setScenarios(response.items);}).catch(fail);
        if(page==='profile'&&user?.auth_provider==='telegram')api<Preferences>('/notifications').then(response=>{if(current())setPrefs(response);}).catch(fail);
        if(page==='data')api<{items:Record<string,unknown>[]}>('/datasets').then(response=>{if(current())setDataHistory(response.items);}).catch(()=>{});
        if(page==='admin'&&user?.role==='admin'){
            api<{items:User[]}>('/admin/users').then(response=>{if(current())setAdminUsers(response.items);}).catch(fail);
            api<{items:Record<string,unknown>[]}>('/admin/audit').then(response=>{if(current())setAudit(response.items);}).catch(()=>{});
        }
        return()=>{active=false;};
    },[page,user,revision]);
    useEffect(()=>{
        const id=new URLSearchParams(location.search).get('scenario');if(!user||!id||deepLinkOpened.current)return;
        let active=true;const epoch=identityEpoch.current;deepLinkOpened.current=true;
        api<Scenario>('/scenarios/'+encodeURIComponent(id)).then(response=>{if(active&&epoch===identityEpoch.current)setDetail(response);}).catch(reason=>{if(active&&epoch===identityEpoch.current)setError(errorText(reason));});
        return()=>{active=false;};
    },[user]);
    useEffect(()=>{
        let active=true;
        const refresh=()=>{if(!user)return;const epoch=identityEpoch.current;api<{user:User|null}>('/auth/me').then(response=>{
            if(!active||epoch!==identityEpoch.current)return;
            if(response.user){if(response.user.id!==user.id||response.user.role!==user.role||response.user.auth_provider!==user.auth_provider)acceptUser(response.user);else setUser(response.user);}else{identityEpoch.current++;setUser(null);setDetail(null);setSaving(false);setModalBusy(false);setScenarios([]);setPrefs({...defaultPrefs});setTelegramLink('');setAdminUsers([]);setAudit([]);sessionTask.current=null;setSessionAttempt(value=>value+1);}
        }).catch(()=>{});};
        window.addEventListener('focus',refresh);return()=>{active=false;window.removeEventListener('focus',refresh);};
    },[user?.id,user?.role,user?.auth_provider]);
    const closeSaving = useCallback(() => setSaving(false), []), closeDetail = useCallback(() => setDetail(null), []);
    const changeCity = (kind: 'origin' | 'destination', value: string) => { if (kind === 'origin')
        setOriginInput(value);
    else
        setDestinationInput(value); const match = matchingRoute(meta?.routes || [], kind === 'origin' ? value : originInput, kind === 'destination' ? value : destinationInput); if (match?.route !== route) {
        setRoute(match?.route || '');
        if (match)
            setPrice(match.base_price);
        setCapacity('');
        setExperiment(false);
    } setError(''); };
    const openScenario = async (s: Scenario) => { const epoch=identityEpoch.current;try {
        const response=await api<Scenario>('/scenarios/'+s.id);if(epoch===identityEpoch.current)setDetail(response);
    }
    catch (e) {
        if(epoch===identityEpoch.current)setError(errorText(e));
    } };
    async function saveScenario(e: FormEvent<HTMLFormElement>) { e.preventDefault(); const epoch=identityEpoch.current;if (!result || !isCurrent) {
        setError(t("Дождитесь актуального расчёта перед сохранением."));
        return;
    } const form = new FormData(e.currentTarget); setModalBusy(true); try {
        const s = await post<Scenario>('/scenarios', { title: form.get('title'), note: form.get('note'), route: result.route, date: result.date, price: result.price, ...(result.is_experiment ? { capacity: result.capacity, demand_multiplier: result.demand_multiplier } : {}), alternatives: Array.from(new Set([result.base_price, Number(result.recommended_price.toFixed(2)), result.price])) });
        if(epoch!==identityEpoch.current)return;
        setSaving(false);
        setRevision(v => v + 1);
        notify(t("Решение сохранено"));
        setDetail(s);
    }
    catch (e) {
        if(epoch===identityEpoch.current)setError(errorText(e));
    }
    finally {
        if(epoch===identityEpoch.current)setModalBusy(false);
    } }
    async function updateScenario(patch: Record<string, unknown>) { if (!detail)
        return; const epoch=identityEpoch.current;setModalBusy(true); try {
        const s = await api<Scenario>('/scenarios/' + detail.id, { method: 'PATCH', body: JSON.stringify(patch) });
        if(epoch!==identityEpoch.current)return;
        setDetail(s);
        setRevision(v => v + 1);
        notify(t("Решение обновлено"));
    }
    catch (e) {
        if(epoch===identityEpoch.current)setError(errorText(e));
    }
    finally {
        if(epoch===identityEpoch.current)setModalBusy(false);
    } }
    async function linkTelegram(){
        const epoch=identityEpoch.current;setModalBusy(true);
        try{
            const response=await post<{url:string}>('/auth/telegram/link',{});
            if(epoch!==identityEpoch.current)return;
            if(response.url){setTelegramLink(response.url);window.open(response.url,'_blank','noopener,noreferrer');}
            else notify(t('Сначала укажите имя Telegram-бота в настройках проекта.'));
        }catch(reason){if(epoch===identityEpoch.current)setError(errorText(reason));}
        finally{if(epoch===identityEpoch.current)setModalBusy(false);}
    }
    async function importData(e: FormEvent<HTMLFormElement>) { e.preventDefault(); setModalBusy(true); try {
        const form = new FormData(e.currentTarget);
        await api('/admin/import', { method: 'POST', body: form });
        await loadMeta();
        setRevision(v => v + 1);
        notify(t("Новая версия прогноза проверена и загружена"));
    }
    catch (e) {
        setError(errorText(e));
    }
    finally {
        setModalBusy(false);
    } }
    const header = () => <div className="page-heading"><div><div className="eyebrow">{t("ЦЕНТР УПРАВЛЕНИЯ · РЕШИСЬ АВИА")}</div><h1>{t(labels[page])}</h1><p>{({ forecast: t("Проверьте цену. Оцените спрос. Выберите обоснованное решение."), overview: t("Вся сеть направлений — в одном календаре."), scenarios: t("Ваши расчёты, альтернативы и принятые решения."), reports: t("Сохранённые расчёты, которыми удобно поделиться."), data: t("Источник каждого числа и прозрачные правила расчёта."), profile: t('Профиль и настройки входа, сохранений и Telegram.','Profile and settings for sign-in, saved decisions and Telegram.'), admin: t("Доступ к системе, новые прогнозы и история изменений.") })[page]}</p></div>{page === 'forecast' && <button className="btn btn-dark" onClick={() => setSaving(true)} disabled={!user || sessionBusy || !result || busy || !isCurrent}><Save size={17}/>{t("Сохранить решение")}</button>}</div>;
    if (!meta)
        return <VoxelBoot error={error||undefined} onRetry={loadMeta}/>;
    return <div className={'app-shell'+(page==='forecast'?' plains-backdrop':'')}>
 <aside className={'sidebar ' + (menu ? 'is-open' : '')}><a className="brand" href="#forecast" onClick={() => navigate('forecast')}><span className="brand-mark"><VoxelPlaneIcon size={26}/></span><span>{t("Решись")}<span className="brand-light">{t("Авиа")}</span><small>{t("Центр управления спросом")}</small></span></a><div className="workspace"><span className="workspace-icon">{t("РА")}</span><div><strong>{t("Рабочее пространство")}</strong><small>{t("Учебный проект")}</small></div><ShieldCheck size={16}/></div><div className="nav-caption">{t("РАБОЧИЕ ИНСТРУМЕНТЫ")}</div><nav>{nav.map(([key, Icon]) => { const p = key as Page; return <button key={p} className={'nav-item ' + (page === p ? 'active' : '')} onClick={() => navigate(p)}><Icon size={19}/><span>{t(labels[p])}</span>{p === 'forecast' && <i />}</button>; })}</nav><div className="sidebar-bottom"><div className="model-card"><span className="small-label"><i className="status-dot"/>{t("ПРОГНОЗ ПОДКЛЮЧЁН")}</span><strong>{meta.dataset.route_count}<> {t("направлений ·")} </>{meta.dataset.rows}<> {t("записей")}</></strong><small>{day(meta.dataset.start_date)} — {day(meta.dataset.end_date)} {meta.dataset.end_date.slice(0, 4)}</small><button onClick={() => navigate('data')}><>{t("Паспорт данных")} </><ArrowRight size={14}/></button></div>{user?.role === 'admin' && <button className={'nav-item ' + (page === 'admin' ? 'active' : '')} onClick={() => navigate('admin')}><Settings2 size={19}/>{t("Управление")}</button>}<button className={'nav-item ' + (page === 'profile' ? 'active' : '')} onClick={() => navigate('profile')}><span className="avatar">{user ? displayName.slice(0, 1).toUpperCase() : <LogIn size={17}/>}</span><span>{displayName}<small>{displaySubtitle}</small></span><ChevronRight size={15}/></button></div></aside>
 {menu && <div className="sidebar-scrim" onClick={() => setMenu(false)}/>}
 <div className="main-shell"><header className="topbar"><div className="breadcrumbs"><button className="icon-btn mobile-only" onClick={() => setMenu(true)} aria-label={t("Открыть меню")}><Menu size={23}/></button><span className="desktop-only">{t("Рабочее пространство")}</span><ChevronRight size={14} className="desktop-only"/><strong>{t(labels[page])}</strong></div><div className="top-actions"><LanguageControl/><AccountAccess user={user} botUsername={meta.bot_username} onAuthenticated={acceptUser}/><ThemeControl mode={theme.mode} resolved={theme.resolved} onChange={theme.setMode}/><span className="data-badge"><i className="status-dot"/><>{t("Данные:")} </>{new Date(meta.dataset.start_date + 'T12:00:00').toLocaleDateString(locale(), { month: 'short', year: 'numeric' })}</span><button className="icon-btn" onClick={() => navigate('profile')} aria-label={t("Настройки уведомлений")}><Bell size={19}/></button><button className="avatar light" onClick={() => navigate('profile')} aria-label={t("Открыть профиль")}>{user ? displayName.slice(0, 1).toUpperCase() : t("Д")}</button></div></header>
 <main>{header()}{page==='forecast'&&<VoxelWelcome onLearnMore={()=>navigate('data')}/>} {sessionError && <div className="error-banner" role="alert"><AlertTriangle size={18}/><span>{t(sessionError)}</span><button className="text-btn" onClick={retrySession}>{t("Повторить")}</button></div>}{error && <div className="error-banner" role="alert"><AlertTriangle size={18}/><span>{t(error)}</span><button className="icon-btn" onClick={() => setError('')} aria-label={t("Закрыть сообщение")}><X size={16}/></button></div>}
 {page === 'forecast' && <>
 <div className="forecast-layout"><section className="panel input-panel"><div className="panel-title"><span className="section-icon"><SlidersHorizontal size={18}/></span><h2>{t("Параметры расчёта")}</h2></div><form onSubmit={e => { e.preventDefault(); calculate(); }}><CityField label={t("Откуда")} value={originInput} onChange={value => changeCity('origin', value)} cities={cities} kind="origin"/><div className="route-line"><span /><ArrowDownRight size={16}/><span /></div><CityField label={t("Куда")} value={destinationInput} onChange={value => changeCity('destination', value)} cities={cities} kind="destination"/>{routeProblem && <p className="city-help" role="status">{routeProblem}<> {t("Доступные вылеты:")} </>{[...new Set(meta.routes.map(item => cityName(item.origin)))].join(', ')}.</p>}<DateControl value={date} onChange={value => { setDate(value); setError(''); }} availableDates={meta.dates}/>{!validDate && <p className="city-help" role="status">{t("Для выбранной даты нет прогноза. Выберите выделенный день в календаре.")}</p>}<div className="label-row"><label htmlFor="ticket-price">{t("Цена билета")}</label><span>{t("за пассажира")}</span></div><div className="price-input"><input id="ticket-price" type="number" min="0" max="10000000" step="any" required value={price} onChange={e => setPrice(Number(e.target.value))}/><span>₽</span></div>{validPair && selectedRoute ? <><input className="price-range" aria-label={t("Изменить цену")} type="range" min={selectedRoute.price_min} max={selectedRoute.price_max} step="1" value={Math.max(selectedRoute.price_min, Math.min(selectedRoute.price_max, price))} onChange={e => setPrice(Number(e.target.value))}/><div className="range-labels"><span>{money(selectedRoute.price_min)}</span><span>{money(selectedRoute.price_max)}</span></div><div className="base-price"><span>{t("Базовая цена направления")}</span><button type="button" onClick={() => setPrice(selectedRoute.base_price)}>{money(selectedRoute.base_price)} <RefreshCw size={12}/></button></div></> : <p className="city-help">{t("Выберите доступное направление, чтобы увидеть базовую цену и диапазон оптимизации.")}</p>}<details className="experiment"><summary><Settings2 size={15}/>{t("Экспериментальные условия")}<ChevronDown size={14}/></summary><label className="check-label"><input type="checkbox" checked={experiment} onChange={e => { setExperiment(e.target.checked); if (e.target.checked)
            setCapacity(String(result?.capacity || 900)); }}/>{t("Изменить допущения")}</label>{experiment && <><label>{t("Вместимость за день")}<input className="plain-input" type="number" min="1" max="100000" value={capacity} onChange={e => setCapacity(e.target.value)}/></label><label>{t("Множитель спроса")}<input className="plain-input" type="number" min="0.01" max="10" step="0.05" value={multiplier} onChange={e => setMultiplier(e.target.value)}/></label><small>{t("Изменения создают эксперимент, исходный прогноз сохраняется.")}</small></>}</details><button className="btn btn-dark full" type="submit" disabled={busy || !validPair || !validDate}><RefreshCw size={16} className={busy ? 'spin' : ''}/>{busy ? t("Рассчитываем…") : t("Рассчитать прогноз")}</button></form><div className="source-note"><ShieldCheck size={15}/><span>{t("Ваш ML-прогноз")}<br /><strong>{meta.dataset.rows}<> {t("записей · 9 квантилей")}</></strong></span></div></section>
 <div className={'results-column ' + (busy ? 'is-loading' : '')} aria-busy={busy}>{result && isCurrent ? <><div className="result-heading"><div><span className="small-label">{t("РЕЗУЛЬТАТ РАСЧЁТА")}</span><h2>{routeName(meta.routes.find(r => r.route === result.route)?.name || result.route)}<span>{day(result.date, true)}</span></h2></div><span className={'pill ' + (result.is_experiment ? 'amber' : 'green')}><i />{!isCurrent ? t("Ожидает пересчёта") : result.is_experiment ? t("Эксперимент") : t("Медианный сценарий")}</span></div><Metrics result={result}/>{result.demand < 0 && <IconNote>{t("Отрицательная линейная оценка означает нулевой прогноз покупок.")}</IconNote>}<AnalyticsPanel result={result} analytics={analytics} analyticsError={analyticsError} onSelectPrice={setPrice} onSelectDate={setDate} onRetry={calculate} tab={chartTab} onTabChange={setChartTab}/><div className="finance-row"><section className="panel finance-card"><span className="metric-label">{t("Прогноз выручки")}<TrendingUp size={18}/></span><strong>{money(result.revenue)}</strong><small>{t("Цена × прогноз продаж")}</small></section><section className="panel finance-card accent"><span className="metric-label">{t("Маржинальный доход")}<ArrowUpRight size={18}/></span><strong>{money(result.contribution)}</strong><small>{t("За вычетом затрат на пассажиров")}</small></section></div></> : <section className="panel">{!validPair ? <Empty icon={Plane} title={t("Для этого направления нет данных")} text={routeProblem} action={<div className="analytics-note">{t("Выберите пару городов из исходного прогноза. Обратные маршруты автоматически не создаются.")}</div>}/> : !validDate ? <Empty icon={CalendarDays} title={t("Выберите дату из прогноза")} text={tf("Откройте календарь: в текущем CSV доступны даты {0} — {1} {2} года.", [day(meta.dataset.start_date, true), day(meta.dataset.end_date, true), meta.dataset.end_date.slice(0, 4)])}/> : error && !busy ? <Empty icon={AlertTriangle} title={t("Не удалось получить расчёт")} text={t(error)} action={<button className="btn btn-outline" type="button" onClick={calculate}><RefreshCw size={16}/>{t("Повторить")}</button>}/> : <div className="voxel-processing"><img src="/voxel/survey-drone.svg" width="52" height="52" alt=""/><VoxelActivity/></div>}</section>}</div></div>
 {result && isCurrent && <><section className="recommendation"><div className="recommendation-icon"><Sparkles size={23}/></div><div><span className="small-label">{t("ПОДДЕРЖКА РЕШЕНИЯ")}</span><h3><>{t("Проверьте цену")} </>{money(result.recommended_price)}</h3><p>{t("Максимум маржинального дохода по медианному прогнозу в допустимом диапазоне цен.")}</p></div><button className="btn btn-white" onClick={() => setPrice(Number(result.recommended_price.toFixed(2)))}>{t("Проверить цену")}<ArrowRight size={17}/></button></section><section className="panel compare-panel"><div className="panel-title"><div><h2>{t("Сравните перед решением")}</h2><p>{t("Один прогноз. Разные цены. Видимые последствия.")}</p></div><GitCompareArrows size={21}/></div><div className="table-scroll"><table><thead><tr><th>{t("Вариант")}</th><th>{t("Цена")}</th><th>{t("Продажи")}</th><th>{t("Загрузка")}</th><th>{t("Выручка")}</th><th>{t("Маржинальный доход")}</th><th /></tr></thead><tbody>{comparisons.map((r, i) => <tr key={r.price} className={r.price === result.price ? 'highlight-row' : ''}><td><span className={'table-dot ' + (i === 0 ? 'neutral' : 'teal')}/>{r.price === result.price ? t("Выбранная цена") : r.price === result.base_price ? t("Базовая цена") : t("Расчётная рекомендация")}</td><td className="strong">{money(r.price)}</td><td>{number(r.sales)}</td><td>{number(r.load_factor * 100, 1)}%</td><td>{money(r.revenue)}</td><td className="strong">{money(r.contribution)}</td><td><button className="icon-btn" aria-label={tf("Выбрать цену {0}", [money(r.price)])} onClick={() => setPrice(r.price)}>{r.price === result.price ? <Check size={17}/> : <ArrowRight size={17}/>}</button></td></tr>)}</tbody></table></div></section><details className="panel explanation"><summary><span><CircleHelp size={18}/>{t("Как рассчитан результат")}</span><ChevronDown size={17}/></summary><div className="explanation-body"><div className="formula">{t("Спрос = базовый спрос − чувствительность × (цена − базовая цена)")}<br />{t("Продажи = минимум из вместимости и неотрицательного спроса")}</div>{result.explanation.map((s, i) => <p key={i}>{t(s)}</p>)}<div className="table-scroll"><table><thead><tr><th>{t("Квантиль")}</th>{result.quantiles.map(q => <th key={q.q}>P{q.q * 100}</th>)}</tr></thead><tbody><tr><td>{t("Спрос")}</td>{result.quantiles.map(q => <td key={q.q}>{number(q.demand, 2)}</td>)}</tr><tr><td>{t("Продажи")}</td>{result.quantiles.map(q => <td key={q.q}>{number(q.sales, 2)}</td>)}</tr></tbody></table></div><p className="muted">{t("P10–P90 — центральный диапазон квантильного прогноза. Точность его вероятностной интерпретации зависит от калибровки модели.")}</p></div></details><IconNote>{t("Расчёт описывает направление за день. Вместимость и прогноз непроданных мест не являются фактическими данными о бронированиях.")}</IconNote></>}
 </>}
 {page === 'overview' && <>
 <div className="overview-intro"><div><span className="small-label">{t("ВАША СЕТЬ НАПРАВЛЕНИЙ")}</span><h2>{t("Внимание — там, где оно нужно")}</h2><p>{t("Загрузка рассчитана при базовой цене каждого направления.")}</p></div><div className="period"><CalendarDays size={18}/>{day(meta.dataset.start_date)} — {day(meta.dataset.end_date)} {meta.dataset.end_date.slice(0, 4)}</div></div>
 <div className="overview-stats"><div className="panel"><span className="metric-label">{t("Направлений")}<Plane size={18}/></span><strong>{meta.routes.length}</strong><small>{t("из Москвы")}</small></div><div className="panel"><span className="metric-label">{t("Дней в прогнозе")}<CalendarDays size={18}/></span><strong>{meta.dates.length}</strong><small>{t("доступны для расчёта")}</small></div><div className="panel"><span className="metric-label">{t("Требуют внимания")}<Target size={18}/></span><strong>{overview.filter(x => x.status !== 'normal').length}</strong><small><>{t("из")} </>{overview.length}<> {t("записей направления / даты")}</></small></div></div>
 <section className="panel calendar-panel"><div className="panel-title"><div><h2>{t("Календарь прогнозной загрузки")}</h2><p>{t("Выберите ячейку, чтобы перейти к расчёту.")}</p></div><div className="legend"><span><i className="dot pale"/>{t("до 65%")}</span><span><i className="dot teal"/>65–95%</span><span><i className="dot amber"/>{t("от 95%")}</span></div></div><div className="calendar-scroll"><div className="heatmap" style={{ gridTemplateColumns: `174px repeat(${meta.dates.length},minmax(24px,1fr))` }}><div className="heat-label">{t("Направление / дата")}</div>{meta.dates.map(d => <span className="heat-date" key={d}>{new Date(d + 'T12:00:00').getDate()}{d.endsWith('-01') && <small>{new Date(d + 'T12:00:00').toLocaleDateString(locale(), { month: 'short' }).replace('.', '')}</small>}</span>)}{meta.routes.map(r => <div className="heat-row" key={r.route}><div className="heat-route"><strong>{routeName(r.destination || r.name)}</strong><small>{r.route}</small></div>{meta.dates.map(d => { const item = overview.find(x => x.route === r.route && x.date === d); return <button key={d} disabled={!item} className={'heat-cell ' + (!item ? 'loading' : item.load_factor >= .95 ? 'high' : item.load_factor < .65 ? 'low' : 'medium')} title={`${routeName(r.name)}, ${day(d)}: ${item ? number(item.load_factor * 100, 1) + '%' : t("загрузка данных")}`} onClick={() => { setRoute(r.route); setDate(d); setPrice(r.base_price); setExperiment(false); navigate('forecast'); }}><span className="sr-only">{routeName(r.name)}, {day(d)}: {item ? number(item.load_factor * 100, 1) + '%' : t("нет данных")}</span></button>; })}</div>)}</div></div></section>
 <section className="panel"><div className="panel-title"><div><h2>{t("Требуют внимания")}</h2><p>{t("Сигналы по прогнозу, без данных о фактических бронированиях.")}</p></div><select className="plain-input compact" aria-label={t("Фильтр направлений")} value={filter} onChange={e => { setFilter(e.target.value); setAttentionLimit(20); }}><option value="all">{t("Все направления")}</option>{meta.routes.map(r => <option key={r.route} value={r.route}>{routeName(r.name)}</option>)}</select></div><div className="attention-list">{overview.filter(x => x.status !== 'normal' && (filter === 'all' || x.route === filter)).slice(0, attentionLimit).map(item => <button className="attention-row" key={item.route + item.date} onClick={() => { setRoute(item.route); setDate(item.date); setPrice(item.price); setExperiment(false); navigate('forecast'); }}><span className={'attention-icon ' + (item.status === 'deficit' ? 'amber' : 'teal')}><AlertTriangle size={18}/></span><span><strong>{routeName(meta.routes.find(r => r.route === item.route)?.name || item.route)}</strong><small>{day(item.date, true)} · {t(item.reason)}</small></span><span className="attention-value">{number(item.load_factor * 100, 1)}%<small>{t("загрузка")}</small></span><ChevronRight size={17}/></button>)}{overview.filter(x => x.status !== 'normal' && (filter === 'all' || x.route === filter)).length > attentionLimit && <div className="load-more"><button className="btn btn-outline" onClick={() => setAttentionLimit(v => v + 20)}>{t("Показать ещё")}<ChevronDown size={15}/></button></div>}{overview.length === 0 && <div className="inline-loading"><RefreshCw size={18} className="spin"/>{t("Загружаем календарь…")}</div>}{overview.length > 0 && !overview.some(x => x.status !== 'normal' && (filter === 'all' || x.route === filter)) && <Empty title={t("Все показатели в пределах порогов")} text={t("Для выбранных направлений дополнительных сигналов нет.")} icon={CheckCircle2}/>}</div></section>
 </>}
 {(page === 'scenarios' || page === 'reports') && <>{!user ? <section className="panel"><Empty title={sessionBusy ? t("Подготавливаем ваши сохранения") : t("Не удалось открыть сохранения")} text={sessionBusy ? t("Рабочее пространство откроется автоматически.") : t("Повторите попытку, чтобы сохранять расчёты и готовить отчёты.")} action={!sessionBusy ? <button className="btn btn-dark" onClick={retrySession}><RefreshCw size={17}/>{t("Повторить")}</button> : undefined}/></section> : <><div className="section-toolbar"><div className="filter-tabs"><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>{t("Все решения")}</button>{(['draft', 'review', 'approved'] as const).map(s => <button key={s} className={filter === s ? 'selected' : ''} onClick={() => setFilter(s)}>{t(statuses[s])}</button>)}</div><button className="btn btn-dark" onClick={() => navigate('forecast')}><Plus size={17}/>{t("Новый расчёт")}</button></div>{scenarios.filter(s => filter === 'all' || s.status === filter).length ? <div className="scenario-grid">{scenarios.filter(s => filter === 'all' || s.status === filter).map(s => <article className="panel scenario-card" key={s.id}><div className="card-top"><span className={'pill ' + (s.status === 'approved' ? 'green' : s.status === 'review' ? 'amber' : 'neutral')}>{t(statuses[s.status])}</span><span className="muted text-small">{timestamp(s.created_at)}</span></div><button className="scenario-title" onClick={() => openScenario(s)}>{s.title}<ArrowUpRight size={19}/></button><p className="scenario-route">{routeName(meta.routes.find(r => r.route === s.route)?.name || s.route)} · {day(s.date, true)}</p><div className="scenario-numbers"><div><span>{t("Цена")}</span><strong>{money(s.price)}</strong></div><div><span>{t("Маржинальный доход")}</span><strong>{money(s.result.contribution, true)}</strong></div></div>{s.note && <p className="scenario-note">{s.note}</p>}<div className="card-footer">{page === 'reports' ? <><a className="text-btn" href={documentUrl(`/scenarios/${s.id}/export.csv`)}><Download size={15}/>CSV</a><a className="text-btn" href={documentUrl(`/scenarios/${s.id}/report`)} target="_blank" rel="noreferrer"><FileText size={15}/>{t("Печать / PDF")}</a></> : <><span className="muted text-small">{t("Версия прогноза закреплена")}</span><button className="text-btn" onClick={() => openScenario(s)}>{t("Открыть")}<ArrowRight size={15}/></button></>}</div></article>)}</div> : <section className="panel"><Empty title={t("Пока нет сохранённых решений")} text={t("Выберите направление и цену, сравните варианты и сохраните первый расчёт.")} action={<button className="btn btn-dark" onClick={() => navigate('forecast')}>{t("Перейти к прогнозу")}<ArrowRight size={16}/></button>}/></section>}</>}</>}
 {page === 'data' && <><div className="data-hero"><div className="data-hero-icon"><Database size={29}/></div><div><span className="small-label">{t("ПАСПОРТ ПРОГНОЗА")}</span><h2>{t("Ваш CSV стал рабочим инструментом")}</h2><p>{t("Данные из ML-части используются во всех расчётах сайта и бота.")}</p></div><span className="pill green"><CheckCircle2 size={14}/>{t("Проверен при импорте")}</span></div><div className="data-grid"><section className="panel"><div className="panel-title"><h2>{t("Текущая версия")}</h2><ShieldCheck size={19}/></div><dl className="definition-list"><div><dt>{t("Файл")}</dt><dd>{meta.dataset.filename}</dd></div><div><dt>{t("Период")}</dt><dd>{day(meta.dataset.start_date, true)} — {day(meta.dataset.end_date, true)} {meta.dataset.end_date.slice(0, 4)}</dd></div><div><dt>{t("Объём")}</dt><dd>{meta.dataset.rows}<> {t("записей ·")} </>{meta.dataset.route_count}<> {t("направлений")}</></dd></div><div><dt>{t("Квантили")}</dt><dd>P10, P20, P30, P40, P50, P60, P70, P80, P90</dd></div><div><dt>{t("Загружен")}</dt><dd>{timestamp(meta.dataset.imported_at)}</dd></div><div><dt>{t("Контрольная сумма")}</dt><dd className="checksum">{meta.dataset.sha256}</dd></div></dl></section><section className="panel"><div className="panel-title"><h2>{t("Что означают показатели")}</h2><CircleHelp size={19}/></div><div className="explain-list"><div><span>01</span><p><strong>{t("Спрос")}</strong>{t("Число желающих купить билет при указанной цене. Может превышать вместимость.")}</p></div><div><span>02</span><p><strong>{t("Продажи")}</strong>{t("Неотрицательный спрос, ограниченный числом мест направления за день.")}</p></div><div><span>03</span><p><strong>{t("Маржинальный доход")}</strong>{t("Выручка за вычетом затрат на пассажиров. Постоянные затраты на рейсы не учтены.")}</p></div><div><span>04</span><p><strong>{t("Диапазон P10–P90")}</strong>{t("Центральные квантили прогноза при одной и той же цене.")}</p></div></div></section></div><section className="panel"><div className="panel-title"><h2>{t("Параметры направлений")}</h2><Plane size={19}/></div><div className="table-scroll"><table><thead><tr><th>{t("Направление")}</th><th>{t("Базовая цена")}</th><th>{t("Затраты на пассажира")}</th><th>{t("Чувствительность*")}</th><th>{t("Диапазон оптимизации")}</th></tr></thead><tbody>{meta.routes.map(r => <tr key={r.route}><td><strong>{routeName(r.name)}</strong><small className="table-sub">{r.route}</small></td><td>{money(r.base_price)}</td><td>{money(r.cost_per_passenger)}</td><td>{number(r.price_sensitivity, 4)}</td><td>{money(r.price_min)} — {money(r.price_max)}</td></tr>)}</tbody></table></div><p className="table-footnote">{t("* Изменение спроса в пассажирах при увеличении цены на 1 ₽.")}</p></section><IconNote>{t("Прогноз покрывает только указанные направления и даты. В данных нет фактических бронирований, времени вылета и номеров отдельных рейсов. Расчётные рекомендации не публикуют тарифы в системе продаж.")}</IconNote>{meta.dataset.warnings?.map((s, i) => <IconNote warning key={i}>{t(s)}</IconNote>)}{dataHistory.length > 1 && <section className="panel"><div className="panel-title"><h2>{t("История версий")}</h2><Clock size={18}/></div>{dataHistory.map((d, i) => <div className="version-row" key={i}><Database size={17}/><span>{String(d.filename || d.id || t("Версия данных"))}</span><small>{d.imported_at ? timestamp(String(d.imported_at)) : ''}</small></div>)}</section>}</>}
 {page === 'profile' && <>{!user ? <section className="panel"><Empty icon={Users} title={sessionBusy ? t("Подготавливаем рабочее пространство") : t("Не удалось открыть профиль")} text={t("Расчёты доступны без регистрации. Сохранения откроются автоматически.")} action={!sessionBusy ? <button className="btn btn-dark" onClick={retrySession}>{t("Повторить")}</button> : undefined}/></section> : <><div className="profile-grid"><section className="panel profile-card"><span className="avatar profile-avatar">{displayName.slice(0, 1).toUpperCase()}</span><h2>{displayName}</h2><p>{displaySubtitle}</p><AccountAccess user={user} botUsername={meta.bot_username} className="full" onAuthenticated={acceptUser}/><span className="pill neutral">{isGuest ? t("Гостевой профиль") : t(roles[user.role])}</span>{user.auth_provider !== 'guest' && <button className="btn btn-outline full" onClick={async () => { try {
                const out = await post<{
                    redirect_url?: string;
                }>('/auth/logout', {});
                if (out.redirect_url) {
                    window.location.assign(out.redirect_url);
                    return;
                }
                setUser(null);
                setScenarios([]);
                retrySession();
                navigate('forecast');
            }
            catch (e) {
                setError(errorText(e));
            } }}><LogOut size={16}/>{t("Выйти")}</button>}</section><section className="panel"><div className="panel-title"><h2>{isGuest ? t("Как сохраняются решения") : t("Ваше пространство")}</h2><Bookmark size={20}/></div><p>{isGuest ? t("Расчёты и отчёты доступны в этом браузере без регистрации.") : t('Ваши решения доступны на разных устройствах после входа тем же способом. Telegram подключается отдельно по вашему выбору.','Sign in the same way on another device to access your decisions. Connecting Telegram is a separate, optional step.')}</p>{isGuest && <IconNote>{t("Ключ доступа к сохранённым решениям хранится в cookie этого браузера. Если удалить cookie, доступ к гостевым решениям будет потерян.")}</IconNote>}</section></div>
 {user.auth_provider!=='telegram'&&<section className="panel"><div className="panel-title"><div><h2>{t('Синхронизация по желанию')}</h2><p>{t('По желанию. По умолчанию решения сайта и мини-приложения раздельные.')}</p></div><Send size={21}/></div>{user.telegram_id?<p>{t('Telegram подключён.','Telegram is connected.')} <span className="muted">ID: {String(user.telegram_id)}</span></p>:<><IconNote>{user.role==='admin'?t('После подтверждения ваш Telegram получит доступ администратора этого проекта. Не пересылайте ссылку другим людям.','After confirmation, your Telegram account will receive administrator access to this project. Do not share the link with anyone.'):t('После подтверждения сайт и Telegram будут использовать один профиль и общие решения. Права аккаунта сохранятся.','After confirmation, the website and Telegram will share one profile and its decisions. Your account permissions will be preserved.')}</IconNote><button className="btn btn-outline" disabled={modalBusy} onClick={linkTelegram}>{t('Подключить Telegram','Connect Telegram')}<ArrowRight size={16}/></button>{telegramLink&&<div className="link-fallback"><a className="text-btn" href={telegramLink} target="_blank" rel="noreferrer">{t('Продолжить в Telegram')}<ExternalLink size={14}/></a><small>{t('Нажмите «Старт» в боте и вернитесь на эту страницу.')}</small></div>}</>}</section>}
 {user.auth_provider === 'telegram' ? <section className="panel"><div className="panel-title"><div><h2>{t("Только полезные уведомления")}</h2><p>{t("Подписки включаются по вашему выбору.")}</p></div><Bell size={20}/></div><form className="prefs-form" onSubmit={async (e) => { e.preventDefault(); const epoch=identityEpoch.current;setModalBusy(true); try {
                const updated=await api<Preferences>('/notifications', { method: 'PUT', body: JSON.stringify(prefs) });if(epoch!==identityEpoch.current)return;setPrefs(updated);
                notify(t("Настройки уведомлений сохранены"));
            }
            catch (err) {
                if(epoch===identityEpoch.current)setError(errorText(err));
            }
            finally {
                if(epoch===identityEpoch.current)setModalBusy(false);
            } }}><label className="toggle-row"><span><strong>{t("Изменения прогноза")}</strong><small>{t("Сигнал при загрузке новой версии данных и превышении вашего порога.")}</small></span><input type="checkbox" role="switch" checked={prefs.enabled} onChange={e => setPrefs({ ...prefs, enabled: e.target.checked })}/></label><label className="toggle-row"><span><strong>{t("Ежедневная сводка")}</strong><small>{t("Короткий обзор выбранных направлений в Telegram.")}</small></span><input type="checkbox" role="switch" checked={prefs.digest_enabled} onChange={e => setPrefs({ ...prefs, digest_enabled: e.target.checked })}/></label><div className="form-grid"><label>{t("Порог изменения загрузки, п.п.")}<input className="plain-input" type="number" min="1" max="100" value={prefs.change_threshold} onChange={e => setPrefs({ ...prefs, change_threshold: Number(e.target.value) })}/></label><label>{t("Час сводки")}<select className="plain-input" value={prefs.digest_hour} onChange={e => setPrefs({ ...prefs, digest_hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>)}</select></label><label>{t("Тихие часы: с")}<select className="plain-input" value={prefs.quiet_start} onChange={e => setPrefs({ ...prefs, quiet_start: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{i}:00</option>)}</select></label><label>{t("Тихие часы: до")}<select className="plain-input" value={prefs.quiet_end} onChange={e => setPrefs({ ...prefs, quiet_end: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{i}:00</option>)}</select></label><label>{t("Часовой пояс")}<select className="plain-input" value={prefs.timezone} onChange={e => setPrefs({ ...prefs, timezone: e.target.value })}><option value="Asia/Novosibirsk">{t("Новосибирск · UTC+7")}</option><option value="Europe/Moscow">{t("Москва · UTC+3")}</option><option value="Asia/Yekaterinburg">{t("Екатеринбург · UTC+5")}</option><option value="Asia/Vladivostok">{t("Владивосток · UTC+10")}</option><option value="UTC">UTC</option></select></label></div><label>{t("Направления")}</label><div className="route-checks">{meta.routes.map(r => <label key={r.route} className="check-label"><input type="checkbox" checked={prefs.routes.includes(r.route)} onChange={e => setPrefs({ ...prefs, routes: e.target.checked ? [...prefs.routes, r.route] : prefs.routes.filter(x => x !== r.route) })}/>{routeName(r.destination || r.name)}</label>)}</div><small className="muted">{t("Если направления не выбраны, сводка охватывает все доступные направления.")}</small>{!user.telegram_delivery_ready && <IconNote>{t("Откройте бота командой /start, чтобы включить доставку сообщений.")}</IconNote>}<button className="btn btn-dark" type="submit" disabled={modalBusy}><Save size={16}/>{t("Сохранить настройки")}</button></form></section> : <section className="panel"><Empty icon={Bell} title={t("Настройки рассылок доступны в боте")} text={t("Бот работает самостоятельно. Откройте его, чтобы выбрать уведомления и время сводки.")} action={<a className="btn btn-outline" href={`https://t.me/${meta.bot_username || 'CU_AviGo_app'}`} target="_blank" rel="noreferrer">{t("Открыть бота")}<ExternalLink size={16}/></a>}/></section>}</>}</>}
 {page === 'admin' && <>{user?.role !== 'admin' ? <section className="panel"><Empty icon={ShieldCheck} title={t("Нужен доступ администратора")} text={t("Управление пользователями и импортом доступно администратору проекта.")} action={adminMode ? <a className="btn btn-dark" href={'/signin-with-chatgpt?return_to=' + encodeURIComponent('/?admin=1#admin')} target="_top"><ShieldCheck size={17}/>{t("Вход администратора")}</a> : undefined}/></section> : <><section className="panel"><div className="panel-title"><div><h2>{t("Загрузить новый прогноз")}</h2><p>{t("Проверка структуры, чисел, уникальности записей и порядка квантилей.")}</p></div><Database size={20}/></div><form className="import-form" onSubmit={importData}><label>{t("CSV с прогнозом")}<input className="plain-input" name="forecast" type="file" accept=".csv,text/csv" required/></label><label>{t("Справочник направлений · необязательно")}<input className="plain-input" name="routes" type="file" accept=".csv,text/csv"/></label><IconNote>{t("Импорт создаёт новую версию. Сохранённые решения продолжают ссылаться на исходные данные.")}</IconNote><button className="btn btn-dark" type="submit" disabled={modalBusy}><Database size={16}/>{modalBusy ? t("Проверяем данные…") : t("Проверить и загрузить")}</button></form></section><section className="panel"><div className="panel-title"><h2>{t("Пользователи и права")}</h2><Users size={19}/></div><div className="table-scroll"><table><thead><tr><th>{t("Имя")}</th><th>{t("Почта")}</th><th>{t("Роль")}</th></tr></thead><tbody>{adminUsers.map(u => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td><select className="plain-input compact" aria-label={tf("Роль пользователя {0}", [u.name])} value={u.role} onChange={async (e) => { try {
        await api('/admin/users/' + u.id, { method: 'PATCH', body: JSON.stringify({ role: e.target.value }) });
        setRevision(v => v + 1);
        notify(t("Права обновлены"));
    }
    catch (err) {
        setError(errorText(err));
    } }}>{Object.entries(roles).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</select></td></tr>)}</tbody></table></div></section><section className="panel"><div className="panel-title"><h2>{t("Журнал изменений")}</h2><Clock size={19}/></div><div className="audit-list">{audit.slice(0, 50).map((a, i) => <div key={i}><span className="audit-dot"/><div><strong>{t(String(a.description || a.action || t("Изменение")))}</strong><small>{String(a.email || a.user_id || t("Система"))}</small></div><time>{a.created_at ? timestamp(String(a.created_at)) : ''}</time></div>)}</div></section></>}</>}
 <footer className="footer"><span><Plane size={14}/>{t("Решись Авиа")}</span><span>{t("Решения на основе данных · Учебный проект")}</span><a className="voxel-license-link" href="/third-party-notices.txt" target="_blank" rel="noreferrer">{t("Графика и лицензии","Artwork and licenses")}</a><button onClick={() => navigate('data')}>{t("О данных и ограничениях")}<ArrowUpRight size={13}/></button></footer>
 </main><nav className="mobile-nav">{([['overview', LayoutDashboard], ['forecast', SlidersHorizontal], ['scenarios', Bookmark], ['profile', Users]] as const).map(([p, Icon]) => <button key={p} className={page === p ? 'active' : ''} onClick={() => navigate(p)}><Icon size={20}/><span>{p === 'overview' ? t("Обзор") : p === 'forecast' ? t("Расчёт") : p === 'scenarios' ? t("Решения") : t("Профиль")}</span></button>)}</nav></div>
 {toast && <div className="toast" role="status"><CheckCircle2 size={19}/>{t(toast)}</div>}
 {saving && result && <Modal title={t("Сохранить ценовое решение")} onClose={closeSaving}><form className="auth-form" onSubmit={saveScenario}><label>{t("Название")}<input className="plain-input" name="title" defaultValue={`${routeName(selectedRoute?.name || route)} · ${day(date)}`} required minLength={2} maxLength={150}/></label><div className="saved-summary"><span>{money(result.price)}</span><span>{number(result.sales)}<> {t("билетов")}</></span><span>{money(result.contribution, true)}<> {t("марж. дохода")}</></span></div><label>{t("Обоснование или заметка")}<textarea className="plain-input" name="note" rows={4} maxLength={4000} placeholder={t("Почему выбран этот вариант? Какие допущения важно учесть?")}/></label><IconNote>{t("В карточке сохранятся результат, альтернативные цены и версия исходного прогноза.")}</IconNote>{error && <div className="form-error" role="alert">{t(error)}</div>}<button className="btn btn-dark full" disabled={modalBusy}><Save size={17}/>{modalBusy ? t("Сохраняем…") : t("Сохранить решение")}</button></form></Modal>}
 {detail && <Modal title={t("Карточка ценового решения")} onClose={closeDetail} wide><div className="detail-top"><span className={'pill ' + (detail.status === 'approved' ? 'green' : detail.status === 'review' ? 'amber' : 'neutral')}>{t(statuses[detail.status])}</span><span className="muted text-small">{timestamp(detail.created_at)}</span></div><h2 className="detail-title">{detail.title}</h2><p className="detail-sub">{routeName(meta.routes.find(r => r.route === detail.route)?.name || detail.route)} · {day(detail.date, true)} · {money(detail.price)}</p><Metrics result={detail.result}/><div className="detail-finance"><span>{t("Маржинальный доход")}<strong>{money(detail.result.contribution)}</strong></span><span>{t("Выручка")}<strong>{money(detail.result.revenue)}</strong></span></div><form className="auth-form" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); updateScenario({ title: f.get('title'), note: f.get('note') }); }} key={detail.id}><label>{t("Название")}<input disabled={!canEditDetail} className="plain-input" name="title" defaultValue={detail.title} required minLength={2} maxLength={150}/></label><label>{t("Обоснование")}<textarea disabled={!canEditDetail} className="plain-input" name="note" defaultValue={detail.note} rows={3} maxLength={4000}/></label><button className="btn btn-outline" disabled={modalBusy || !canEditDetail}><Save size={15}/>{t("Сохранить изменения")}</button></form><div className="detail-actions">{detail.status === 'draft' && <button className="btn btn-dark" disabled={modalBusy} onClick={() => updateScenario({ status: 'review' })}>{t("На рассмотрение")}<ArrowRight size={15}/></button>}{detail.status === 'review' && (user?.role === 'manager' || user?.role === 'admin') && <button className="btn btn-dark" disabled={modalBusy} onClick={() => updateScenario({ status: 'approved' })}><Check size={16}/>{t("Согласовать")}</button>}{detail.status !== 'draft' && canEditDetail && <button className="btn btn-outline" disabled={modalBusy} onClick={() => updateScenario({ status: 'draft' })}>{t("Вернуть в черновик")}</button>}<a className="btn btn-outline" href={documentUrl(`/scenarios/${detail.id}/export.csv`)}><Download size={16}/>CSV</a><a className="btn btn-outline" href={documentUrl(`/scenarios/${detail.id}/report`)} target="_blank" rel="noreferrer"><FileText size={16}/>{t("Печать / PDF")}</a><button className="btn btn-outline" onClick={() => { setRoute(detail.route); setDate(detail.date); setPrice(detail.price); setExperiment(detail.result.is_experiment); setCapacity(String(detail.result.capacity)); setMultiplier(String(detail.result.demand_multiplier ?? 1)); setDetail(null); navigate('forecast'); }}>{detail.dataset_id === meta.dataset.id ? t("Открыть расчёт") : t("Пересчитать по текущим данным")}<ArrowUpRight size={16}/></button></div>{error && <div className="form-error" role="alert">{t(error)}</div>}{!canEditDetail && <IconNote>{t("Согласованное решение защищено от изменений. Изменить его статус может руководитель или администратор.")}</IconNote>}<p className="muted text-small"><>{t("Снимок результата закреплён за версией данных")} </>{String(detail.dataset_id).slice(0, 12)}{t(". Согласование не публикует тариф в системе продаж.")}</p>{detail.history && detail.history.length > 0 && <details className="detail-history"><summary>{t("История решения")}</summary>{detail.history.map((h, i) => <p key={i}>{t(h.description || h.action || '')} <span className="muted">{(h.at || h.created_at) ? timestamp(h.at || h.created_at!) : ''}</span></p>)}</details>}<button disabled={!canEditDetail} className="text-btn danger delete-btn" onClick={async () => { if (!window.confirm(t("Удалить сохранённое решение? Это действие нельзя отменить.")))
        return; try {
        await api('/scenarios/' + detail.id, { method: 'DELETE' });
        setDetail(null);
        setRevision(v => v + 1);
        notify(t("Решение удалено"));
    }
    catch (e) {
        setError(errorText(e));
    } }}>{t("Удалить решение")}</button></Modal>}
 </div>;
}

import {t,tf,locale,routeName,cityName,canonicalCity,useLanguage} from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Monitor, Moon, Sun } from 'lucide-react';
type ThemeMode = 'system' | 'light' | 'dark';
export function useAppTheme() {
    const [mode, setMode] = useState<ThemeMode>('light'), [systemDark, setSystemDark] = useState(false);
    useEffect(() => { try {
        const value = localStorage.getItem('avia-theme');
        if (value === 'light' || value === 'dark' || value === 'system')
            setMode(value);
    }
    catch { } const media = matchMedia('(prefers-color-scheme: dark)'); setSystemDark(media.matches); const change = () => setSystemDark(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
    const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
    useEffect(() => { document.documentElement.dataset.theme = resolved; document.documentElement.style.colorScheme = resolved; const tg = (window as unknown as {
        Telegram?: {
            WebApp?: {
                setHeaderColor?: (color: string) => void;
                setBackgroundColor?: (color: string) => void;
            };
        };
    }).Telegram?.WebApp; const background = getComputedStyle(document.documentElement).getPropertyValue('--page-bg').trim(); const color = /^#[a-f0-9]{6}$/i.test(background) ? background : resolved === 'dark' ? '#0c1422' : '#f4f6f9'; try {
        tg?.setHeaderColor?.(color);
        tg?.setBackgroundColor?.(color);
    }
    catch { } }, [resolved]);
    const changeMode = (value: ThemeMode) => { setMode(value); try {
        localStorage.setItem('avia-theme', value);
    }
    catch { } };
    return { mode, resolved, setMode: changeMode };
}
export function ThemeControl({ mode, resolved, onChange }: {
    mode: ThemeMode;
    resolved: 'light' | 'dark';
    onChange: (value: ThemeMode) => void;
}) {
    const [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), Icon = mode === 'system' ? Monitor : resolved === 'dark' ? Moon : Sun;
    useEffect(() => { if (!open)
        return; const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node))
        setOpen(false); }; document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside); }, [open]);
    return <div ref={root} style={{ position: 'relative' }} onKeyDown={event => { if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
    } }}><button type="button" ref={button} className="theme-toggle" aria-label={t("Оформление: ") + (mode === 'system' ? t("как в системе") : resolved === 'dark' ? t("тёмное") : t("светлое"))} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}><Icon size={18}/><span>{mode === 'system' ? t("Системная") : resolved === 'dark' ? t("Тёмная") : t("Светлая")}</span><ChevronDown size={13}/></button>{open && <div className="theme-menu" role="menu" aria-label={t("Выбрать оформление")}>{([{ value: 'light', title: t("Светлая"), Icon: Sun }, { value: 'dark', title: t("Тёмная"), Icon: Moon }, { value: 'system', title: t("Как в системе"), Icon: Monitor }] as const).map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={mode === option.value} onClick={() => { onChange(option.value); setOpen(false); button.current?.focus(); }}><option.Icon size={17}/>{option.title}{mode === option.value && <Check size={15} style={{ marginLeft: 'auto' }}/>}</button>)}</div>}</div>;
}

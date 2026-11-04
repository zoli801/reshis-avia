import {Languages} from 'lucide-react';
import {t,useLanguage,type Language} from './i18n';

export function LanguageControl(){
 const [language,setLanguage]=useLanguage();
 return <label className="language-control" title={t('Язык интерфейса','Interface language')}><Languages size={17} aria-hidden="true"/><select aria-label={t('Язык интерфейса','Interface language')} value={language} onChange={event=>setLanguage(event.target.value as Language)}><option value="ru">RU</option><option value="en">EN</option></select></label>;
}

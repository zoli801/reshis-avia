import {useState} from 'react';
import {ArrowRight,Lightbulb} from 'lucide-react';
import {t,useLanguage} from './i18n';
import './VoxelDecor.css';
import './plains-scene.css';

/** Original vector artwork. The visual motif never changes model values. */
export function VoxelSpinner({small=false}:{small?:boolean}){
  return <span className={'voxel-spinner'+(small?' is-small':'')} aria-hidden="true"><i/><i/><i/><i/></span>;
}

export function VoxelPlaneIcon({size=24}:{size?:number}){
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true"><path d="M7 1h2v5h2v2h3v2H9v3h2v2H5v-2h2v-3H2V8h3V6h2z"/></svg>;
}

export function VoxelActivity({label,compact=false}:{label?:string;compact?:boolean}){
  useLanguage();
  return <div className={'voxel-activity'+(compact?' is-compact':'')} role="status" aria-live="polite"><VoxelSpinner/><span>{label||t('Считаем спрос и обновляем графики…','Calculating demand and updating charts…')}</span><span className="voxel-activity-track" aria-hidden="true"><i/><i/><i/><i/><i/></span></div>;
}

export function VoxelBoot({label,error,onRetry}:{label?:string;error?:string;onRetry?:()=>void}){
  useLanguage();
  return <div className="boot voxel-boot"><div className="voxel-boot-scene" aria-hidden="true"><img className="voxel-boot-island" src="/voxel/plains-landscape.svg" width="384" height="216" alt=""/><img className="voxel-boot-drone" src="/voxel/survey-drone.svg" width="72" height="72" alt=""/></div><div className="voxel-boot-copy"><span className="voxel-kicker">{t('БИОМ · РАВНИНЫ','BIOME · PLAINS')}</span><h1>{t('Решись Авиа','Reshis Avia')}</h1>{error?<><p role="alert">{error}</p>{onRetry&&<button type="button" className="btn btn-dark" onClick={onRetry}>{t('Повторить','Try again')}</button>}</>:<VoxelActivity label={label||t('Загружаем ваш прогноз…','Loading your forecast…')} compact/>}</div></div>;
}

const tips=[
  ['Начните с маршрута и даты. Затем измените цену — спрос, продажи и графики пересчитаются вместе.','Start with a route and date. Then adjust the price: demand, sales and charts update together.'],
  ['Спрос — сколько человек хотят купить билет. Продажи ограничены числом мест: лишних билетов в прогнозе нет.','Demand is how many people want a ticket. Sales are capped at capacity: the forecast cannot sell extra seats.'],
  ['P10–P90 показывает диапазон прогноза. Сравните его с вместимостью, чтобы оценить неопределённость спроса.','P10–P90 shows the forecast range. Compare it with capacity to assess demand uncertainty.'],
] as const;

export function VoxelWelcome({onLearnMore}:{onLearnMore:()=>void}){
  useLanguage();
  const [tip,setTip]=useState(-1);
  return <section className="voxel-welcome" aria-label={t('Полётная мастерская','Flight workshop')}>
    <div className="voxel-intro"><span className="voxel-kicker"><i aria-hidden="true"/>{t('БИОМ · РАВНИНЫ','BIOME · PLAINS')}</span><h2>{t('Ваш маршрут. Ваше решение.','Your route. Your decision.')}</h2><p>{t('Выберите направление и цену. Постройте прогноз своего полёта.','Choose a route and a price. Build your flight forecast.')}</p><div className="voxel-intro-actions"><button className="voxel-tip-button" type="button" onClick={()=>setTip(current=>current>=tips.length-1?-1:current+1)} aria-expanded={tip>=0} aria-controls="navigator-tip"><Lightbulb size={15}/>{tip===tips.length-1?t('Скрыть совет','Hide tip'):tip>=0?t('Ещё совет','Another tip'):t('Совет Пика','Pip’s tip')}</button><button type="button" className="voxel-model-link" onClick={onLearnMore}>{t('О модели','About the model')}<ArrowRight size={14}/></button></div>{tip>=0&&<p id="navigator-tip" className="voxel-tip" role="status">{t(tips[tip][0],tips[tip][1])}</p>}</div>
    <div className="voxel-hero-scene" aria-hidden="true"><img className="voxel-airfield" src="/voxel/plains-landscape.svg" width="640" height="240" alt="" fetchPriority="high"/><img className="voxel-hero-cloud" src="/voxel/pixel-cloud.svg" width="112" height="48" alt=""/><div className="voxel-characters"><img className="voxel-navigator" src="/voxel/navigator.svg" width="112" height="144" alt=""/><img className="voxel-drone" src="/voxel/survey-drone.svg" width="88" height="88" alt=""/></div><span className="voxel-crew-caption">{t('Штурман Пик и дрон Байт','Navigator Pip & drone Byte')}</span></div>
  </section>;
}

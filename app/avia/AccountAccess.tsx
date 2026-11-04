import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowRight,CheckCircle2,Eye,EyeOff,KeyRound,LoaderCircle,LockKeyhole,LogIn,Send,ShieldCheck,UserRound,X} from 'lucide-react';
import {isTelegramClient,post,type User} from './api';
import {t,useLanguage} from './i18n';
import './account.css';
import {VoxelSpinner} from './VoxelDecor';

type Props={user:User|null;botUsername?:string;onAuthenticated:(user:User)=>void;className?:string};
type Tab='login'|'register'|'security';
type Challenge={login_id:string;browser_secret:string;url:string;expires_at:string|number;verification_code:string};
const signInPath='/signin-with-chatgpt?return_to='+encodeURIComponent('/?auth=chatgpt#profile');

export function AccountAccess({user,botUsername='CU_AviGo_app',onAuthenticated,className=''}:Props){
  useLanguage();
  const [open,setOpen]=useState(false),[tab,setTab]=useState<Tab>('login'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState('');
  const [username,setUsername]=useState(''),[name,setName]=useState(''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[currentPassword,setCurrentPassword]=useState(''),[visible,setVisible]=useState(false),[importGuest,setImportGuest]=useState(false);
  const [challenge,setChallenge]=useState<Challenge|null>(null),[seconds,setSeconds]=useState(0);
  const dialog=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),requestEpoch=useRef(0),callbacks=useRef(onAuthenticated);
  callbacks.current=onAuthenticated;
  const telegramClient=isTelegramClient();
  const guest=!user||user.auth_provider==='guest';
  const cancelChallenge=()=>{if(challenge)void post('/auth/telegram/cancel',{login_id:challenge.login_id,browser_secret:challenge.browser_secret}).catch(()=>{});};
  const close=()=>{requestEpoch.current++;cancelChallenge();setOpen(false);setChallenge(null);setPassword('');setConfirmation('');setCurrentPassword('');setError('');setSuccess('');setBusy(false);};
  const selectTab=(value:Tab)=>{requestEpoch.current++;cancelChallenge();setTab(value);setError('');setSuccess('');setChallenge(null);setBusy(false);setPassword('');setConfirmation('');setCurrentPassword('');};
  useEffect(()=>{
    if(!open)return;
    const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const focusable=()=>Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]')??[]).filter(el=>el.offsetParent!==null);
    focusable()[0]?.focus();
    const keydown=(event:KeyboardEvent)=>{if(event.key==='Escape')close();if(event.key!=='Tab')return;const list=focusable(),first=list[0],last=list.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}};
    document.addEventListener('keydown',keydown);return()=>{document.body.style.overflow=previousOverflow;document.removeEventListener('keydown',keydown);trigger.current?.focus();};
  },[open]);
  useEffect(()=>{
    if(!challenge||!open)return;
    let stopped=false,inflight=false;const epoch=requestEpoch.current;
    const expiry=typeof challenge.expires_at==='number'?challenge.expires_at*(challenge.expires_at<1e12?1000:1):Date.parse(challenge.expires_at);
    const tick=async()=>{
      if(stopped||inflight)return;
      const remaining=Math.max(0,Math.ceil((expiry-Date.now())/1000));setSeconds(remaining);
      if(!remaining){setError(t('Запрос входа истёк. Создайте новый.','This sign-in request has expired. Create a new one.'));setChallenge(null);return;}
      inflight=true;
      try{const result=await post<{status:string;user?:User}>('/auth/telegram/poll',{login_id:challenge.login_id,browser_secret:challenge.browser_secret});if(stopped||epoch!==requestEpoch.current)return;if(result.user&&result.status==='authenticated'){callbacks.current(result.user);close();}}
      catch(reason){if(stopped||epoch!==requestEpoch.current)return;setError(reason instanceof Error?reason.message:t('Не удалось проверить вход.','Could not check sign-in.'));setChallenge(null);}
      finally{inflight=false;}
    };
    void tick();const timer=setInterval(()=>void tick(),2500);return()=>{stopped=true;clearInterval(timer);};
  },[challenge,open]);
  const submit=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();setError('');setSuccess('');
    if((tab==='register'||tab==='security')&&password!==confirmation){setError(t('Пароли не совпадают.','The passwords do not match.'));return;}
    const epoch=++requestEpoch.current;setBusy(true);
    try{
      if(tab==='security'){
        const result=await post<{user?:User}>('/auth/password',{current_password:currentPassword,new_password:password});
        if(epoch!==requestEpoch.current)return;if(result.user)callbacks.current(result.user);
        setPassword('');setConfirmation('');setCurrentPassword('');setSuccess(t('Пароль изменён. Другие сеансы завершены.','Password changed. Other sessions have been signed out.'));
      }else{
        const result=await post<{user:User}>(tab==='register'?'/auth/register':'/auth/login',{username,password,...(tab==='register'?{name}:{}),import_guest:guest&&importGuest});
        if(epoch!==requestEpoch.current)return;callbacks.current(result.user);close();
      }
    }catch(reason){if(epoch===requestEpoch.current)setError(reason instanceof Error?reason.message:t('Не удалось выполнить вход.','Could not sign in.'));}
    finally{if(epoch===requestEpoch.current)setBusy(false);}
  };
  const startTelegram=async()=>{
    const epoch=++requestEpoch.current;cancelChallenge();setBusy(true);setError('');setSuccess('');setChallenge(null);
    try{const value=await post<Challenge>('/auth/telegram/start',{});if(epoch===requestEpoch.current)setChallenge(value);}
    catch(reason){if(epoch===requestEpoch.current)setError(reason instanceof Error?reason.message:t('Не удалось начать вход через Telegram.','Could not start Telegram sign-in.'));}
    finally{if(epoch===requestEpoch.current)setBusy(false);}
  };
  return <>
    <button ref={trigger} className={'btn btn-outline account-trigger '+className} aria-label={guest?t('Войти в аккаунт','Sign in to your account'):t('Настройки аккаунта','Account settings')} onClick={()=>{setTab(user?.auth_provider==='password'?'security':'login');setOpen(true);}}><LogIn size={16}/><span>{guest?t('Войти','Sign in'):t('Аккаунт','Account')}</span></button>
    {open&&<div className="account-backdrop" onClick={event=>{if(event.target===event.currentTarget)close();}}>
      <div ref={dialog} className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <div className="account-heading"><div className="account-symbol"><ShieldCheck size={24}/></div><button className="account-close" type="button" onClick={close} aria-label={t('Закрыть','Close')}><X size={21}/></button></div>
        {telegramClient?<><h2 id="account-title">{t('Ваш аккаунт Telegram','Your Telegram account')}</h2><p className="account-intro">{t('В мини-приложении вы уже вошли через подтверждённый аккаунт Telegram. Сайт работает отдельно и предлагает вход через ChatGPT, логин с паролем или Telegram.','You are already signed in to the Mini App with your verified Telegram account. The standalone website offers ChatGPT, username and password, or Telegram sign-in.')}</p><a className="btn btn-dark full" href={window.location.origin+'/#profile'} target="_blank" rel="noopener noreferrer">{t('Открыть отдельный сайт','Open standalone website')}<ArrowRight size={16}/></a><p className="account-footnote">{t('Данные сайта и мини-приложения объединяются только после добровольного связывания в профиле сайта.','Website and Mini App data are combined only after you choose to link them in the website profile.')}</p></>:<>
        <h2 id="account-title">{tab==='security'?t('Безопасность аккаунта','Account security'):tab==='register'?t('Создайте свой аккаунт','Create your account'):t('Добро пожаловать','Welcome back')}</h2>
        <p className="account-intro">{tab==='security'?t('Измените пароль для входа по логину.','Change the password for your username account.'):t('Сохраняйте решения и возвращайтесь к ним с любого устройства.','Save decisions and access them from any device.')}</p>
        <div className="account-tabs" role="group" aria-label={t('Способ входа','Sign-in options')}>
          <button aria-pressed={tab==='login'} onClick={()=>selectTab('login')}>{t('Вход','Sign in')}</button>
          <button aria-pressed={tab==='register'} onClick={()=>selectTab('register')}>{t('Регистрация','Register')}</button>
          {user?.auth_provider==='password'&&<button aria-pressed={tab==='security'} onClick={()=>selectTab('security')}><LockKeyhole size={14}/>{t('Пароль','Password')}</button>}
        </div>
        {tab!=='security'&&<>
          <div className="account-providers"><a className="btn btn-outline" href={signInPath} target="_top"><span className="account-chatgpt" aria-hidden="true">✳</span>ChatGPT<ArrowRight size={15}/></a><button className="btn btn-outline" type="button" disabled={busy} onClick={startTelegram}><Send size={17}/>Telegram<ArrowRight size={15}/></button></div>
          {challenge&&<div className="account-telegram" role="status"><strong>{t('Подтвердите вход в боте','Confirm sign-in in the bot')}</strong><p>{t('Сравните код на сайте и в Telegram. Подтверждайте только свой запрос.','Match the code shown here and in Telegram. Only confirm your own request.')}</p><div className="account-code" aria-label={t('Код подтверждения','Verification code')}>{challenge.verification_code}</div><a className="btn btn-dark full" href={challenge.url} target="_blank" rel="noopener noreferrer"><Send size={16}/>{t('Открыть бота','Open bot')} @{botUsername}</a><small>{t('Сайт ждёт подтверждения','Waiting for your confirmation')}{seconds>0?' · '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'):''}</small><button type="button" className="text-btn" onClick={()=>{requestEpoch.current++;cancelChallenge();setChallenge(null);}}>{t('Отменить запрос','Cancel request')}</button></div>}
          <div className="account-divider"><span>{t('или по логину','or use a username')}</span></div>
        </>}
        <form className="account-form" onSubmit={submit}>
          {tab==='register'&&<label>{t('Как вас зовут','Your name')}<div className="account-input"><UserRound size={17}/><input name="name" autoComplete="name" value={name} onChange={e=>setName(e.target.value)} minLength={1} maxLength={80} required placeholder={t('Ваше имя','Your name')}/></div></label>}
          {tab!=='security'&&<label>{t('Логин','Username')}<div className="account-input"><UserRound size={17}/><input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={e=>setUsername(e.target.value)} minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}" required placeholder="aviator"/></div>{tab==='register'&&<small>{t('3–32 символа: латинские буквы, цифры, точка, дефис и подчёркивание.','3–32 characters: Latin letters, numbers, dots, hyphens and underscores.')}</small>}</label>}
          {tab==='security'&&<label>{t('Текущий пароль','Current password')}<div className="account-input"><KeyRound size={17}/><input name="current_password" autoComplete="current-password" type={visible?'text':'password'} value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)} required maxLength={128}/></div></label>}
          <label>{tab==='security'?t('Новый пароль','New password'):t('Пароль','Password')}<div className="account-input"><KeyRound size={17}/><input name="password" autoComplete={tab==='login'?'current-password':'new-password'} type={visible?'text':'password'} value={password} onChange={e=>setPassword(e.target.value)} required minLength={tab==='login'?1:12} maxLength={128}/><button type="button" className="account-reveal" aria-label={visible?t('Скрыть пароль','Hide password'):t('Показать пароль','Show password')} aria-pressed={visible} onClick={()=>setVisible(!visible)}>{visible?<EyeOff size={17}/>:<Eye size={17}/>}</button></div>{tab!=='login'&&<small>{t('От 12 до 128 символов. Используйте уникальный пароль.','12–128 characters. Use a unique password.')}</small>}</label>
          {tab!=='login'&&<label>{t('Повторите пароль','Confirm password')}<div className="account-input"><LockKeyhole size={17}/><input name="confirmation" autoComplete="new-password" type={visible?'text':'password'} value={confirmation} onChange={e=>setConfirmation(e.target.value)} required minLength={12} maxLength={128}/></div></label>}
          {guest&&tab!=='security'&&<label className="account-check"><input type="checkbox" checked={importGuest} onChange={e=>setImportGuest(e.target.checked)}/><span>{t('Перенести мои гостевые решения из этого браузера в аккаунт при входе по логину.','Move my guest decisions from this browser into the account when signing in with a username.')}</span></label>}
          {error&&<div className="form-error" role="alert">{error}</div>}
          {success&&<div className="account-success" role="status"><CheckCircle2 size={17}/>{success}</div>}
          <button className="btn btn-dark full" type="submit" disabled={busy}>{busy?<VoxelSpinner small/>:tab==='security'?<ShieldCheck size={17}/>:<LogIn size={17}/>}<span>{busy?t('Подождите…','Please wait…'):tab==='register'?t('Создать аккаунт','Create account'):tab==='security'?t('Изменить пароль','Change password'):t('Войти','Sign in')}</span></button>
        </form>
        <p className="account-footnote"><LockKeyhole size={13}/>{t('Регистрация добровольная. Сайт доступен и без входа. Telegram связывается с сайтом только по вашему выбору.','Registration is optional. You can use the site without signing in. Telegram is linked only when you choose to link it.')}</p>
        </>}
      </div>
    </div>}
  </>;
}

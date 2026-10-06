import {useEffect,useRef,useState} from 'react';
import {useForm,useStore} from '@tanstack/react-form';
import {ArrowLeft,LoaderCircle,Mail} from 'lucide-react';
import {passwordRecoveryClient,errorMessage} from './api';

export function PasswordRecovery90({onClose}:{onClose:()=>void}){
 const [stage,setStage]=useState<'email'|'code'|'done'>('email'),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const controller=useRef<AbortController|null>(null),alive=useRef(true),latch=useRef(false),operation=useRef<string|null>(null);
 const form=useForm({defaultValues:{email:'',code:'',password:'',confirmation:''},onSubmit:async()=>void submit()}),value=useStore(form.store,s=>s.values);
 useEffect(()=>{alive.current=true;const clear=()=>{controller.current?.abort();form.reset()};window.addEventListener('pagehide',clear);return()=>{alive.current=false;window.removeEventListener('pagehide',clear);clear()}},[]);
 async function submit(){
  if(latch.current||stage==='done')return;latch.current=true;setBusy(true);setError('');const pending=new AbortController();controller.current=pending;
  try{
   if(stage==='email'){
    operation.current??=crypto.randomUUID();const r=await passwordRecoveryClient.requestPasswordRecovery({email:value.email,operationId:operation.current},{signal:pending.signal});
    if(alive.current&&!pending.signal.aborted){form.reset();setMessage(r.message);setStage('code')}
   }else{
    if(value.password!==value.confirmation)throw Error('The passwords do not match.');
    const r=await passwordRecoveryClient.completePasswordRecovery({recoveryCode:value.code.trim(),newPassword:value.password},{signal:pending.signal});if(!r.requiresLogin)throw Error('Password recovery could not be confirmed.');
    if(alive.current&&!pending.signal.aborted){form.reset();setStage('done');setMessage('Your password was reset and existing Golf sessions were revoked. Sign in with your new password and your existing authenticator or MFA recovery code, if enabled.')}
   }
  }catch(e){if(alive.current&&!pending.signal.aborted)setError(errorMessage(e instanceof Error?e:new Error('Password recovery could not be completed.')))}
  finally{form.setFieldValue('password','');form.setFieldValue('confirmation','');latch.current=false;if(alive.current)setBusy(false)}
 }
 return <><h2>Recover your password</h2><p>Recovery requires explicit enrollment, your currently verified Golf email and configured email delivery. Your authenticator stays enabled.</p>
 {message?<p className="session-notice" role="status">{message}</p>:null}
 {stage==='done'?<button className="button primary full" onClick={onClose}>Return to sign-in</button>:<form aria-label="Password recovery" onSubmit={e=>{e.preventDefault();void form.handleSubmit()}}>
 {stage==='email'?<><label htmlFor="recovery-email90">Golf email</label><input id="recovery-email90" type="email" autoComplete="email" autoCapitalize="none" required maxLength={254} value={value.email} disabled={busy} onChange={e=>form.setFieldValue('email',e.target.value)}/><button className="button primary full" disabled={busy||!value.email}>{busy?<LoaderCircle className="spin" size={17}/>:<Mail size={17}/>}Request recovery code</button><button type="button" className="text-button" disabled={busy} onClick={()=>{form.reset();setStage('code')}}>I already have a recovery code</button></>:<><label htmlFor="recovery-code90">Recovery code from email</label><input id="recovery-code90" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} required maxLength={69} value={value.code} disabled={busy} onChange={e=>form.setFieldValue('code',e.target.value)}/><label htmlFor="recovery-password90">New password</label><input id="recovery-password90" type="password" autoComplete="new-password" required minLength={15} maxLength={1024} value={value.password} disabled={busy} onChange={e=>form.setFieldValue('password',e.target.value)}/><label htmlFor="recovery-confirmation90">Confirm new password</label><input id="recovery-confirmation90" type="password" autoComplete="new-password" required minLength={15} maxLength={1024} value={value.confirmation} disabled={busy} onChange={e=>form.setFieldValue('confirmation',e.target.value)}/><p className="field-help">Use at least 15 characters. This does not reset MFA or revoke independent provider or Git credentials.</p><button className="button primary full" disabled={busy||value.code.trim().length!==69||Array.from(value.password).length<15||value.password!==value.confirmation}>{busy?<LoaderCircle className="spin" size={17}/>:null}Reset password</button></>}
 </form>}{error?<p className="error" role="alert">{error}</p>:null}{stage!=='done'?<button className="text-button" disabled={busy} onClick={()=>{form.reset();onClose()}}><ArrowLeft size={15}/>Back to sign-in</button>:null}</>;
}

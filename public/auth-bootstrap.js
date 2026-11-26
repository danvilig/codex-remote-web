import { installAccessSession } from './access-session.js';
import { codexInterfaceMark } from './codex-brand.js';
import { codexIcon } from './codex-icons.js';
import { createDomI18n, createI18n } from './i18n.js';

const $=selector=>document.querySelector(selector);
const i18n=globalThis.__codexWebuiI18n||createI18n();
globalThis.__codexWebuiI18n=i18n;
globalThis.__codexWebuiDomI18n=globalThis.__codexWebuiDomI18n||createDomI18n(i18n);
const t=message=>i18n.t(message);

function stylesheetReady(link){
  try{
    if(link.disabled||!link.sheet?.cssRules.length)return false;
    return new URL(link.href).pathname!=='/workspace.css'||
      getComputedStyle(document.documentElement).getPropertyValue('--workspace-styles-ready').trim()==='1';
  }
  catch{return false;}
}

function retryStylesheet(link){
  const replacement=link.cloneNode();
  const url=new URL(link.href);
  url.searchParams.set('retry',Date.now());
  replacement.href=url.href;
  return new Promise(resolve=>{
    const finish=()=>{
      clearTimeout(timer);
      replacement.onload=replacement.onerror=null;
      resolve();
    };
    replacement.onload=replacement.onerror=finish;
    const timer=setTimeout(finish,8000);
    link.replaceWith(replacement);
  });
}

async function ensureWorkspaceStyles(){
  const links=()=>[...document.head.querySelectorAll('link[rel="stylesheet"]')]
    .filter(link=>['/style.css','/workspace.css'].includes(new URL(link.href).pathname));
  const missing=()=>links().filter(link=>!stylesheetReady(link));
  if(!missing().length)return;

  const dialog=document.createElement('dialog');
  dialog.className='stylesheet-recovery';
  dialog.setAttribute('aria-labelledby','stylesheetRecoveryTitle');
  const title=document.createElement('h1');
  title.id='stylesheetRecoveryTitle';
  const retry=document.createElement('button');
  retry.type='button';
  retry.textContent=t('Retry loading');
  title.textContent=t('Loading workspace styles…');
  retry.disabled=true;
  dialog.append(title,retry);
  document.body.append(dialog);
  dialog.addEventListener('cancel',event=>event.preventDefault());
  dialog.showModal();

  while(missing().length){
    title.textContent=t('Loading workspace styles…');
    retry.disabled=true;
    await Promise.all(missing().map(retryStylesheet));
    if(!missing().length)break;
    title.textContent=t('Workspace styles could not load');
    retry.disabled=false;
    retry.focus();
    await new Promise(resolve=>retry.addEventListener('click',resolve,{once:true}));
  }
  dialog.close();
  dialog.remove();
}

async function loadApp(){
  for(const href of ['/vendor/katex/katex.min.css','/vendor/xterm/xterm.css']){
    if(document.querySelector(`link[href="${href}"]`))continue;
    const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);
  }
  const revision = $('meta[name="app-bundle-revision"]')?.content;
  await import(revision ? `/app.bundle.js?v=${revision}` : '/app.bundle.js');
}

async function start(){
  await ensureWorkspaceStyles();
  let status;
  try{
    const response=await fetch('/api/auth/status',{credentials:'same-origin',cache:'no-store'});
    status=await response.json();
    if(!response.ok && !['cloudflare-access','quick-tunnel'].includes(status.mode))throw new Error(`Authentication status failed (${response.status})`);
  }catch(reason){console.error('[codex-webui] authentication status failed',reason);return}
  globalThis.__codexWebuiAccessIdentity=status.authenticated&&['cloudflare-access','quick-tunnel'].includes(status.mode)?status.identity:null;
  if(['cloudflare-access','quick-tunnel'].includes(status.mode)){const session=installAccessSession(status,{translate:t});if(session.required)return}
  if(status.authenticated||(!status.setupRequired&&!status.passwordRequired)){await loadApp();return}
  const gate=$('#passwordGate'),app=$('#app'),input=$('#passwordInput'),confirmInput=$('#passwordConfirmInput'),form=$('#passwordLoginForm'),button=$('#passwordLoginButton'),error=$('#passwordError'),title=$('#passwordTitle');
  let mode=status.setupRequired?'setup':'login';
  $('#passwordCodexMark').innerHTML=codexInterfaceMark('password-codex-mark');
  const visibility=$('#passwordVisibility');
  function setPasswordVisibility(visible){
    input.type=confirmInput.type=visible?'text':'password';
    visibility.setAttribute('aria-pressed',String(visible));
    visibility.innerHTML=codexIcon(visible?'eyeOff':'eye');
  }
  visibility.onclick=()=>setPasswordVisibility(input.type==='password');
  const configure=()=>{
    const setup=mode==='setup';
    title.textContent=t(setup?'Set a LAN password':'Log in');
    gate.setAttribute('aria-label',t(setup?'Codex WebUI password setup':'Codex WebUI login'));
    $('#passwordLabel').textContent=setup?'New password':'Password';
    input.autocomplete=setup?'new-password':'current-password';
    input.minLength=setup?12:0;
    input.maxLength=256;
    $('#passwordConfirmLabel').hidden=confirmInput.hidden=!setup;confirmInput.required=setup;confirmInput.value='';
    setPasswordVisibility(false);
    button.textContent=t(setup?'Set password':'Log in');
  };
  configure();gate.hidden=false;app.setAttribute('aria-hidden','true');app.inert=true;requestAnimationFrame(()=>input.focus());
  form.onsubmit=async event=>{
    event.preventDefault();error.hidden=true;
    if(mode==='setup'&&input.value.length<12){error.textContent=t('Password must be at least 12 characters');error.hidden=false;input.focus();return}
    if(mode==='setup'&&input.value!==confirmInput.value){error.textContent=t('Passwords do not match');error.hidden=false;confirmInput.select();return}
    const endpoint=mode==='setup'?'/api/auth/setup':'/api/auth/login';
    button.disabled=true;button.textContent=t(mode==='setup'?'Setting password…':'Logging in…');
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:input.value})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok){
        if(mode==='setup'&&response.status===409){mode='login';input.value='';configure();throw new Error(t('A password was already set. Log in to continue.'));}
        throw new Error(data.error||t(mode==='setup'?'Unable to set the password':'Unable to log in'));
      }
      gate.hidden=true;app.removeAttribute('aria-hidden');app.inert=false;input.value='';confirmInput.value='';
      await loadApp();
    }catch(reason){error.textContent=reason instanceof Error?reason.message:String(reason);error.hidden=false;input.select()}
    finally{button.disabled=false;button.textContent=t(mode==='setup'?'Set password':'Log in')}
  };
}

start().catch(error=>console.error('[codex-webui] authentication bootstrap failed',error));

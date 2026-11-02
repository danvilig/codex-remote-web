import { temporaryQr } from './quick-qr.js';
export function mountTemporaryAccess(root, { request, ensureSession, back, t = value => value }) {
  root.innerHTML = `<h2 data-quick="title"></h2><p data-quick="description"></p>
    <p class="remote-message" data-quick="message" role="status" aria-live="polite"></p>
    <form data-quick="form"><label><span data-quick="emailLabel"></span><input name="quickEmail" type="email" required autocomplete="email" maxlength="254"></label><button class="primary" type="submit" data-quick="start"></button></form>
    <div data-quick="connection" hidden><dl class="remote-summary"><dt data-quick="statusLabel"></dt><dd data-quick="status" data-i18n-ignore></dd><dt data-quick="allowedLabel"></dt><dd data-quick="email" data-i18n-ignore></dd></dl>
      <div class="remote-quick-address" data-quick="address" hidden><a data-quick="link" target="_blank" rel="noreferrer" data-i18n-ignore></a><div class="remote-quick-qr" data-quick="qr" role="img"></div><p data-quick="scan"></p><div class="remote-actions"><button type="button" data-quick="copy"></button><a class="remote-open primary" data-quick="open" target="_blank" rel="noreferrer"></a></div></div>
    </div>
    <p class="remote-hint" data-quick="limits"></p><a data-quick="install" href="https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/" target="_blank" rel="noreferrer" hidden></a>
    <div class="remote-actions"><button type="button" data-quick="back"></button><button type="button" data-quick="retry" hidden></button><button type="button" class="danger" data-quick="stop" hidden></button></div>`;
  const $ = name => root.querySelector(`[data-quick="${name}"]`);
  const input = root.querySelector('[name=quickEmail]');
  const copy = {title:'Temporary access without a domain',description:'Enter your email to generate an HTTPS address. Cloudflare sends a verification code when you sign in. No domain, account or API token is required.',emailLabel:'Allowed email',start:'Start temporary access',statusLabel:'Status',allowedLabel:'Allowed email',scan:'Scan with your phone to open this workspace.',copy:'Copy address',open:'Open your workspace',limits:'The address changes when restarted and works only while this WebUI is running. Temporary access is intended for testing and may be unstable. Use your own domain for a permanent address.',back:'Back',retry:'Reconnect management',stop:'Stop temporary access',install:'cloudflared installation guide'};
  for (const [key,value] of Object.entries(copy)) $(key).textContent=t(value);
  $('qr').setAttribute('aria-label',t('Scan to open the temporary workspace'));
  let timer, generation=0, visible=false, busy=false, status=null, qrUrl=null;
  const message = (value='',error=false) => { $('message').textContent=t(value);$('message').classList.toggle('error',error); };
  function render(next) {
    status=next;
    $('form').hidden=next.running;
    $('start').disabled=busy || !next.available;
    $('install').hidden=next.phase!=='failed' || ![
      'Install cloudflared to use temporary access.',
      'Update cloudflared to a version supporting protected Quick Tunnels.',
    ].includes(next.error);
    $('connection').hidden=!next.running;
    $('email').textContent=next.email || '';
    if (!input.value && next.email) input.value=next.email;
    $('status').textContent=t({starting:'Starting…',ready:'Connected',stopping:'Stopping…',failed:'Connection ended',stopped:'Stopped'}[next.phase] || 'Checking…');
    $('stop').hidden=!next.running;
    $('stop').disabled=busy || next.phase==='stopping';
    const ready=next.phase==='ready' && !!next.publicOrigin;
    $('address').hidden=!ready;
    if(ready) {
      $('link').href=$('open').href=next.publicOrigin; $('link').textContent=next.publicOrigin;
      if(qrUrl!==next.publicOrigin) {$('qr').innerHTML=temporaryQr(next.publicOrigin);qrUrl=next.publicOrigin;}
    } else {qrUrl=null;$('qr').replaceChildren();$('link').removeAttribute('href');$('open').removeAttribute('href');$('link').textContent='';}
    message(!next.available ? 'Open the full WebUI to start temporary access.' : next.error || '',!!next.error);
  }
  function schedule() {
    clearTimeout(timer);
    if(visible) timer=setTimeout(()=>void refresh(),status?.phase==='starting'||status?.phase==='stopping'?800:2500);
  }
  async function refresh() {
    const current=generation;
    try {const next=await request('quick/status');if(visible && current===generation){render(next);$('retry').hidden=true;}}
    catch(error) {if(!visible || current!==generation)return;message(error.status===401 || error.status===403?'Management session ended. Reconnect to manage temporary access.':'Unable to check temporary access. Your running connection has not been restarted.',true);$('retry').hidden=true;if(error.status===401||error.status===403){$('retry').hidden=false;return;}}
    schedule();
  }
  async function action(fn) {
    if(busy)return;busy=true;for(const button of root.querySelectorAll('button'))button.disabled=true;
    try {await fn();}catch(error){message(error.message || 'Temporary access could not start. Check the network and try again.',true);}
    finally {busy=false;for(const button of root.querySelectorAll('button'))button.disabled=false;if(status){$('start').disabled=!status.available;$('stop').disabled=status.phase==='stopping';}}
  }
  $('form').onsubmit=event=>{event.preventDefault();void action(async()=>{render(await request('quick/start',{email:input.value}));schedule();});};
  $('stop').onclick=()=>void action(async()=>{render(await request('quick/stop',{}));schedule();});
  $('copy').onclick=()=>void action(async()=>{try{await navigator.clipboard.writeText(status.publicOrigin);message('Address copied.');}catch{message('Copy is unavailable. Select and copy the address manually.',true);}});
  $('back').onclick=()=>{close();void back();};
  $('retry').onclick=()=>void open();
  async function open(email='') {
    visible=true;generation++;message();$('retry').hidden=true;
    if(email && !input.value)input.value=email;
    await action(async()=>{await ensureSession();await refresh();});
  }
  function close() {visible=false;generation++;clearTimeout(timer);}
  return {open,close};
}

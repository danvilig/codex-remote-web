import { mountTemporaryAccess } from './temporary-access.js';
import { hostnameFor } from '../src/shared/remote-address.js';
// Shared by settings and standalone setup. Credentials stay on the server; browsers never store them.
export function mountRemoteAccess(root, { t = value => value, standalone = false } = {}) {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const text = value => escape(value);
  const permissions = [['Account','Account Settings','Read'],['Account','Cloudflare Tunnel','Edit'],['Account','Access: Apps and Policies','Edit'],['Account','Access: Organizations, Identity Providers, and Groups','Read'],['Zone','Zone','Read'],['Zone','DNS','Edit']];
  const labels = ['Connect account', 'Choose address', 'Review changes', 'Configure', 'Ready'];
  root.innerHTML = `<div class="remote-access-wizard">
    <p class="settings-description">${text('Reach this workspace securely from another device.')}</p>
    <ol class="remote-steps" aria-label="${text('Setup progress')}">${labels.map((label, index) => `<li data-step="${index}"><span>${index + 1}</span>${text(label)}</li>`).join('')}</ol>
    <p class="remote-message" data-remote="message" role="status" aria-live="polite"></p>
    <section data-stage="checking" class="settings-group-card remote-card" hidden><p>${text('Checking remote access configuration…')}</p><button type="button" data-action="refreshStatus" hidden>${text('Try again')}</button></section>
    <section data-stage="overview" class="settings-group-card remote-card" hidden>
      <h2 data-remote="overviewTitle">${text('Remote access is configured')}</h2><p data-remote="overviewState"></p>
      <dl class="remote-summary" data-remote="overviewSummary"></dl>
      <a class="remote-open primary" data-remote="overviewLink" target="_blank" rel="noreferrer">${text('Open your workspace')}</a>
      <p class="remote-hint" data-remote="managementHint">${text('To change or remove this deployment, open Remote access on the server using its local address. No API token is needed to view this configuration.')}</p>
      <div class="remote-actions"><button type="button" data-action="manageLocal" hidden>${text('Manage on this machine')}</button><button type="button" data-action="quickOverview" hidden>${text('Temporary access without a domain')}</button></div>
    </section>
    <div data-stage="locked" class="settings-group-card remote-card">
      <h2>${text('Choose remote access')}</h2>
      <div class="remote-access-choices"><div class="remote-access-choice"><h3>${text('Without a domain')}</h3><p>${text('Generate a temporary HTTPS address and sign in with an email verification code.')}</p><button type="button" class="primary" data-action="quick">${text('Temporary access without a domain')}</button></div>
      <div class="remote-access-choice"><h3>${text('Use your own domain')}</h3><p>${text('Configure a permanent address with Cloudflare Tunnel and Access.')}</p><button type="button" data-action="unlock">${text('Start setup')}</button></div></div>
      <p class="remote-hint">${text('If this page is open through a public hostname, run bun run setup:cloudflare on the server and open its local link.')}</p>
    </div>
    <section data-stage="quick" class="settings-group-card remote-card" hidden></section>
    <form data-stage="account" class="settings-group-card remote-card" hidden>
      <h2>${text('Connect Cloudflare')}</h2>
      <p>${text('Create the token with the exact three-part rows below. The first part is the resource scope, the second is the permission group, and the third is the access level.')}</p>
      <details class="remote-permissions" open><summary>${text('Required Cloudflare API token permissions')}</summary><div class="remote-permission-table"><div class="remote-permission-head"><span>${text('Scope')}</span><span>${text('Permission group')}</span><span>${text('Access')}</span></div>
      ${permissions.map(row=>`<div class="remote-permission-row" data-i18n-ignore>${row.map(value=>`<code>${text(value)}</code>`).join('')}</div>`).join('')}</div>
      <button type="button" data-action="copyPermissions">${text('Copy permission list')}</button>
      <p class="remote-hint">${text('Use Account for Tunnel and Access permissions in this wizard. Access also appears under Zone, but that scope does not authorize the account-level API used here. Use Zone for Zone and DNS.')}</p>
      <p class="remote-hint">${text('Write permissions may be labelled Edit or Write. If Cloudflare Tunnel is absent, use one of these supported Account permission groups:')}</p>
      <ul class="remote-permission-alternatives" data-i18n-ignore><li><code>Account → Cloudflare One Connector: cloudflared → Write</code></li><li><code>Account → Cloudflare One Connectors → Write</code></li></ul>
      <p class="remote-hint">${text('Choose one Tunnel permission, not all alternatives.')}</p>
      <p class="remote-hint">${text('For the Team Domain lookup, select the full group name Access: Organizations, Identity Providers, and Groups. Access: Organizations is a separate permission entry.')}</p>
      <p class="remote-hint">${text('For Account resources, choose the specific account that owns the Tunnel. For Zone resources, choose the specific domain that will host the WebUI, not All zones.')}</p></details>
      <label>${text('API token')}<input name="token" type="password" required autocomplete="off" spellcheck="false" maxlength="512" aria-label="${text('API token')}"></label>
      <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">${text('Create a scoped API token')}</a>
      <div class="remote-actions"><button type="button" data-action="quickAccount">${text('Without a domain')}</button><button class="primary" type="submit">${text('Connect account')}</button><button type="button" data-action="retryCredential" hidden>${text('Retry saved token')}</button><button type="button" data-action="forgetAccountCredential" hidden>${text('Delete saved token')}</button><button type="button" data-action="cancelToken" hidden>${text('Back to configuration')}</button></div>
    </form>
    <form data-stage="address" class="settings-group-card remote-card" hidden>
      <h2 data-remote="addressTitle">${text('Choose your address')}</h2>
      <div class="remote-grid"><label>${text('Account')}<select name="accountId" required></select></label><label>${text('Domain')}<select name="zoneId" required></select></label></div>
      <label>${text('Tunnel setup')}<select name="tunnelMode"><option value="existing">${text('Use an existing Tunnel')}</option><option value="create">${text('Create a Tunnel on this machine')}</option></select></label>
      <div data-remote="existingTunnel"><label>${text('Existing Tunnel')}<select name="tunnelId" required></select></label>
      <p class="remote-hint" data-remote="tunnelIdentity" role="status"></p>
      <p class="remote-hint" data-remote="tunnelId" data-i18n-ignore></p>
      <label class="remote-confirm" data-remote="confirmLocal" hidden><input name="confirmLocal" type="checkbox"><span>${text('I verified that this Tunnel has only this machine as its connector host.')}</span></label></div>
      <div data-remote="newTunnel" hidden><label>${text('Tunnel name')}<input name="tunnelName" value="Codex Remote Web" maxlength="60"></label><p class="remote-hint">${text('Creates a dedicated Tunnel and a separate user connector service here. Existing cloudflared services are preserved.')}</p><p class="remote-hint" data-remote="connectorDependency"></p><a href="https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/" target="_blank" rel="noreferrer">${text('Install cloudflared')}</a></div>
      <label>${text('Public hostname')}<span class="remote-hostname"><input name="subdomain" required autocomplete="off" placeholder="codex or @" spellcheck="false" maxlength="253" aria-label="${text('Subdomain or @')}"><span data-remote="domainSuffix" data-i18n-ignore></span></span></label>
      <p class="remote-hint" data-remote="hostnamePreview" data-i18n-ignore></p>
      <p class="remote-hint">${text('Enter a subdomain such as codex, or @ for the selected domain itself. The domain suffix is added automatically.')}</p>
      <div class="remote-grid"><label>${text('Allowed email')}<input name="email" type="email" required autocomplete="email" maxlength="254"></label><label>${text('Local service port')}<input name="port" type="number" required min="1024" max="65535" value="8900"></label></div>
      <p class="remote-hint" data-remote="installationHint">${text('A separate native service will be installed. Choose an unused port to keep the current workspace running. Linux user systemd and an existing Cloudflare login method are required.')}</p>
      <p class="remote-hint" data-remote="migrationHint" hidden>${text('Change the hostname, domain, existing Tunnel, port or allowed email in the current Cloudflare account. Saving restarts the protected service and may briefly interrupt remote access.')}</p>
      <div class="remote-actions"><button type="button" data-action="cancelConfiguration" hidden>${text('Cancel')}</button><button type="button" data-action="reconnect">${text('Change token')}</button><button class="primary" type="submit">${text('Preview changes')}</button></div>
    </form>
    <section data-stage="review" class="settings-group-card remote-card" hidden>
      <h2>${text('Review changes')}</h2><dl data-remote="summary" class="remote-summary"></dl><ul data-remote="changes" class="remote-checks"></ul>
      <p>${text('The public route is enabled only after the native service confirms Access protection. This does not send messages or change Codex credentials.')}</p>
      <div class="remote-actions"><button type="button" data-action="back">${text('Back')}</button><button type="button" class="primary" data-action="apply">${text('Configure remote access')}</button></div>
    </section>
    <section data-stage="running" class="settings-group-card remote-card" hidden><h2>${text('Configuring remote access')}</h2><ul data-remote="progress" class="remote-checks" aria-live="polite"></ul><p>${text('Keep this page open. Reconnecting will check progress and will not repeat the deployment request.')}</p></section>
    <section data-stage="ready" class="settings-group-card remote-card" hidden>
      <h2 data-remote="resultTitle">${text('Remote access')}</h2><p data-remote="result"></p>
      <dl class="remote-summary" data-remote="managedSummary"></dl><a class="remote-open primary" data-remote="publicLink" target="_blank" rel="noreferrer" hidden>${text('Open your workspace')}</a>
      <div class="remote-actions"><button type="button" data-action="quickReady">${text('Temporary access without a domain')}</button><button type="button" data-action="editIdentity">${text('Change configuration')}</button><button type="button" data-action="replaceCredential">${text('Replace API token')}</button><button type="button" data-action="forgetCredential">${text('Delete saved token')}</button><button type="button" data-action="recoverIdentity" hidden>${text('Recover configuration')}</button><button type="button" data-action="doctor">${text('Run diagnostics')}</button><button type="button" data-action="remove">${text('Remove managed deployment')}</button><button type="button" data-action="retry">${text('Back to setup')}</button></div>
      <ul data-remote="diagnostics" class="remote-checks" aria-live="polite"></ul>
      <div data-remote="removeConfirm" class="remote-remove" hidden><p>${text('Remove the route, DNS, Access app and native service created by this wizard? Other resources will be preserved.')}</p><div class="remote-actions"><button type="button" data-action="cancelRemove">${text('Cancel')}</button><button class="danger" type="button" data-action="confirmRemove">${text('Remove remote access')}</button></div></div>
    </section>
    <footer class="remote-footer"><span>${text('Cloudflare access identity is separate from your Codex account.')}</span><button type="button" data-action="lock" hidden>${text('Lock management')}</button></footer>
  </div>`;
  const $ = selector => root.querySelector(selector);
  const field = name => root.querySelector(`[name="${name}"]`);
  const message = $('[data-remote="message"]');
  let csrf = '', plan = null, input = null, polling = null, busy = false, initialized = false, resourceGeneration = 0, zones = [], tunnels = [], createAvailable = false, savedCredential = false, deployment = null, editing = false, quickView = false, suggestedEmail = "";
  const temporary = mountTemporaryAccess($('[data-stage=quick]'), { t, request,
    async ensureSession() {
      let current;try{current=await request('session');}catch(error){if(![401,403].includes(error.status))throw error;csrf='';}
      if (current?.csrf) { csrf=current.csrf;return; }
      const {key}=await request('launch',{}), session=await request('session',{key});csrf=session.csrf;initialized=true;
    },
    async back() { if(!standalone && await overview())return;show('locked'); },
  });
  async function openTemporary() { quickView=true;show('quick');await temporary.open(suggestedEmail || deployment?.input?.email); }
  const initialKey = new URLSearchParams(location.hash.slice(1)).get('setup');
  if (initialKey) history.replaceState(history.state, '', location.pathname + location.search);
  function show(stage) {
    for (const node of root.querySelectorAll('[data-stage]')) node.hidden = node.dataset.stage !== stage;
    $('.remote-steps').hidden = editing || ['overview','checking','ready','locked','quick'].includes(stage);
    if (stage !== 'quick') { quickView=false; temporary.close(); }
    const index = { locked: 0, account: 0, address: 1, review: 2, running: 3, ready: 4 }[stage];
    for (const node of root.querySelectorAll('[data-step]')) { node.classList.toggle('complete', Number(node.dataset.step) < index); if (Number(node.dataset.step) === index) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current'); }
    $('[data-action="lock"]').hidden = !csrf || stage === 'running';
  }
  function setMessage(value = '', error = false) { message.textContent = t(value); message.classList.toggle('error', error); }
  function buttons(disabled) { for (const button of root.querySelectorAll('button')) button.disabled = disabled; }
  async function request(path, body) {
    const response = await fetch(`/api/setup/${path}`, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', headers: { 'X-Setup-Request': '1', ...(csrf ? { 'X-Setup-Csrf': csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Setup request failed.'), { status: response.status, details: data.details });
    return data;
  }
  async function perform(fn) {
    if (busy) return; busy = true; buttons(true); setMessage();
    try { await fn(); } catch (error) {
      setMessage(error instanceof TypeError || error instanceof SyntaxError ? 'Remote access could not be loaded. Retry or refresh this page.' : error.message || 'Setup request failed.', true);
      if (error.details) {
        const detail = error.details, context = document.createElement('span'); context.className = 'remote-error-context';
        context.textContent = `${t(detail.operation)} · HTTP ${detail.httpStatus}${detail.codes?.length ? ` · Cloudflare ${detail.codes.join(', ')}` : ''}`;
        const permission = document.createElement('code'); permission.dataset.i18nIgnore = ''; permission.textContent = detail.permission;
        const hint = document.createElement('span'); hint.textContent = t('API tokens are reusable. Check the permission row, selected account/domain resources, token expiry and client IP restrictions.');
        message.append(context, permission, hint);
      }
      if (error.status === 401 || error.status === 403) { csrf = ''; show('locked'); } }
    finally { busy = false; buttons(false); }
  }
  function options(select, items, empty) {
    if (!Array.isArray(items)) throw new Error('Cloudflare returned incomplete resource data. Retry loading.');
    select.replaceChildren(...items.map(item => new Option(item.name, item.id)));
    if (!items.length) { const option = new Option(t(empty), ''); option.disabled = true; select.add(option); }
    select.disabled = !items.length;
  }
  async function resources() {
    const generation = ++resourceGeneration;
    const account = field('accountId').value;
    if (!account) return;
    field('zoneId').disabled = field('tunnelId').disabled = true;
    const data = await request(`resources?accountId=${encodeURIComponent(account)}`);
    if (generation !== resourceGeneration) return;
    if (!Array.isArray(data.zones) || !Array.isArray(data.tunnels)) throw new Error('Cloudflare returned incomplete resource data. Retry loading.');
    zones = data.zones; tunnels = data.tunnels; createAvailable = data.createAvailable;
    options(field('zoneId'), zones, 'No domains available');
    options(field('tunnelId'), tunnels.map(item => ({...item, name: `${item.name} · ${t(item.local ? 'Connected to this machine' : 'Machine unconfirmed')} · ${t(item.status)}`})), 'No remotely managed Tunnels available');
    const recommended = tunnels.find(item => item.local && !item.multipleLocations && item.status === 'healthy');
    if (recommended) field('tunnelId').value = recommended.id;
    if (!tunnels.length && !editing) field('tunnelMode').value = 'create';
    if (input && input.accountId === account) { for (const name of ['zoneId','tunnelId']) { const control = field(name); if ([...control.options].some(option => option.value === input[name])) control.value = input[name]; } }
    if (!editing && (input?.tunnelMode === 'create' || (tunnels.length && input?.tunnelMode))) field('tunnelMode').value = input.tunnelMode;
    if (input?.hostname) restoreSubdomain(input.hostname);
    updateHostname(); updateTunnel();
  }
  function restoreInput(values) { if (!values) return; input = values; for (const name of ['email','port']) if (values[name] != null) field(name).value = values[name]; if (values.hostname) restoreSubdomain(values.hostname); }
  function restoreSubdomain(hostname) {
    const zone = zones.find(item => item.id === field('zoneId').value);
    if (zone) field('subdomain').value = hostname === zone.name ? '@' : hostname.endsWith(`.${zone.name}`) ? hostname.slice(0, -zone.name.length - 1) : '';
  }
  function updateHostname() {
    const zone = zones.find(item => item.id === field('zoneId').value);
    const prefix = field('subdomain').value.trim();
    $('[data-remote="domainSuffix"]').textContent = zone ? `${prefix === '@' ? '' : '.'}${zone.name}` : '';
    try { const hostname = hostnameFor(prefix, zone?.name); field('subdomain').setCustomValidity(''); $('[data-remote="hostnamePreview"]').textContent = `https://${hostname}`; }
    catch (error) { field('subdomain').setCustomValidity(prefix ? t(error.message) : ''); $('[data-remote="hostnamePreview"]').textContent = ''; }
  }
  function updateTunnel() {
    const create = field('tunnelMode').value === 'create';
    $('[data-remote="existingTunnel"]').hidden = create;
    $('[data-remote="newTunnel"]').hidden = !create;
    field('tunnelId').required = !create;
    field('tunnelId').disabled = create || !tunnels.length;
    field('tunnelName').disabled = !create; field('tunnelName').required = create;
    $('[data-remote="connectorDependency"]').textContent = t(createAvailable ? 'cloudflared is available. The connector token will be stored in a private file, never shown in this page.' : 'Install cloudflared on this machine before creating a Tunnel. Then refresh the preview.');
    const selected = tunnels.find(item => item.id === field('tunnelId').value);
    const matched = selected?.local && !selected.multipleLocations;
    $('[data-remote="tunnelIdentity"]').textContent = t(selected?.multipleLocations ? 'This Tunnel has connectors on other machines too. Create a dedicated local Tunnel for this loopback service.' : matched ? 'Connector identity matched this machine. This Tunnel can reach the local WebUI.' : 'The connector location could not be confirmed. Healthy only means a connector is online; verify it runs on this machine or create a dedicated Tunnel.');
    $('[data-remote="tunnelId"]').textContent = selected ? `Tunnel ID: ${selected.id}` : '';
    $('[data-remote="confirmLocal"]').hidden = create || matched || !selected || selected.multipleLocations;
    field('confirmLocal').required = !create && !!selected && !matched && !selected.multipleLocations;
    field('confirmLocal').disabled = !field('confirmLocal').required;
    field('confirmLocal').checked = !!(input?.confirmLocal && selected?.id === input.tunnelId);
  }
  function accountState(state) {
    savedCredential = !!state.savedCredential;
    $('[data-action="retryCredential"]').hidden = !savedCredential;
    $('[data-action="forgetAccountCredential"]').hidden = !savedCredential;
    $('[data-action="cancelToken"]').hidden = !deployment;
  }
  async function startAddress(state = null, edit = false) {
    editing = edit;
    state ||= await request('status'); accountState(state);
    if (!state.connected) { show('account'); if (state.credentialError) setMessage(state.credentialError, true); return; }
    options(field('accountId'), state.accounts || [], 'No accounts available');
    if (input && [...field('accountId').options].some(option => option.value === input.accountId)) field('accountId').value = input.accountId;
    field('accountId').disabled = editing;
    field('tunnelMode').querySelector('[value=create]').disabled = editing;
    if (editing) field('tunnelMode').value = 'existing';
    $('[data-remote=addressTitle]').textContent = t(editing ? 'Change configuration' : 'Choose your address');
    $('[data-remote=installationHint]').hidden = editing;
    $('[data-remote=migrationHint]').hidden = !editing;
    $('[data-action=cancelConfiguration]').hidden = !editing;
    show('address'); await resources();
  }
  async function status() {
    const state = await request('status'); deployment = state.deployment || null; accountState(state);
    if (deployment) restoreInput(deployment.input);
    if (state.phase === 'running') { show('running'); renderProgress(state); schedulePoll(); return; }
    if (!state.connected) { show('account'); setMessage(state.credentialError || '', !!state.credentialError); return; }
    if (['complete','failed','removed'].includes(state.phase)) { renderResult(state); return; }
    if (deployment && deployment.phase !== 'removed') {
      renderResult({ phase: deployment.phase === 'complete' ? 'complete' : 'failed', hostname: deployment.input.hostname, verification: 'pending', steps: [] }); return;
    }
    await startAddress(state);
  }
  function summary(selector, rows) {
    const container = $(selector); container.replaceChildren();
    for (const [label,value] of rows) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = t(label); dd.textContent = value ?? ''; dd.dataset.i18nIgnore = ''; container.append(dt,dd); }
  }
  function summaryRows(rows) { summary('[data-remote=summary]', rows); }
  function renderProgress(state) { $('[data-remote="progress"]').replaceChildren(...(Array.isArray(state.steps) ? state.steps : []).map(label => { const li = document.createElement('li'); li.textContent = t(label); return li; })); }
  function renderResult(state) {
    editing = false; show('ready'); renderProgress(state);
    summary('[data-remote=managedSummary]', input ? [['Public hostname',input.hostname],['Existing Tunnel',input.tunnelId],['Allowed email',input.email],['Local service port',String(input.port)]] : []);
    $('[data-remote=managedSummary]').hidden = state.phase === 'removed';
    $('[data-action=forgetCredential]').hidden = !savedCredential;
    $('[data-action=editIdentity]').hidden = deployment?.phase !== 'complete' || !!(deployment?.identityRecovery || deployment?.configurationRecovery);
    $('[data-action=recoverIdentity]').hidden = !(deployment?.identityRecovery || deployment?.configurationRecovery);
    const success = state.phase === 'complete', removed = state.phase === 'removed';
    $('[data-remote="resultTitle"]').textContent = t(success ? 'Your remote address is configured' : removed ? 'Remote access removed' : 'Setup needs attention');
    $('[data-remote="result"]').textContent = t(success ? state.verification === 'login-required' ? 'The public address requires Cloudflare login. Open it and sign in to verify your workspace.' : 'Configuration is saved. DNS or public login verification is pending; run diagnostics and sign in to complete verification.' : removed ? 'Managed resources were removed. Your existing workspace is unchanged.' : state.error || ((deployment?.identityRecovery || deployment?.configurationRecovery) ? 'A configuration change needs recovery. Recover it before making other changes.' : 'Reconnect your Cloudflare account, then run diagnostics or remove the managed deployment.'));
    const link = $('[data-remote="publicLink"]'); link.hidden = !success; if (success) link.href = `https://${state.hostname || input?.hostname}`;
    $('[data-action="remove"]').hidden = removed || !!(deployment?.identityRecovery || deployment?.configurationRecovery);
    $('[data-action="retry"]').hidden = success || !!(deployment && deployment.phase !== 'removed');
  }
  function schedulePoll() {
    clearTimeout(polling); polling = setTimeout(async () => {
      try { await status(); }
      catch (error) { setMessage('Connection interrupted. Checking progress; no deployment request will be repeated.', true); if (error.status === 401 || error.status === 403) { csrf = ''; show('locked'); } else schedulePoll(); }
    }, 900);
  }
  async function unlock(key) {
    const data = await request('session', { key }); csrf = data.csrf; initialized = true; await status();
  }
  $('[data-action="copyPermissions"]').onclick = async () => {
    try { await navigator.clipboard.writeText(permissions.map(row => row.join(' → ')).join('\n')); setMessage('Permission list copied.'); }
    catch { setMessage('Copy is unavailable. Select and copy the permission rows manually.', true); }
  };
  async function overview() {
    show('checking'); setMessage(); $('[data-action="refreshStatus"]').hidden = true;
    try {
      const response = await fetch('/api/remote-access/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('Remote access status is unavailable. Try again.');
      const data = await response.json();
      if (!data.configured) return false;
      const address = new URL(data.publicOrigin);
      if (address.protocol !== 'https:' || address.origin !== data.publicOrigin) throw new Error('Remote access status is unavailable. Try again.');
      const summary = $('[data-remote="overviewSummary"]'); summary.replaceChildren();
      const quickMode=data.mode==='quick-tunnel';suggestedEmail=data.allowedEmail || '';
      $('[data-remote=overviewTitle]').textContent=t(quickMode?'Temporary access without a domain':'Remote access is configured');
      const values = [['Public hostname', address.hostname], ['Authentication', quickMode?'Email verification':'Cloudflare Access'], ['Allowed email', data.allowedEmail]];
      if(data.teamDomain)values.push(['Team Domain',data.teamDomain]);
      $('[data-remote=managementHint]').textContent=t(quickMode?'This temporary address is managed from the local WebUI. Stopping it closes its remote connections and terminals.':'To change or remove this deployment, open Remote access on the server using its local address. No API token is needed to view this configuration.');
      if (data.identity?.email) values.push(['Signed in as', data.identity.email]);
      if (data.expiresAt) values.push(['Session expires', new Date(data.expiresAt).toLocaleString()]);
      for (const [label,value] of values) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = t(label); dd.textContent = t(value); dd.dataset.i18nIgnore = ''; summary.append(dt,dd); }
      $('[data-remote="overviewState"]').textContent = t(data.mode==='quick-tunnel' ? 'This address works only while temporary access is running.' : data.recoveryRequired ? 'A configuration change needs recovery. Recover it before making other changes.' : data.active ? 'Cloudflare Access protection is active for this workspace.' : 'Your deployment configuration is saved. Open the public address to access the protected workspace.');
      $('[data-remote="overviewLink"]').href = address.origin;
      $('[data-action="manageLocal"]').hidden = !data.canManage;
      $('[data-action=quickOverview]').hidden = !data.canManage;
      show('overview'); return true;
    } catch (error) { setMessage(error.message, true); $('[data-action="refreshStatus"]').hidden = false; return true; }
  }
  $('[data-action=quickAccount]').onclick = () => perform(openTemporary);
  $('[data-action=quickReady]').onclick = () => perform(openTemporary);
  $('[data-action=quick]').onclick = () => perform(openTemporary);
  $('[data-action=quickOverview]').onclick = () => perform(openTemporary);
  $('[data-action="refreshStatus"]').onclick = () => { initialized = false; void open(); };
  $('[data-action="manageLocal"]').onclick = () => perform(async () => { const { key } = await request('launch', {}); await unlock(key); });
  $('[data-action="unlock"]').onclick = () => perform(async () => { const { key } = await request('launch', {}); await unlock(key); });
  $('[data-stage="account"]').onsubmit = event => { event.preventDefault(); void perform(async () => {
    const token = field('token').value; field('token').value = '';
    await request('connect', { token }); await status();
  }); };
  field('accountId').onchange = () => { field('accountId').disabled = true; void perform(resources).finally(() => { field('accountId').disabled = false; }); };
  field('zoneId').onchange = updateHostname;
  field('subdomain').oninput = updateHostname;
  field('tunnelMode').onchange = updateTunnel;
  field('tunnelId').onchange = updateTunnel;
  $('[data-stage="address"]').onsubmit = event => { event.preventDefault(); void perform(async () => {
    input = { ...Object.fromEntries(new FormData(event.currentTarget)), accountId: field('accountId').value };
    input.confirmLocal = field('confirmLocal').checked;
    input.hostname = hostnameFor(input.subdomain, zones.find(zone => zone.id === input.zoneId)?.name);
    plan = await request(editing ? 'change/preview' : 'preview', input);
    if (plan.unchanged) { plan = null; await status(); setMessage('No configuration changes.'); return; }
    if (plan.installed) { renderResult({ phase: 'complete', hostname: plan.hostname, verification: 'pending' }); return; }
    $('[data-action=apply]').textContent = t(editing ? 'Save changes' : 'Configure remote access');
    const summary = $('[data-remote="summary"]'); summary.replaceChildren();
    for (const [label, value] of [['Public hostname',input.hostname],['Allowed email',input.email],['Local service port',plan.service]]) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = t(label); dd.textContent = value; summary.append(dt,dd); }
    if (editing) {
      const display = (label,value) => (label === 'Domain' ? zones : label === 'Existing Tunnel' ? tunnels : []).find(item => item.id === value)?.name || value;
      const rows = plan.differences.map(row => [row.label, `${display(row.label,row.before)} → ${display(row.label,row.after)}`]);
      summaryRows(rows);
    }
    $('[data-remote="changes"]').replaceChildren(...plan.changes.map(value => { const li = document.createElement('li'); li.textContent = t(value); return li; })); show('review');
  }); };
  $('[data-action="back"]').onclick = () => { plan = null; show('address'); };
  $('[data-action="reconnect"]').onclick = () => show('account');
  $('[data-action="retry"]').onclick = () => perform(async () => { $('[data-remote="diagnostics"]').replaceChildren(); await startAddress(); });
  $('[data-action="apply"]').onclick = () => perform(async () => {
    if (!plan?.id) return;
    const id = plan.id; plan = null; show('running');
    try { await request('apply', { id }); } finally { schedulePoll(); }
  });
  $('[data-action=replaceCredential]').onclick = () => { setMessage(); show('account'); };
  $('[data-action=cancelToken]').onclick = () => perform(status);
  $('[data-action=retryCredential]').onclick = () => perform(async () => { await request('credential/retry', {}); await status(); });
  const forgetCredential = () => perform(async () => {
    if (!confirm(t('Delete the saved management token? Your deployment and public login remain configured. You will need a token to manage Cloudflare again.'))) return;
    await request('credential/forget', {}); savedCredential = false; await status();
  });
  $('[data-action=forgetCredential]').onclick = forgetCredential;
  $('[data-action=forgetAccountCredential]').onclick = forgetCredential;
  $('[data-action=editIdentity]').onclick = () => perform(async () => {
    restoreInput({ ...deployment.input, tunnelMode: 'existing' }); await startAddress(null, true);
  });
  $('[data-action=cancelConfiguration]').onclick = () => perform(status);
  $('[data-action=recoverIdentity]').onclick = () => perform(async () => { show('running'); try { await request('change/recover', {}); } finally { schedulePoll(); } });
  $('[data-action="doctor"]').onclick = () => perform(async () => {
    const result = await request('doctor', {});
    $('[data-remote="diagnostics"]').replaceChildren(...result.checks.map(check => { const li = document.createElement('li'); li.className = check.ok ? 'passed' : 'error'; li.textContent = `${check.ok ? '✓' : '○'} ${t(check.label)}`; return li; }));
    if (!result.installed) setMessage('No managed deployment was found.');
  });
  $('[data-action="remove"]').onclick = () => { $('[data-remote="removeConfirm"]').hidden = false; };
  $('[data-action="cancelRemove"]').onclick = () => { $('[data-remote="removeConfirm"]').hidden = true; };
  $('[data-action="confirmRemove"]').onclick = () => perform(async () => { $('[data-remote="removeConfirm"]').hidden = true; show('running'); try { await request('remove', {}); } finally { schedulePoll(); } });
  $('[data-action="lock"]').onclick = () => perform(async () => { await request('lock', {}); csrf = ''; initialized = false; show('locked'); });
  show(standalone ? 'locked' : 'checking');
  async function open() {
    if(quickView){await temporary.open();return;}
    if (initialized && (standalone || csrf)) return;
    initialized = true;
    if (initialKey) { await perform(() => unlock(initialKey)); return; }
    if (!standalone && await overview()) return;
    try { const data = await request('session'); if (!data.csrf) { show('locked'); return; } csrf = data.csrf; const quickState=await request('quick/status'); if(quickState.running){await openTemporary();return;} await status(); }
    catch { csrf = ''; show('locked'); }
  }
  if (standalone) void open();
  return { open, close() { clearTimeout(polling);temporary.close();initialized=false; } };
}

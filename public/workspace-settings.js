import { createSettingsData } from './settings-data.js';
import { translate } from './i18n.js';
// Settings routes, browser preferences and the allowlisted native configuration facade.
export function createWorkspaceSettings({ $, state, t, rpc, onThreadsChanged, useConfigPermissions, reasoningLabel, selectedPermission, syncPermissionSettings, toggleAccountMenu, onOpen, chooseModel, chooseEffort, getReviewPreferences, setReviewPreferences, chooseProject }) {
  const preferenceKey = 'codex-remote-web-preferences';
  let preferences;
  try { preferences = JSON.parse(localStorage.getItem(preferenceKey) || '{}'); } catch {}
  preferences = {
    sendKey: preferences?.sendKey === 'mod-enter' ? 'mod-enter' : 'enter',
    chatFont: [13,14,15,16,18].includes(preferences?.chatFont) ? preferences.chatFont : 13,
    codeFont: [11,12,13,14,16].includes(preferences?.codeFont) ? preferences.codeFont : 12,
  };
  function applyPreferences() {
    document.documentElement.style.setProperty('--codex-chat-font-size', `${preferences.chatFont}px`);
    document.documentElement.style.setProperty('--codex-chat-code-font-size', `${preferences.codeFont}px`);
    $('#prompt').title = preferences.sendKey === 'enter' ? t('Enter to send, Shift+Enter for a new line') : t('Ctrl / ⌘ + Enter to send');
  }
  for (const [id, key] of [['settingsSendKey','sendKey'], ['settingsChatFont','chatFont'], ['settingsCodeFont','codeFont']]) {
    $(`#${id}`).value = String(preferences[key]);
    $(`#${id}`).onchange = event => {
      preferences[key] = key === 'sendKey' ? event.target.value : Number(event.target.value);
      localStorage.setItem(preferenceKey, JSON.stringify(preferences)); applyPreferences();
    };
  }
  applyPreferences();
  function syncEditableSettings() {
    applyPreferences();
    $('#settingsPermissionValue').textContent = t(selectedPermission().label);
    const model = $('#settingsModel'), effort = $('#settingsEffort');
    model.replaceChildren(...state.models.map(item => new Option(item.displayName || item.model, item.model)));
    model.value = state.selectedModel; model.disabled = !state.models.length;
    effort.replaceChildren(...[...$('#effortSelect').options].map(option => new Option(reasoningLabel(option.value), option.value)));
    effort.value = $('#effortSelect').value; effort.disabled = !state.models.length;
    const review = getReviewPreferences();
    $('#settingsDiffMode').value = review.mode; $('#settingsDiffWrap').checked = review.wrap; $('#settingsDiffExpanded').checked = review.expanded;
    $('#settingsProjectValue').textContent = state.projectless ? t('No project') : state.workspaceContext?.cwd || state.config.defaultCwd || '—';
  }
  $('#settingsModel').onchange = event => { chooseModel(event.target.value); syncEditableSettings(); };
  $('#settingsEffort').onchange = event => { chooseEffort(event.target.value); syncEditableSettings(); };
  for (const [id, key] of [['settingsDiffMode','mode'], ['settingsDiffWrap','wrap'], ['settingsDiffExpanded','expanded']]) {
    $(`#${id}`).onchange = event => setReviewPreferences({ [key]: key === 'mode' ? event.target.value : event.target.checked });
  }
  $('#settingsChooseProject').onclick = chooseProject;
  addEventListener('codex-webui:preferences', syncEditableSettings);

  const dataPages = createSettingsData({ $, state, t, rpc, onThreadsChanged });
  $('#settingsStorageArchives').onclick = () => setSettingsPage('data-controls');
  $('#settingsStorageWorktrees').onclick = () => setSettingsPage('worktrees');
  $('#settingsUseConfig').onclick = () => { useConfigPermissions(); $('#settingsPermissionValue').textContent = t(selectedPermission().label); };
  let nativeSnapshot = null, nativeBusy = false;
  const dirty = new Set();
  const nativeControls = {
    approval_policy: $('#settingsApproval'), sandbox_mode: $('#settingsSandbox'),
    'sandbox_workspace_write.network_access': $('#settingsNetwork'),
    'memories.generate_memories': $('#settingsMemoryGenerate'), 'memories.use_memories': $('#settingsMemoryUse'),
    developer_instructions: $('#settingsInstructions'),
    web_search: $('#settingsWebSearch'), model_reasoning_summary: $('#settingsReasoningSummary'), model_verbosity: $('#settingsVerbosity')
  };
  const controlValue = control => control.type === 'checkbox' ? control.checked : control.value;
  function nativeChanges() {
    return Object.fromEntries([...dirty].filter(key => controlValue(nativeControls[key]) !== nativeSnapshot?.values[key]).map(key => [key, controlValue(nativeControls[key])]));
  }
  function nativeStatus(message) {
    for (const id of ['settingsNativeStatus','settingsPersonalStatus']) $(`#${id}`).textContent = message;
    if (nativeSnapshot?.instructionsEditable === false) $('#settingsPersonalStatus').textContent = 'Custom instructions exceed the editor limit. Edit them in Codex configuration directly.';
  }
  function syncNativeButtons() {
    for (const fields of document.querySelectorAll('.settings-native-fields')) fields.disabled = nativeBusy || !nativeSnapshot?.version;
    $('#settingsInstructions').disabled = nativeBusy || !nativeSnapshot?.version || nativeSnapshot.instructionsEditable === false;
    for (const id of ['settingsNativeReload','settingsPersonalReload']) $(`#${id}`).disabled = nativeBusy;
    for (const id of ['settingsNativeSave','settingsPersonalSave']) $(`#${id}`).disabled = nativeBusy || !nativeSnapshot?.version || !Object.keys(nativeChanges()).length;
  }
  for (const [key, control] of Object.entries(nativeControls)) {
    const empty = control.querySelector('option[value=""]'); if (empty) empty.disabled = true;
    control.addEventListener(control.tagName === 'TEXTAREA' ? 'input' : 'change', () => { dirty.add(key); nativeStatus('Unsaved changes'); syncNativeButtons(); });
  }
  async function nativeRequest(method = 'GET') {
    if (nativeBusy) return;
    if (method === 'GET' && dirty.size && !confirm(t('Discard unsaved configuration changes?'))) return;
    if (method === 'PUT') {
      const changes = nativeChanges();
      if ((changes.sandbox_mode === 'danger-full-access' || changes.approval_policy === 'never') && !confirm(t('Save unrestricted execution settings? These defaults can allow commands without approval when using Codex configuration.'))) return;
    }
    nativeBusy = true; syncNativeButtons(); nativeStatus(method === 'GET' ? 'Loading settings…' : 'Saving…');
    try {
      const response = await fetch('/api/settings', { method, cache: 'no-store', ...(method === 'PUT' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: nativeChanges(), version: nativeSnapshot.version }) } : {}) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Settings unavailable');
      nativeSnapshot = result; dirty.clear();
      for (const [key, control] of Object.entries(nativeControls)) {
        if (control.type === 'checkbox') control.checked = result.values[key] ?? key.startsWith('memories.');
        else control.value = result.values[key] ?? '';
      }
      nativeStatus(!result.version ? 'User configuration is unavailable for editing.' : method === 'GET' ? 'Server configuration loaded' : result.overridden ? 'Saved. Higher-priority settings override these values.' : 'Saved. Start a new chat to use these settings.');
    } catch (error) { nativeStatus(error.message); }
    finally { nativeBusy = false; syncNativeButtons(); }
  }
  for (const id of ['settingsNativeReload','settingsPersonalReload']) $(`#${id}`).onclick = () => nativeRequest();
  for (const id of ['settingsNativeSave','settingsPersonalSave']) $(`#${id}`).onclick = () => nativeRequest('PUT');
  const pages = {
    'general-settings': { title: 'General' },
    'data-controls': { title: 'Archived chats' },
    storage: { title: 'Storage' },
    worktrees: { title: 'Worktrees' },
    personalization: { title: 'Personalization' },
    notifications: { title: 'Notifications' },
    appearance: { title: 'Appearance' },
    profile: { title: 'Profile' },
    'keyboard-shortcuts': { title: 'Keyboard shortcuts' },
    agent: { title: 'Configuration' },
    'browser-use': { title: 'Browser' },
    'git-settings': { title: 'Git' },
    'code-review': { title: 'Code review' },
    runtime: { title: 'Server capabilities' },
    'remote-access': { title: 'Remote access' },
  };
  const aliases = { general: 'general-settings', account: 'profile', keyboard: 'keyboard-shortcuts' };
  const legacyTitles = { 'plugins-settings': 'Plugins', 'skills-settings': 'Skills', 'computer-use': 'Computer use', connections: 'Connections', 'cloud-settings': 'Cloud preferences', 'cloud-environments': 'Cloud environments', 'hooks-settings': 'Hooks', worktrees: 'Worktrees', 'data-controls': 'Archived chats' };
  let mobileLayout = matchMedia('(max-width:600px)').matches;
  let returnFocus = null;
  function normalize(page = 'general-settings') {
    const candidate = aliases[page] || page;
    return pages[candidate] || legacyTitles[candidate] ? candidate : 'general-settings';
  }
  function settingsRoutePage(pathname = location.pathname) {
    const match = pathname.match(/^\/settings(?:\/([^/]+))?\/?$/);
    return match ? normalize(match[1] || 'general-settings') : null;
  }
  function row(label, value) {
    const node = document.createElement('div'); node.className = 'settings-row settings-readonly-row';
    const copy = document.createElement('strong'), status = document.createElement('span');
    copy.textContent = t(label); status.textContent = value; node.append(copy, status); return node;
  }
  function renderStatus(page) {
    const title = pages[page]?.title || legacyTitles[page];
    $('#settingsPlaceholderTitle').textContent = t(title);
    const description = $('#settingsPlaceholderDescription'); description.hidden = false;
    const enabled = value => t(value ? 'Enabled' : 'Disabled by server');
    const definitions = {
      'browser-use': [ 'Open websites from the side panel. Sites may block embedding; external links open in a new tab.', [['Browser', t('Embedded browser')]] ],
      'git-settings': [ 'Read repository changes in the Review panel. Direct undo and reapply require server permission.', [['Working folder', state.active?.cwd || state.config.defaultCwd || '—'], ['Undo / Reapply', enabled(state.config.capabilities?.reviewWrite)]] ],
      runtime: [ 'These capabilities are controlled by the server. Codex tools use their own execution permissions.', [['Standalone terminal', enabled(state.config.capabilities?.terminal)], ['Undo / Reapply', enabled(state.config.capabilities?.reviewWrite)], ['Connection', t(state.connected ? 'Codex connected' : 'Connecting')]] ],
    };
    const [copy, values] = definitions[page] || ['This feature is not available in this WebUI yet.', [['Status', t('Not available')]]];
    description.textContent = t(copy);
    $('#settingsPlaceholderRows').replaceChildren(...values.map(([label, value]) => row(label, value)));
  }
  function setSettingsPage(page = 'general-settings', { updateRoute = true } = {}) {
    const selected = normalize(page), content = ['general-settings', 'notifications', 'appearance', 'profile', 'keyboard-shortcuts', 'agent', 'code-review', 'remote-access', 'data-controls', 'storage', 'worktrees', 'personalization'].includes(selected) ? selected : 'placeholder';
    for (const button of document.querySelectorAll('[data-settings-page]')) {
      const active = button.dataset.settingsPage === selected;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    for (const node of document.querySelectorAll('[data-settings-content]')) node.hidden = node.dataset.settingsContent !== content;
    if (content === 'placeholder') renderStatus(selected);
    dispatchEvent(new Event(selected === 'remote-access' ? 'codex-webui:remote-access' : 'codex-webui:remote-access-close'));
    syncEditableSettings();
    if (['agent','personalization'].includes(selected) && !nativeSnapshot) nativeRequest();
    dataPages.show(selected);
    $('#settingsPageTitle').textContent = t(pages[selected]?.title || legacyTitles[selected]);
    $('#settingsContent').scrollTo({ top: 0 });
    $('#settingsDialog').dataset.mobilePage = 'true';
    if (updateRoute && settingsRoutePage()) history.replaceState({ ...history.state, codexWebuiSettings: true }, '', `/settings/${selected}`);
  }
  const keywords = {
    'general-settings': 'Language Interface language System default Send message with Project Permissions 语言 中文 英文 发送 项目 权限',
    appearance: 'Theme Chat font size Code font size 主题 字体 外观',
    agent: 'Model Reasoning effort Approval policy Sandbox settings Allow network access Web search Response verbosity 模型 推理 审批 沙箱 网络 网页搜索 输出',
    personalization: 'Generate memories Use memories Custom instructions 记忆 个性化 自定义 指令',
    'data-controls': 'Archived chats Unarchive 归档 恢复', storage: 'Storage Logs Total 存储 用量 日志', worktrees: 'Worktrees Git Branch 工作树 分支'
  };
  function searchText(button) {
    const page = button.dataset.settingsPage, title = pages[page]?.title || legacyTitles[page] || '';
    return [button.textContent, title, translate(title, 'zh-CN'), keywords[page] || ''].join(' ').toLocaleLowerCase();
  }
  function filterSettingsNavigation(query = '') {
    const normalized = query.trim().toLocaleLowerCase(); let count = 0;
    $('#clearSettingsSearch').hidden = !normalized;
    for (const group of document.querySelectorAll('[data-settings-group]')) {
      let visible = 0;
      for (const button of group.querySelectorAll('[data-settings-page]')) {
        button.hidden = button.dataset.settingsAvailable === 'false' || Boolean(normalized && !searchText(button).includes(normalized));
        if (!button.hidden) visible++;
      }
      group.hidden = !visible; count += visible;
    }
    $('#settingsNavEmpty').hidden = count !== 0;
  }
  function showSettingsMobileNavigation() { $('#settingsDialog').dataset.mobilePage = 'false'; $('#settingsSearch').focus(); }
  function hideSettings() {
    if ($('#settingsDialog').open) $('#settingsDialog').close();
    document.body.classList.remove('settings-open');
    $('#app').inert = false;
    $('#railHome').setAttribute('aria-current', 'page');
    if (returnFocus?.isConnected && returnFocus.checkVisibility()) returnFocus.focus();
    else $('#toggleSidebar').focus();
  }
  function returnToWorkspace() {
    if (settingsRoutePage()) history.replaceState({}, '', history.state?.codexSettingsReturnPath || '/');
    hideSettings();
  }
  function closeSettings() {
    if (settingsRoutePage()) {
      if (typeof history.state?.codexSettingsReturnPath === 'string') { history.back(); return; }
      history.replaceState({}, '', '/');
    }
    hideSettings();
  }
  function showSettings(page = 'general-settings', { updateRoute = true } = {}) {
    const dialog = $('#settingsDialog');
    if (!dialog.open) returnFocus = document.activeElement;
    onOpen?.(); toggleAccountMenu(false); syncPermissionSettings();
    $('#settingsPermissionValue').textContent = t(selectedPermission().label);
    $('#settingsProjectValue').textContent = state.projectless ? t('No project') : state.active?.cwd || state.config.defaultCwd || '—';
    $('#settingsSearch').value = ''; filterSettingsNavigation(); setSettingsPage(page, { updateRoute });
    mobileLayout = matchMedia('(max-width:600px)').matches;
    dialog.dataset.mobilePage = String(mobileLayout);
    if (!dialog.open) dialog.show();
    document.body.classList.add('settings-open'); $('#app').inert = true;
    $('#railHome').setAttribute('aria-current', 'false');
    requestAnimationFrame(() => (mobileLayout ? $('#settingsSearch') : $('#closeSettingsNav')).focus());
  }
  function openSettings(page = 'general-settings') {
    const selected = normalize(page), current = settingsRoutePage();
    if (!current) history.pushState({ codexWebuiSettings: true, codexSettingsReturnPath: location.pathname + location.search + location.hash }, '', `/settings/${selected}`);
    else if (current !== selected) history.replaceState({ ...history.state, codexWebuiSettings: true }, '', `/settings/${selected}`);
    showSettings(selected, { updateRoute: false });
  }
  $('#closeSettingsNav').onclick = closeSettings;
  for (const button of document.querySelectorAll('.settings-mobile-back')) button.onclick = showSettingsMobileNavigation;
  $('#settingsSearch').oninput = event => filterSettingsNavigation(event.currentTarget.value);
  $('#clearSettingsSearch').onclick = () => { $('#settingsSearch').value = ''; filterSettingsNavigation(); $('#settingsSearch').focus(); };
  $('#settingsSearch').onkeydown = event => { if (event.key === 'Escape' && event.currentTarget.value) { event.preventDefault(); event.stopPropagation(); $('#clearSettingsSearch').click(); } };
  addEventListener('resize', () => { const mobile = matchMedia('(max-width:600px)').matches; if (mobile !== mobileLayout) { mobileLayout = mobile; if ($('#settingsDialog').open) $('#settingsDialog').dataset.mobilePage = String(mobile); } });
  addEventListener('popstate', () => { const page = settingsRoutePage(); if (page) showSettings(page, { updateRoute: false }); else hideSettings(); });
  return { openSettings, returnToWorkspace, closeSettings, showSettings, setSettingsPage, settingsRoutePage, filterSettingsNavigation, sendKey: () => preferences.sendKey };
}

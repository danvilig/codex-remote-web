import { desktopLocale } from './localization.js';
import { mountRemoteAccess } from '../public/remote-access.js';
import { createI18n, createDomI18n } from '../public/i18n.js';
import { codexIcon, hydrateCodexIcons } from '../public/codex-icons.js';
import { installThemedSelects } from '../public/themed-select.js';
import { codexInterfaceMark } from '../public/codex-brand.js';

const translations = {
  'Your gateway, in the background.': '你的网关，在后台运行。', Overview: '概览', 'Gateway settings': '网关设置', 'Remote access': '远程访问', Diagnostics: '诊断', 'DESKTOP GATEWAY': '桌面网关', 'Open workspace': '打开工作区', 'Start gateway': '启动网关', 'Stop gateway': '停止网关', Restart: '重启', 'Always available while you are signed in': '登录期间，持续在后台运行', 'Close this window or quit the tray: your gateway keeps running. Signing out stops the background service.': '关闭窗口或退出托盘后，网关仍继续运行；注销系统后，后台服务停止。', 'Initialize gateway': '初始化网关', 'Initialize and configure': '初始化与设置', 'Stop the gateway before changing its settings. Your existing Codex account and configuration are used.': '修改设置前请先停止网关。网关沿用你现有的 Codex 账户与配置。', 'Project directory': '项目目录', Browse: '浏览', 'Local port': '本地端口', Language: '语言', System: '跟随系统', 'Codex executable (optional)': 'Codex 程序路径（可选）', 'cloudflared executable (optional)': 'cloudflared 程序路径（可选）', Appearance: '外观', Light: '浅色', Dark: '深色', 'Start gateway at login': '登录时启动网关', 'Enable web terminal': '启用网页终端', 'The web terminal runs with your user permissions. Enable it only when needed.': '网页终端使用当前用户权限，仅在需要时启用。', 'Save settings': '保存设置', 'Check dependencies': '检测依赖', Dependencies: '依赖', 'Codex and Git are required. cloudflared is required only for remote access. Install missing tools or select their executable paths, then check again.': '需要 Codex 与 Git；远程访问还需要 cloudflared。安装缺少的工具或选择程序路径后重新检测。', 'Background activity': '后台活动', 'Lifecycle events only. Credentials and conversation contents are never shown here.': '仅展示启动、停止等活动，不包含凭据和会话内容。', 'Background component': '后台组件', "Remove login startup and stop this application's background processes. Projects and credentials are preserved.": '移除登录启动项并停止本应用的后台进程，保留项目与凭据。', 'Stop and remove background component': '停止并移除后台组件', Running: '运行中', Stopped: '已停止', Starting: '启动中', Stopping: '停止中', Failed: '启动失败', 'Ready to initialize': '等待初始化', 'Complete initialization to start your gateway.': '完成初始化，即可启动网关。', 'Your workspace is available. You can close this window.': '工作区已就绪，可以关闭此窗口。', 'The gateway is stopped. Your settings are saved.': '网关已停止，设置已保存。', 'Settings saved.': '设置已保存。', 'Working…': '正在处理…', 'Background agent is unavailable': '后台代理不可用',
};
Object.assign(translations, {
  'Desktop gateway': '桌面网关', 'Runs in your login session': '在当前登录会话中运行', 'Gateway connection': '网关连接', 'Background and terminal': '后台与终端', Theme: '主题', 'Local gateway': '本地网关', 'Local address': '本地地址', 'Dependencies checked.': '依赖检测完成。', 'Gateway started.': '网关已启动。', 'Gateway stopped.': '网关已停止。', 'Gateway restarted.': '网关已重启。', 'No background activity yet.': '暂无后台活动。', 'Gateway configuration saved': '网关设置已保存', 'Background agent ready': '后台代理已就绪', 'Local gateway ready': '本地网关已就绪', 'Protected gateway ready': '受保护网关已就绪', 'Local gateway exited': '本地网关已退出', 'Protected gateway exited': '受保护网关已退出', 'Connector ready': '连接器已就绪', 'Connector stopped': '连接器已停止', 'Background agent stopped': '后台代理已停止', 'Automatic startup failed': '自动启动失败', 'Shutdown failed': '停止后台代理失败', 'Background activity updated': '后台活动已更新', 'Background component removed.': '后台组件已移除。',
});
Object.assign(translations, { 'Clean up and uninstall': '清理并卸载', 'Remove the remote deployment in Remote access before cleaning up.': '请先在“远程访问”中移除远程部署，再进行清理。', 'Finish remote access or startup recovery before cleaning up.': '请先完成远程访问或启动项恢复，再进行清理。', 'Auto-detect': '自动检测', 'Executable not found': '未找到程序', 'Executable could not be verified': '无法验证程序' });
// The desktop configuration is authoritative, including in the native
// WebKit ephemeral origin where localStorage is unavailable.
const i18n = createI18n({ storage: null });
createDomI18n(i18n);
const t = message => i18n.locale === 'zh-CN' ? translations[message] || i18n.t(message) : message;
const $ = selector => document.querySelector(selector);
const form = $('#configuration');
let current, busy = false, hydrated = false, page = 'overview', remote, eventKey = '', lastFeedback, lastDependencies, languageBusy = false;
const pageNames = { overview: 'Overview', configuration: 'Gateway settings', remote: 'Remote access', diagnostics: 'Diagnostics' };
const eventNames = { 'configuration-saved': 'Gateway configuration saved', 'agent-ready': 'Background agent ready', 'local:gateway-ready': 'Local gateway ready', 'protected:gateway-ready': 'Protected gateway ready', 'local:gateway-exited': 'Local gateway exited', 'protected:gateway-exited': 'Protected gateway exited', 'connector-ready': 'Connector ready', 'connector-stopped': 'Connector stopped', 'agent-stopped': 'Background agent stopped', 'startup-failed': 'Automatic startup failed', 'shutdown-failed': 'Shutdown failed' };
async function invoke(action, body) {
  const reply = await window.desktop.invoke(action, body);
  if (!reply?.ok) throw Object.assign(new Error(reply?.error || 'Desktop operation failed'), { status: reply?.status });
  return reply.value;
}
function message(value = '', kind = 'info') {
  lastFeedback = { value, kind };
  const node = $('#message'); node.dataset.kind = kind;
  node.classList.toggle('error', kind === 'error');
  if (!value) { node.replaceChildren(); return; }
  node.innerHTML = codexIcon(kind === 'error' ? 'triangleAlert' : kind === 'success' ? 'check' : 'info');
  const copy = document.createElement('span'); copy.textContent = t(value); node.append(copy);
}
function translate() {
  for (const node of document.querySelectorAll('[data-text]')) node.textContent = t(node.dataset.text);
  document.documentElement.lang = i18n.locale;
  $('#pageTitle').textContent = t(pageNames[page]);
  for (const [selector, label] of [['nav', 'Settings'], ['#events', 'Background activity'], ['#desktopLanguage', 'Language'], ['#desktopTheme', 'Theme']]) $(selector).setAttribute('aria-label', t(label));
  for (const node of document.querySelectorAll('input[placeholder]')) node.placeholder = t('Auto-detect');
  if (lastFeedback) message(lastFeedback.value, lastFeedback.kind);
}
function appearance() {
  const preference = form.elements.theme.value;
  document.documentElement.dataset.theme = preference === 'system' ? matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light' : preference;
}
function showPage(next) {
  if (next === page) return;
  themedSelects.close();
  const previous = $(`[data-panel="${page}"]`);
  if (previous.contains(document.activeElement)) $(`[data-page="${next}"]`).focus();
  page = next;
  for (const node of document.querySelectorAll('[data-panel]')) node.hidden = node.dataset.panel !== next;
  for (const node of document.querySelectorAll('[data-page]')) { if (node.dataset.page === next) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); }
  $('#pageTitle').textContent = t(pageNames[next]);
  $('.desktop-main').scrollTop = 0;
  if (next === 'remote') { if (!remote) remote = mountRemoteAccess($('#remoteAccess'), { standalone: true, t, transport: (path, body) => invoke('setup', { path, body }) }); else void remote.open(); }
  else remote?.close();
}
function values() {
  return { ...current.config, cwd: form.elements.cwd.value, port: Number(form.elements.port.value), codex: form.elements.codex.value, cloudflared: form.elements.cloudflared.value, autostart: form.elements.autostart.checked, terminal: form.elements.terminal.checked, language: form.elements.language.value, theme: form.elements.theme.value };
}
function renderEvents(events) {
  const key = i18n.locale + JSON.stringify(events);
  if (key === eventKey) return;
  eventKey = key;
  const nodes = [...events].reverse().map(item => {
    const li = document.createElement('li'), time = document.createElement('time'), text = document.createElement('span');
    time.dateTime = item.time; time.textContent = new Date(item.time).toLocaleTimeString(i18n.locale, { hour: '2-digit', minute: '2-digit', hour12: false });
    time.title = new Date(item.time).toLocaleString(i18n.locale);
    text.textContent = t(eventNames[item.event] || 'Background activity updated'); li.append(time, text); return li;
  });
  if (!nodes.length) { const li = document.createElement('li'); li.className = 'desktop-empty-event'; li.textContent = t('No background activity yet.'); nodes.push(li); }
  $('#events').replaceChildren(...nodes);
}
function render(state) {
  current = state;
  if (!hydrated) {
    for (const key of ['cwd', 'port', 'codex', 'cloudflared', 'language', 'theme']) form.elements[key].value = state.config[key];
    for (const key of ['autostart', 'terminal']) form.elements[key].checked = state.config[key];
    i18n.setPreference(desktopLocale(state.config.language, [state.systemLocale || desktopLocale('system', navigator.languages)])); translate(); appearance(); themedSelects.sync(); hydrated = true;
  }
  const running = state.local.phase === 'running', stopped = ['stopped', 'failed'].includes(state.local.phase);
  const phase = t({ running: 'Running', stopped: 'Stopped', starting: 'Starting', stopping: 'Stopping', failed: 'Failed' }[state.local.phase] || 'Stopped');
  $('#gatewayState').textContent = state.config.initialized ? phase : t('Ready to initialize'); $('#sidebarStatus').textContent = phase;
  $('#gatewayCard').dataset.phase = state.local.phase;
  for (const id of ['gatewayDot', 'sidebarDot']) $('#' + id).classList.toggle('running', running);
  $('#gatewayDescription').textContent = state.local.error || t(!state.config.initialized ? 'Complete initialization to start your gateway.' : running ? 'Your workspace is available. You can close this window.' : 'The gateway is stopped. Your settings are saved.');
  $('#localAddress').textContent = state.url; $('#projectDirectory').textContent = state.config.cwd;
  $('#start').disabled = busy || !stopped || !state.config.initialized; $('#stop').disabled = busy || stopped; $('#restart').disabled = busy || !running;
  $('#save').disabled = busy || !stopped || !['stopped', 'failed'].includes(state.protected.phase);
  for (const node of document.querySelectorAll('#checkDependencies, [data-choose], #removeBackground, #cleanUninstall')) node.disabled = busy;
  $('#openWorkspace').disabled = busy || !running; $('#initialize').hidden = state.config.initialized;
  renderEvents(state.events);
}
function renderDependencies(results) {
  lastDependencies = results;
  $('#dependencies').replaceChildren(...results.map(item => {
    const li = document.createElement('li'); li.classList.toggle('failed', !item.ok); li.innerHTML = codexIcon(item.ok ? 'check' : 'triangleAlert');
    const copy = document.createElement('div'); copy.className = 'dependency-copy';
    const name = document.createElement('strong'); name.textContent = item.name;
    const version = document.createElement('small'); version.textContent = t(item.version || item.error);
    copy.append(name, version);
    if (item.path) { const path = document.createElement('code'); path.textContent = item.path; path.dataset.i18nIgnore = ''; copy.append(path); }
    li.append(copy); return li;
  }));
}
async function refresh() { try { render(await invoke('status')); } catch (error) { message(error.message, 'error'); } }
async function action(fn, button, success) {
  if (busy) return;
  busy = true; button?.setAttribute('aria-busy', 'true');
  if (current) render(current); message('Working…');
  try { await fn(); message(success || '', 'success'); }
  catch (error) { message(error.message, 'error'); }
  finally { button?.removeAttribute('aria-busy'); busy = false; await refresh(); }
}
$('#brand').innerHTML = codexInterfaceMark(); hydrateCodexIcons();
const themedSelects = installThemedSelects({ t, icon: codexIcon });
for (const node of document.querySelectorAll('[data-page]')) node.onclick = () => showPage(node.dataset.page);
$('#initialize').onclick = () => showPage('configuration');
for (const [name, success] of [['start', 'Gateway started.'], ['stop', 'Gateway stopped.'], ['restart', 'Gateway restarted.']]) $('#' + name).onclick = event => void action(() => invoke(name), event.currentTarget, success);
$('#openWorkspace').onclick = event => void action(() => invoke('openWorkspace'), event.currentTarget);
for (const node of document.querySelectorAll('[data-choose]')) node.onclick = () => void action(async () => { const value = await invoke(node.dataset.choose); if (value) form.elements[node.dataset.field].value = value; }, node);
$('#checkDependencies').onclick = event => void action(async () => {
  const results = await invoke('dependencies', { config: values() });
  renderDependencies(results);
}, event.currentTarget, 'Dependencies checked.');
form.onsubmit = event => { event.preventDefault(); void action(async () => { render(await invoke('config', values())); showPage('overview'); }, $('#save'), 'Settings saved.'); };
form.elements.language.onchange = async () => {
  if (languageBusy || !current) return;
  languageBusy = true;
  form.elements.language.disabled = true; themedSelects.sync();
  try {
    const state = await invoke('language', { language: form.elements.language.value });
    current = { ...state, systemLocale: current.systemLocale };
  } catch (error) { message(error.message, 'error'); }
  finally {
    form.elements.language.value = current.config.language;
    i18n.setPreference(desktopLocale(current.config.language, [current.systemLocale || desktopLocale('system', navigator.languages)]));
    translate(); if (lastDependencies) renderDependencies(lastDependencies);
    render(current); remote?.close(); remote = null; $('#remoteAccess').replaceChildren();
    languageBusy = false; form.elements.language.disabled = false; themedSelects.sync();
  }
};
form.elements.theme.onchange = appearance; matchMedia('(prefers-color-scheme:dark)').addEventListener('change', appearance);
$('#cleanUninstall').onclick = event => void action(() => invoke('cleanUninstall'), event.currentTarget);
$('#removeBackground').onclick = event => void action(() => invoke('removeBackground'), event.currentTarget);
translate(); await refresh(); if (current && !current.config.initialized) showPage('configuration');
setInterval(() => { if (!busy && !languageBusy) void refresh(); }, 2000);

import { mountRemoteAccess } from '../public/remote-access.js';
import { createI18n, createDomI18n } from '../public/i18n.js';
import { codexInterfaceMark } from '../public/codex-brand.js';

const translations = {
  'Your gateway, in the background.': '你的网关，在后台运行。', Overview: '概览', 'Gateway settings': '网关设置', 'Remote access': '远程访问', Diagnostics: '诊断', 'DESKTOP GATEWAY': '桌面网关', 'Open workspace': '打开工作区', 'Start gateway': '启动网关', 'Stop gateway': '停止网关', Restart: '重启', 'Always available while you are signed in': '登录期间，持续在后台运行', 'Close this window or quit the tray: your gateway keeps running. Signing out stops the background service.': '关闭窗口或退出托盘后，网关仍继续运行；注销系统后，后台服务停止。', 'Initialize gateway': '初始化网关', 'Initialize and configure': '初始化与设置', 'Stop the gateway before changing its settings. Your existing Codex account and configuration are used.': '修改设置前请先停止网关。网关沿用你现有的 Codex 账户与配置。', 'Project directory': '项目目录', Browse: '浏览', 'Local port': '本地端口', Language: '语言', System: '跟随系统', 'Codex executable (optional)': 'Codex 程序路径（可选）', 'cloudflared executable (optional)': 'cloudflared 程序路径（可选）', Appearance: '外观', Light: '浅色', Dark: '深色', 'Start gateway at login': '登录时启动网关', 'Enable web terminal': '启用网页终端', 'The web terminal runs with your user permissions. Enable it only when needed.': '网页终端使用当前用户权限，仅在需要时启用。', 'Save settings': '保存设置', 'Check dependencies': '检测依赖', Dependencies: '依赖', 'Codex and Git are required. cloudflared is required only for remote access. Install missing tools or select their executable paths, then check again.': '需要 Codex 与 Git；远程访问还需要 cloudflared。安装缺少的工具或选择程序路径后重新检测。', 'Background activity': '后台活动', 'Lifecycle events only. Credentials and conversation contents are never shown here.': '仅展示启动、停止等活动，不包含凭据和会话内容。', 'Background component': '后台组件', "Remove login startup and stop this application's background processes. Projects and credentials are preserved.": '移除登录启动项并停止本应用的后台进程，保留项目与凭据。', 'Stop and remove background component': '停止并移除后台组件', Running: '运行中', Stopped: '已停止', Starting: '启动中', Stopping: '停止中', Failed: '启动失败', 'Ready to initialize': '等待初始化', 'Complete initialization to start your gateway.': '完成初始化，即可启动网关。', 'Your workspace is available. You can close this window.': '工作区已就绪，可以关闭此窗口。', 'The gateway is stopped. Your settings are saved.': '网关已停止，设置已保存。', 'Settings saved.': '设置已保存。', 'Working…': '正在处理…', 'Background agent is unavailable': '后台代理不可用',
};
const i18n = createI18n();
createDomI18n(i18n);
const t = message => i18n.locale === 'zh-CN' ? translations[message] || i18n.t(message) : message;
const $ = selector => document.querySelector(selector);
const form = $('#configuration');
let current, busy = false, hydrated = false, page = 'overview', remote;
const pageNames = { overview: 'Overview', configuration: 'Gateway settings', remote: 'Remote access', diagnostics: 'Diagnostics' };
async function invoke(action, body) {
  const reply = await window.desktop.invoke(action, body);
  if (!reply?.ok) throw Object.assign(new Error(reply?.error || 'Desktop operation failed'), { status: reply?.status });
  return reply.value;
}
function message(value = '', error = false) { $('#message').textContent = t(value); $('#message').classList.toggle('error', error); }
function translate() {
  for (const node of document.querySelectorAll('[data-text]')) node.textContent = t(node.dataset.text);
  document.documentElement.lang = i18n.locale;
  $('#pageTitle').textContent = t(pageNames[page]);
}
function appearance() {
  const preference = form.elements.theme.value;
  document.documentElement.dataset.theme = preference === 'system' ? matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light' : preference;
}
function showPage(next) {
  page = next; for (const node of document.querySelectorAll('[data-panel]')) node.hidden = node.dataset.panel !== next;
  for (const node of document.querySelectorAll('[data-page]')) { if (node.dataset.page === next) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); }
  $('#pageTitle').textContent = t(pageNames[next]);
  if (next === 'remote') { if (!remote) remote = mountRemoteAccess($('#remoteAccess'), { standalone: true, t, transport: (path, body) => invoke('setup', { path, body }) }); else void remote.open(); }
  else remote?.close();
}
function values() {
  return { ...current.config, cwd: form.elements.cwd.value, port: Number(form.elements.port.value), codex: form.elements.codex.value, cloudflared: form.elements.cloudflared.value, autostart: form.elements.autostart.checked, terminal: form.elements.terminal.checked, language: form.elements.language.value, theme: form.elements.theme.value };
}
function render(state) {
  current = state;
  if (!hydrated) {
    for (const key of ['cwd', 'port', 'codex', 'cloudflared', 'language', 'theme']) form.elements[key].value = state.config[key];
    for (const key of ['autostart', 'terminal']) form.elements[key].checked = state.config[key];
    i18n.setPreference(state.config.language === 'zh' ? 'zh-CN' : state.config.language); translate(); appearance(); hydrated = true;
  }
  const running = state.local.phase === 'running', stopped = ['stopped', 'failed'].includes(state.local.phase);
  const phase = t({ running: 'Running', stopped: 'Stopped', starting: 'Starting', stopping: 'Stopping', failed: 'Failed' }[state.local.phase] || 'Stopped');
  $('#gatewayState').textContent = state.config.initialized ? phase : t('Ready to initialize'); $('#sidebarStatus').textContent = phase;
  for (const id of ['gatewayDot', 'sidebarDot']) $('#' + id).classList.toggle('running', running);
  $('#gatewayDescription').textContent = state.local.error || t(!state.config.initialized ? 'Complete initialization to start your gateway.' : running ? 'Your workspace is available. You can close this window.' : 'The gateway is stopped. Your settings are saved.');
  $('#localAddress').textContent = state.url;
  $('#start').disabled = busy || !stopped || !state.config.initialized; $('#stop').disabled = busy || stopped; $('#restart').disabled = busy || !running;
  $('#save').disabled = busy || !stopped || !['stopped', 'failed'].includes(state.protected.phase);
  $('#openWorkspace').disabled = !running; $('#initialize').hidden = state.config.initialized;
  $('#events').textContent = state.events.map(item => `${new Date(item.time).toLocaleTimeString()}  ${item.event}`).join('\n');
}
async function refresh() { try { render(await invoke('status')); } catch (error) { message(error.message, true); } }
async function action(fn) {
  if (busy) return; busy = true; if (current) render(current); message('Working…');
  try { await fn(); message(); } catch (error) { message(error.message, true); }
  finally { busy = false; await refresh(); }
}
$('#brand').innerHTML = codexInterfaceMark();
for (const node of document.querySelectorAll('[data-page]')) node.onclick = () => showPage(node.dataset.page);
$('#initialize').onclick = () => showPage('configuration');
for (const name of ['start', 'stop', 'restart']) $('#' + name).onclick = () => void action(() => invoke(name));
$('#openWorkspace').onclick = () => void action(() => invoke('openWorkspace'));
for (const node of document.querySelectorAll('[data-choose]')) node.onclick = () => void action(async () => { const value = await invoke(node.dataset.choose); if (value) form.elements[node.dataset.field].value = value; });
$('#checkDependencies').onclick = () => void action(async () => {
  const results = await invoke('dependencies', { config: values() });
  $('#dependencies').replaceChildren(...results.map(item => { const li = document.createElement('li'); li.classList.toggle('failed', !item.ok); li.textContent = `${item.ok ? '✓' : '○'} ${item.name}  ${item.version || item.error}\n${item.path || ''}`; return li; }));
});
form.onsubmit = event => { event.preventDefault(); void action(async () => { render(await invoke('config', values())); message('Settings saved.'); showPage('overview'); }); };
form.elements.language.onchange = () => { i18n.setPreference(form.elements.language.value === 'zh' ? 'zh-CN' : form.elements.language.value); translate(); if (current) render(current); remote?.close(); remote = null; $('#remoteAccess').replaceChildren(); };
form.elements.theme.onchange = appearance; matchMedia('(prefers-color-scheme:dark)').addEventListener('change', appearance);
$('#removeBackground').onclick = () => void action(() => invoke('removeBackground'));
translate(); await refresh(); if (current && !current.config.initialized) showPage('configuration');
setInterval(() => { if (!busy) void refresh(); }, 2000);

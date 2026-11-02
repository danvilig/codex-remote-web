import { installThemedSelects } from './themed-select.js';
import { mountRemoteAccess } from './remote-access.js';
import { codexInterfaceMark } from './codex-brand.js';
import { codexIcon } from './codex-icons.js';
import { createI18n, createDomI18n } from './i18n.js';
const i18n = createI18n();
const applyTheme = () => {
  let preference = 'system'; try { preference = localStorage.getItem('codex-remote-web-theme') || 'system'; } catch {}
  document.documentElement.dataset.theme = preference === 'system' ? matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light' : preference;
};
applyTheme(); matchMedia('(prefers-color-scheme:dark)').addEventListener('change', applyTheme);
document.querySelector('#setupTheme').onclick = () => { try { localStorage.setItem('codex-remote-web-theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); } catch {} applyTheme(); };
document.querySelector('#setupBrand').innerHTML = codexInterfaceMark('setup-brand');
document.querySelector('#setupIcon').innerHTML = codexIcon('globe');
mountRemoteAccess(document.querySelector('#remoteAccessSetup'), { t: message => i18n.t(message), standalone: true });
createDomI18n(i18n);

installThemedSelects({t:message=>i18n.t(message),icon:codexIcon});

import { createDeveloperSettings } from './settings-developer-tools.js';
// Data-backed settings pages. User content is always rendered as text, never HTML.
export function createSettingsData({ $, state, t, rpc, onThreadsChanged }) {
  const developer = createDeveloperSettings({ $, state, t });
  let archived = [], cursor = null, busy = false, loaded = false;
  const list = $('#settingsArchiveList'), status = $('#settingsArchiveStatus');
  const node = (tag, text, className) => { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; };
  function renderArchives() {
    const query = $('#settingsArchiveSearch').value.trim().toLocaleLowerCase(), project = $('#settingsArchiveProject').value, kind = $('#settingsArchiveType').value;
    list.replaceChildren();
    const filtered = archived.filter(item => (!query || `${item.name || item.preview || ''} ${item.cwd || ''}`.toLocaleLowerCase().includes(query)) && (!project || item.cwd === project) && (!kind || (typeof item.source === 'object' && item.source !== null ? 'subagent' : 'interactive') === kind));
    const groups = new Map();
    for (const item of filtered) { const key = item.cwd || ''; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
    for (const [project, items] of groups) {
      const title = node('h2', project || t('No project'), 'settings-section-title settings-section-spaced'); title.dataset.i18nIgnore = ''; list.append(title);
      const group = node('div', '', 'settings-group-card');
      for (const item of items) {
        const row = node('div', '', 'settings-row'), copy = node('span', ''), title = node('strong', item.name || item.preview || item.id);
        title.dataset.i18nIgnore = ''; copy.append(title);
        if (item.updatedAt || item.createdAt) copy.append(node('small', new Date((item.updatedAt || item.createdAt) * 1000).toLocaleString(document.documentElement.lang)));
        const button = node('button', t('Unarchive'), 'settings-action'); button.type = 'button'; button.disabled = busy;
        button.onclick = async () => {
          if (busy) return;
          busy = true; button.disabled = true; $('#settingsArchiveReload').disabled = true; $('#settingsArchiveMore').disabled = true;
          try { await rpc('thread/unarchive', { threadId: item.id }); archived = archived.filter(entry => entry.id !== item.id); status.textContent = 'Chat restored'; await onThreadsChanged?.(); }
          catch { status.textContent = 'Unable to restore chat. Try again.'; }
          finally { busy = false; $('#settingsArchiveReload').disabled = false; $('#settingsArchiveMore').disabled = false; renderArchives(); }
        };
        row.append(copy, button); group.append(row);
      }
      list.append(group);
    }
    if (!filtered.length && loaded) list.append(node('p', t('No archived chats found'), 'settings-note'));
    $('#settingsArchiveMore').hidden = !cursor;
  }
  async function loadArchives(more = false) {
    if (busy) return;
    if (!state.connected) { status.textContent = 'Connecting to Codex'; return; }
    busy = true; $('#settingsArchiveReload').disabled = true; $('#settingsArchiveMore').disabled = true; renderArchives(); status.textContent = 'Loading…';
    try {
      const result = await rpc('thread/list', { archived: true, limit: 100, cursor: more ? cursor : null, sortKey: 'updated_at', sourceKinds: [] });
      const items = Array.isArray(result.data) ? result.data : [];
      archived = [...new Map((more ? [...archived, ...items] : items).map(item => [item.id, item])).values()];
      cursor = result.nextCursor || null; loaded = true;
      const select = $('#settingsArchiveProject'), value = select.value;
      select.replaceChildren(new Option('All projects', ''), ...[...new Set(archived.map(item => item.cwd).filter(Boolean))].map(path => new Option(path, path)));
      select.value = value;
      status.textContent = cursor ? 'More archived chats are available. Filters apply to loaded chats.' : 'Archived chats loaded';
    } catch { status.textContent = 'Unable to load archived chats. Try again.'; }
    finally { busy = false; $('#settingsArchiveReload').disabled = false; $('#settingsArchiveMore').disabled = false; renderArchives(); }
  }
  addEventListener('codex-webui:bridge-connected', () => { if ($('#settingsDialog').open && document.querySelector('[data-settings-page="data-controls"].active')) loadArchives(); });
  $('#settingsArchiveSearch').oninput = renderArchives;
  $('#settingsArchiveProject').onchange = renderArchives;
  $('#settingsArchiveType').onchange = renderArchives;
  $('#settingsArchiveReload').onclick = () => loadArchives();
  $('#settingsArchiveMore').onclick = () => loadArchives(true);
  const formatSize = bytes => {const unit=bytes>=1073741824?['GiB',1073741824]:bytes>=1048576?['MiB',1048576]:bytes>=1024?['KiB',1024]:['B',1];return new Intl.NumberFormat(document.documentElement.lang,{maximumFractionDigits:1}).format(bytes/unit[1])+' '+unit[0];};
  let storageBusy = false, worktreesBusy = false;
  async function loadStorage() {
    if (storageBusy) return;
    storageBusy = true; $('#settingsStorageReload').disabled = true; $('#settingsStorageStatus').textContent = 'Loading…';
    try {
      const response = await fetch('/api/settings/storage', { cache: 'no-store' }); if (!response.ok) throw new Error(); const result = await response.json();
      const titles = { sessions: 'Chats', archived: 'Archived chats', memories: 'Memories', worktrees: 'Worktrees', logs: 'Logs', other: 'Other' };
      const colors = { sessions:'#699cf6', archived:'#a786e9', memories:'#e2ac57', worktrees:'#70bda8', logs:'#d77f90', other:'#999fa8' };
      const groups = Object.entries(result.groups).filter(([key]) => Object.hasOwn(colors,key));
      const total = Math.max(0, Number(result.totalBytes) || 0), overview = $('#settingsStorageChart'); overview.replaceChildren();
      const summary = node('div','','storage-overview-total'); summary.append(node('strong',formatSize(total)),node('span',t('Total'))); overview.append(summary);
      const bar = node('div','','storage-segments'); bar.role='img'; bar.setAttribute('aria-label',groups.map(([key,bytes])=>`${t(titles[key])}: ${formatSize(bytes)}`).join(', '));
      for(const [key,bytes] of groups){const segment=node('span','');segment.style.flexGrow=String(Math.max(0,bytes));segment.style.backgroundColor=colors[key];segment.title=`${t(titles[key])}: ${formatSize(bytes)}`;bar.append(segment);} overview.append(bar);
      $('#settingsStorageRows').replaceChildren(...groups.map(([key, bytes]) => {
        const row = node('div', '', 'settings-row'), category=node('span','','storage-category'), swatch=node('i','','storage-swatch');swatch.style.backgroundColor=colors[key];swatch.setAttribute('aria-hidden','true');category.append(swatch,node('strong',t(titles[key])));
        const amount=node('span',formatSize(bytes));amount.append(node('small',`${total?new Intl.NumberFormat(document.documentElement.lang,{maximumFractionDigits:1}).format(bytes/total*100):0}%`,'storage-category-percent'));row.append(category,amount);return row;
      }));
      $('#settingsStorageStatus').textContent = result.partial ? 'Partial measurement. The scan limit was reached or some files were unavailable.' : 'Storage usage updated';
    } catch { $('#settingsStorageStatus').textContent = 'Storage or worktree information is unavailable.'; }
    finally { storageBusy = false; $('#settingsStorageReload').disabled = false; }
  }
  async function loadWorktrees() {
    if (worktreesBusy) return;
    worktreesBusy = true; $('#settingsWorktreeReload').disabled = true; $('#settingsWorktreeStatus').textContent = 'Loading…';
    const cwd = state.active?.cwd || state.workspaceContext?.cwd || state.config.defaultCwd;
    $('#settingsWorktreeProject').textContent = cwd || ''; $('#settingsWorktreeList').replaceChildren();
    try {
      await developer.loadWorktrees();
    } catch { $('#settingsWorktreeStatus').textContent = 'Select a Git project to view its worktrees.'; }
    finally { worktreesBusy = false; $('#settingsWorktreeReload').disabled = false; }
  }
  $('#settingsStorageReload').onclick = loadStorage; $('#settingsWorktreeReload').onclick = loadWorktrees;
  return { show(page) { developer.show(page); if (page === 'data-controls') { if (!loaded) loadArchives(); else renderArchives(); } if (page === 'storage') loadStorage(); if (page === 'worktrees') loadWorktrees(); } };
}

// Browser-owned projects, pins and sidebar organization. Native thread data stays authoritative.
export function createWorkspaceNavigation({ t, codexIcon, titleOf, shortPath, onOpen, onDelete, onAddProject, onSelectProject, menu }) {
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const pinsKey = 'codex-remote-web-pins', sectionsKey = 'codex-remote-web-sections', projectsKey = 'codex-remote-web-projects', preferencesKey = 'codex-remote-web-sidebar';
  const saved = read(pinsKey, []), pins = new Set(Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : []);
  const registered = read(projectsKey, []), projects = new Set(Array.isArray(registered) ? registered.filter(path => typeof path === 'string' && path.startsWith('/')) : []);
  const savedSections = read(sectionsKey, {}), sections = savedSections && typeof savedSections === 'object' && !Array.isArray(savedSections) ? savedSections : {};
  const preferences = read(preferencesKey, {});
  let grouping = ['project', 'connection', 'list'].includes(preferences?.grouping) ? preferences.grouping : 'project';
  let sort = ['activity', 'created', 'name'].includes(preferences?.sort) ? preferences.sort : 'activity';
  let notificationSort = preferences?.notificationSort === true;
  const unread = new Map(); let snapshot;
  function syncNotificationButton(){const button=document.querySelector('#sidebarNotificationsButton');button.setAttribute('aria-pressed',String(notificationSort));button.title=t(notificationSort?'Notification order enabled':'Sort by notifications');}
  syncNotificationButton();
  const savePreferences = () => localStorage.setItem(preferencesKey, JSON.stringify({ grouping, sort, notificationSort }));
  function disclosure(label, key, defaultOpen = true) {
    const details = document.createElement('details'); details.className = 'workspace-thread-section'; details.dataset.section = key;
    details.open = Boolean(snapshot.query.trim()) || (sections[key] ?? defaultOpen);
    const summary = document.createElement('summary'); summary.innerHTML = `<span></span>${codexIcon('chevronRight', 'section-chevron')}`; summary.firstElementChild.textContent = t(label); details.append(summary);
    details.addEventListener('toggle', () => { if (!details.isConnected || snapshot.query.trim()) return; sections[key] = details.open; localStorage.setItem(sectionsKey, JSON.stringify(sections)); });
    return details;
  }
  function threadRow(thread) {
    const row = document.createElement('div'); row.className = `thread-item${snapshot.activeId === thread.id ? ' active' : ''}`; row.dataset.id = thread.id;
    const open = document.createElement('button'); open.type = 'button'; open.className = 'thread-open';
    open.textContent = titleOf(thread); open.title = [titleOf(thread), shortPath(thread.cwd)].filter(Boolean).join(' — ');
    if (snapshot.activeId === thread.id) open.setAttribute('aria-current', 'page');
    open.onclick = () => onOpen(thread.id);
    const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'thread-pin';
    pin.setAttribute('aria-label', t(pins.has(thread.id) ? 'Unpin chat' : 'Pin chat')); pin.title = pin.getAttribute('aria-label'); pin.setAttribute('aria-pressed', String(pins.has(thread.id))); pin.innerHTML = codexIcon('pin');
    pin.onclick = () => { if (pins.has(thread.id)) pins.delete(thread.id); else pins.add(thread.id); localStorage.setItem(pinsKey, JSON.stringify([...pins])); render(snapshot); document.querySelector(`[data-section=recents] [data-id="${CSS.escape(thread.id)}"] .thread-pin`)?.focus(); };
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'thread-delete';
    remove.setAttribute('aria-label', t('Delete thread “{title}”', { title: titleOf(thread) })); remove.title = t('Delete thread'); remove.innerHTML = codexIcon('trash'); remove.onclick = () => onDelete(thread);
    if(unread.has(thread.id)||snapshot.pending?.has(thread.id)){const dot=document.createElement('span');dot.className='thread-notification-dot';dot.setAttribute('aria-label',t(snapshot.pending?.has(thread.id)?'Waiting for your response':'Unread update'));row.append(dot);}
    row.append(open, pin, remove); return row;
  }
  function organize(anchor) {
    const change = (key, value) => { if (key === 'grouping') grouping = value; else sort = value; savePreferences(); render(snapshot); document.querySelector('#projectsOptions')?.focus(); };
    menu.open(anchor, [
      { label: 'Organize sidebar', icon: 'panelLeft', children: [['project','By project','folder'], ['connection','By connection','monitor'], ['list','In one list','list']].map(([value,label,icon]) => ({ label, icon, checked: grouping === value, action: () => change('grouping', value) })) },
      { label: 'Sort chats by', icon: 'sort', children: [['activity','Last activity'], ['created','Date created'], ['name','Name']].map(([value,label]) => ({ label, checked: sort === value, action: () => change('sort', value) })) },
    ]);
  }
  function projectGroup(cwd, items) {
    const project = document.createElement('details'); project.className = 'workspace-project'; project.dataset.cwd = cwd;
    const projectKey = `project:${cwd}`;
    project.open = Boolean(snapshot.query.trim()) || (sections[projectKey] ?? items.some(thread => thread.id === snapshot.activeId));
    project.addEventListener('toggle', () => { if (!project.isConnected || snapshot.query.trim()) return; sections[projectKey] = project.open; localStorage.setItem(sectionsKey, JSON.stringify(sections)); });
    const summary = document.createElement('summary'), name = document.createElement('span');
    summary.innerHTML = `<span class="project-folder-icon">${codexIcon('folder')}${codexIcon('globe', 'project-remote-badge')}</span>`;
    name.className = 'project-label'; name.textContent = cwd === snapshot.home ? t('Home') : cwd.split('/').filter(Boolean).at(-1) || cwd;
    summary.title = cwd; summary.append(name);
    const connection = document.createElement('span'); connection.className = 'project-connection'; connection.textContent = t('Remote server');
    const status = document.createElement('span'); status.className = `project-connection-dot${snapshot.connected ? ' connected' : ''}`; status.setAttribute('aria-label', t(snapshot.connected ? 'Codex connected' : 'Connecting'));
    summary.append(connection, status); project.append(summary);
    if (!items.length) {
      const start = document.createElement('button'); start.type = 'button'; start.className = 'project-new-chat'; start.textContent = t('New chat'); start.onclick = () => onSelectProject(cwd); project.append(start);
    }
    for (const item of items) project.append(threadRow(item));
    return project;
  }
  function render(next) {
    snapshot = next;
    const root = document.querySelector('#threadList'), query = next.query.trim().toLocaleLowerCase();
    const timestamp = value => Number(value) || Date.parse(value) || 0;
    const time = thread => sort === 'created' ? timestamp(thread.createdAt) : timestamp(thread.recencyAt || thread.updatedAt || thread.createdAt);
    if(next.activeId)unread.delete(next.activeId);
    const priority=thread=>(next.pending?.has(thread.id)?2:unread.has(thread.id)?1:0);
    const threads = next.threads.filter(thread => !query || `${titleOf(thread)} ${thread.cwd || ''}`.toLocaleLowerCase().includes(query)).sort((a, b) => (notificationSort ? priority(b)-priority(a)||(unread.get(b.id)||0)-(unread.get(a.id)||0) : 0) || (sort === 'name' ? titleOf(a).localeCompare(titleOf(b)) : time(b)-time(a)));
    const pinned = disclosure('Pinned', 'pinned', pins.size > 0);
    const pinnedThreads = threads.filter(thread => pins.has(thread.id));
    for (const thread of pinnedThreads) pinned.append(threadRow(thread));
    if (!pinnedThreads.length) { const empty = document.createElement('p'); empty.className = 'workspace-list-hint'; empty.textContent = t('Pin a chat to keep it here.'); pinned.append(empty); }
    const projectSection = disclosure('Projects', 'projects'); projectSection.dataset.grouping = grouping;
    const actions = document.createElement('span'); actions.className = 'project-section-actions';
    for (const [id, label, icon, action] of [['projectsOptions','Project options','ellipsis',organize], ['projectButton','Add project','plus',onAddProject]]) {
      const button = document.createElement('button'); button.id = id; button.type = 'button'; button.title = t(label); button.setAttribute('aria-label', t(label)); button.innerHTML = codexIcon(icon);
      if (id === 'projectsOptions') { button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); }
      button.onclick = event => { event.preventDefault(); event.stopPropagation(); action(button); }; actions.append(button);
    }
    projectSection.firstElementChild.append(actions);
    const groups = new Map();
    for (const cwd of projects) if (!query || cwd.toLocaleLowerCase().includes(query)) groups.set(cwd, []);
    for (const thread of threads) { const key = thread.projectless || !thread.cwd ? '' : thread.cwd; if (!key) continue; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(thread); }
    let container = projectSection;
    if (grouping === 'connection' && groups.size) { const connection = document.createElement('div'); connection.className = 'workspace-connection'; const label = document.createElement('p'); label.textContent = t('Remote server'); connection.append(label); projectSection.append(connection); container = connection; }
    if (grouping === 'list') for (const thread of threads) projectSection.append(threadRow(thread));
    else for (const [cwd, items] of groups) container.append(projectGroup(cwd, items));
    if (!groups.size && grouping !== 'list') { const empty = document.createElement('p'); empty.className = 'workspace-list-hint'; empty.textContent = t('Add a project to get started.'); projectSection.append(empty); }
    const recent = disclosure('Recents', 'recents');
    for (const thread of threads.slice(0, 30)) recent.append(threadRow(thread));
    if (!threads.length) { const empty = document.createElement('p'); empty.className = 'workspace-list-hint'; empty.textContent = t(query ? 'No matching tasks' : 'Your chats will appear here.'); recent.append(empty); }
    root.replaceChildren(pinned, projectSection, recent);
  }
  return {
    render,
    toggleNotifications(){notificationSort=!notificationSort;savePreferences();syncNotificationButton();if(snapshot)render(snapshot);},
    notify(threadId){if(threadId&&threadId!==snapshot?.activeId){unread.set(threadId,Date.now());if(unread.size>500)unread.delete(unread.keys().next().value);}if(snapshot)render(snapshot);},
    registerProject(cwd) { if (!cwd?.startsWith('/') || projects.has(cwd)) return; projects.add(cwd); localStorage.setItem(projectsKey, JSON.stringify([...projects])); if (snapshot) render(snapshot); },
  };
}

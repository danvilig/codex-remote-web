import { createAttachmentLibrary } from './attachment-library.js';
import { createScheduledTasks } from './scheduled-tasks.js';
import { createProjectResources } from './project-resources.js';
import { createWorkspaceDock } from './workspace-dock.js';
// Desktop chrome and capability-scoped Dock surfaces.
export function createWorkspaceChrome({ $, state, t, codexIcon, menu, returnToWorkspace, openSettings, openReview, openBrowser, openFolderPicker, startNewTask, setWorkspace, openThread, searchChats, openImageViewer, rpc }) {
  let feature = null, customizeTab = 'plugins', catalog = null, generation = 0, returnFocus = null, searchTimer;
  const dock = createWorkspaceDock({ t, icon: codexIcon, menu, openTool: (kind, anchor) => kind === 'review' ? workspaceAction(openReview, 'railReview') : openFeature(kind, anchor), openManager: anchor => openFeature('dock', anchor) });
  const resources = createProjectResources({ container: $('#workspaceFeatureContent'), search: $('#workspaceFeatureSearch'), state, t, reference, openImage: openImageViewer, openChat: id => workspaceAction(() => openThread(id)), rpc, isCurrent: () => feature==='images' });
  const library=createAttachmentLibrary({container:$('#workspaceFeatureContent'),search:$('#workspaceFeatureSearch'),state,t,reference,openImage:openImageViewer,openChat:id=>workspaceAction(()=>openThread(id)),rpc,isCurrent:()=>feature==='library'});
  const schedules = createScheduledTasks({container:$('#workspaceFeatureContent'),search:$('#workspaceFeatureSearch'),state,t,openChat:id=>workspaceAction(()=>openThread(id)),rpc,isCurrent:()=>feature==='scheduled'});
  const history = [{ id: null, cwd: null }]; let historyIndex = 0, navigationBusy = false;
  function syncHistory() { $('#navigationBack').disabled = navigationBusy || historyIndex <= 0; $('#navigationForward').disabled = navigationBusy || historyIndex >= history.length - 1; }
  function recordNavigation(id = null, cwd = null) { if (navigationBusy) return; if (history[historyIndex].id === id) { history[historyIndex].cwd = cwd; return; } history.splice(historyIndex + 1); history.push({ id, cwd }); historyIndex = history.length - 1; syncHistory(); }
  function setRailActive(id = 'railHome') {
    for (const button of document.querySelectorAll('.workspace-rail > .rail-button')) { if (button.id === id) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
  }
  function closeFeature() {
    generation++; library.close();resources.close(); schedules.close(); clearTimeout(searchTimer); feature = null;
    if ($('#workspaceFeatureDialog').open) $('#workspaceFeatureDialog').close();
    document.body.classList.remove('workspace-feature-open');
    if (!$('#settingsDialog').open) $('#app').inert = false;
    setRailActive();
    if (returnFocus?.isConnected && returnFocus.checkVisibility()) returnFocus.focus();
  }
  function workspaceAction(action, railId = 'railHome') {
    menu.close(); closeFeature(); returnToWorkspace(); action(); setRailActive(railId);
  }
  function empty(message) { const p = document.createElement('p'); p.className = 'workspace-feature-empty'; p.textContent = t(message); $('#workspaceFeatureContent').replaceChildren(p); }
  function card(name, description, status, action, actionLabel = 'Use in chat') {
    const article = document.createElement('article'); article.className = 'workspace-resource-card';
    const heading = document.createElement('h2'); heading.textContent = name;
    const copy = document.createElement('p'); copy.textContent = description;
    article.append(heading, copy);
    if (status) { const badge = document.createElement('small'); badge.textContent = t(status); article.append(badge); }
    if (action) { const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-action'; button.textContent = t(actionLabel); button.onclick = action; article.append(button); }
    return article;
  }
  function reference(text) { workspaceAction(() => { if(typeof text==='object'){if(!state.composerMentions.some(item=>item.id===text.id))state.composerMentions.push(text);dispatchEvent(new Event('codex-webui:attachment-reference'));return;}const input = $('#prompt'); input.value += `${input.value && !/\s$/.test(input.value) ? ' ' : ''}${text} `; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }); }
  function renderCustomize() {
    if (feature !== 'customize' || !catalog) return;
    $('#workspaceFeatureTitle').textContent = t(customizeTab === 'plugins' ? 'Plugins' : 'Skills');
    $('#workspaceFeatureDescription').textContent = t(customizeTab === 'plugins' ? 'Manage available plugins. Installed plugins may require account connections in Codex.' : 'Manage skills for this project. Install trusted local skill folders or reference enabled skills in a chat.');
    for (const button of document.querySelectorAll('[data-customize-tab]')) { const active = button.dataset.customizeTab === customizeTab; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
    const installed = $('#customizeInstalled'); installed.replaceChildren();
    for (const plugin of catalog.plugins.filter(item => item.installed)) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = plugin.name; button.onclick = () => { customizeTab = 'plugins'; $('#workspaceFeatureSearch').value = plugin.name; renderCustomize(); }; installed.append(button);
    }
    if (!installed.childElementCount) { const p = document.createElement('p'); p.textContent = t(catalog.pluginsAvailable ? 'No installed plugins' : 'Plugin status unavailable'); installed.append(p); }
    const available = customizeTab === 'plugins' ? catalog.pluginsAvailable : catalog.skillsAvailable;
    if (!available) { empty(customizeTab === 'plugins' ? 'Plugin status unavailable' : 'Skill status unavailable'); return; }
    const needle = $('#workspaceFeatureSearch').value.trim().toLocaleLowerCase();
    const items = (customizeTab === 'plugins' ? catalog.plugins : catalog.skills).filter(item => `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle));
    if (!items.length) empty(needle ? 'No matching resources' : customizeTab === 'plugins' ? 'No plugins found in the available catalogs.' : 'No skills found for this project.');
    const content=$('#workspaceFeatureContent'); if(items.length)content.replaceChildren();
    for(const item of items) {
      const kind=customizeTab==='plugins'?'plugin':'skill';
      const article=card(item.name,item.description,kind==='plugin'?(item.installed?(item.enabled?'Installed':'Installed · Disabled'):'Not installed'):(item.enabled?'Enabled':'Disabled'),kind==='skill'&&item.enabled?()=>reference(`$${item.name}`):null);
      const add=(label,action)=>{const button=document.createElement('button');button.type='button';button.className='settings-action';button.textContent=t(label);button.dataset.customizeAction=action;button.onclick=()=>confirmChange(article,{kind,id:item.id,action});article.append(button);};
      if(kind==='skill'||item.installed)add(item.enabled?'Disable':'Enable',item.enabled?'disable':'enable');
      if(kind==='plugin'&&!item.installed&&item.installable)add('Install','install');
      if(kind==='plugin'&&item.installed||kind==='skill'&&item.removable)add('Uninstall','uninstall');
      content.append(article);
    }
    if(customizeTab==='skills') {
      const form=document.createElement('form');form.className='skill-install-form';
      const label=document.createElement('label');label.textContent=t('Local skill folder');const input=document.createElement('input');input.className='settings-input';input.required=true;input.placeholder=t('Folder containing SKILL.md');input.setAttribute('aria-label',t('Local skill folder'));label.append(input);
      const button=document.createElement('button');button.type='button';button.className='settings-action';button.textContent=t('Install skill');
      const install=()=>{const source=input.value.trim();if(!source){input.focus();return;}confirmChange(form,{kind:'skill',action:'install',source});};
      button.onclick=install;form.onsubmit=event=>{event.preventDefault();install();};form.append(label,button);content.prepend(form);
    }

  }
  function confirmChange(article,payload) {
    article.querySelector('.resource-confirm')?.remove();const panel=document.createElement('div');panel.className='resource-confirm';
    const message=document.createElement('p');message.textContent=t(payload.action==='uninstall'?'Remove this resource? User skill files will be deleted.':payload.action==='install'?'Only install resources you trust. Their instructions and tools may be used by Codex.':'Apply this change to future Codex use?');
    const cancel=document.createElement('button');cancel.type='button';cancel.className='settings-action';cancel.textContent=t('Cancel');cancel.onclick=()=>panel.remove();
    const confirm=document.createElement('button');confirm.type='button';confirm.className='settings-action primary';confirm.textContent=t('Confirm');panel.append(message,cancel,confirm);article.append(panel);confirm.focus();
    confirm.onclick=async()=>{const id=++generation;confirm.disabled=true;cancel.disabled=true;try{
      const cwd=state.active?.cwd||state.workspaceContext?.cwd||state.config.defaultCwd;
      const response=await fetch('/api/customize?'+new URLSearchParams({cwd}),{method:'POST',headers:{'content-type':'application/json','x-workspace-request':'1'},body:JSON.stringify({...payload,confirmed:true})});const result=await response.json();if(!response.ok)throw new Error(result.error);
      if(feature==='customize'&&generation===id){catalog=result;renderCustomize();}
    }catch(error){if(feature==='customize'&&generation===id){message.textContent=t('Unable to apply this customization change. Reload the catalog and check permissions and resource ownership.');confirm.disabled=false;cancel.disabled=false;}}};
  }
  async function openFeature(kind, anchor) {
    menu.close(); closeFeature(); returnToWorkspace(); returnFocus = anchor;
    feature = kind; const requestId = ++generation;
    const titles = { images: 'Images', scheduled: 'Scheduled', library: 'Library', customize: 'Plugins', sites: 'Sites', dock: 'Manage Dock' };
    $('#workspaceFeatureTitle').textContent = t(titles[kind]);
    $('#workspaceFeatureDialog').dataset.feature = kind;
    $('#workspaceFeatureNav').hidden = kind !== 'customize';
    $('#workspaceFeatureSearchLabel').hidden = !['library','images','customize','scheduled'].includes(kind); $('#workspaceFeatureSearch').value = '';
    $('#workspaceFeatureDescription').textContent = t({ images: 'Images from the current project and conversation.', scheduled: 'Scheduled tasks continue on this server while the WebUI service is running.', library: 'Uploaded files and files shared in conversations.', customize: 'Loading installed skills and plugins…', sites: 'Sites includes creating, saving and deploying websites. Site management and deployment are not connected in this WebUI.', dock: 'Choose which tools appear in the Dock. Hidden tools remain available in More.' }[kind]);
    empty('Loading…');
    if (!$('#workspaceFeatureDialog').open) $('#workspaceFeatureDialog').show();
    document.body.classList.add('workspace-feature-open'); $('#app').inert = true;
    setRailActive({ images: 'railImages', scheduled: 'railScheduled', library: 'railLibrary', customize: 'railCustomize', sites: 'railSites' }[kind]);
    $('#closeWorkspaceFeature').focus();
    if (kind === 'scheduled') await schedules.open();
    else if (kind === 'dock') dock.render($('#workspaceFeatureContent'));
    else if (kind === 'customize') {
      catalog = null;
      try {
        const cwd = state.active?.cwd || state.workspaceContext?.cwd || state.config.defaultCwd;
        const response = await fetch(`/api/customize?${new URLSearchParams({ cwd })}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Unavailable');
        const result = await response.json(); if (generation !== requestId || feature !== kind) return;
        catalog = result; renderCustomize();
      } catch { if (generation === requestId && feature === kind) empty('Customization is unavailable. Check the server connection.'); }
    } else if (kind==='library') await library.open();
    else if (kind === 'images') {
      await resources.open(kind);
    } else {
      empty('Not available yet');
      if (kind === 'sites') $('#workspaceFeatureContent').append(card(t('Project preview'), t('Open the existing browser panel to preview a running project. This does not deploy a site.'), '', () => workspaceAction(openBrowser, 'railSites'), 'Open preview browser'));
    }
  }
  for (const [id, kind] of [['railImages','images'],['railScheduled','scheduled'],['railLibrary','library'],['railCustomize','customize'],['railSites','sites']]) $(`#${id}`).onclick = event => openFeature(kind, event.currentTarget);
  $('#railHome').onclick = () => workspaceAction(startNewTask);
  $('#railReview').onclick = () => workspaceAction(openReview, 'railReview');
  $('#railMore').onclick = event => dock.open(event.currentTarget);
  $('#compactDockButton').onclick = event => dock.open(event.currentTarget);
  $('#threadActionsButton').onclick = event => menu.open(event.currentTarget, [ { label: 'Code Review', icon: 'codeReview', action: openReview }, { label: 'Browser', icon: 'globe', action: openBrowser }, { label: 'Toggle terminal panel', icon: 'terminal', action: () => $('#toggleBottomPanel').click() }, { label: 'Toggle side panel', icon: 'panelRight', action: () => $('#toggleSidePanel').click() } ]);
  $('#closeWorkspaceFeature').onclick = closeFeature;
  $('#customizeSearchButton').onclick = () => $('#workspaceFeatureSearch').focus();
  $('#workspaceFeatureDialog').addEventListener('cancel', event => { event.preventDefault(); closeFeature(); });
  $('#workspaceFeatureSearch').oninput = () => { if (feature === 'scheduled') schedules.search(); else if (feature === 'customize') renderCustomize(); else if (['library','images'].includes(feature)) { clearTimeout(searchTimer); searchTimer = setTimeout(() => feature==='library'?library.search():resources.search(), 150); } };
  for (const button of document.querySelectorAll('[data-customize-tab]')) button.onclick = () => { customizeTab = button.dataset.customizeTab; $('#workspaceFeatureSearch').value = ''; renderCustomize(); };
  for (const [id, offset] of [['navigationBack', -1], ['navigationForward', 1]]) $(`#${id}`).onclick = async () => {
    const target = historyIndex + offset; if (navigationBusy || target < 0 || target >= history.length) return;
    navigationBusy = true; syncHistory();
    try { const entry = history[target]; if (!entry.id && entry.cwd) setWorkspace(entry.cwd); const result = entry.id ? await openThread(entry.id) : startNewTask(); if (result !== false) historyIndex = target; }
    finally { navigationBusy = false; syncHistory(); }
  };
  addEventListener('keydown', event => { if (event.key === 'Escape' && feature && !$('#imageViewer').open) { event.preventDefault(); event.stopImmediatePropagation(); closeFeature(); } });
  addEventListener('popstate', () => { if (feature) closeFeature(); });
  return { recordNavigation, closeFeature };
}

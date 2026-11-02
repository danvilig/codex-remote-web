import { codexIcon } from './codex-icons.js';
import { mountFileDocument } from './file-document.js';

// Lazy, bounded project explorer. All reads retain the existing server boundaries.
export function createFileExplorer({ container, search, cwd, t, reference, openImage, menu, toast = () => {}, isCurrent = () => true }) {
  let project = '', epoch = 0, selected = '', focused = '', previewId = 0, searchTimer;
  let cache = new Map(), expanded = new Set(['']), controllers = new Set();
  const workspaces = new Map();
  const documents = new Map(); let documentView = null;
  addEventListener('beforeunload',event=>{if([...documents.values()].some(doc=>doc.text!==doc.savedText)){event.preventDefault();event.returnValue='';}});
  const node = (tag, className = '', text = '') => { const n = document.createElement(tag); n.className = className; n.textContent = text; return n; };
  // Keep UI source strings in English for the DOM translator's reversible locale
  // tracking; file names and file content are explicitly excluded from translation.
  const iconButton = (label, glyph, action) => { const b = node('button', 'explorer-icon-button'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.innerHTML = codexIcon(glyph); b.onclick = action; return b; };
  const header = node('header', 'explorer-toolbar');
  header.append(node('strong', '', 'Explorer'));
  header.append(iconButton('Collapse folders', 'chevronsUp', () => { expanded = new Set(['']); render(); }), iconButton('Refresh', 'refreshCw', () => open()));
  const location = node('div', 'resource-location explorer-location'); location.dataset.i18nIgnore = '';
  const tree = node('div', 'file-explorer-tree'); tree.role = 'tree'; tree.setAttribute('aria-label', 'Project files');
  const notice = node('p', 'explorer-notice'); notice.role = 'status';
  const preview = node('section', 'explorer-preview'); preview.hidden = true; preview.setAttribute('aria-label', 'File preview');
  const navigation = node('section', 'explorer-navigator');
  const searchLabel = search.closest('.side-file-search');
  if (searchLabel) navigation.append(searchLabel);
  navigation.append(header, location, tree, notice);
  container.classList.add('file-explorer'); container.replaceChildren(preview, navigation);
  function closePreview(restoreFocus = true) { documentView?.destroy();documentView=null;previewId++; preview.hidden = true; preview.replaceChildren(); container.classList.remove('has-preview'); if (restoreFocus) focusRow(selected); }
  async function json(url, options = {}) {
    const controller = new AbortController(); if(options.method!=='POST')controllers.add(controller);
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal,...options });
      if (!response.ok) { const data=await response.json().catch(()=>({}));throw Object.assign(Error(response.status === 404 ? 'The server is older than this page. Update the running WebUI service.' : 'Files are unavailable. Check the project folder and access permissions.'),{code:data.code,status:response.status}); }
      return await response.json();
    } finally { controllers.delete(controller); }
  }
  const listingUrl = (path, cursor = 0) => '/api/library?' + new URLSearchParams({ cwd: project, path, query: search.value.trim(), cursor: String(cursor) });
  function activeRow(path) { return [...tree.querySelectorAll('[role=treeitem]')].find(row => row.dataset.path === path); }
  function focusRow(path) { const row = activeRow(path); if (row) { focused = path; for (const item of tree.querySelectorAll('[role=treeitem]')) item.tabIndex = item === row ? 0 : -1; row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }); } }
  async function load(path, more = false) {
    const version = epoch, previous = cache.get(path);
    if (previous?.loading || (!more && previous?.items)) return;
    const entry = { items: previous?.items || [], cursor: previous?.cursor ?? null, loading: true }; cache.set(path, entry); render();
    try {
      const result = await json(listingUrl(path, more ? previous.cursor : 0));
      if (version !== epoch) return;
      cache.set(path, { items: more ? [...entry.items, ...result.items] : result.items, cursor: result.nextCursor, partial: result.partial });
    } catch (error) { if (version !== epoch || error.name === 'AbortError') return; cache.set(path, { ...entry, loading: false, error: error.message }); }
    if (version !== epoch) return;
    render();
    if (tree.contains(document.activeElement)) focusRow(focused);
    for (const item of cache.get(path)?.items || []) if (item.kind === 'folder' && expanded.has(item.path)) void load(item.path);
  }
  function fileUrl(item) { return '/api/files/download?' + new URLSearchParams({ cwd: project, path: `${project}/${item.path}` }); }
  function addReference(item) { reference(`@${item.path}`); }
  function context(event, item) {
    if (!menu) return;
    event.preventDefault(); focused = item.path;
    const actions = [{ label: 'Copy relative path', icon: 'copy', action: async () => { try { await navigator.clipboard.writeText(item.path); toast(t('Copied')); } catch { toast(t('Copy failed. Select the answer and copy it.')); } } }];
    if (item.kind === 'file') actions.unshift({ label: 'Reference in chat', icon: 'plus', action: () => addReference(item) });
    if (item.kind === 'file' && item.downloadable) actions.push({ label: 'Download', icon: 'arrowDown', action: () => { const a = node('a'); a.href = fileUrl(item); a.download = item.name; a.click(); } });
    menu.open(activeRow(item.path), actions);
  }
  function row(item, level) {
    const folder = item.kind === 'folder', open = expanded.has(item.path);
    const entry = node('div', `explorer-row${folder ? ' explorer-folder' : ''}`); entry.role = 'treeitem'; entry.tabIndex = item.path === focused ? 0 : -1;
    entry.dataset.path = item.path; entry.dataset.kind = item.kind; entry.style.setProperty('--file-depth', level - 1); entry.setAttribute('aria-level', String(level)); entry.setAttribute('aria-label', item.path); entry.setAttribute('aria-selected', String(item.path === selected)); entry.title = item.path;
    if (folder) entry.setAttribute('aria-expanded', String(open));
    const arrow = node('span', 'explorer-chevron'); if (folder) arrow.innerHTML = codexIcon(open ? 'chevronDown' : 'chevronRight');
    const glyph = node('span', 'explorer-file-icon'); glyph.innerHTML = codexIcon(folder ? (open ? 'folderOpen' : 'folder') : item.image ? 'image' : 'file');
    const label = node('span', 'explorer-name', item.name); label.dataset.i18nIgnore = '';
    const line = node('div', 'explorer-row-line'); line.append(arrow, glyph, label); entry.append(line);
    if (search.value.trim() && item.path.includes('/')) { const parent = node('small', 'explorer-parent', item.path.slice(0, item.path.lastIndexOf('/'))); parent.dataset.i18nIgnore = ''; line.append(parent); }
    line.onclick = event => { event.stopPropagation(); focused = item.path; if (folder) toggle(item.path); else { selected = item.path; render(); focusRow(item.path); void showPreview(item); } };
    entry.oncontextmenu = event => { event.stopPropagation(); context(event, item); };
    entry.onkeydown = event => {
      if (['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End','Enter',' '].includes(event.key) || (event.key === 'F10' && event.shiftKey)) event.stopPropagation();
      const rows = [...tree.querySelectorAll('[role=treeitem]')], index = rows.indexOf(entry);
      if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) { event.preventDefault(); focusRow(rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))]?.dataset.path); }
      else if (event.key === 'ArrowRight' && folder) { event.preventDefault(); if (!open) toggle(item.path); else if (Number(rows[index + 1]?.getAttribute('aria-level')) > level) focusRow(rows[index + 1]?.dataset.path); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); if (folder && open) toggle(item.path); else focusRow(item.path.includes('/') ? item.path.slice(0,item.path.lastIndexOf('/')) : ''); }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); line.click(); }
      else if (event.key === 'F10' && event.shiftKey) context(event, item);
    };
    entry.onfocus = () => { focused = item.path; };
    return entry;
  }
  function toggle(path) { if (expanded.has(path)) expanded.delete(path); else expanded.add(path); render(); focusRow(path); if (expanded.has(path)) void load(path); }
  function children(parent, path, level) {
    const data = cache.get(path);
    if (!data) return;
    for (const item of data.items) {
      const entry = row(item, level); parent.append(entry);
      if (item.kind === 'folder' && expanded.has(item.path)) { const group = node('div', 'explorer-group'); group.role = 'group'; entry.append(group); children(group, item.path, level + 1); }
    }
    if (data.loading || data.error || !data.items.length) { const message = node('div', 'explorer-tree-note', data.error || (data.loading ? 'Loading…' : 'This folder is empty.')); message.style.paddingLeft = `${level * 14 + 20}px`; parent.append(message); if (data.error) { const retry = node('button', 'explorer-load-more', 'Retry'); retry.type = 'button'; retry.onclick = () => { cache.delete(path); void load(path); }; parent.append(retry); } }
    if (data.cursor !== null && !data.loading) { const more = node('button', 'explorer-load-more', 'Load more'); more.type = 'button'; more.onclick = () => load(path, true); parent.append(more); }
  }
  function render() {
    const restore = tree.contains(document.activeElement); tree.replaceChildren();
    const name = project.split('/').filter(Boolean).at(-1) || project;
    const root = row({ name, path: '', kind: 'folder' }, 1); root.classList.add('explorer-project-root'); root.setAttribute('aria-label', name); tree.append(root);
    if (expanded.has('')) { const group = node('div', 'explorer-group'); group.role = 'group'; root.append(group); children(group, '', 2); }
    if (!tree.querySelector('[tabindex="0"]')) root.tabIndex = 0;
    notice.textContent = [...cache.values()].some(entry => entry.partial) ? 'Some files were omitted because the scan limit was reached.' : ''; notice.hidden = !notice.textContent;
    if (restore) focusRow(focused);
  }
  async function showPreview(item) {
    documentView?.destroy();documentView=null;
    const id = ++previewId, version = epoch; preview.hidden = false; preview.replaceChildren(); container.classList.add('has-preview');
    const top = node('div', 'explorer-preview-toolbar'), name = node('span', 'explorer-preview-name', item.name); name.title = item.path; name.dataset.i18nIgnore = '';
    const back = iconButton('Back to files', 'arrowLeft', closePreview); back.classList.add('explorer-back');
    top.append(back, name, iconButton('Reference in chat', 'plus', () => addReference(item)));
    if (item.downloadable) { const a = node('a', 'explorer-icon-button'); a.title = 'Download'; a.setAttribute('aria-label', 'Download'); a.innerHTML = codexIcon('arrowDown'); a.href = fileUrl(item); a.download = item.name; top.append(a); }
    top.append(iconButton('Close preview', 'x', closePreview)); preview.append(top);
    const breadcrumb = node('div', 'explorer-breadcrumb', item.path.split('/').join(' › ')); breadcrumb.dataset.i18nIgnore = ''; preview.append(breadcrumb);
    const body = node('div', 'explorer-preview-body'); preview.append(body);
    if (item.image && item.downloadable) { const src = '/api/images/local?' + new URLSearchParams({cwd: project, path:item.path}); const image = node('img'); image.src = src; image.alt = item.name; const b = node('button','explorer-image-preview'); b.type = 'button'; b.append(image); b.onclick = () => openImage(src,item.name,`${project}/${item.path}`); body.append(b); return; }
    body.textContent = 'Loading…';
    try {
      if (!item.downloadable) throw Error('Preview unavailable. Download this file to open it.');
      const directory=project,key=`${directory}\0${item.path}`,url='/api/files/document?'+new URLSearchParams({cwd:directory,path:item.path});
      let model=documents.get(key);
      if(!model||model.text===model.savedText){
        let data;
        try{data=await json(url);}catch(error){
          if(error.status!==404)throw error;
          data={...await json('/api/library/preview?'+new URLSearchParams({path:`${directory}/${item.path}`})),writable:false,editingUnavailable:true};
        }
        model={...data,savedText:data.text};
      }
      if (id !== previewId || version !== epoch) return;
      documents.set(key,model);
      for(const [entry,doc] of documents){if(documents.size<=32)break;if(entry!==key&&doc.text===doc.savedText)documents.delete(entry);}
      documentView=mountFileDocument({body,toolbar:top,model,filename:item.name,cwd:`${directory}/${item.path.includes('/')?item.path.slice(0,item.path.lastIndexOf('/')):''}`,t,toast,
        save:changes=>changes===null?json(url):json('/api/files/document',{method:'POST',headers:{'content-type':'application/json','x-workspace-request':'1'},body:JSON.stringify({cwd:directory,path:item.path,...changes})})});
    } catch (error) { if (id === previewId && version === epoch && error.name !== 'AbortError') body.textContent = error.message==='The server is older than this page. Update the running WebUI service.'?error.message:'Preview unavailable. Download this file to open it.'; }
  }
  function cancel() { epoch++; previewId++; for (const controller of controllers) controller.abort(); controllers.clear(); clearTimeout(searchTimer); }
  async function open() {
    const next = cwd(); if (!next) return;
    if (project && project !== next) { workspaces.set(project, new Set(expanded)); if (workspaces.size > 20) workspaces.delete(workspaces.keys().next().value); }
    cancel();
    if (project !== next) { expanded = workspaces.get(next) || new Set(['']); selected = ''; focused = ''; }
    project = next; cache = new Map(); closePreview(false); location.textContent = project; location.title = project;
    render(); await load('');
  }
  return { open, search() { clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (!isCurrent()) return; cancel(); cache = new Map(); expanded.add(''); closePreview(false); void load(''); },150); }, close: cancel };
}

import { codexIcon } from './codex-icons.js';

const STORAGE_KEY = 'codex-remote-web-panel-widths';

// Pointer Events cover mouse, pen and tablet touch. Widths are preferences, not
// fixed viewport sizes: every layout pass reserves space for the main composer.
export function installPanelSizing({ sidebar, panel, shell, maximize, t, onChange = () => {} }) {
  let preferred = {}, drag = null, frame = 0;
  try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); for (const key of ['left','right']) if (Number.isFinite(saved[key])) preferred[key] = Math.max(200, Math.min(1600, saved[key])); } catch {}
  const body = document.body, handles = {};
  function bounds() {
    const width = shell.clientWidth, rightOpen = !panel.hidden || body.classList.contains('summary-panel-open');
    const leftOpen = !body.classList.contains('sidebar-hidden') && !document.documentElement.classList.contains('mobile-device');
    const left = leftOpen ? preferred.left || sidebar.getBoundingClientRect().width : 0;
    const right = rightOpen ? preferred.right || (panel.hidden ? document.querySelector('#summaryPanel') : panel)?.getBoundingClientRect().width || 340 : 0;
    // Existing tablet behavior hides the left drawer when opening a right tool.
    const actualLeft = leftOpen ? Math.max(200, Math.min(left, width - (rightOpen ? 260 : 0) - 280)) : 0;
    const actualRight = rightOpen ? Math.max(260, Math.min(right, width - actualLeft - 280)) : 0;
    return { width, left: actualLeft, right: actualRight, leftOpen, rightOpen };
  }
  function sync() {
    frame = 0;
    const desktop = innerWidth > 720, size = bounds();
    body.classList.toggle('sidebar-sized', desktop && Boolean(preferred.left));
    body.classList.toggle('side-panel-sized', desktop && Boolean(preferred.right));
    body.style.setProperty('--sized-sidebar-w', `${size.left}px`);
    body.style.setProperty('--sized-panel-w', `${size.right}px`);
    handles.left.hidden = !desktop || !size.leftOpen || body.classList.contains('side-panel-maximized');
    handles.right.hidden = !desktop || panel.hidden || body.classList.contains('side-panel-maximized');
    for (const [key, handle] of Object.entries(handles)) {
      handle.setAttribute('aria-valuemin', key === 'left' ? '200' : '260');
      handle.setAttribute('aria-valuemax', String(Math.max(key === 'left' ? 200 : 260, Math.floor(size.width - 280 - (key === 'left' ? size.right : size.left)))));
      handle.setAttribute('aria-valuenow', String(Math.round(size[key])));
    }
    if (panel.hidden && isMaximized()) setMaximized(false);
    const label = isMaximized() ? 'Restore panel size' : 'Maximize panel';
    maximize.title = t(label); maximize.setAttribute('aria-label', t(label)); maximize.setAttribute('aria-pressed', String(isMaximized()));
    maximize.innerHTML = codexIcon(isMaximized() ? 'minimize' : 'maximize');
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(sync); }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferred)); } catch {} }
  function change(key, width) {
    const size = bounds(), min = key === 'left' ? 200 : 260, other = key === 'left' ? size.right : size.left;
    preferred[key] = Math.max(min, Math.min(width, Math.max(min, size.width - other - 280)));
    sync();
  }
  function end(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    const {handle,id} = drag; drag = null;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    body.classList.remove('panel-resizing'); save(); onChange();
  }
  for (const [key, host] of [['left', sidebar], ['right', panel]]) {
    const handle = document.createElement('div'); handles[key] = handle;
    handle.className = `panel-resize-handle panel-resize-${key}`;
    handle.role = 'separator'; handle.tabIndex = 0; handle.setAttribute('aria-orientation','vertical');
    handle.setAttribute('aria-label', key === 'left' ? 'Resize left sidebar' : 'Resize right sidebar');
    handle.setAttribute('aria-controls', host.id); host.append(handle);
    handle.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault(); handle.focus({preventScroll:true});
      drag = { key, id:event.pointerId, x:event.clientX, width:host.getBoundingClientRect().width, handle };
      handle.setPointerCapture(event.pointerId); body.classList.add('panel-resizing');
    };
    handle.onpointermove = event => { if (drag?.id !== event.pointerId) return; change(key, drag.width + (event.clientX - drag.x) * (key === 'left' ? 1 : -1)); };
    handle.onpointerup = end; handle.onpointercancel = end; handle.onlostpointercapture = end;
    handle.ondblclick = () => { delete preferred[key]; sync(); save(); onChange(); };
    handle.onkeydown = event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const value = event.key === 'Home' ? 200 : event.key === 'End' ? Number(handle.getAttribute('aria-valuemax')) : host.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 1 : -1) * (key === 'left' ? 1 : -1) * (event.shiftKey ? 40 : 10);
      change(key, value); save(); onChange();
    };
  }
  function isMaximized() { return body.classList.contains('side-panel-maximized'); }
  function setMaximized(value) {
    body.classList.toggle('side-panel-maximized', Boolean(value) && !panel.hidden); sync(); onChange();
    // A responsive reflow can hide the focused tree/handle; keep focus in the tool.
    if (value && document.activeElement?.classList.contains('panel-resize-handle')) maximize.focus();
  }
  maximize.onclick = () => setMaximized(!isMaximized());
  const observer = new MutationObserver(records => { if (records.some(record => record.oldValue !== body.className)) schedule(); }); observer.observe(body,{attributes:true,attributeFilter:['class'],attributeOldValue:true});
  addEventListener('resize', () => { if (drag) end(); schedule(); });
  sync();
  return { sync, isMaximized, setMaximized };
}

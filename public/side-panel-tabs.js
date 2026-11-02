const definitions = {
  launcher: ['newTab', 'New tab', 'globe', 'sidePanelLauncher'],
  review: ['reviewTab', 'Changes', 'fileDiff', 'reviewPanelContent'],
  browser: ['browserTab', 'Browser', 'globe', 'browserPanel'],
  terminal: ['terminalTab', 'Terminal', 'terminal', 'sideTerminalPanel'],
  utility: ['filesTab', 'Files', 'folderOpen', 'utilityPanelContent'],
  'side-chat': ['sideChatTab', 'Side chat', 'messageSquare', 'sideChatPanel'],
  'side-task': ['sideTaskTab', 'Side tasks', 'messageSquare', 'sideTaskPanel'],
};

// Each tool owns its tab; hiding the panel preserves sessions, closing a tab
// disposes only that tool. The launcher is recreated after the last tab closes.
export function createSidePanelTabs({ container, t, icon, onSelect, onClose, onEmpty }) {
  const opened = new Set(['launcher']);
  let selected = 'launcher';
  function render() {
    container.replaceChildren();
    for (const kind of opened) {
      const [id, title, glyph, panelId] = definitions[kind];
      const wrapper = document.createElement('div');
      wrapper.className = 'side-panel-tab-shell';
      wrapper.classList.toggle('active', selected === kind);
      wrapper.dataset.tabKind = kind;
      const tab = document.createElement('button');
      tab.id = id; tab.type = 'button'; tab.role = 'tab'; tab.className = 'side-panel-tab';
      tab.dataset.sidePanelTab = kind;
      tab.setAttribute('aria-selected', String(selected === kind));
      tab.setAttribute('aria-controls', panelId); tab.tabIndex = selected === kind ? 0 : -1;
      tab.innerHTML = icon(glyph);
      const label = document.createElement('span'); label.textContent = t(title); tab.append(label);
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'side-panel-tab-close';
      close.setAttribute('aria-label', t('Close {name} tab', { name: t(title) }));
      close.dataset.closeTab = kind; close.innerHTML = icon('x');
      close.onclick = () => { api.close(kind); focusSelected(); };
      tab.onclick = () => api.activate(kind);
      tab.onauxclick = event => { if (event.button === 1) { event.preventDefault(); api.close(kind); focusSelected(); } };
      tab.onkeydown = event => {
        const kinds = [...opened], index = kinds.indexOf(kind);
        let next;
        if (event.key === 'ArrowRight') next = kinds[(index + 1) % kinds.length];
        if (event.key === 'ArrowLeft') next = kinds[(index - 1 + kinds.length) % kinds.length];
        if (event.key === 'Home') next = kinds[0];
        if (event.key === 'End') next = kinds.at(-1);
        if (next) { event.preventDefault(); api.activate(next); focusSelected(); }
        if (event.key === 'Delete') { event.preventDefault(); api.close(kind); focusSelected(); }
      };
      wrapper.append(tab, close); container.append(wrapper);
      document.getElementById(panelId)?.setAttribute('aria-labelledby', id);
    }
  }
  function focusSelected() { if (!document.querySelector('#sidePanel')?.hidden) container.querySelector('[aria-selected=true]')?.focus(); }
  const api = {
    refresh: render,
    activate(kind, notify = true) {
      if (!definitions[kind]) return;
      if (opened.has(kind) && selected === kind) { if (notify) onSelect(kind); return; }
      opened.add(kind); selected = kind; render();
      container.querySelector('[aria-selected=true]')?.closest('.side-panel-tab-shell')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (notify) { onSelect(kind); focusSelected(); }
    },
    close(kind) {
      const kinds = [...opened], index = kinds.indexOf(kind);
      if (index < 0) return;
      opened.delete(kind); onClose(kind);
      if (!opened.size) { opened.add('launcher'); selected = 'launcher'; render(); onSelect(selected); onEmpty(); }
      else if (selected === kind) { selected = kinds[index + 1] || kinds[index - 1]; render(); onSelect(selected); }
      else render();
    },
  };
  render();
  return api;
}

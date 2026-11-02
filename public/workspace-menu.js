// Shared menus with pointer submenus, roving keyboard focus and viewport clamping.
export function createWorkspaceMenu({ t, codexIcon }) {
  const menus = [];
  let opener = null;
  function close(restoreFocus = false) {
    for (const menu of menus.splice(0)) menu.remove();
    opener?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && opener?.isConnected) opener.focus();
  }
  function mount(anchor, items, level = 0) {
    for (const menu of menus.splice(level)) menu.remove();
    const menu = document.createElement('div'); menu.className = 'workspace-popup'; menu.role = 'menu';
    menu.setAttribute('aria-label', anchor.getAttribute('aria-label') || anchor.textContent);
    document.body.append(menu); menus.push(menu);
    const buttons = [];
    for (const item of items) {
      const button = document.createElement('button'); button.type = 'button'; button.role = item.checked === undefined ? 'menuitem' : 'menuitemradio'; button.tabIndex = -1; button.setAttribute('aria-label', t(item.label));
      if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
      if (item.disabled) button.disabled = true;
      if (item.icon) button.insertAdjacentHTML('beforeend', codexIcon(item.icon));
      const label = document.createElement('span'); label.textContent = t(item.label); button.append(label);
      if(item.description){const detail=document.createElement('small');detail.textContent=t(item.description);label.append(detail);}
      if (item.children) { button.setAttribute('aria-haspopup', 'menu'); button.insertAdjacentHTML('beforeend', codexIcon('chevronRight')); }
      else if (item.checked) button.insertAdjacentHTML('beforeend', codexIcon('check'));
      const submenu = () => { if (item.children) return mount(button, item.children, level + 1); };
      button.onpointerenter = () => { if (item.children) submenu(); else for (const child of menus.splice(level + 1)) child.remove(); };
      button.onclick = event => { event.stopPropagation(); if (item.children) { submenu()?.querySelector('button')?.focus(); return; } close(); item.action?.(); };
      menu.append(button); buttons.push(button);
    }
    const bounds = anchor.getBoundingClientRect(), rect = menu.getBoundingClientRect();
    let left = level ? bounds.right + 6 : bounds.left, top = level ? bounds.top : bounds.bottom + 6;
    if (left + rect.width > innerWidth - 8) left = level ? bounds.left - rect.width - 6 : innerWidth - rect.width - 8;
    menu.style.left = `${Math.max(8, left)}px`; menu.style.top = `${Math.max(8, Math.min(top, innerHeight - rect.height - 8))}px`;
    menu.onkeydown = event => {
      const enabled = buttons.filter(button => !button.disabled), index = buttons.indexOf(document.activeElement), current = enabled.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); enabled[event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : current < 0 ? (event.key === 'ArrowUp' ? enabled.length - 1 : 0) : (current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length]?.focus();
      } else if (event.key === 'ArrowRight' && items[index]?.children) { event.preventDefault(); mount(buttons[index], items[index].children, level + 1).querySelector('button')?.focus(); }
      else if (event.key === 'ArrowLeft' && level) { event.preventDefault(); for (const child of menus.splice(level)) child.remove(); anchor.focus(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close();
    };
    return menu;
  }
  document.addEventListener('pointerdown', event => { if (menus.length && !menus.some(menu => menu.contains(event.target)) && !opener?.contains(event.target)) close(); });
  addEventListener('resize', () => close());
  addEventListener('popstate', () => close());
  return {
    close,
    open(anchor, items) {
      if (opener === anchor && menus.length) { close(true); return; }
      const keyboard = anchor.matches(':focus-visible');
      close(); opener = anchor; anchor.setAttribute('aria-expanded', 'true'); const popup=mount(anchor, items);
      // Pointer opening must not paint the first item as if selected.
      if(keyboard)popup.querySelector('button:not(:disabled)')?.focus();
      else {popup.tabIndex=-1;popup.focus({preventScroll:true});}
    },
  };
}

// Keep native form state/events, render the popup ourselves for consistent themes
// and rounded options across Chromium, Safari and operating systems.
export function installThemedSelects({ t, icon }) {
  const controls = new Map();
  let sequence = 0;
  let popup = null,
    active = null;
  function close(focus = false) {
    popup?.remove();
    popup = null;
    if (active) {
      active.button.setAttribute('aria-expanded', 'false');
      if (focus) active.button.focus();
    }
    active = null;
  }
  function sync(select) {
    const control = controls.get(select);
    if (!control) return;
    control.label.textContent = select.selectedOptions[0]?.textContent || '';
    const disabled =
      select.disabled || Boolean(select.closest('fieldset:disabled'));
    if (control.button.disabled !== disabled)
      control.button.disabled = disabled;
    control.button.setAttribute(
      'aria-label',
      `${
        select.getAttribute('aria-label') ||
        select.closest('label')?.querySelector('strong')?.textContent ||
        [...(select.closest('label')?.childNodes || [])]
          .filter((node) => node.nodeType === 3)
          .map((node) => node.textContent.trim())
          .join(' ') ||
        select.name ||
        select.id
      }: ${control.label.textContent}`
    );
    if (control.wrapper.hidden !== select.hidden)
      control.wrapper.hidden = select.hidden;
  }
  function open(control) {
    if (active === control) {
      close(true);
      return;
    }
    close();
    active = control;
    const { select, button } = control;
    popup = document.createElement('div');
    popup.className = 'workspace-select-popup';
    popup.role = 'listbox';
    popup.id = `${select.id}-options`;
    popup.setAttribute('aria-label', button.getAttribute('aria-label'));
    button.setAttribute('aria-controls', popup.id);
    button.setAttribute('aria-expanded', 'true');
    const options = [];
    for (const option of select.options) {
      if (option.hidden) continue;
      const item = document.createElement('button');
      item.type = 'button';
      item.role = 'option';
      item.tabIndex = -1;
      item.textContent = option.textContent;
      item.disabled =
        option.disabled || Boolean(option.closest('optgroup:disabled'));
      item.setAttribute('aria-selected', String(option.selected));
      item.onclick = () => {
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync(select);
        close(true);
      };
      popup.append(item);
      if (!item.disabled) options.push(item);
    }
    document.body.append(popup);
    const rect = button.getBoundingClientRect();
    popup.style.minWidth = `${Math.min(Math.max(rect.width, 150), innerWidth - 24)}px`;
    popup.style.maxHeight = `${Math.min(320, innerHeight - 24)}px`;
    const bounds = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - bounds.width - 12))}px`;
    popup.style.top = `${Math.max(12, rect.bottom + bounds.height < innerHeight - 12 ? rect.bottom + 5 : rect.top - bounds.height - 5)}px`;
    (
      options.find((item) => item.getAttribute('aria-selected') === 'true') ||
      options[0]
    )?.focus();
    popup.onkeydown = (event) => {
      const index = options.indexOf(document.activeElement);
      let next;
      if (event.key === 'ArrowDown')
        next = options[(index + 1) % options.length];
      if (event.key === 'ArrowUp')
        next = options[(index - 1 + options.length) % options.length];
      if (event.key === 'Home') next = options[0];
      if (event.key === 'End') next = options.at(-1);
      if (next) {
        event.preventDefault();
        next.focus();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
      if (event.key === 'Tab') close(true);
      if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.key !== ' '
      )
        options
          .find((item) =>
            item.textContent
              .toLocaleLowerCase()
              .startsWith(event.key.toLocaleLowerCase())
          )
          ?.focus();
    };
  }
  function scan() {
    for (const select of document.querySelectorAll(
      'select.settings-select, .remote-access-wizard select'
    )) {
      if (!controls.has(select)) {
        if (!select.id) select.id = `workspaceSelect-${++sequence}`;
        const wrapper = document.createElement('span');
        wrapper.className = 'workspace-select';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'workspace-select-trigger';
        button.role = 'combobox';
        button.dataset.select = select.id;
        button.setAttribute('aria-haspopup', 'listbox');
        button.setAttribute('aria-expanded', 'false');
        const label = document.createElement('span');
        button.append(label);
        button.insertAdjacentHTML('beforeend', icon('chevronDown'));
        select.before(wrapper);
        wrapper.append(select, button);
        select.classList.add('workspace-select-native');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        const control = { select, wrapper, button, label };
        controls.set(select, control);
        button.onclick = (event) => {
          event.preventDefault();
          sync(select);
          open(control);
        };
        button.onkeydown = (event) => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            open(control);
          }
        };
        select.addEventListener('change', () => sync(select));
        select.addEventListener('focus', () => button.focus());
      }
      sync(select);
    }
    for (const [select, control] of controls)
      if (!select.isConnected) {
        if (active === control) close();
        controls.delete(select);
      }
  }
  let queued = false;
  new MutationObserver((records) => {
    if (
      !records.some(
        (record) =>
          record.target instanceof HTMLSelectElement ||
          record.target instanceof HTMLOptionElement ||
          (record.type === 'attributes' &&
            ['open', 'hidden', 'disabled'].includes(record.attributeName)) ||
          [...record.addedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches('select,option') || node.querySelector('select'))
          )
      )
    )
      return;
    if (!queued) {
      queued = true;
      queueMicrotask(() => {
        queued = false;
        scan();
      });
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open', 'hidden', 'disabled', 'selected']
  });
  document.addEventListener('pointerdown', (event) => {
    if (
      popup &&
      !popup.contains(event.target) &&
      !active?.button.contains(event.target)
    )
      close();
  });
  addEventListener('resize', () => close());
  document.addEventListener(
    'scroll',
    (event) => {
      if (popup && !popup.contains(event.target)) close();
    },
    true
  );
  scan();
  return { sync: scan, close };
}

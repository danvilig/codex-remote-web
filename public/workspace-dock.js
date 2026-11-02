const tools = [
  ['images', 'Images', 'images', 'railImages'],
  ['scheduled', 'Scheduled', 'clock', 'railScheduled'],
  ['library', 'Library', 'library', 'railLibrary'],
  ['customize', 'Customize', 'customize', 'railCustomize'],
  ['review', 'Code Review', 'codeReview', 'railReview'],
  ['sites', 'Sites', 'sites', 'railSites']
];
export function createWorkspaceDock({ t, icon, menu, openTool, openManager }) {
  const key = 'codex-remote-web-dock';
  let hidden = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(saved))
      hidden = new Set(
        saved.filter((id) => tools.some((tool) => tool[0] === id))
      );
  } catch {}
  function apply() {
    for (const [id, , , button] of tools)
      document.getElementById(button).hidden = hidden.has(id);
  }
  function open(anchor) {
    const compact = !document
      .querySelector('.workspace-rail')
      .checkVisibility();
    const items = tools
      .filter(([id]) => compact || hidden.has(id))
      .map(([id, label, glyph]) => ({
        label,
        icon: glyph,
        action: () => openTool(id, anchor)
      }));
    items.push({
      label: 'Manage Dock',
      icon: 'outline',
      action: () => openManager(anchor)
    });
    menu.open(anchor, items);
  }
  function render(container) {
    container.replaceChildren();
    for (const [id, title, glyph] of tools) {
      const row = document.createElement('div');
      row.className = 'dock-manager-row';
      const label = document.createElement('label'),
        input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !hidden.has(id);
      input.setAttribute('aria-label', t(title));
      label.append(input);
      label.insertAdjacentHTML('beforeend', icon(glyph));
      const text = document.createElement('span');
      text.textContent = t(title);
      label.append(text);
      row.append(label);
      input.onchange = () => {
        if (input.checked) hidden.delete(id);
        else hidden.add(id);
        localStorage.setItem(key, JSON.stringify([...hidden]));
        apply();
      };
      container.append(row);
    }
  }
  apply();
  return { open, render };
}

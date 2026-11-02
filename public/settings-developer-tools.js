import DOMPurify from 'dompurify';
import { renderFileMarkdown } from './rendering.js';



export function createDeveloperSettings({ $, state, t }) {
  const node = (tag, text = '', className = '') => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
  const button = (label, id) => { const el = node('button', t(label), 'settings-action'); el.type = 'button'; if (id) el.id = id; return el; };
  const project = () => state.active?.cwd || state.workspaceContext?.cwd || state.config.defaultCwd;
  const userText = (tag, text, className) => { const el = node(tag, text, className); el.dataset.i18nIgnore = ''; return el; };
  const errors = { TOOLS_FILE_CONFLICT: 'Reload before saving: the file changed. Your edits have been kept.', TOOLS_PREVIEW_EXPIRED: 'This confirmation expired or has already been used. Preview again.', TOOLS_WORKTREE_DIRTY: 'The worktree has uncommitted files. Commit or move them before removal.', TOOLS_WORKTREE_BUSY: 'This worktree is in use or its usage cannot be verified.', TOOLS_WORKTREE_CHANGED: 'The worktree changed or is locked. Reload and inspect it.', TOOLS_CLEANUP_CHANGED: 'Cleanup candidates changed. Preview again.', TOOLS_BUSY: 'Another operation is in progress. Try again shortly.', TOOLS_STORAGE_BUSY: 'Another operation is in progress. Try again shortly.' };
  async function request(action, input = {}) {
    const response = await fetch('/api/settings/developer-tools', { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-request': '1' }, body: JSON.stringify({ action, cwd: project(), ...input }) });
    const result = await response.json();
    if (!response.ok) throw new Error(t(errors[result.code] || 'Developer tools are unavailable for this project.'));
    return result;
  }
  async function run(control, status, fn) {
    if (control.disabled) return;
    control.disabled = true; status.textContent = t('Loading…');
    try { await fn(); } catch (error) { status.textContent = error.message; }
    finally { control.disabled = false; }
  }
  function confirmPreview(title, contents, acceptLabel, accept) {
    const dialog = node('dialog', '', 'developer-tools-dialog'), heading = node('h2', t(title));
    const bar = node('div', '', 'settings-save-bar'), cancel = button('Cancel'), save = button(acceptLabel), status = node('p'); status.role = 'status';
    save.classList.add('primary'); save.id = 'developerToolsConfirm'; cancel.onclick = () => dialog.close();
    save.onclick = () => run(save, status, async () => { await accept(); dialog.close(); });
    bar.append(cancel, save); dialog.append(heading, contents, status, bar); document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal(); cancel.focus();
  }

  const personal = document.querySelector('[data-settings-content="personalization"]'), instructions = node('section', '', 'developer-tools-section');
  const instructionsTitle = node('h2', t('Project instructions'), 'settings-section-title settings-section-spaced'), instructionsCopy = node('p', t('Read and edit this project’s AGENTS.md. Changes apply when Codex next reads project instructions.'), 'settings-description');
  const agentsProject = userText('p', ''), inherited = node('details'), inheritedList = node('ul'); inherited.append(node('summary',t('Inherited instruction files (read-only)')),node('p',t('Instruction discovery depends on the native server, its overrides and configuration. This list shows known files within the allowed project ancestors and Codex home.'),'settings-note'),inheritedList);
  const editor = node('textarea', '', 'settings-instructions'); editor.id = 'settingsProjectAgents'; editor.rows = 10; editor.maxLength = 256 * 1024; editor.spellcheck = false; editor.dataset.i18nIgnore = ''; editor.setAttribute('aria-labelledby', 'settingsProjectAgentsTitle'); instructionsTitle.id = 'settingsProjectAgentsTitle';
  const agentsReload = button('Reload', 'settingsProjectAgentsReload'), agentsPreview = button('Preview changes', 'settingsProjectAgentsPreview'), agentsStatus = node('p'); agentsStatus.id = 'settingsProjectAgentsStatus'; agentsStatus.role = 'status';
  const agentsBar = node('div', '', 'settings-save-bar'); agentsBar.append(agentsReload, agentsPreview, agentsStatus); instructions.append(instructionsTitle, instructionsCopy, agentsProject, inherited, editor, agentsBar); personal.append(instructions);
  let agents = null, agentsCwd = null;
  async function loadAgents() {
    if (agents && editor.value !== agents.text && !confirm(t('Discard unsaved project instructions?'))) return;
    const cwd = project(), result = await request('agents.read', { cwd });
    agents = result; agentsCwd = cwd; agentsProject.textContent = cwd || ''; editor.value = result.text;
    inheritedList.replaceChildren(...(result.inherited || []).map(item=>userText('li',`${item.path} · ${item.bytes} B`)));
    agentsStatus.textContent = t(result.exists ? 'Project instructions loaded' : 'AGENTS.md does not exist. Preview changes to create it.');
  }
  agentsReload.onclick = () => run(agentsReload, agentsStatus, loadAgents);
  agentsPreview.onclick = () => run(agentsPreview, agentsStatus, async () => {
    if (!agents) { await loadAgents(); return; }
    const result = await request('agents.preview', { cwd: agentsCwd, text: editor.value, revision: agents.revision });
    const view = node('div', '', 'developer-tools-diff');
    for (const [label, text] of [['Before', result.before], ['After', result.after]]) { const block = node('section'), body = node('div'); block.append(node('h3', t(label))); if (label === 'After') { body.className = 'developer-tools-markdown'; body.innerHTML = DOMPurify.sanitize(renderFileMarkdown(text, { cwd: agentsCwd }), { FORBID_TAGS:['style','script','iframe','object','embed'], FORBID_ATTR:['style'] }); } else body.append(userText('pre', text)); body.dataset.i18nIgnore=''; block.append(body); view.append(block); }
    confirmPreview('Review changes', view, 'Save AGENTS.md', async () => {
      agents = await request('agents.save', { previewToken: result.previewToken }); editor.value = agents.text; agentsStatus.textContent = t('Project instructions saved');
    });
    agentsStatus.textContent = '';
  });

  const worktrees = document.querySelector('[data-settings-content="worktrees"]');
  const worktreeCreate = button('Create managed worktree', 'settingsWorktreeCreate'); $('#settingsWorktreeReload').after(worktreeCreate);
  worktrees.querySelector('.settings-description').textContent = t('Only clean, unoccupied worktrees created here can be removed. Their branches are preserved.');
  async function loadWorktrees() {
    const cwd = project(); $('#settingsWorktreeProject').textContent = cwd || '';
    const result = await request('worktrees.list', { cwd });
    $('#settingsWorktreeList').replaceChildren(...result.worktrees.map(item => {
      const row = node('div', '', 'settings-row developer-worktree-row'), copy = node('span'); copy.append(userText('strong', item.branch || t('Detached HEAD')), userText('small', item.path), node('small', t(item.managed ? 'Managed by WebUI' : 'External worktree'))); row.append(copy);
      if (item.managed) {
        const remove = button('Remove worktree'); remove.disabled = item.locked || !item.removable;
        remove.onclick = () => run(remove, $('#settingsWorktreeStatus'), async () => {
          const preview = await request('worktrees.preview-remove', { cwd, id: item.id }), copy = node('div'); copy.append(node('p', t('Keep the Git branch and remove this clean worktree directory?')), userText('pre', item.path), userText('p', item.branch));
          confirmPreview('Remove worktree', copy, 'Remove worktree', async () => { await request('worktrees.remove', { previewToken: preview.previewToken }); await loadWorktrees(); $('#settingsWorktreeStatus').textContent = t('Worktree removed; branch preserved'); });
        }); row.append(remove);
      }
      return row;
    }));
    $('#settingsWorktreeStatus').textContent = t('Worktrees loaded');
  }
  worktreeCreate.onclick = () => run(worktreeCreate, $('#settingsWorktreeStatus'), async () => { await request('worktrees.create'); await loadWorktrees(); $('#settingsWorktreeStatus').textContent = t('Worktree created'); });

  const cleanup = button('Preview cleanup', 'settingsStorageCleanup'), storage = document.querySelector('[data-settings-content="storage"]');
  storage.querySelector('.settings-save-bar').append(cleanup);
  storage.querySelector('.settings-note').textContent = t('Cleanup removes only old unused WebUI uploads and managed cache/logs. Chats, credentials, memories and project files are preserved.');
  cleanup.onclick = () => run(cleanup, $('#settingsStorageStatus'), async () => {
    const result = await request('cleanup.preview'), content = node('div');
    if (!result.items.length) { $('#settingsStorageStatus').textContent = t('No eligible files to remove.'); return; }
    const list = node('ul');
    for (const item of result.items) list.append(userText('li', `${item.name} · ${new Intl.NumberFormat(document.documentElement.lang).format(item.bytes)} B`));
    content.append(list); confirmPreview('Preview cleanup', content, 'Confirm cleanup', async () => { await request('cleanup.execute', { previewToken: result.previewToken }); $('#settingsStorageStatus').textContent = t('Cleanup completed'); });
    $('#settingsStorageStatus').textContent = '';
  });

  const mcp = node('section', '', 'developer-tools-section'), mcpReload = button('Reload MCP inventory', 'settingsMcpReload'), mcpStatus = node('p'), mcpList = node('div'); mcpList.id = 'settingsMcpList'; mcpStatus.role = 'status'; mcpStatus.id = 'settingsMcpStatus';
  mcp.append(node('h2', t('MCP inventory'), 'settings-section-title settings-section-spaced'), node('p', t('Tools and resources advertised by the native server. Account connection changes are not available here.'), 'settings-description'), mcpReload, mcpStatus, mcpList);
  document.querySelector('[data-settings-content="agent"]').append(mcp);
  mcpReload.onclick = () => run(mcpReload, mcpStatus, async () => {
    const result = await request('mcp.inventory', { threadId: state.active?.id || null }); mcpList.replaceChildren();
    for (const server of result.servers) {
      const section = node('details', '', 'settings-group-card developer-mcp-server'); section.append(userText('summary', `${server.name} · ${server.runtimeStatus} · ${server.authStatus}`));
      for (const [label, items] of [['Tools', server.tools], ['Resources', server.resources], ['Resource templates', server.resourceTemplates]]) {
        const list = node('ul'); section.append(node('h3', t(label)));
        for (const item of items) list.append(userText('li', item.name + (item.description ? ` — ${item.description}` : '')));
        section.append(list);
      }
      mcpList.append(section);
    }
    mcpStatus.textContent = t(result.servers.length ? 'MCP inventory loaded' : 'No MCP servers reported.');
  });
  return { loadWorktrees, show(page) { if (page === 'personalization' && (!agents || agentsCwd !== project())) run(agentsReload, agentsStatus, loadAgents); } };
}

const DRAFT_KEY = 'codex-remote-web-access-draft';
export function saveAccessDraft(storage, draft) {
  if (typeof draft?.text !== 'string' || draft.text.length > 250000) return;
  try { storage.setItem(DRAFT_KEY, JSON.stringify({ text: draft.text, threadId: draft.threadId || null, cwd: draft.cwd || null })); } catch { /* Storage can be unavailable in private browsing. */ }
}
export function takeAccessDraft(storage, { threadId = null, cwd = null } = {}) {
  try {
    const draft = JSON.parse(storage.getItem(DRAFT_KEY) || 'null');
    if (!draft || typeof draft.text !== 'string' || draft.threadId !== threadId || (!threadId && draft.cwd !== cwd)) return null;
    storage.removeItem(DRAFT_KEY); return draft.text;
  } catch { return null; }
}
export function installAccessSession(initialStatus, { translate = value => value } = {}) {
  const rawFetch = globalThis.fetch.bind(globalThis);
  let required = false, checking = null, status = initialStatus;
  function preserveDraft() {
    const state = globalThis.__codexWebuiDebug?.state, input = document.querySelector('#prompt');
    if (state && input) saveAccessDraft(sessionStorage, { text: input.value, threadId: state.active?.id, cwd: state.workspaceContext?.cwd });
  }
  function requireAuthentication() {
    if (required) return;
    required = true; preserveDraft();
    dispatchEvent(new Event('codex-webui:auth-required'));
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    for (const node of document.querySelectorAll('#app,.workspace-rail')) node.inert = true;
    const gate = document.querySelector('#accessGate'); gate.hidden = false;
    document.querySelector('#accessGateTitle').textContent = translate('Sign in again');
    document.querySelector('#accessGateDescription').textContent = translate('Your access session ended. Your draft is saved in this tab. Sign in to continue; messages will not be sent automatically.');
    const link = document.querySelector('#accessLogin'); link.textContent = translate(status.mode==='quick-tunnel'?'Continue with email verification':'Continue with Cloudflare Access'); link.href = status.loginUrl || '/'; link.focus();
  }
  async function check() {
    if (required) return true;
    if (checking) return checking;
    checking = (async () => {
      try {
        const response = await rawFetch('/api/auth/status', { cache: 'no-store', redirect: 'manual', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        if (response.status >= 500) return false;
        if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403 || !response.headers.get('content-type')?.includes('application/json')) { requireAuthentication(); return true; }
        const next = await response.json();
        if (!next.authenticated) { requireAuthentication(); return true; }
        status = next; return false;
      } catch { return false; } // Network loss is not evidence of an expired login.
      finally { checking = null; }
    })();
    return checking;
  }
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return rawFetch(input, init);
    if (required) throw Object.assign(new Error('Authentication required'), { code: 'AUTH_REQUIRED' });
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)); headers.set('X-Requested-With', 'XMLHttpRequest');
    try {
      const response = await rawFetch(input, { ...init, headers });
      if (response.status === 401 || response.status === 403 || response.redirected || response.headers.get('content-type')?.includes('text/html')) await check();
      return response;
    } catch (error) { await check(); throw error; }
  };
  const session = { get required() { return required; }, get status() { return status; }, check, requireAuthentication, preserveDraft,
    restoreDraft(state) { const text = takeAccessDraft(sessionStorage, { threadId: state.active?.id || null, cwd: state.workspaceContext?.cwd || null }); if (text !== null) { const input = document.querySelector('#prompt'); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); } },
  };
  globalThis.__codexWebuiAccessSession = session;
  if (!status.authenticated) requireAuthentication();
  return session;
}

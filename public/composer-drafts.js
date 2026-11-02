const STORAGE_KEY = 'codex-webui-composer-drafts';
const MAX_DRAFTS = 20, MAX_TEXT = 250_000, MAX_PERSISTED = 1_000_000;
const empty = () => ({ text: '', mentions: [] });
const clone = draft => ({ text: draft.text, mentions: draft.mentions.map(item => ({ ...item })) });

// Tab-scoped recovery only. Storage failures must never stop typing or navigation.
export function createComposerDrafts(storage) {
  const drafts = new Map();
  try {
    const saved = JSON.parse(storage()?.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(saved)) for (const entry of saved.slice(-MAX_DRAFTS)) {
      if (!Array.isArray(entry)) continue;
      const [key, draft] = entry;
      if (typeof key !== 'string' || key.length > 4096 || typeof draft?.text !== 'string' || draft.text.length > MAX_TEXT) continue;
      const mentions = Array.isArray(draft.mentions) ? draft.mentions.filter(item => item && typeof item.id === 'string').slice(0, 50).map(item => Object.fromEntries(Object.entries(item).filter(([, value]) => typeof value === 'string' && value.length <= 4096))) : [];
      drafts.set(key, { text: draft.text, mentions });
    }
  } catch {}
  function persist() {
    try {
      let size = 0;
      const saved = [...drafts].reverse().filter(([, draft]) => {
        const length = JSON.stringify(draft).length;
        if (draft.text.length > MAX_TEXT || size + length > MAX_PERSISTED) return false;
        size += length;
        return true;
      }).reverse();
      storage()?.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {}
  }
  return {
    get(key) { return clone(drafts.get(key) || empty()); },
    set(key, draft) {
      drafts.delete(key);
      if (draft.text || draft.mentions.length) drafts.set(key, clone(draft));
      while (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value);
      persist();
    },
    remove(key) { drafts.delete(key); persist(); },
  };
}

export function mergeComposerDrafts(submitted, newer) {
  return {
    text: submitted.text && newer.text ? `${submitted.text}\n\n${newer.text}` : submitted.text || newer.text,
    mentions: [...new Map([...submitted.mentions, ...newer.mentions].map(item => [item.id, item])).values()],
  };
}

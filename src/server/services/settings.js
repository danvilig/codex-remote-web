// Narrow facade over native config RPCs. Never return raw config/layers or accept paths.
export const EDITABLE_SETTINGS = Object.freeze({
  approval_policy: ['on-request', 'never'],
  sandbox_mode: ['read-only', 'workspace-write', 'danger-full-access'],
  'sandbox_workspace_write.network_access': [false, true],
  'memories.generate_memories': [false, true],
  'memories.use_memories': [false, true],
  web_search: ['disabled', 'cached', 'indexed', 'live'],
  model_reasoning_summary: ['auto', 'concise', 'detailed', 'none'],
  model_verbosity: ['low', 'medium', 'high'],
});

const get = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);

export function publicSettings(result) {
  const layer = result?.layers?.find(layer => layer.name?.type === 'user' && !layer.name.profile);
  if (!result?.config || !Array.isArray(result.layers)) throw new Error('Settings unavailable');
  const values = {}, sources = {};
  for (const [key, options] of Object.entries(EDITABLE_SETTINGS)) {
    values[key] = options.includes(get(result.config, key)) ? get(result.config, key) : null;
    const source = result.origins?.[key]?.name?.type;
    sources[key] = ['user', 'project', 'system', 'sessionFlags', 'enterpriseManaged', 'mdm'].includes(source) ? source : 'default';
  }
  const instructions = typeof result.config.developer_instructions === 'string' ? result.config.developer_instructions : '';
  const instructionsEditable = instructions.length <= 16000;
  // Never present a truncated document as if it were safe to overwrite.
  values.developer_instructions = instructionsEditable ? instructions : '';
  return { values, sources, instructionsEditable, version: typeof layer?.version === 'string' ? layer.version : null };
}

export function settingsEdits(payload) {
  if (!payload || Object.keys(payload).some(key => !['values', 'version'].includes(key)) ||
      typeof payload.version !== 'string' || !payload.version || payload.version.length > 256 ||
      !payload.values || typeof payload.values !== 'object' || Array.isArray(payload.values)) {
    throw new Error('Invalid settings request');
  }
  const entries = Object.entries(payload.values);
  if (!entries.length || entries.length > Object.keys(EDITABLE_SETTINGS).length + 1 ||
      entries.some(([key, value]) => key === 'developer_instructions' ? typeof value !== 'string' || value.length > 16000 : !Object.hasOwn(EDITABLE_SETTINGS, key) || !EDITABLE_SETTINGS[key].includes(value))) {
    throw new Error('Unsupported setting or value');
  }
  return entries.map(([keyPath, value]) => ({ keyPath, value, mergeStrategy: 'replace' }));
}

export function createSettingsService(request) {
  const read = async () => publicSettings(await request('config/read', { includeLayers: true }));
  return {
    read,
    async write(payload) {
      const edits = settingsEdits(payload);
      const current = await read();
      if (!current.version || current.version !== payload.version) {
        const error = new Error('Settings changed. Reload before saving.'); error.status = 409; throw error;
      }
      // Keep loaded chats unchanged; new threads read the updated user configuration.
      // Native expectedVersion also closes the race between read and write.
      const result = await request('config/batchWrite', { edits, expectedVersion: payload.version, reloadUserConfig: false });
      return { ...await read(), overridden: result.status === 'okOverridden' };
    },
  };
}

import { expect, test } from 'bun:test';
import { publicSettings, settingsEdits, createSettingsService } from '../../src/server/services/settings.js';

const nativeConfig = (version = 'v1') => ({ config: { web_search: 'live', model_verbosity: 'high', api_key: 'SECRET' }, origins: { web_search: { name: { type: 'project', dotCodexFolder: '/private' } } }, layers: [{ name: { type: 'user', file: '/private/config.toml', profile: null }, version, config: { token: 'SECRET' } }] });

test('publishes only supported settings, source types and base user version', () => {
  const result = publicSettings(nativeConfig());
  expect(result).toMatchObject({ values: { web_search: 'live', model_reasoning_summary: null, model_verbosity: 'high' }, sources: { web_search: 'project', model_reasoning_summary: 'default', model_verbosity: 'default' }, version: 'v1' });
  expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(JSON.stringify(result)).not.toContain('/private');
  expect(publicSettings({ config: {}, layers: [] }).version).toBeNull();
  expect(() => publicSettings({ config: {} })).toThrow();
});

test('rejects arbitrary config keys, paths, unsafe values and unversioned writes', () => {
  for (const payload of [null, {}, { values: { web_search: 'live' } }, { version: 'v1', values: {} }, { version: 'v1', values: { web_search: 'bad' } }, { version: 'v1', values: { sandbox_mode: 'invalid' } }, { version: 'v1', values: { 'model_providers.secret': 'x' } }, { version: 'v1', filePath: '/tmp/config', values: { web_search: 'live' } }, { version: 'v1', values: { __proto__: 'x' } }]) expect(() => settingsEdits(payload)).toThrow();
  expect(settingsEdits({ version: 'v1', values: { web_search: 'disabled' } })).toEqual([{ keyPath: 'web_search', value: 'disabled', mergeStrategy: 'replace' }]);
});

test('writes only changed allowlisted keys with native version protection', async () => {
  const calls: any[] = [];
  const service = createSettingsService(async (method, params) => { calls.push({ method, params }); return method === 'config/read' ? nativeConfig() : { status: 'okOverridden' }; });
  const result = await service.write({ version: 'v1', values: { model_verbosity: 'low' } });
  expect(calls[1]).toEqual({ method: 'config/batchWrite', params: { edits: [{ keyPath: 'model_verbosity', value: 'low', mergeStrategy: 'replace' }], expectedVersion: 'v1', reloadUserConfig: false } });
  expect(result.overridden).toBe(true);
});

test('rejects stale or missing user versions without issuing a write', async () => {
  let writes = 0;
  const service = createSettingsService(async method => { if (method !== 'config/read') writes++; return nativeConfig('v2'); });
  await expect(service.write({ version: 'v1', values: { web_search: 'live' } })).rejects.toThrow('Reload');
  expect(writes).toBe(0);
});

 test('nested booleans preserve false values and arbitrary objects cannot escape the facade', () => {
  const result = publicSettings({ ...nativeConfig(), config: { memories: { use_memories: false, generate_memories: true, secret: 'SECRET' }, sandbox_workspace_write: { network_access: false, writable_roots: ['/private'] } } });
  expect(result.values['memories.use_memories']).toBe(false);
  expect(result.values['memories.generate_memories']).toBe(true);
  expect(result.values['sandbox_workspace_write.network_access']).toBe(false);
  expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(JSON.stringify(result)).not.toContain('/private');
  expect(settingsEdits({ version: 'v1', values: { 'memories.use_memories': false, developer_instructions: '' } })).toHaveLength(2);
  for (const value of ['true', {}, null]) expect(() => settingsEdits({ version: 'v1', values: { 'memories.use_memories': value } })).toThrow();
  expect(() => settingsEdits({ version: 'v1', values: { developer_instructions: 'a'.repeat(16001) } })).toThrow();
});

test('oversized instructions are read only rather than silently truncated', () => {
  const result = publicSettings({ ...nativeConfig(), config: { developer_instructions: 'a'.repeat(16001) } });
  expect(result.instructionsEditable).toBe(false); expect(result.values.developer_instructions).toBe('');
});

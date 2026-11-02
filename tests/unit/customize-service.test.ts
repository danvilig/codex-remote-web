import { expect, test } from 'bun:test';
import { publicPlugins, publicSkills, readCustomization } from '../../src/server/services/customize.js';

test('customization exposes display metadata without paths, URLs or auth material', () => {
  const skills = publicSkills({ data: [{ skills: [{ name: 'review', description: 'Review workflow', enabled: true, path: '/private', secret: 'SECRET' }] }] });
  const plugins = publicPlugins({ marketplaces: [{ path: '/private', plugins: [{ id: 'a', name: 'Docs', installed: true, enabled: false, interface: { shortDescription: 'Documents', logoUrl: 'https://private.example' }, authPolicy: 'SECRET' }, { id: 'a', name: 'Duplicate' }] }] });
  expect(skills).toEqual([{ name: 'review', description: 'Review workflow', enabled: true }]);
  expect(plugins).toEqual([{ name: 'Docs', description: 'Documents', installed: true, enabled: false }]);
  expect(JSON.stringify({ skills, plugins })).not.toMatch(/private|SECRET|https:/);
});

test('distinguishes unsupported plugin API from an empty installed catalog', async () => {
  const calls: any[] = [];
  const result = await readCustomization(async (method, params) => { calls.push({ method, params }); if (method === 'plugin/list') throw new Error('Unsupported'); return { data: [] }; }, '/workspace');
  expect(result).toEqual({ skills: [], plugins: [], skillsAvailable: true, pluginsAvailable: false });
  expect(calls).toContainEqual({ method: 'plugin/list', params: { cwds: ['/workspace'], marketplaceKinds: ['local'], forceRefetch: false } });
  expect(() => publicSkills({})).toThrow();
  expect(() => publicPlugins({})).toThrow();
});

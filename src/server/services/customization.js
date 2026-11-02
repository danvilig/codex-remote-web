import { createHash, randomUUID } from 'node:crypto';
import { publicSettings } from './settings.js';
import { installSkill, removableSkill, removeSkill } from './skill-files.js';
const identity = (kind, ...parts) =>
  createHash('sha256')
    .update(JSON.stringify([kind, ...parts]))
    .digest('hex')
    .slice(0, 32);
const changes = new Set();
const text = (value, limit = 2000) =>
  typeof value === 'string' ? value.slice(0, limit) : '';

export function createCustomizationService(request, options) {
  const mutationKey = options.privateRoot;
  async function catalog(cwd, force = false) {
    const [skills, plugins] = await Promise.allSettled([
      request('skills/list', { cwds: [cwd], forceReload: force }),
      request('plugin/list', { cwds: [cwd], forceRefetch: force })
    ]);
    const skillEntries =
      skills.status === 'fulfilled'
        ? (skills.value.data || []).flatMap((entry) => entry.skills || [])
        : [];
    const pluginEntries =
      plugins.status === 'fulfilled'
        ? (plugins.value.marketplaces || []).flatMap((market) =>
            (market.plugins || []).map((plugin) => ({ plugin, market }))
          )
        : [];
    return {
      skillsAvailable: skills.status === 'fulfilled',
      pluginsAvailable: plugins.status === 'fulfilled',
      skills: skillEntries
        .filter((item) => typeof item.name === 'string')
        .slice(0, 200)
        .map((item) => ({
          ...item,
          key: identity('skill', item.path || item.name)
        })),
      plugins: pluginEntries
        .filter((item) => typeof item.plugin.id === 'string')
        .slice(0, 200)
        .map((item) => ({
          ...item,
          key: identity(
            'plugin',
            item.market.path || item.market.name,
            item.plugin.id
          )
        }))
    };
  }
  async function read(cwd, force = false) {
    const raw = await catalog(cwd, force);
    return {
      skillsAvailable: raw.skillsAvailable,
      pluginsAvailable: raw.pluginsAvailable,
      skills: await Promise.all(
        raw.skills.map(async (item) => ({
          id: item.key,
          name: text(item.name, 160),
          description: text(item.shortDescription || item.description),
          enabled: item.enabled === true,
          removable: await removableSkill(item.path, { ...options, cwd })
        }))
      ),
      plugins: raw.plugins.map(({ key, plugin, market }) => ({
        id: key,
        name: text(plugin.interface?.displayName || plugin.name, 160),
        description: text(plugin.interface?.shortDescription),
        installed: plugin.installed === true,
        enabled: plugin.enabled === true,
        installable:
          plugin.installPolicy !== 'NOT_AVAILABLE' &&
          (!plugin.availability || plugin.availability === 'AVAILABLE'),
        marketplace: text(market.name, 160)
      }))
    };
  }
  async function composerTools(cwd) {
    const raw = await catalog(cwd);
    return { items: raw.skills
      .filter(item => item.enabled === true && typeof item.path === 'string')
      .map(item => ({ id: item.key, name: text(item.name, 160), description: text(item.shortDescription || item.description) })) };
  }
  async function resolveComposerTools(cwd, payload) {
    if (!payload || Object.keys(payload).some(key => key !== 'ids') ||
        !Array.isArray(payload.ids) || payload.ids.length > 20 ||
        payload.ids.some(id => typeof id !== 'string') ||
        new Set(payload.ids).size !== payload.ids.length) throw new Error('Invalid tools');
    const raw = await catalog(cwd, true);
    return { items: payload.ids.map(id => {
      const item = raw.skills.find(item => item.key === id && item.enabled === true && typeof item.path === 'string');
      if (!item) throw new Error('Tool unavailable');
      return { type: 'skill', name: item.name, path: item.path };
    }) };
  }
  async function pluginEnabled(plugin, enabled) {
    const config = await request('config/read', { includeLayers: true }),
      version = publicSettings(config).version;
    if (!version) throw new Error('User configuration is unavailable');
    await request('config/batchWrite', {
      edits: [
        {
          keyPath: `plugins.${JSON.stringify(plugin.id)}.enabled`,
          value: enabled,
          mergeStrategy: 'replace'
        }
      ],
      expectedVersion: version,
      reloadUserConfig: false
    });
  }
  async function write(cwd, payload) {
    if (changes.has(mutationKey)) {
      const error = new Error('A customization change is already running');
      error.status = 409;
      throw error;
    }
    if (
      !payload ||
      Object.keys(payload).some(
        (key) => !['kind', 'id', 'action', 'source', 'confirmed'].includes(key)
      ) ||
      payload.confirmed !== true ||
      !['skill', 'plugin'].includes(payload.kind) ||
      !['enable', 'disable', 'install', 'uninstall'].includes(payload.action)
    )
      throw new Error('Confirm a supported customization change');
    changes.add(mutationKey);
    try {
      if (payload.kind === 'skill' && payload.action === 'install') {
        const installed = await installSkill(payload.source, options);
        await request('skills/config/write', {
          path: installed.path,
          enabled: true
        });
        // Discovery uses the normal Codex user skill directory; no script is executed.
        await request('skills/list', { cwds: [cwd], forceReload: true });
      } else {
        const raw = await catalog(cwd, true),
          collection = payload.kind === 'skill' ? raw.skills : raw.plugins,
          selected = collection.find((item) => item.key === payload.id);
        if (!selected) throw new Error('Resource changed. Reload the catalog.');
        if (payload.kind === 'skill') {
          if (payload.action === 'uninstall') {
            if (!(await removableSkill(selected.path, { ...options, cwd })))
              throw new Error('Managed skill');
            await request('skills/config/write', {
              ...(selected.path
                ? { path: selected.path }
                : { name: selected.name }),
              enabled: false
            });
            await removeSkill(selected.path, { ...options, cwd });
          } else if (['enable', 'disable'].includes(payload.action))
            await request('skills/config/write', {
              ...(selected.path
                ? { path: selected.path }
                : { name: selected.name }),
              enabled: payload.action === 'enable'
            });
          else throw new Error('Unsupported skill action');
        } else {
          const { plugin, market } = selected;
          if (payload.action === 'install') {
            if (
              plugin.installed ||
              plugin.installPolicy === 'NOT_AVAILABLE' ||
              (plugin.availability && plugin.availability !== 'AVAILABLE')
            )
              throw new Error('Plugin cannot be installed');
            await request('plugin/install', {
              pluginName: plugin.name,
              ...(market.path
                ? { marketplacePath: market.path }
                : { remoteMarketplaceName: market.name }),
              installAttemptId: randomUUID()
            });
          } else if (payload.action === 'uninstall') {
            if (!plugin.installed) throw new Error('Plugin not installed');
            await request('plugin/uninstall', { pluginId: plugin.id });
          } else {
            if (!plugin.installed) throw new Error('Plugin not installed');
            await pluginEnabled(plugin, payload.action === 'enable');
          }
        }
      }
      return await read(cwd, true);
    } finally {
      changes.delete(mutationKey);
    }
  }
  return { read, write, composerTools, resolveComposerTools };
}

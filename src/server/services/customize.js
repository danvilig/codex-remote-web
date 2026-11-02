// Read-only display metadata. Exclude native paths, auth policies, source URLs and private fields.
const bounded = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
export function publicSkills(result) {
  if (!Array.isArray(result?.data)) throw new Error('Invalid skills response');
  const skills = result.data.flatMap(entry => Array.isArray(entry.skills) ? entry.skills : []);
  return skills.filter(item => typeof item.name === 'string').slice(0, 200).map(item => ({ name: bounded(item.name, 160), description: bounded(item.shortDescription || item.description), enabled: item.enabled === true }));
}
export function publicPlugins(result) {
  if (!Array.isArray(result?.marketplaces)) throw new Error('Invalid plugins response');
  const seen = new Set();
  return result.marketplaces.flatMap(entry => Array.isArray(entry.plugins) ? entry.plugins : []).filter(item => {
    if (!item.id || typeof item.id !== 'string' || seen.has(item.id)) return false; seen.add(item.id); return true;
  }).slice(0, 200).map(item => ({ name: bounded(item.interface?.displayName || item.name, 160), description: bounded(item.interface?.shortDescription), installed: item.installed === true, enabled: item.enabled === true }));
}
export async function readCustomization(request, cwd) {
  const [skills, plugins] = await Promise.allSettled([
    request('skills/list', { cwds: [cwd], forceReload: false }).then(publicSkills),
    request('plugin/list', { cwds: [cwd], marketplaceKinds: ['local'], forceRefetch: false }).then(publicPlugins),
  ]);
  return { skills: skills.status === 'fulfilled' ? skills.value : [], plugins: plugins.status === 'fulfilled' ? plugins.value : [], skillsAvailable: skills.status === 'fulfilled', pluginsAvailable: plugins.status === 'fulfilled' };
}

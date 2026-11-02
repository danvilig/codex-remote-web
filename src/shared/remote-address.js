export function hostnameFor(subdomain, zone) {
  const prefix = String(subdomain || '').trim().toLowerCase();
  const domain = String(zone || '').trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('Select a domain first.');
  if (prefix === '@') return domain;
  if (!prefix || prefix === domain || prefix.endsWith(`.${domain}`) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(prefix)) throw new Error('Enter only a subdomain, or @ for the selected domain.');
  const hostname = `${prefix}.${domain}`;
  if (hostname.length > 253) throw new Error('The hostname is too long.');
  return hostname;
}

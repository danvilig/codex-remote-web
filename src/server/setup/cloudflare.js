// The management token is supplied only by the server-side private credential store or local setup input.
const API = 'https://api.cloudflare.com/client/v4';
export class SetupError extends Error {
  constructor(message, status = 400, details) { super(message); this.status = status; if (details) this.details = details; }
}
export function operationHint(path) {
  const pathname = path.split('?')[0];
  if (pathname === '/accounts') return { operation: 'List Cloudflare accounts', permission: 'Account → Account Settings → Read' };
  if (pathname.endsWith('/access/organizations')) return { operation: 'Read Cloudflare Team Domain', permission: 'Account → Access: Organizations, Identity Providers, and Groups → Read' };
  if (pathname.includes('/access/apps')) return { operation: 'Manage Cloudflare Access applications', permission: 'Account → Access: Apps and Policies → Edit' };
  if (pathname.includes('/cfd_tunnel')) return { operation: 'Read or update Cloudflare Tunnel', permission: 'Account → Cloudflare Tunnel → Edit' };
  if (pathname.includes('/dns_records')) return { operation: 'Manage Cloudflare DNS records', permission: 'Zone → DNS → Edit' };
  return { operation: 'Read Cloudflare domains', permission: 'Zone → Zone → Read' };
}
export class CloudflareClient {
  constructor(token, fetcher = fetch) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{16,512}$/.test(token)) throw new SetupError('Enter a valid Cloudflare API token.');
    this.token = token; this.fetcher = fetcher;
  }
  async request(path, method = 'GET', body) {
    let response, data;
    try {
      response = await this.fetcher(API + path, { method, redirect: 'error', signal: AbortSignal.timeout(12000), headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      if (text.length > 4_000_000) throw new Error('Oversized response');
      data = JSON.parse(text);
    } catch { throw new SetupError('Cloudflare could not be reached. Check your network and retry.', 502); }
    if (!response.ok || data.success === false) {
      // Never forward management API payloads or credentials to browser/logs.
      const details = { ...operationHint(path), httpStatus: response.status, codes: (Array.isArray(data.errors) ? data.errors : []).map(error => error?.code).filter(code => Number.isSafeInteger(code) && code >= 0).slice(0, 5) };
      throw new SetupError(response.status === 401 || response.status === 403 ? 'Cloudflare denied access. Check token permissions and account scope.' : response.status === 429 ? 'Cloudflare rate limit reached. Try again later.' : 'Cloudflare rejected the operation. Refresh the preview and retry.', response.status === 429 ? 429 : 400, details);
    }
    return data;
  }
  async list(path) {
    const result = [];
    for (let page = 1; page <= 50; page++) {
      const data = await this.request(`${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=50`);
      if (!Array.isArray(data.result)) throw new SetupError('Unexpected Cloudflare response.', 502);
      result.push(...data.result);
      const pages = data.result_info?.total_pages;
      if (pages ? page >= pages : data.result.length < 50) return result;
    }
    throw new SetupError('Too many Cloudflare resources. Narrow the API token scope.');
  }
  async result(path, method, body) { return (await this.request(path, method, body)).result; }
}
export function resourceId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(value)) throw new SetupError('Select a valid Cloudflare resource.');
  return value;
}
export function setupInput(input) {
  const hostname = String(input.hostname || '').trim().toLowerCase();
  const email = String(input.email || '').trim().toLowerCase();
  if (hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) throw new SetupError('Enter a full hostname without a scheme or path.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SetupError('Enter the one email address allowed to sign in.');
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new SetupError('Choose a local service port between 1024 and 65535.');
  const create = input.tunnelMode === 'create';
  const tunnelName = String(input.tunnelName || 'Codex Remote Web').trim();
  if (create && (!tunnelName || tunnelName.length > 60 || /[\r\n\x00-\x1f]/.test(tunnelName))) throw new SetupError('Enter a Tunnel name between 1 and 60 characters.');
  return { accountId: resourceId(input.accountId), zoneId: resourceId(input.zoneId), ...(create ? { tunnelMode: 'create', tunnelName } : { tunnelId: resourceId(input.tunnelId) }), ...(input.confirmLocal === true ? { confirmLocal: true } : {}), hostname, email, port };
}
export function matchesHost(pattern, hostname) {
  const host = String(pattern || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  return host === '*' || host === hostname || (host.startsWith('*.') && hostname.endsWith(host.slice(1)));
}

export function accessConfiguration(env = process.env) {
  const mode = env.CODEX_WEBUI_AUTH_MODE || 'local';
  if (!['local', 'cloudflare-access'].includes(mode)) throw new Error('Invalid CODEX_WEBUI_AUTH_MODE');
  if (mode === 'local') return { mode };
  const required = name => { const value = String(env[name] || '').trim(); if (!value || value.length > 1024) throw new Error(`${name} is required`); return value; };
  const publicOrigin = required('CODEX_WEBUI_PUBLIC_ORIGIN');
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) throw new Error('CODEX_WEBUI_PUBLIC_ORIGIN must be an HTTPS origin without a path');
  const teamDomain = required('CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(teamDomain)) throw new Error('Invalid Cloudflare Access team domain');
  const audience = required('CODEX_WEBUI_CF_ACCESS_AUD');
  const allowedEmail = required('CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowedEmail)) throw new Error('Invalid Cloudflare Access email');
  if (!['127.0.0.1', '::1', 'localhost'].includes(env.HOST || '127.0.0.1')) throw new Error('Cloudflare mode requires a loopback listener');
  const allowLocalLoopback = String(env.CODEX_WEBUI_ALLOW_LOCAL_LOOPBACK || '').toLowerCase() === 'true';
  return { mode, publicOrigin, teamDomain, issuer: `https://${teamDomain}`, audience, allowedEmail, allowLocalLoopback };
}

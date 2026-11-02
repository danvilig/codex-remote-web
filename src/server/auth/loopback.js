// Explicit local inspection must not accept Tunnel/proxy traffic or cross-site
// requests. The socket, Host and browser Origin must all describe this machine.
export function isLocalInspectionRequest(req, config) {
  if (config.mode !== 'cloudflare-access' || !config.allowLocalLoopback) return false;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  if (Object.keys(req.headers).some(key => key === 'forwarded' || key === 'x-real-ip' || key.startsWith('x-forwarded-') || key.startsWith('cf-'))) return false;
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false;
  try {
    const local = new URL(`http://${req.headers.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) || local.host !== String(req.headers.host).toLowerCase()) return false;
    if (req.headers.origin && req.headers.origin !== local.origin) return false;
    return true;
  } catch { return false; }
}

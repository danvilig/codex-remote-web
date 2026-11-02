// Reauthorize long-lived browser transports through a fresh HTTP handshake at least every five minutes.
export const MAX_CONNECTION_MS = 300000;
export function createConnectionLease(principal, expire, { now = Date.now, maxMs = MAX_CONNECTION_MS } = {}) {
  if (!principal) return { valid: () => true, dispose() {} };
  const deadline = Math.min(principal.expiresAt, now() + maxMs);
  let finished = false;
  const end = () => { if (finished) return; finished = true; clearTimeout(timer); expire(deadline >= principal.expiresAt ? 'AUTH_EXPIRED' : 'AUTH_REFRESH'); };
  const timer = setTimeout(end, Math.max(0, deadline - now())); timer.unref?.();
  return { valid() { if (now() >= deadline) end(); return !finished; }, dispose() { finished = true; clearTimeout(timer); }, deadline };
}

import { readPrivate } from '../src/server/desktop/private-store.js';
import { join } from 'node:path';

export async function agentRequest(directory, action, body, { timeoutMs = 120000, expectedInstallation } = {}) {
  const descriptor = await readPrivate(join(directory, 'agent.json'));
  if (!descriptor || descriptor.version !== 1 || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(descriptor.token || '')) throw new Error('Background agent is unavailable');
  if (expectedInstallation !== undefined && descriptor.installation !== expectedInstallation) throw new Error('Background agent belongs to another installation');
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/v1/control`, { method: 'POST', headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, body }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Desktop operation failed'), { status: response.status });
  return result;
}

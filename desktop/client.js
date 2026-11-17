import { readPrivate } from '../src/server/desktop/private-store.js';
import { join } from 'node:path';

export async function agentRequest(directory, action, body, { timeoutMs = 120000, expectedInstallation } = {}) {
  const missing = Symbol('missing agent descriptor');
  const descriptor = await readPrivate(join(directory, 'agent.json'), missing);
  if (descriptor === missing) throw Object.assign(new Error('Background agent is unavailable'), { code: 'AGENT_ABSENT' });
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) || descriptor.version !== 1 || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(descriptor.token || '')) throw Object.assign(new Error('Background agent state is invalid'), { code: 'AGENT_STATE_INVALID' });
  if (expectedInstallation !== undefined && descriptor.installation !== expectedInstallation) throw Object.assign(new Error('Background agent belongs to another installation'), { code: 'AGENT_FOREIGN' });
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${descriptor.port}/v1/control`, { method: 'POST', headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, body }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (error) {
    if (['ECONNREFUSED', 'ConnectionRefused'].includes(error.code) || error.cause?.code === 'ECONNREFUSED') throw Object.assign(new Error('Background agent is offline'), { code: 'AGENT_OFFLINE', cause: error });
    throw error;
  }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Desktop operation failed'), { status: response.status });
  return result;
}

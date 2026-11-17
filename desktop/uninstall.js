import { agentRequest } from './client.js';
import { configureSession } from './session.js';

export async function uninstallBackground(options, installation) {
  const { directory } = options;
  // A stale launcher for installation A must not control installation B's agent.
  // Recheck ownership on each request in case the descriptor was replaced.
  const requestOptions = { expectedInstallation: installation, timeoutMs: options.timeoutMs ?? 120000 };
  for (const action of ['stop', 'shutdown']) {
    try { await agentRequest(directory, action, undefined, requestOptions); }
    catch (error) {
      // Only an absent/offline endpoint or another installation is harmless.
      // A live refusal, timeout or unsafe state must keep uninstall retryable.
      if (!['AGENT_ABSENT', 'AGENT_OFFLINE', 'AGENT_FOREIGN'].includes(error.code)) throw error;
    }
  }
  // Ownership is rechecked under the registration lock after all HTTP awaits.
  await configureSession(false, { ...options, expectedInstallation: installation });
}

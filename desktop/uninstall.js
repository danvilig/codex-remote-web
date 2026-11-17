import { join } from 'node:path';
import { readPrivate } from '../src/server/desktop/private-store.js';
import { agentRequest } from './client.js';
import { configureSession, sessionOwnedBy } from './session.js';

export async function uninstallBackground(options, installation) {
  const { directory } = options;
  const registration = await readPrivate(join(directory, 'session.json'));
  const descriptor = await readPrivate(join(directory, 'agent.json'));
  const ownsAgent = !installation || descriptor?.installation === installation;
  const ownsRegistration = !installation || sessionOwnedBy(registration, installation, options);
  // A stale launcher for installation A must not control installation B's agent.
  // Recheck ownership on each request in case the descriptor was replaced.
  const requestOptions = { expectedInstallation: installation };
  if (ownsAgent) await agentRequest(directory, 'stop', undefined, requestOptions).catch(() => {});
  if (ownsRegistration) await configureSession(false, options);
  if (ownsAgent) await agentRequest(directory, 'shutdown', undefined, requestOptions).catch(() => {});
}

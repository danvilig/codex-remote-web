import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Only read identity from the currently running unit invocation. Never inspect tokens.
export async function localConnectorIds({ command = exec } = {}) {
  const ids = new Set();
  for (const user of [false, true]) {
    for (const unit of ['cloudflared.service', 'codex-remote-web-tunnel.service']) {
      try {
        const { stdout: properties } = await command('systemctl', [...(user ? ['--user'] : []), 'show', unit, '-p', 'InvocationID', '-p', 'ActiveState'], { timeout: 2500, maxBuffer: 32768 });
        if (!properties.includes('ActiveState=active')) continue;
        const invocation = properties.match(/^InvocationID=([a-f0-9]{32})$/m)?.[1];
        if (!invocation) continue;
        const { stdout } = await command('journalctl', [...(user ? ['--user'] : []), '--no-pager', '-b', '-n', '500', '-o', 'cat', `_SYSTEMD_INVOCATION_ID=${invocation}`], { timeout: 2500, maxBuffer: 512000 });
        for (const match of stdout.matchAll(/Generated Connector ID:\s*([a-f0-9-]{36})/gi)) if (UUID.test(match[1])) ids.add(match[1].toLowerCase());
      } catch { /* Restricted journals or missing units mean unknown identity, never a match. */ }
    }
  }
  return [...ids];
}
export function connectorSummary(connectors, localIds) {
  const local = new Set(localIds.map(id => id.toLowerCase()));
  let connectedHere = 0, connectedElsewhere = 0;
  for (const connector of Array.isArray(connectors) ? connectors : []) {
    const connections = Array.isArray(connector.conns) ? connector.conns : [];
    if (!connections.length) continue;
    const id = connector.id || connections[0]?.client_id;
    if (typeof id === 'string' && local.has(id.toLowerCase())) connectedHere++;
    else connectedElsewhere++;
  }
  return { connectedHere, connectedElsewhere, local: connectedHere > 0, multipleLocations: connectedHere > 0 && connectedElsewhere > 0 };
}

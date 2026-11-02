import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accessConfiguration } from '../config/access.js';

// A deliberately small, authenticated view. Never return the deployment receipt,
// AUD, probe nonce, unit contents or management/connector tokens.
export async function remoteAccessStatus(config, home, principal) {
  let active = ['cloudflare-access','quick-tunnel'].includes(config.mode), recoveryRequired = false;
  if (!active) {
    let receipt;
    try { receipt = JSON.parse(await readFile(join(home, '.config/codex-remote-web/setup-state.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { configured: false }; throw error; }
    recoveryRequired = !!(receipt.identityChange || receipt.configurationChange);
    if (receipt.phase !== 'complete' && !recoveryRequired) return { configured: false };
    if (receipt.configurationChange?.committed) receipt = receipt.configurationChange.candidate;
    config = accessConfiguration({ CODEX_WEBUI_AUTH_MODE: 'cloudflare-access', CODEX_WEBUI_PUBLIC_ORIGIN: `https://${receipt.input?.hostname}`, CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN: receipt.teamDomain, CODEX_WEBUI_CF_ACCESS_AUD: receipt.aud, CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL: receipt.input?.email });
  }
  return { configured: true, ...(recoveryRequired ? { recoveryRequired: true } : {}), active, mode: config.mode, publicOrigin: config.publicOrigin, teamDomain: config.teamDomain, allowedEmail: config.allowedEmail, identity: principal ? { email: principal.email } : null, expiresAt: config.mode === 'quick-tunnel' ? null : principal?.expiresAt || null };
}

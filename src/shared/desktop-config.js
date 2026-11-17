import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const desktopDirectory = (home = homedir()) => join(home, '.config', 'codex-remote-web', 'desktop');
export function desktopConfig(input = {}, home = homedir()) {
  const defaults = { version: 1, initialized: false, enabled: false, autostart: true, cwd: home, port: 8899, codex: '', cloudflared: '', terminal: false, language: 'system', theme: 'system' };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new Error('Invalid desktop configuration');
  const config = { ...defaults, ...input };
  if (config.version !== 1 || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Choose a port between 1024 and 65535');
  for (const key of ['cwd', 'codex', 'cloudflared']) {
    if (typeof config[key] !== 'string' || /[\0\r\n]/.test(config[key]) || (config[key] && !isAbsolute(config[key]))) throw new Error('Choose an absolute local path');
  }
  if (!config.cwd || !['system', 'zh', 'en'].includes(config.language) || !['system', 'light', 'dark'].includes(config.theme)) throw new Error('Invalid desktop preferences');
  for (const key of ['initialized', 'enabled', 'autostart', 'terminal']) if (typeof config[key] !== 'boolean') throw new Error('Invalid desktop switch');
  return config;
}

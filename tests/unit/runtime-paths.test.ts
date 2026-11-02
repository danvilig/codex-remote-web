import { expect, test } from 'bun:test';
import { gatewayCommand, nodeRuntime } from '../../src/server/config/paths.js';

test('compiled systemd launch uses the executable without Bun CLI arguments', () => {
  expect(gatewayCommand('/opt/webui', '/opt/webui/codex-remote-web', true)).toEqual(['/opt/webui/codex-remote-web']);
  expect(gatewayCommand('/opt/webui', '/opt/bun', false)).toEqual(['/opt/bun', 'run', '/opt/webui/dist/server.js']);
});
test('explicit worker runtime remains compatible with existing deployments', () => {
  expect(nodeRuntime({ CODEX_WEBUI_NODE: '/opt/custom/node', PATH: '' })).toBe('/opt/custom/node');
  expect(nodeRuntime({ PATH: '' })).toBeNull();
});

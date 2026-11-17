import { expect, test } from 'bun:test';
import { windowsIsolatedProcess, windowsIsolatedScript } from '../../src/server/bridge/windows-isolated.js';

test('Windows isolated launcher keeps executable, Unicode and shell metacharacters in data', () => {
  const command = ['C:\\Program Files\\Codex\\node.exe', 'C:\\用户\\codex.js', '', 'a"b', 'tail\\', "$(exit 17); `whoami` & | %PATH%"];
  const directory = 'C:\\项目 with spaces\\';
  const original = { SystemRoot: 'C:\\Windows', FIXTURE_VALUE: 'unchanged' };
  const spec = windowsIsolatedProcess(command, directory, original);
  expect(spec.binary).toMatch(/Windows[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  expect(spec.args.slice(0, -1)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  expect(Buffer.from(spec.args.at(-1)!, 'base64').toString('utf16le')).toBe(windowsIsolatedScript);
  expect(JSON.parse(Buffer.from(spec.env.CODEX_WEBUI_ISOLATED_SPEC, 'base64').toString('utf8'))).toEqual({ command, cwd: directory });
  expect(spec.env.FIXTURE_VALUE).toBe('unchanged');
  expect(original).not.toHaveProperty('CODEX_WEBUI_ISOLATED_SPEC');
  // The executable command line has Windows' 32767-character ceiling. Native
  // argv is separate UTF-8 data and cannot consume/inject the encoded script.
  expect(spec.args.join(' ').length + spec.binary.length).toBeLessThan(32767);
  expect(windowsIsolatedScript).not.toContain(command.at(-1)!);
});

test('Windows isolated launcher rejects invalid executable/argument data before spawn', () => {
  for (const command of [[], [''], ['a', null], ['a\0b'], ['a', 'b\0c']]) {
    expect(() => windowsIsolatedProcess(command, '/fixture')).toThrow('Invalid isolated process specification');
  }
  for (const directory of ['', '\0', null]) {
    expect(() => windowsIsolatedProcess(['fixture'], directory)).toThrow('Invalid isolated process specification');
  }
});

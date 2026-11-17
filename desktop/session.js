import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readPrivate, writePrivate } from '../src/server/desktop/private-store.js';

const exec = promisify(execFile);
const label = 'io.github.danvilig.codex-remote-web.desktop-agent';
const marker = '# Managed by Codex Remote Web desktop v1';
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const systemdQuote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
export function sessionDefinition({ platform = process.platform, home = homedir(), executable, args = [], env = process.env }) {
  for (const value of [executable, ...args]) if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('Invalid background launcher');
  args = [...args, '--background-agent'];
  if (platform === 'darwin') return {
    platform, path: join(home, 'Library/LaunchAgents', label + '.plist'),
    content: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[executable, ...args].map(value => `<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>20</integer></dict></plist>\n`,
  };
  if (platform === 'linux') return {
    platform, path: join(home, '.config/systemd/user/codex-remote-web-desktop.service'),
    content: `${marker}\n[Unit]\nDescription=Codex Remote Web desktop gateway\nPartOf=graphical-session.target\nAfter=graphical-session.target\nStartLimitIntervalSec=60\nStartLimitBurst=3\n[Service]\nExecStart=${[executable, ...args].map(systemdQuote).join(' ')}\n${['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'].filter(key => env[key] && !/[\r\n]/.test(env[key])).map(key => `Environment=${systemdQuote(key + '=' + env[key])}\n`).join('')}Restart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nKillMode=control-group\nUMask=0077\n[Install]\nWantedBy=graphical-session.target\n`,
  };
  if (platform !== 'win32') throw new Error('Unsupported desktop system');
  // These arguments are interpreted by a GUI executable, never cmd.exe.
  const quote = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  const name = 'Codex Remote Web Desktop ' + createHash('sha256').update(home).digest('hex').slice(0, 12);
  return { platform, name, executable, arguments: args.map(quote).join(' ') };
}
async function powershell(script, env) {
  const binary = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return exec(binary, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, ...env }, windowsHide: true, timeout: 20000 });
}
export async function configureSession(enabled, options) {
  const definition = options.definition || sessionDefinition(options), recordPath = join(options.directory, 'session.json');
  const run = options.run || exec;
  const saved = await readPrivate(recordPath);
  const restore = () => configureSession(!!saved, { ...options, definition: saved || definition });
  if (enabled && JSON.stringify(saved) === JSON.stringify(definition)) return async () => {};
  if (definition.platform === 'win32') {
    const spec = enabled ? definition : saved;
    if (!spec) return async () => {};
    const payload = Buffer.from(JSON.stringify(spec)).toString('base64');
    const previous = Buffer.from(JSON.stringify(saved || spec)).toString('base64');
    const script = `$ErrorActionPreference='Stop'; $s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CRW_TASK_SPEC))|ConvertFrom-Json; $old=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CRW_TASK_PREVIOUS))|ConvertFrom-Json; $scheduler=New-Object -ComObject Schedule.Service; $scheduler.Connect(); $folder=$scheduler.GetFolder('\\'); $existing=$null; try{$existing=$folder.GetTask($s.name)}catch{}; ${saved ? '' : "if($existing){throw 'A background task with this name already exists'};"} if($existing -and ($existing.Definition.Actions.Count -ne 1 -or $existing.Definition.Actions.Item(1).Path -ne $old.executable -or $existing.Definition.Actions.Item(1).Arguments -ne $old.arguments)){throw 'The background task changed; preserve it'}; ` + (enabled ? `$task=$scheduler.NewTask(0); $task.RegistrationInfo.Description='Codex Remote Web desktop v1'; $task.Principal.LogonType=3; $task.Principal.RunLevel=0; $task.Settings.Enabled=$true; $task.Settings.DisallowStartIfOnBatteries=$false; $task.Settings.StopIfGoingOnBatteries=$false; $task.Settings.ExecutionTimeLimit='PT0S'; $task.Settings.MultipleInstances=2; $trigger=$task.Triggers.Create(9); $trigger.UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name; $action=$task.Actions.Create(0); $action.Path=$s.executable; $action.Arguments=$s.arguments; $null=$folder.RegisterTaskDefinition($s.name,$task,6,[Security.Principal.WindowsIdentity]::GetCurrent().Name,$null,3)` : `if($existing){$folder.DeleteTask($s.name,0)}`);
    await powershell(script, { CRW_TASK_SPEC: payload, CRW_TASK_PREVIOUS: previous });
  } else {
    const spec = enabled ? definition : saved;
    if (!spec) return async () => {};
    const metadata = await lstat(spec.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== process.getuid())) throw new Error('Unsafe background registration; preserve it before continuing');
    const current = await readFile(spec.path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current !== null && (!saved || current !== saved.content)) throw new Error('Background registration changed; preserve it before continuing');
    if (!enabled && definition.platform === 'linux') {
      const expected = join(options.home || homedir(), '.config/systemd/user/codex-remote-web-desktop.service');
      if (spec.path !== expected) throw new Error('Background registration path changed; preserve it before continuing');
      const runtime = options.env?.XDG_RUNTIME_DIR || process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
      const bus = await lstat(join(runtime, 'bus')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!bus) {
        // No logged-in manager: remove only our verified enablement link and
        // unit. systemctl --user disable can itself require a live user bus.
        const wants = join(dirname(expected), 'graphical-session.target.wants');
        const parent = await lstat(wants).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (parent && (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid())) throw new Error('Unsafe background enablement directory');
        const link = join(wants, 'codex-remote-web-desktop.service');
        const metadata = parent && await lstat(link).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (metadata && (!metadata.isSymbolicLink() || metadata.uid !== process.getuid() || resolve(wants, await readlink(link)) !== expected)) throw new Error('Background enablement changed; preserve it before continuing');
        if (metadata) await rm(link);
        await rm(spec.path, { force: true });
        await rm(recordPath, { force: true });
        return restore;
      }
    }
    try {
      if (enabled) { await mkdir(dirname(spec.path), { recursive: true, mode: 0o700 }); await writeFile(spec.path, spec.content, { mode: 0o600 }); }
      // Reload after removing the unit, so the manager sees the final state.
      else if (definition.platform === 'linux') await run('systemctl', ['--user', '--no-reload', 'disable', 'codex-remote-web-desktop.service'], { timeout: 15000 });
      if (!enabled) await rm(spec.path, { force: true });
      if (definition.platform === 'linux') {
        await run('systemctl', ['--user', 'daemon-reload'], { timeout: 15000 });
        // Do not stop the current session's agent when disabling login startup.
        if (enabled) await run('systemctl', ['--user', 'enable', 'codex-remote-web-desktop.service'], { timeout: 15000 });
      } else if (enabled) {
        const domain = `gui/${process.getuid()}`;
        await run('launchctl', ['enable', `${domain}/${label}`], { timeout: 15000 });
        await run('launchctl', ['bootout', `${domain}/${label}`], { timeout: 15000 }).catch(() => {});
        await run('launchctl', ['bootstrap', domain, spec.path], { timeout: 15000 });
      } else {
        await run('launchctl', ['disable', `gui/${process.getuid()}/${label}`], { timeout: 15000 });
      }
      if (enabled) await writePrivate(recordPath, definition); else await rm(recordPath, { force: true });
    } catch (error) {
      // A failed registration must not leave a newly written startup file.
      if (current === null) await rm(spec.path, { force: true });
      else await writeFile(spec.path, current, { mode: 0o600 });
      if (definition.platform === 'linux') {
        await run('systemctl', ['--user', '--no-reload', saved ? 'enable' : 'disable', 'codex-remote-web-desktop.service'], { timeout: 15000 });
        await run('systemctl', ['--user', 'daemon-reload'], { timeout: 15000 });
      } else {
        const domain = `gui/${process.getuid()}`;
        await run('launchctl', [saved ? 'enable' : 'disable', `${domain}/${label}`], { timeout: 15000 });
        if (saved) {
          await run('launchctl', ['bootout', `${domain}/${label}`], { timeout: 15000 }).catch(() => {});
          await run('launchctl', ['bootstrap', domain, spec.path], { timeout: 15000 });
        }
      }
      throw error;
    }
    return restore;
  }
  if (enabled) await writePrivate(recordPath, definition); else await rm(recordPath, { force: true });
  return restore;
}

import { version } from '../../package.json';

const command = process.argv[2];
if (command === '--version' || command === '-v') {
  console.log(`Codex Remote Web ${version}`);
} else if (command === '--help' || command === '-h') {
  console.log(`Codex Remote Web ${version}
Usage: codex-remote-web [setup | agent | uninstall-desktop | --version | --help]

No command: start the full WebUI (default http://127.0.0.1:8899).
setup: open the standalone remote-access configuration wizard.
agent: run the private desktop controller (managed by the desktop app).
uninstall-desktop: stop and unregister this user's desktop background component.
Configure your project with CODEX_WEBUI_CWD. Keep this installation directory
intact: public assets, runtime and terminal workers accompany the executable.
Codex CLI is required; cloudflared is needed for remote access.`);
} else if (command === 'session-configure') {
  try {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 262144) throw new Error('Background registration request is too large'); }
    const request = JSON.parse(input);
    if (typeof request.enabled !== 'boolean' || !request.options || typeof request.options.directory !== 'string') throw new Error('Invalid background registration request');
    const allowed = ['directory', 'executable', 'args', 'definition', 'expectedInstallation', 'expectedRegistration', 'expectedGeneration'];
    if (Object.keys(request.options).some(key => !allowed.includes(key))) throw new Error('Invalid background registration option');
    const { configureSession } = await import('../../desktop/session.js');
    const restore = await configureSession(request.enabled, request.options);
    console.log(JSON.stringify({ snapshot: restore.snapshot }));
  } catch (error: any) { console.log(JSON.stringify({ error: error.message, code: error.code })); process.exitCode = 1; }
} else if (command === 'cleanup-desktop') {
  const { desktopDirectory } = await import('../shared/desktop-config.js');
  const { cleanDesktopState } = await import('./desktop/cleanup.js');
  try { console.log(JSON.stringify(await cleanDesktopState(desktopDirectory()))); }
  catch (error: any) { console.error(error.message); process.exitCode = 1; }
} else if (command === 'uninstall-desktop') {
  const { desktopDirectory } = await import('../shared/desktop-config.js');
  const { uninstallBackground } = await import('../../desktop/uninstall.js');
  const directory = desktopDirectory();
  const installation = process.argv[3];
  await uninstallBackground({ directory, executable: installation || process.execPath }, installation);
} else if (command === 'agent') {
  const { startDesktopAgent } = await import('./desktop/agent.js');
  try { await startDesktopAgent(); }
  catch (error: any) {
    if (error.code === 'PRIVATE_LOCK_BUSY') process.exit(0);
    console.error('Desktop agent could not start. Check private state permissions and installation.'); process.exit(1);
  }
} else if (command === 'setup') {
  const { startSetupServer } = await import('./setup/http.js');
  const result = await startSetupServer();
  console.log(`Codex Remote Web — remote access setup\n${result.url}\nOpen this single-use link on this machine. Keep this process running until setup finishes.`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => result.server.close(() => process.exit(0)));
} else if (command) {
  console.error(`Unknown command: ${command}. Run with --help.`);
  process.exitCode = 1;
} else {
  await import('./index.ts');
}

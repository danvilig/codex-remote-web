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
} else if (command === 'uninstall-desktop') {
  const { desktopDirectory } = await import('../shared/desktop-config.js');
  const { agentRequest } = await import('../../desktop/client.js');
  const { configureSession } = await import('../../desktop/session.js');
  const { readPrivate } = await import('./desktop/private-store.js');
  const { join } = await import('node:path');
  const directory = desktopDirectory();
  const registration = await readPrivate(join(directory, 'session.json'));
  const descriptor = await readPrivate(join(directory, 'agent.json'));
  const installation = process.argv[3];
  if (!installation || registration?.executable === installation || descriptor?.installation === installation) {
    await agentRequest(directory, 'stop').catch(() => {});
    await configureSession(false, { directory, executable: process.execPath });
    await agentRequest(directory, 'shutdown').catch(() => {});
  }
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

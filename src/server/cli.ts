import { version } from '../../package.json';

const command = process.argv[2];
if (command === '--version' || command === '-v') {
  console.log(`Codex Remote Web ${version}`);
} else if (command === '--help' || command === '-h') {
  console.log(`Codex Remote Web ${version}
Usage: codex-remote-web [setup | --version | --help]

No command: start the full WebUI (default http://127.0.0.1:8899).
setup: open the standalone remote-access configuration wizard.
Configure your project with CODEX_WEBUI_CWD. Keep this installation directory
intact: public assets, runtime and terminal workers accompany the executable.
Codex CLI is required; cloudflared is needed for remote access.`);
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

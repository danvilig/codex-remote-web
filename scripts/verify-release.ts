// Identical offline release gates for local candidates and both GitHub workflows.
// No model calls, real credentials, service restarts or Cloudflare mutations.
const root = new URL('..', import.meta.url).pathname;
async function run(args: string[]) {
  console.log(`\nVerifying: ${args.join(' ')}`);
  const child = Bun.spawn(args, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Verification failed: ${args.join(' ')}`);
}
await run(['bun', 'audit']);
for (const suite of ['check', 'build', 'test:unit', 'test:foundations', 'test:workspace', 'test:webkit', 'test:performance', 'test:access', 'test:setup', 'test:quick', 'test:project-roots', 'test:release']) {
  await run(['bun', 'run', suite]);
}
if (Bun.which('cloudflared')) await run(['bun', 'run', 'test:quick:cli']);
else console.log('SKIP real cloudflared offline validation: binary not installed. Required on deployment hosts with cloudflared.');
await run(['git', 'diff', '--exit-code']);
await run(['git', 'diff', '--check']);
if (await Bun.file(new URL('../SOURCE_PROVENANCE.json', import.meta.url)).exists()) await run(['bun', 'run', 'source:scan']);

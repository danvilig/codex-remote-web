import { test, expect } from 'bun:test';
import { GatewayProcess } from '../../src/server/desktop/process.js';

test('desktop helper diagnostics retain only fixed phase codes across split stderr', async () => {
  const events: string[] = [];
  const code = `
    process.stderr.write('PRIVATE_FIXTURE_OUTPUT\\n[codex-isolated:co');
    setTimeout(()=>{
      process.stderr.write('mpile] SECRET_FIXTURE_PATH\\n[codex-isolated:unknown]\\n[codex-isolated:job-assign:5]\\n[codex-isolated:spec:9999999999]\\n');
      process.send({type:'desktop-ready'});
    },50);
    process.on('message',message=>{if(message.action==='shutdown')process.exit(0)});
    setInterval(()=>{},1000);
  `;
  const gateway = new GatewayProcess({ command: [process.execPath, '--eval', code], log: event => events.push(event), restart: false });
  try {
    await gateway.start({ env: process.env, cwd: process.cwd() });
    expect(events).toContain('native-helper:compile');
    expect(events).toContain('gateway-ready');
    expect(events).toContain('native-helper:job-assign:5');
    expect(events.every(event => ['native-helper:compile', 'native-helper:job-assign:5', 'gateway-ready'].includes(event))).toBe(true);
  } finally { await gateway.stop(); }
},10000);

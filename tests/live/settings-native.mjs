import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createSettingsService } from '../../src/server/services/settings.js';
const root = await mkdtemp(join(tmpdir(), 'codex-native-config-'));
await writeFile(join(root, 'config.toml'), '');
const child = spawn(process.env.CODEX_BINARY || 'codex', ['app-server'], { cwd: root, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root, CODEX_AUTH_PATH: join(root, 'auth.json') }, stdio: ['pipe','pipe','ignore'] });
const pending = new Map(); let id = 0;
const lines = createInterface({ input: child.stdout });
lines.on('line', line => { const msg=JSON.parse(line);const task=pending.get(msg.id);if(task){pending.delete(msg.id);msg.error?task.reject(new Error(msg.error.message)):task.resolve(msg.result)}});
const request = (method,params) => new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});child.stdin.write(JSON.stringify({id:key,method,params})+'\n')});
const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);
try {
 await request('initialize',{clientInfo:{name:'settings-validation',version:'1'},capabilities:{experimentalApi:true}});
 child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 const service=createSettingsService(request); const before=await service.read();
 assert.ok(before.version);
 const result=await service.write({version:before.version,values:{approval_policy:'on-request',sandbox_mode:'read-only','sandbox_workspace_write.network_access':false,'memories.generate_memories':false,'memories.use_memories':false,developer_instructions:'Isolated settings validation.'}});
 assert.equal(result.values['memories.use_memories'],false);assert.equal(result.values['memories.generate_memories'],false);assert.equal(result.values.sandbox_mode,'read-only');assert.equal(result.values.developer_instructions,'Isolated settings validation.');
 const config=await readFile(join(root,'config.toml'),'utf8');assert.ok(config.includes('use_memories = false'));
 const started=await request('thread/start',{cwd:root});assert.equal(started.approvalPolicy,'on-request');assert.equal(started.sandbox.type,'readOnly');
 console.log('PASS: native Codex isolated config validation and persistence; no model or tools invoked');
} finally { clearTimeout(timeout);child.kill('SIGTERM');lines.close();await new Promise(resolve=>child.once('close',resolve));await rm(root,{recursive:true,force:true}); }

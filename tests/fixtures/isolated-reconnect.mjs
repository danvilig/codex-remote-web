#!/usr/bin/env node
// An exited server leaves a tool holding stdout. The tool emits a split stale
// notification while the replacement initializes, then survives until reaped.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const tool = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{});process.on('message',()=>{setTimeout(()=>process.stdout.write('{"method":"fixture/stale",'),200);setTimeout(()=>process.stdout.write('"params":{}}\\n'),350)});process.send('ready');setInterval(()=>{},1000)`], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
tool.once('message', () => {
  appendFileSync(process.env.FIXTURE_PIDS, JSON.stringify({ native: process.pid, tool: tool.pid, group: process.pid }) + '\n');
  const replacement = readFileSync(process.env.FIXTURE_PIDS, 'utf8').trim().split('\n').length > 1;
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'fixture/crash') { tool.send('stale', () => process.exit(7)); return; }
    const delay = request.method === 'fixture/slow' ? 2700 : request.method === 'initialize' && replacement ? Number(process.env.FIXTURE_INIT_DELAY || 0) : 0;
    if (request.id) setTimeout(() => process.stdout.write(JSON.stringify({ id: request.id, result: { pid: process.pid } }) + '\n'), delay);
  });
});

// Offline verification against the installed binary: no tunnel, account or email.
import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { quickConnectorArgs, quickPreflight, validateQuickConfiguration, connectorEnvironment } from '../../src/server/setup/quick.js';
const exec=promisify(execFile);
test('installed cloudflared accepts the production arguments and selects the private Unix ingress',async()=>{
  const binary=await quickPreflight(),directory=await mkdtemp(join(tmpdir(),'crw-real-cli-'));
  try {
    const socket=join(directory,'origin.sock');
    await writeFile(join(directory,'config.yml'),JSON.stringify({ingress:[{service:`unix:${socket}`}]}),{mode:0o600});
    const args=quickConnectorArgs(directory,'diagnostic@example.invalid');
    await validateQuickConfiguration(binary,args,process.env,directory);
    const {stdout}=await exec(binary,[...args,'ingress','rule','https://fixture-quick.trycloudflare.com'],{env:connectorEnvironment(process.env,directory),timeout:5000});
    expect(stdout).toContain(`service: unix:${socket}`);expect(stdout).not.toContain('service: hello_world');
    await expect(validateQuickConfiguration(binary,[...args,'--logformat','json'],process.env,directory)).rejects.toThrow('rejected');
    await expect(validateQuickConfiguration(binary,[...args,'--url','http://127.0.0.1:0'],process.env,directory)).rejects.toThrow('rejected');
  }finally{await rm(directory,{recursive:true,force:true});}
});

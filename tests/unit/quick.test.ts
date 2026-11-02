import {test,expect} from 'bun:test';
import {mkdtemp,rm,stat,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {QuickTunnel,quickEmail,quickOrigin,connectorEnvironment,createQuickConnector,quickPreflight,validateQuickConfiguration} from '../../src/server/setup/quick.js';
import {quickAuthenticator} from '../../src/server/setup/quick-origin.js';
import {temporaryQr} from '../../public/quick-qr.js';
const URL='https://fixture-quick.trycloudflare.com',EMAIL='owner@example.com';
async function fixture(fn) {
  const directory=await mkdtemp(join(tmpdir(),'crw-quick-test-'));let control, origin, closes=0, stopped=0;
  const quick=new QuickTunnel({directory,env:{PATH:process.env.PATH,HOME:directory},preflight:async()=>'/fixture/cloudflared',validate:async()=>{},workspace:async options=>{
    origin={...options,active:null,activate(url){this.active=url;},async close(){closes++;}};return origin;
  },connector:options=>{
    let finish;const closed=new Promise(resolve=>finish=resolve);
    control={...options,exit(){options.onExit();finish();}};
    return {closed,stop(){stopped++;finish();}};
  },startupMs:500});
  const start=async()=>{quick.start(EMAIL);for(let i=0;!control;i++){if(i>100)throw new Error('Fixture did not initialize');await Bun.sleep(5);}};
  try{await fn({quick,directory,start,control:()=>control,origin:()=>origin,closes:()=>closes,stopped:()=>stopped});}finally{await quick.stop();await rm(directory,{recursive:true,force:true});}
}
test('temporary email and address accept one identity and only official HTTPS hostnames',()=>{
  expect(quickEmail(' Owner@Example.COM ')).toBe(EMAIL);
  for(const email of ['', 'a@example.com,b@example.com','*@example.com','user@example.com\n--url','a @example.com'])expect(()=>quickEmail(email)).toThrow();
  for(const url of ['http://test.trycloudflare.com', 'https://test.trycloudflare.com/','https://trycloudflare.com','https://a.trycloudflare.com.evil.test','https://a.b.trycloudflare.com'])expect(()=>quickOrigin(url)).toThrow();
  expect(quickOrigin(URL)).toBe(URL);
  const env=connectorEnvironment({PATH:'/bin',HOME:'/secret',TUNNEL_TOKEN:'secret',TUNNEL_HOSTNAME:'wrong.example',TUNNEL_HTTP_HOST_HEADER:'localhost',CODEX_AUTH_PATH:'/secret',HTTPS_PROXY:'http://proxy'},'/private');
  expect(env).toEqual({HOME:'/private',PATH:'/bin',HTTPS_PROXY:'http://proxy'});
});
test('temporary tunnel is guarded until protected readiness, survives views, and stops only its own origin/connector',async()=>fixture(async f=>{
  await f.start();expect(f.quick.status()).toMatchObject({phase:'starting',publicOrigin:null,running:true});
  expect(f.origin().active).toBeNull();const args=f.control().args;
  expect(args).toContain('--allowed-mail');expect(args[args.indexOf('--allowed-mail')+1]).toBe(EMAIL);
  expect(args).not.toContain('--url');expect(args).not.toContain('--logformat');expect(args).toContain('--hello-world');
  expect(args[args.indexOf('--output')+1]).toBe('json');
  const config=JSON.parse(await readFile(args[args.indexOf('--config')+1],'utf8'));expect(config.ingress).toEqual([{service:`unix:${f.origin().socketPath}`}]);expect((await stat(f.origin().socketPath.replace('/origin.sock',''))).mode&0o777).toBe(0o700);
  expect(()=>f.quick.start('another@example.com')).toThrow('already');
  f.control().onMessage({type:'ready',publicOrigin:URL});await f.quick.runtime.starting;
  expect(f.quick.status()).toMatchObject({phase:'ready',publicOrigin:URL,email:EMAIL,running:true});expect(f.origin().active).toBe(URL);
  expect(JSON.stringify(f.quick.status())).not.toContain('socket');
  await f.quick.stop();expect(f.quick.status()).toMatchObject({phase:'stopped',publicOrigin:null,running:false});expect(f.closes()).toBe(1);expect(f.stopped()).toBe(1);
  expect(await readFile(join(f.directory,'quick-tunnel.lock')).catch(()=>null)).toBeNull();
}));
test('startup timeout and malformed readiness fail closed, and unexpected connector exit closes the workspace',async()=>fixture(async f=>{
  await f.start();f.control().onMessage({type:'ready',publicOrigin:'https://evil.example'});await f.quick.runtime.starting;
  expect(f.quick.status().phase).toBe('failed');expect(f.closes()).toBe(1);
}));
test('quick startup timeout never publishes an address',async()=>fixture(async f=>{
  await f.start();await f.quick.runtime.starting;expect(f.quick.status()).toMatchObject({phase:'failed',publicOrigin:null,running:false});expect(f.closes()).toBe(1);
}));
test('unexpected quick exit disposes origin and permits a new explicit start',async()=>fixture(async f=>{
  await f.start();f.control().onMessage({type:'ready',publicOrigin:URL});await f.quick.runtime.starting;
  f.control().exit();for(let i=0;f.quick.runtime;i++){if(i>100)throw new Error('Not disposed');await Bun.sleep(5);}
  expect(f.quick.status()).toMatchObject({phase:'failed',publicOrigin:null,running:false});expect(f.closes()).toBe(1);
}));
test('failed origin cleanup still stops the connector, retains the lock and allows explicit cleanup retry',async()=>fixture(async f=>{
  await f.start();f.control().onMessage({type:'ready',publicOrigin:URL});await f.quick.runtime.starting;
  const close=f.origin().close;f.origin().close=async()=>{throw new Error('private filesystem detail');};
  await f.quick.stop();expect(f.stopped()).toBe(1);
  expect(f.quick.status()).toMatchObject({phase:'failed',running:true,publicOrigin:null});
  expect(f.quick.status().error).toContain('cleanup');expect(f.quick.status().error).not.toContain('private');
  expect(await readFile(join(f.directory,'quick-tunnel.lock'),'utf8')).toContain(String(process.pid));
  expect(()=>f.quick.start(EMAIL)).toThrow('already');
  f.origin().close=close;await f.quick.stop();expect(f.quick.status()).toMatchObject({phase:'stopped',running:false});
  expect(await readFile(join(f.directory,'quick-tunnel.lock')).catch(()=>null)).toBeNull();
}));
test('supervisor rejects an unprotected connector banner without publishing an address',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'crw-unprotected-test-')),messages=[];let timer;
  try {
    const script=join(directory,'unprotected.cjs');
    await writeFile(script,"console.error('Your quick Tunnel has been created!');console.error('https://fixture-quick.trycloudflare.com');console.error('Registered tunnel connection');setInterval(()=>{},1000);");
    const connector=createQuickConnector({binary:Bun.which('node'),args:[script],directory,env:process.env,onMessage:message=>messages.push(message),onExit:()=>{}});
    await Promise.race([connector.closed,new Promise((_,reject)=>{timer=setTimeout(()=>{connector.stop();reject(new Error('Supervisor did not reject unprotected connector'));},4000);})]);
    expect(messages).toContainEqual({type:'error',code:'protection'});expect(messages.some(message=>message.type==='ready')).toBe(false);
  } finally {clearTimeout(timer);await rm(directory,{recursive:true,force:true});}
});
test('missing cloudflared and versions without email protection give actionable errors',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'crw-preflight-test-'));
  try {
    await expect(quickPreflight({PATH:directory})).rejects.toThrow('Install cloudflared');
    await writeFile(join(directory,'cloudflared'),"#!/bin/sh\nprintf '%s\\n' '--unix-socket'\n",{mode:0o700});
    await expect(quickPreflight({PATH:directory})).rejects.toThrow('Update cloudflared');
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('configuration preflight rejects CLI usage errors even when the binary exits successfully',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'crw-cli-error-test-'));
  try {
    const binary=join(directory,'cloudflared');
    await writeFile(binary,"#!/bin/sh\nprintf '%s\\n' 'Incorrect Usage. flag provided but not defined: -logformat'\nexit 0\n",{mode:0o700});
    await expect(validateQuickConfiguration(binary,[],process.env,directory)).rejects.toThrow('rejected the temporary access configuration');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('supervisor reports only a safe failure category for arguments and TLS errors',async()=>{
  for(const [output,code] of [
    ['Incorrect Usage. flag provided but not defined: -logformat','arguments'],
    [JSON.stringify({message:'failed to request quick Tunnel',error:'x509: certificate signed by unknown authority private-token-value'}),'tls'],
  ]) {
    const directory=await mkdtemp(join(tmpdir(),'crw-diagnostic-test-')),messages=[];let timer;
    try {
      const script=join(directory,'error.cjs');await writeFile(script,`console.error(${JSON.stringify(output)});setInterval(()=>{},1000);`);
      const connector=createQuickConnector({binary:Bun.which('node'),args:[script],directory,env:process.env,onMessage:message=>messages.push(message),onExit:()=>{}});
      await Promise.race([connector.closed,new Promise((_,reject)=>{timer=setTimeout(()=>{connector.stop();reject(new Error('Diagnostic timeout'));},4000);})]);
      expect(messages).toContainEqual({type:'error',code});expect(JSON.stringify(messages)).not.toContain('private-token-value');
    }finally{clearTimeout(timer);await rm(directory,{recursive:true,force:true});}
  }
});
test('stop during preflight cancels safely and prevents late socket or connector creation',async()=>{
  let resolve,opened=false;const ready=new Promise(r=>resolve=r);
  const quick=new QuickTunnel({workspace:async()=>{opened=true;},preflight:()=>ready});
  quick.start(EMAIL);const stopping=quick.stop();resolve('/fixture/cloudflared');await stopping;
  expect(quick.status()).toMatchObject({phase:'stopped',running:false,publicOrigin:null});expect(opened).toBe(false);
});
test('another local process cannot start a second managed temporary tunnel',async()=>fixture(async f=>{
  await f.start();let opened=false;
  const another=new QuickTunnel({directory:f.directory,preflight:async()=>'/fixture/cloudflared',workspace:async()=>{opened=true;}});
  another.start(EMAIL);await another.runtime.starting;expect(another.status().phase).toBe('failed');expect(another.status().error).toContain('another');expect(opened).toBe(false);
  expect(f.quick.status().phase).toBe('starting');
}));
test('Unix-only temporary authentication pins Host/Origin, denies pre-readiness and ignores client identity claims',async()=>{
  const config={publicOrigin:null,allowedEmail:EMAIL},authenticate=quickAuthenticator(config);
  const req={method:'GET',url:'/api/config',headers:{host:'fixture-quick.trycloudflare.com',origin:URL}};
  expect((await authenticate(req)).ok).toBe(false);config.publicOrigin=URL;
  expect((await authenticate(req)).principal.email).toBe(EMAIL);
  for(const headers of [{host:'localhost'},{host:'another.trycloudflare.com'},{origin:'https://evil.example'},{'sec-fetch-site':'cross-site'}])expect((await authenticate({...req,headers:{...req.headers,...headers}})).ok).toBe(false);
  expect((await authenticate({...req,headers:{...req.headers,'cf-access-authenticated-user-email':'attacker@example.com'}})).principal.email).toBe(EMAIL);
});
test('temporary QR code contains no remote image and rejects foreign addresses',()=>{
  const svg=temporaryQr(URL);expect(svg).toContain('<svg');expect(svg).not.toContain('<image');expect(svg).not.toContain('href=');
  expect(()=>temporaryQr('https://evil.example')).toThrow();
});

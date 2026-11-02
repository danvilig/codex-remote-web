import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { remoteAccessStatus } from '../../src/server/services/remote-access.js';

test('runtime Access status uses active configuration and returns only safe identity fields', async () => {
  const config = { mode:'cloudflare-access', publicOrigin:'https://workspace.example.com', teamDomain:'team.cloudflareaccess.com', allowedEmail:'owner@example.com', audience:'private-aud' };
  const result = await remoteAccessStatus(config, '/unused/home', { email:config.allowedEmail, sub:'private-subject', expiresAt:1234, token:'private-jwt' });
  expect(result).toEqual({ configured:true, active:true, mode:config.mode, publicOrigin:config.publicOrigin, teamDomain:config.teamDomain, allowedEmail:config.allowedEmail, identity:{email:config.allowedEmail}, expiresAt:1234 });
});

test('local status restores completed deployments without exposing receipt secrets and distinguishes absent, removed and unreadable state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'crw-status-'));
  const directory = join(home, '.config/codex-remote-web'), path = join(directory, 'setup-state.json');
  try {
    expect(await remoteAccessStatus({mode:'local'},home,null)).toEqual({configured:false});
    await mkdir(directory,{recursive:true});
    const receipt = { phase:'complete', input:{ hostname:'workspace.example.com',email:'owner@example.com' }, teamDomain:'team.cloudflareaccess.com', aud:'private-aud', probe:'private-probe', local:{environment:'private-environment'}, connector:{token:'private-token'} };
    await writeFile(path,JSON.stringify(receipt));
    const result = await remoteAccessStatus({mode:'local'},home,null);
    expect(result).toMatchObject({configured:true,active:false,publicOrigin:'https://workspace.example.com',allowedEmail:'owner@example.com',identity:null});
    expect(JSON.stringify(result)).not.toContain('private-');
    await writeFile(path,JSON.stringify({...receipt,phase:'removed'}));
    expect(await remoteAccessStatus({mode:'local'},home,null)).toEqual({configured:false});
    await writeFile(path,'broken json');
    await expect(remoteAccessStatus({mode:'local'},home,null)).rejects.toThrow();
  } finally { await rm(home,{recursive:true,force:true}); }
});

test('interrupted configuration changes stay visible in local settings and committed changes show the candidate address without secrets', async()=>{
  const home=await mkdtemp(join(tmpdir(),'crw-recovery-status-')),directory=join(home,'.config/codex-remote-web');
  try {
    await mkdir(directory,{recursive:true});
    const previous={phase:'complete',input:{hostname:'old.example.com',email:'old@example.com'},aud:'private-old-aud',teamDomain:'team.cloudflareaccess.com',local:{environment:'private-old-env'}};
    const candidate={...previous,input:{hostname:'new.example.com',email:'new@example.com'},aud:'private-new-aud'};
    const receipt={...previous,phase:'change-recovery-required',configurationChange:{previous,candidate,committed:false}};
    const path=join(directory,'setup-state.json');await writeFile(path,JSON.stringify(receipt));
    let status=await remoteAccessStatus({mode:'local'},home,null);
    expect(status).toMatchObject({configured:true,recoveryRequired:true,publicOrigin:'https://old.example.com'});expect(JSON.stringify(status)).not.toContain('private-');
    receipt.configurationChange.committed=true;await writeFile(path,JSON.stringify(receipt));
    status=await remoteAccessStatus({mode:'local'},home,null);expect(status.publicOrigin).toBe('https://new.example.com');expect(status.allowedEmail).toBe('new@example.com');expect(JSON.stringify(status)).not.toContain('private-');
  }finally{await rm(home,{recursive:true,force:true});}
});

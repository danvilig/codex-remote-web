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

test('desktop browser status reads the private desktop receipt separately from CLI deployment and redacts recovery secrets', async () => {
  const { desktopDirectory } = await import('../../src/shared/desktop-config.js');
  const { writePrivate } = await import('../../src/server/desktop/private-store.js');
  const home = await mkdtemp(join(tmpdir(), 'crw-desktop-status-')), path = join(desktopDirectory(home), 'setup-state.json');
  const read = () => remoteAccessStatus({ mode: 'local' }, home, null, { desktopManaged: true });
  try {
    expect(await read()).toEqual({ configured: false, management: 'desktop' });
    const receipt = { phase: 'complete', input: { hostname: 'desktop.example.com', email: 'owner@example.com' }, teamDomain: 'team.cloudflareaccess.com', aud: 'private-aud', probe: 'private-probe', local: { environment: 'private-env' }, connector: { token: 'private-token' } };
    await writePrivate(path, receipt);
    expect(await remoteAccessStatus({ mode: 'local' }, home, null)).toEqual({ configured: false });
    await writeFile(join(home, '.config/codex-remote-web/setup-state.json'), JSON.stringify({ ...receipt, input: { ...receipt.input, hostname: 'cli.example.com' } }));
    expect((await remoteAccessStatus({ mode: 'local' }, home, null)).publicOrigin).toBe('https://cli.example.com');
    expect(await read()).toMatchObject({ configured: true, management: 'desktop', active: false, publicOrigin: 'https://desktop.example.com' });
    expect(JSON.stringify(await read())).not.toContain('private-');
    const candidate = { ...receipt, input: { ...receipt.input, hostname: 'changed.example.com' } };
    await writePrivate(path, { ...receipt, phase: 'change-recovery-required', configurationChange: { candidate, committed: true } });
    expect(await read()).toMatchObject({ configured: true, recoveryRequired: true, publicOrigin: 'https://changed.example.com', management: 'desktop' });
    expect(JSON.stringify(await read())).not.toContain('private-');
    await writePrivate(path, { ...receipt, phase: 'removed' });
    expect(await read()).toEqual({ configured: false, management: 'desktop' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

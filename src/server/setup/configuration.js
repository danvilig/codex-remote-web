// Durable migration of an existing installation. New hostnames get a separate
// Access app; the old boundary is retained until the new service/route is ready.
import { createHash, randomUUID } from 'node:crypto';
import { hostnameFor } from '../../shared/remote-address.js';
import { SetupError, setupInput, resourceId, matchesHost } from './cloudflare.js';
export const digest = value => {
  const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
};
const clone = value => structuredClone(value);
const conflict = message => { throw new SetupError(message, 409); };
const tunnelPath = receipt => `/accounts/${receipt.input.accountId}/cfd_tunnel/${receipt.input.tunnelId}/configurations`;
const appPath = receipt => `/accounts/${receipt.input.accountId}/access/apps`;
const dnsPath = receipt => `/zones/${receipt.input.zoneId}/dns_records`;
const samePlace = (a, b) => a.input.zoneId === b.input.zoneId && a.input.hostname === b.input.hostname;
const sameTunnel = (a, b) => tunnelPath(a) === tunnelPath(b);
const dnsFields = record => Object.fromEntries(Object.entries(record).filter(([key]) => !['created_on','modified_on','comment_modified_on','tags_modified_on','meta'].includes(key)));
const sameDNS = (a,b) => digest(dnsFields(a)) === digest(dnsFields(b));
const exactHost = (value,hostname) => String(value || '').replace(/^https?:\/\//,'').split('/')[0].toLowerCase() === hostname;
const appOwns = (app, r) => app.id === r.appId && app.name === r.appName && app.domain === r.input.hostname && app.aud === r.aud && (app.destinations || []).every(item=>exactHost(item.uri,r.input.hostname)) && (app.self_hosted_domains || []).every(value=>exactHost(value,r.input.hostname));
const sameApp = (a,b) => {
  const normalized = app => Object.fromEntries(Object.entries(app).filter(([key])=>!['created_at','updated_at'].includes(key)));
  return digest(normalized(a)) === digest(normalized(b));
};
const dnsOwns = (record,r) => record.id === r.dnsId && record.name === r.input.hostname && record.type === 'CNAME' && record.content === `${r.input.tunnelId}.cfargotunnel.com` && record.proxied === true && record.comment === r.appName;
const intersects = (app, host) => matchesHost(app.domain,host) || (app.destinations || []).some(item => matchesHost(item.uri,host));
async function records(s,r) { return s.requireClient().list(`${dnsPath(r)}?name=${encodeURIComponent(r.input.hostname)}`); }
async function policy(s,r) {
  const client=s.requireClient(), apps=await client.list(appPath(r)), app=apps.find(app=>app.id===r.appId);
  if (!app || !appOwns(app,r)) conflict('The managed Access application changed. No update was applied.');
  const policies=await client.list(`${appPath(r)}/${r.appId}/policies`);
  if (policies.length!==1 || !s.sameIdentityPolicy(policies[0],r.policy)) conflict('The Access policy was edited. No update was applied.');
  return policies[0];
}
async function sourceState(s,r) {
  const client=s.requireClient(), currentPolicy=await policy(s,r);
  const [config,dns,app]=await Promise.all([client.result(tunnelPath(r)), records(s,r),client.result(`${appPath(r)}/${r.appId}`)]);
  const routes=config.config.ingress.filter(rule=>rule.hostname===r.input.hostname);
  if(routes.length!==1 || digest(routes[0])!==digest(r.route)) conflict('The managed Tunnel route was edited. No update was applied.');
  if(dns.length!==1 || !dnsOwns(dns[0],r)) conflict('DNS was edited. No update was applied.');
  return {config:config.config,dns:dns[0],policy:currentPolicy,app};
}
function targetAvailable(snapshot,old,next,expectedApp=old) {
  if(snapshot.teamDomain!==old.teamDomain) conflict('The Cloudflare Team Domain changed. Restore it before editing this deployment.');
  if(snapshot.apps.some(app=>!appOwns(app,expectedApp)) || snapshot.dns.some(record=>!samePlace(old,next) || !dnsOwns(record,old))) conflict('This hostname already has an Access app or DNS record. Choose an unused address.');
  const matching=snapshot.config.ingress.filter(rule=>matchesHost(rule.hostname,next.input.hostname));
  if(matching.some(rule=>!sameTunnel(old,next) || digest(rule)!==digest(old.route))) conflict('This hostname conflicts with an existing Tunnel route.');
  if(snapshot.config.ingress.at(-1)?.hostname || snapshot.config.ingress.at(-1)?.path) conflict('The Tunnel must end with a catch-all ingress rule.');
}
export async function previewConfiguration(s,raw) {
  s.lock();s.plan=null;
  if(!raw || typeof raw!=='object' || Array.isArray(raw)) throw new SetupError('Select a valid Cloudflare resource.');
  const old=await s.receipt();
  if(!old || old.phase!=='complete' || old.identityChange || old.configurationChange) conflict('Complete or recover the managed deployment before changing its configuration.');
  if(raw.tunnelMode==='create') conflict('When changing configuration, select an existing Tunnel connected to this machine.');
  if('subdomain' in raw) {
    const zone=await s.requireClient().result(`/zones/${resourceId(raw.zoneId)}`);
    try {raw={...raw,hostname:hostnameFor(raw.subdomain,zone.name)};} catch(error){throw new SetupError(error.message);}
  }
  const input=setupInput({...raw,tunnelMode:'existing'});
  if(input.accountId!==old.input.accountId) conflict('Configuration changes must use the current Cloudflare account.');
  if(['zoneId','tunnelId','hostname','email','port'].every(key=>input[key]===old.input[key])) return {unchanged:true};
  await s.deployment.assertOwned(old);await s.deployment.preflight(input.port,true);
  if(input.port!==old.input.port) await s.deployment.availablePort(input.port);
  const next={input}, source=await sourceState(s,old), snapshot=await s.snapshot(input);
  targetAvailable(snapshot,old,next);
  const id=randomUUID(), changes=[];
  for(const [key,label] of [['hostname','Public hostname'],['zoneId','Domain'],['tunnelId','Existing Tunnel'],['port','Local service port'],['email','Allowed email']]) if(input[key]!==old.input[key]) changes.push({label,before:String(old.input[key]),after:String(input[key])});
  s.plan={id,kind:'configuration',input,source,snapshot,receiptDigest:digest(old),expiresAt:Date.now()+600000};
  return {id,kind:'configuration',hostname:input.hostname,service:`127.0.0.1:${input.port}`,differences:changes,changes:['Restart the protected service and move the managed Cloudflare route. Existing connections and web terminals will disconnect.','Remove the previous hostname resources only after the new protected route is ready. Other resources are preserved.']};
}
async function assertNoOtherApp(s,r) {
  const apps=await s.requireClient().list(appPath(r));
  if(apps.some(app=>app.id!==r.appId && intersects(app,r.input.hostname))) conflict('Another Access application conflicts with the new hostname.');
  await policy(s,r);
}
// Change just the owned route; do not overwrite unrelated rules, even in recovery.
async function setRoute(s,r,replacement,allowed) {
  const client=s.requireClient(), latest=await client.result(tunnelPath(r));
  const matching=latest.config.ingress.filter(rule=>rule.hostname===r.input.hostname);
  if(matching.some(rule=>!allowed.some(value=>digest(value)===digest(rule)))) conflict('The managed Tunnel route was edited. Recovery stopped to preserve it.');
  if(replacement && latest.config.ingress.some(rule=>rule.hostname!==r.input.hostname && matchesHost(rule.hostname,r.input.hostname))) conflict('This hostname conflicts with an existing Tunnel route.');
  const config=clone(latest.config);config.ingress=config.ingress.filter(rule=>rule.hostname!==r.input.hostname);
  if(replacement) config.ingress.unshift(clone(replacement));
  if(digest(config)!==digest(latest.config)) await client.result(tunnelPath(r),'PUT',{config});
  const verified=(await client.result(tunnelPath(r))).config.ingress.filter(rule=>rule.hostname===r.input.hostname);
  if(replacement ? verified.length!==1 || digest(verified[0])!==digest(replacement) : verified.length) conflict('The managed Tunnel route could not be verified.');
}
async function deleteDNS(s,r,expected) {
  const current=await records(s,r), found=current.find(record=>record.id===r.dnsId || record.comment===r.appName);
  if(!found) return;
  if(!dnsOwns(found,{...r,dnsId:found.id}) || (expected && !sameDNS(found,expected))) conflict('DNS was edited. Recovery stopped to preserve it.');
  await s.requireClient().result(`${dnsPath(r)}/${found.id}`,'DELETE');
}
async function deleteApp(s,r,expected=r.appSnapshot) {
  const apps=await s.requireClient().list(appPath(r)), listed=apps.find(app=>app.id===r.appId || app.name===r.appName);
  if(!listed) return;
  const app=await s.requireClient().result(`${appPath(r)}/${listed.id}`);
  if(expected && !sameApp(app,expected)) conflict('The managed Access application was edited. Recovery stopped to preserve it.');
  const owned={...r,appId:r.appId||app.id,aud:r.aud||app.aud};
  if(!appOwns(app,owned)) conflict('The managed Access application was edited. Recovery stopped to preserve it.');
  // A lost create response has no policy receipt yet. Verify the exact owner rule.
  const policies=await s.requireClient().list(`${appPath(r)}/${app.id}/policies`);
  if(policies.length!==1 || (r.policy ? !s.sameIdentityPolicy(policies[0],r.policy) : policies[0].decision!=='allow' || digest(policies[0].include)!==digest([{email:{email:r.input.email}}]) || policies[0].exclude?.length || policies[0].require?.length)) conflict('The Access policy was edited. Recovery stopped to preserve it.');
  await s.requireClient().result(`${appPath(r)}/${app.id}`,'DELETE');
}
async function updatePolicy(s,r,previous,next) {
  if(!appOwns(await s.requireClient().result(`${appPath(r)}/${r.appId}`),r)) conflict('The managed Access application changed. No update was applied.');
  const current=await s.requireClient().list(`${appPath(r)}/${r.appId}/policies`);
  if(current.length!==1 || ![previous,next].some(value=>s.sameIdentityPolicy(current[0],value))) conflict('The Access policy was edited. Recovery stopped to preserve it.');
  if(!s.sameIdentityPolicy(current[0],next)) await s.requireClient().result(`${appPath(r)}/${r.appId}/policies/${resourceId(current[0].id)}`,'PUT',s.policyPayload(next));
  const verified=await s.requireClient().list(`${appPath(r)}/${r.appId}/policies`);
  if(verified.length!==1 || !s.sameIdentityPolicy(verified[0],next)) conflict('The updated Access policy could not be verified.');
  return verified[0];
}
async function finish(s,receipt) {
  const {previous:old,candidate:next,source}=receipt.configurationChange;
  await s.deployment.assertOwned(next);await policy(s,next);
  // Ensure the target still exists before removing the previous boundary.
  const snapshot=await s.snapshot(next.input);
  if(snapshot.apps.length!==1 || !appOwns(snapshot.apps[0],next) || snapshot.dns.length!==1 || !dnsOwns(snapshot.dns[0],next) || !snapshot.config.ingress.some(rule=>digest(rule)===digest(next.route))) conflict('The new deployment changed. Recovery stopped before removing previous resources.');
  if(!sameTunnel(old,next) || old.input.hostname!==next.input.hostname) await setRoute(s,old,null,[old.route]);
  if(!samePlace(old,next)) await deleteDNS(s,old,source.dns);
  if(old.appId!==next.appId) await deleteApp(s,old,source.app);
  Object.keys(receipt).forEach(key=>delete receipt[key]);Object.assign(receipt,clone(next),{phase:'complete'});await s.save(receipt);
}
export async function restoreConfiguration(s,receipt) {
  const change=receipt?.configurationChange;
  if(!change) conflict('No configuration change needs recovery.');
  if(change.committed) {await finish(s,receipt);return;}
  const {previous:old,candidate:next,source}=change, client=s.requireClient(), persist=()=>s.save(receipt);
  // Inspect local ownership before touching provider resources during recovery.
  await s.deployment.assertOwned(next,[old.local.environment]);
  if(change.routeIntent) {
    if(sameTunnel(old,next) && old.input.hostname===next.input.hostname) await setRoute(s,old,old.route,[old.route,next.route]);
    else await setRoute(s,next,null,[next.route]);
  }
  if(change.dnsIntent) {
    if(samePlace(old,next)) {
      const current=await records(s,old), record=current.find(item=>item.id===old.dnsId);
      const patched={...source.dns,content:`${next.input.tunnelId}.cfargotunnel.com`};
      if(current.length!==1 || !record || ![source.dns,patched].some(expected=>sameDNS(record,expected))) conflict('DNS was edited. Recovery stopped to preserve it.');
      if(!sameDNS(record,source.dns)) await client.result(`${dnsPath(old)}/${old.dnsId}`,'PATCH',{content:source.dns.content});
      const restored=await records(s,old);if(restored.length!==1 || !sameDNS(restored[0],source.dns)) conflict('The previous DNS record could not be verified.');
    } else await deleteDNS(s,next);
  }
  if(change.policyIntent) await updatePolicy(s,old,next.policy,old.policy);
  if(change.nativeIntent) await s.deployment.restoreConfiguration(old,next,persist);
  if(change.appIntent) await deleteApp(s,next);
  Object.keys(receipt).forEach(key=>delete receipt[key]);Object.assign(receipt,clone(old),{phase:'complete'});await s.save(receipt);
}
export async function changeConfiguration(s,plan) {
  const receipt=await s.receipt();
  if(!receipt || digest(receipt)!==plan.receiptDigest) conflict('The deployment changed. Preview the change again.');
  await s.deployment.assertOwned(receipt);await s.deployment.preflight(plan.input.port,true);
  if(plan.input.port!==receipt.input.port) await s.deployment.availablePort(plan.input.port);
  const source=await sourceState(s,receipt), snapshot=await s.snapshot(plan.input);
  targetAvailable(snapshot,receipt,{input:plan.input});
  if(digest(source)!==digest(plan.source) || digest(snapshot)!==digest(plan.snapshot)) conflict('Cloudflare configuration changed since the preview. Refresh the preview.');
  const old=clone(receipt), next=clone(receipt), client=s.requireClient();
  next.input=clone(plan.input);next.sourceInput=clone(plan.input);
  // Keep provenance for the original dedicated connector when selecting another Tunnel.
  if(old.createdTunnel) next.createdTunnelId=old.createdTunnelId||old.input.tunnelId;
  const newHost=old.input.hostname!==next.input.hostname;
  if(newHost) {next.appName=`Codex Remote Web ${randomUUID()}`;next.appId=null;next.aud=null;next.policy=null;next.dnsId=null;delete next.appSnapshot;}
  receipt.phase='updating';receipt.configurationChange={previous:old,candidate:next,source};
  const change=receipt.configurationChange,persist=()=>s.save(receipt);await persist();
  try {
    if(newHost) {
      change.appIntent=true;await persist();
      const app=await client.result(appPath(next),'POST',{name:next.appName,type:'self_hosted',domain:next.input.hostname,session_duration:'1h',app_launcher_visible:false,policies:[{name:'Workspace owner',decision:'allow',precedence:1,include:[{email:{email:next.input.email}}]}]});
      next.appId=app.id;next.aud=app.aud;await persist();
      if(!next.appId || typeof next.aud!=='string' || !next.aud) conflict('Cloudflare did not return the Access audience.');
      const policies=await client.list(`${appPath(next)}/${next.appId}/policies`);
      if(policies.length!==1 || policies[0].decision!=='allow' || digest(policies[0].include)!==digest([{email:{email:next.input.email}}]) || policies[0].exclude?.length || policies[0].require?.length) conflict('The Access policy does not match the selected single identity.');
      next.policy=policies[0];next.appSnapshot=await client.result(`${appPath(next)}/${next.appId}`);await persist();
    } else if(next.input.email!==old.input.email) {
      next.policy={...clone(old.policy),include:[{email:{email:next.input.email}}]};change.policyIntent=true;await persist();
      next.policy=await updatePolicy(s,old,old.policy,next.policy);next.appSnapshot=await client.result(`${appPath(next)}/${next.appId}`);await persist();
    }
    next.route={hostname:next.input.hostname,service:`http://127.0.0.1:${next.input.port}`,originRequest:{httpHostHeader:next.input.hostname,access:{required:true,teamName:next.teamDomain.split('.')[0],audTag:[next.aud]}}};
    change.nativeIntent=true;await persist();await s.deployment.reconfigure(old,next,persist);s.step('Protected service configuration updated');
    await assertNoOtherApp(s,next);
    // Recheck connector health/location immediately before exposing the route.
    const latest=await s.snapshot(next.input);targetAvailable(latest,old,next,next);
    change.routeIntent=true;await persist();
    await setRoute(s,next,next.route,sameTunnel(old,next) && old.input.hostname===next.input.hostname ? [old.route] : []);
    s.step('Protected Tunnel route updated');
    change.dnsIntent=true;await persist();
    if(samePlace(old,next)) {
      const current=await records(s,old);if(current.length!==1 || !sameDNS(current[0],source.dns)) conflict('DNS changed during the update.');
      if(old.input.tunnelId!==next.input.tunnelId) await client.result(`${dnsPath(old)}/${old.dnsId}`,'PATCH',{content:`${next.input.tunnelId}.cfargotunnel.com`});
    } else {
      if((await records(s,next)).length) conflict('DNS changed during the update.');
      const dns=await client.result(dnsPath(next),'POST',{type:'CNAME',name:next.input.hostname,content:`${next.input.tunnelId}.cfargotunnel.com`,proxied:true,ttl:1,comment:next.appName});next.dnsId=dns.id;await persist();
    }
    const verified=await records(s,next);
    // A reused DNS record keeps its original ownership comment.
    if(!newHost) next.appName=old.appName;
    if(verified.length!==1 || !dnsOwns(verified[0],next)) conflict('The new DNS record could not be verified.');
    change.committed=true;await persist();await finish(s,receipt);s.step('Cloudflare configuration updated');
    s.progress.phase='complete';s.progress.hostname=next.input.hostname;s.progress.verification=await s.publicCheck(next.input.hostname,next.teamDomain);
  } catch(error) {
    if(receipt.configurationChange) {
      try {
        await restoreConfiguration(s,receipt);s.step(change.committed?'Configuration recovery completed':'Previous configuration restored');
        if(change.committed) {s.progress.phase='complete';s.progress.hostname=next.input.hostname;s.progress.verification='pending';return;}
      }
      catch {receipt.phase='change-recovery-required';await persist();}
    }
    throw error;
  }
}

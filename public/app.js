import { createComposerTools } from './composer-tools.js';
import { createFileExplorer } from './file-explorer.js';
import { installPanelSizing } from './panel-sizing.js';
import { createSideChat } from './side-chat.js';
import { createRuntimeProgress, createConversationLoading } from './conversation-progress.js';
import { createTurnPresentation } from './turn-presentation.js';
import { createComposerAttachments, attachmentThumbnail } from './composer-attachments.js';
import { createComposerProjects } from './composer-projects.js';
import { createServerComposerDelivery } from './composer-delivery.js';
import { permissionModes, normalizePermissionProfiles, threadPolicyFor, turnPolicyFor, renderReasoningMenu, renderModelOptions, renderPermissionOptions } from './composer-controls.js';
import { installThemedSelects } from './themed-select.js';
import { createSidePanelTabs } from './side-panel-tabs.js';
import { createComposerDrafts, mergeComposerDrafts } from './composer-drafts.js';
import { installDrawerDismiss } from './drawer-gesture.js';
import { mountRemoteAccess } from './remote-access.js';
import { createWorkspaceMenu } from './workspace-menu.js';
import { createWorkspaceChrome } from './workspace-chrome.js';
import { createWorkspaceSettings } from './workspace-settings.js';
import { createWorkspaceNavigation } from './workspace-navigation.js';
import { DEFAULT_TURN_PAGE_SIZE, applyComposerSuggestion, createLatestRequestGate, createTurnWindow, filterAppModels, getComposerAutocomplete, resolveComposerPlaceholder, selectModelState } from './ui-core.js';
import { agentMessageText, renderAssistantMarkdown, renderItemImages } from './rendering.js';
import { codexIcon, hydrateCodexIcons } from './codex-icons.js';
import { codexInterfaceMark } from './codex-brand.js';
import { createDomI18n, createI18n } from './i18n.js';
import { buildApprovalModel, createReviewPreferences, parseUnifiedDiff, permissionRows, splitDiffHunk, summarizeActivity, unifiedDiffFromFileChanges } from '../src/shared/codex-surfaces.js';
import { browserSandboxFor, normalizeBrowserUrl } from './browser-panel.js';
import { THREAD_NOT_FOUND, bridgeErrorCode, createBridgeError, threadInputErrorMessage } from '../src/shared/bridge-errors.js';
import { collaborationMode, isForeignConversationEvent, notificationApi } from './conversation-policy.js';
import { createUserInputCard } from './user-input.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
globalThis.__renderAssistantMarkdown = renderAssistantMarkdown;
const $ = (s) => document.querySelector(s);
const i18n=globalThis.__codexWebuiI18n||createI18n();
globalThis.__codexWebuiI18n=i18n;
globalThis.__codexWebuiDomI18n=globalThis.__codexWebuiDomI18n||createDomI18n(i18n);
const t=(message,values)=>i18n.t(message,values);
const remoteAccessWizard = mountRemoteAccess(document.querySelector('#remoteAccessSetup'), { t });
addEventListener('codex-webui:remote-access', () => remoteAccessWizard.open());
addEventListener('codex-webui:remote-access-close', () => remoteAccessWizard.close());
document.querySelector('#settingsDialog').addEventListener('close', () => remoteAccessWizard.close());
const workspaceMenu = createWorkspaceMenu({ t, codexIcon });
const themedSelects = installThemedSelects({ t, icon: codexIcon });
const state = { ws:null, events:null, transport:'connecting', wsFallbackTimer:null, rpcId:1, pending:new Map(), threads:[], active:null, models:[], selectedModel:'', workspaceContext:null, projectless:false, composerMode:'local', planMode:false, permissionMode:localStorage.getItem('codex-webui-permission-mode')||'default', permissionProfiles:[], permissionVisibility:{autoReview:true,fullAccess:localStorage.getItem('codex-webui-permission-full-access')!=='false'}, goalMode:false, backgroundAgentsVisible:false, cloudStartingState:null, placeholderText:null, composerMentions:[], turnWindow:null, tokenUsage:new Map(), items:new Map(), turns:new Map(), activities:new Map(), activityItems:new Map(), sideTasks:new Map(), dividers:new Map(), changes:new Map(), requestCards:new Map(), serverRequests:new Map(), motion:new Map(), turnDiffs:new Map(), activeReview:null, account:null, connected:false, config:{home:'',defaultCwd:'',projectless:false} };
const runtimeProgress=createRuntimeProgress({state,t,icon:codexIcon,ensureTurn:ensureTurnTimeline,authRequired:()=>Boolean(globalThis.__codexWebuiAccessSession?.required),isLoading:()=>Boolean(conversationLoad)});
let conversationLoad=null;
let folderBrowse={path:'~',parent:null,selected:null};
const reviewPreferences=(()=>{try{return createReviewPreferences(JSON.parse(localStorage.getItem('codex-webui-review-preferences')||'{}'))}catch{return createReviewPreferences({})}})();
const composerDrafts=createComposerDrafts(()=>sessionStorage);
let composerDraftKey=null,composerSubmission=null,composerDelivery=null;
const threadDraftKey=id=>`thread:${id}`;
function currentDraftKey(){return state.active?.id?threadDraftKey(state.active.id):`new:${state.projectless?'~':state.workspaceContext?.cwd||state.config.defaultCwd}`}
function saveComposerDraft(){if(composerDraftKey)composerDrafts.set(composerDraftKey,{text:$('#prompt').value,mentions:state.composerMentions})}
function restoreComposerDraft(key=currentDraftKey()){composerDraftKey=key;const draft=composerDrafts.get(key);$('#prompt').value=draft.text;state.composerMentions=draft.mentions;renderContextTray();resizePrompt()}
function switchNewTaskDraft(){if(!state.active){const next=currentDraftKey();if(next!==composerDraftKey){saveComposerDraft();restoreComposerDraft(next)}}}
let reviewPatchState='undo';
let sidePanelReturnFocus=null,summaryPanelReturnFocus=null,imageViewerReturnFocus=null;
let bottomPanelLastView=null;
let sidebarLayoutMobile=null;
let pendingFullAccessAction='select';
const createTerminalState=(hostId,panelId)=>({hostId,panelId,term:null,fit:null,ws:null,resizeObserver:null,reconnectTimer:null});
const terminalStates={bottom:createTerminalState('terminalHost','bottomPanel'),side:createTerminalState('sideTerminalHost','sidePanel')};
const browserState={history:[],index:-1,loadTimer:null,loadRequest:0};
const sidePanelTabs=createSidePanelTabs({container:$('.side-panel-tabs'),t,icon:codexIcon,onSelect:view=>setSidePanelView(view),onClose:closeSidePanelTool,onEmpty:()=>setSidePanelOpen(false)});
const accountRequestGate=createLatestRequestGate();
const workspaceContextRequestGate=createLatestRequestGate();
const permissionProfileRequestGate=createLatestRequestGate();
const threadNavigationRequestGate=createLatestRequestGate();
const autocompleteState={match:null,items:[],selected:0,requestId:0,message:''};
const ACTIVE_THREAD_STORAGE_KEY='codex-webui-active-thread';
const ACTIVE_THREAD_SYNC_ACTIVE_MS=800,ACTIVE_THREAD_SYNC_IDLE_MS=2400,THREAD_LIST_POLL_MS=3000;
let activeThreadSyncTimer=null,activeThreadSyncGeneration=0,activeThreadSyncInFlight=false,activeThreadSyncSignature='',threadListTimer=null,threadListInFlight=false,threadListSignature='';

const icons = {
  chevron:codexIcon('chevronRight','activity-chevron'),
  terminal:codexIcon('terminal'),
  file:codexIcon('file'),
  search:codexIcon('search'),
  tool:codexIcon('wrench'),
  check:codexIcon('check'),
};
hydrateCodexIcons();
$('#emptyCodexMark').innerHTML=codexInterfaceMark('empty-codex-mark');

const WS_CONNECT_TIMEOUT_MS=5000;
const accessSession = globalThis.__codexWebuiAccessSession;
if (accessSession?.status.identity?.email) { const label = $('#accessIdentity'); label.hidden = false; label.textContent = `${accessSession.status.mode==='quick-tunnel'?t('Email verification'):'Cloudflare Access'} · ${accessSession.status.identity.email}`; }
function suspendTransports() {
  clearTimeout(quickReconnectTimer);clearWsFallbackTimer(); clearTimeout(threadListTimer); resetActiveThreadSync();
  if (state.ws) { state.ws.onopen=state.ws.onmessage=state.ws.onerror=state.ws.onclose=null; state.ws.close(); state.ws=null; }
  state.events?.close(); state.events=null; state.connected=false; state.transport='connecting'; rejectWebSocketPending();runtimeProgress.refresh();
  for (const terminal of Object.values(terminalStates)) { clearTimeout(terminal.reconnectTimer); if(terminal.ws){terminal.ws.onclose=null;terminal.ws.close();terminal.ws=null;} }
}
addEventListener('codex-webui:auth-required', () => { suspendTransports(); queueMicrotask(()=>accessSession?.preserveDraft()); });
let quickReconnectTimer=null;
async function renewAccessTransport() { suspendTransports(); if (!await accessSession?.check()) connect(); }
function transportSwitchError(){const error=new Error('Bridge transport changed');error.silentTransportSwitch=true;return error}
function clearWsFallbackTimer(){clearTimeout(state.wsFallbackTimer);state.wsFallbackTimer=null}
function rejectWebSocketPending(){for(const pending of state.pending.values())pending.reject(transportSwitchError());state.pending.clear()}
async function postBridge(path,payload,options={}){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),cache:'no-store',signal:options.signal}),data=await response.json().catch(()=>({}));if(!response.ok)throw createBridgeError(data.error||'Codex bridge request failed',data.code);return data}
function connectSse(){
  if(accessSession?.required||state.events)return;
  state.transport='sse';state.connected=false;setStatus('connecting','Connecting to Codex');
  const events=new EventSource('/api/events');state.events=events;
  events.onmessage=event=>{try{handle(JSON.parse(event.data))}catch{}};
  events.onerror=async()=>{if(await accessSession?.check())return;if(state.events===events){state.connected=false;setStatus('connecting','Connecting to Codex')}};
}
function fallbackToSse(ws){
  if(accessSession?.required||state.transport==='sse'||(ws&&state.ws!==ws))return;
  clearWsFallbackTimer();rejectWebSocketPending();state.connected=false;
  if(ws){ws.onopen=ws.onmessage=ws.onerror=ws.onclose=null;try{ws.close()}catch{}}
  state.ws=null;
  if(accessSession?.status.transports?.sse===false){
    state.transport='connecting';setStatus('connecting',t('WebSocket disconnected. Retrying temporary access…'));
    clearTimeout(quickReconnectTimer);quickReconnectTimer=setTimeout(async()=>{if(!await accessSession.check())connect();},2500);return;
  }
  connectSse();
}
function connect(){
  if(accessSession?.required||state.transport==='sse'||state.ws)return;
  const proto=location.protocol==='https:'?'wss:':'ws:';
  let ws;
  try{ws=new WebSocket(`${proto}//${location.host}/ws`)}catch{fallbackToSse();return}
  state.transport='ws';state.ws=ws;
  const fallback=async()=>{if(!await accessSession?.check())fallbackToSse(ws)};
  state.wsFallbackTimer=setTimeout(fallback,WS_CONNECT_TIMEOUT_MS);
  ws.onopen=()=>{if(state.ws===ws)setStatus('connecting','Connecting to Codex')};
  ws.onmessage=(event)=>{if(state.ws!==ws)return;try{const message=JSON.parse(event.data);clearWsFallbackTimer();handle(message)}catch{fallback()}};
  ws.onerror=fallback;ws.onclose=fallback;
}
function rpc(method,params={},options={}){
  if(accessSession?.required)return Promise.reject(Object.assign(new Error('Authentication required'),{code:'AUTH_REQUIRED'}));
  const id=state.rpcId++;
  if(state.transport==='sse')return postBridge('/api/rpc',{id,method,params},{signal:options.timeoutMs?AbortSignal.timeout(options.timeoutMs):undefined}).then(message=>{if(message.type!=='rpc/result')throw createBridgeError(message.error||'Codex bridge request failed',message.code);return message.result});
  if(state.ws?.readyState===WebSocket.OPEN){try{state.ws.send(JSON.stringify({type:'rpc',id,method,params}));return new Promise((resolve,reject)=>{let timer;const finish=callback=>value=>{clearTimeout(timer);callback(value)};state.pending.set(id,{resolve:finish(resolve),reject:finish(reject)});if(options.timeoutMs)timer=setTimeout(()=>{state.pending.delete(id);reject(new Error('Conversation read timed out'))},options.timeoutMs)})}catch{fallbackToSse(state.ws);return Promise.reject(transportSwitchError())}}
  return Promise.reject(transportSwitchError());
}
function respondToCodex(requestId,result,error,requestEpoch=state.serverRequests.get(requestId)?.requestEpoch){
  return postBridge('/api/codex/respond',{requestId,result,error,requestEpoch});
}
function handle(message){
  if(message.type==='delivery/changed'||message.type==='submission/changed'){composerDelivery?.notification();if(message.type==='submission/changed'&&message.receipt?.status==='accepted'&&message.receipt?.threadId===state.active?.id)scheduleActiveThreadSync(0);return;}
  if(message.type==='auth/required'||message.type==='bridge/reconnect'){void renewAccessTransport();return;}
  if(message.type==='bridge/status'){
    if(message.status==='connected'){const shouldLoad=!state.connected;state.connected=true;setStatus('connected','Codex connected');dispatchEvent(new Event('codex-webui:bridge-connected'));if(shouldLoad){loadInitial().then(syncPendingRequests).then(()=>{composerDelivery?.sync();accessSession?.restoreDraft(state)})}}
    else{state.connected=false;invalidatePendingApprovals();setStatus('connecting','Connecting to Codex')}
    return;
  }
  if(message.type==='rpc/result'||message.type==='rpc/error'){
    const p=state.pending.get(message.id);if(!p)return;state.pending.delete(message.id);
    message.type==='rpc/result'?p.resolve(message.result):p.reject(createBridgeError(message.error,message.code));return;
  }
  if(message.type==='codex/notification') onNotification(message.payload.method,message.payload.params||{});
  if(message.type==='codex/request') onServerRequest(message.payload);
}
function setStatus(kind,text){
  $('#statusDot').className='status-dot'+(kind==='connected'?' connected':kind==='error'?' error':'');
  $('#statusText').textContent=t(text||kind);
  runtimeProgress.refresh();
}
async function loadInitial(refreshAccount=false){
  loadAccount(refreshAccount);
  try{const [models,threads,profiles]=await Promise.all([rpc('model/list',{limit:50}),rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc'}),rpc('permissionProfile/list',{cwd:permissionProfileCwd(),limit:100}).catch(()=>({data:[]}))]);
    state.models=filterAppModels(models.data||[]);renderModels();applyThreadSummaries(threads.data||[]);setPermissionProfiles(profiles.data||[]);scheduleThreadListRefresh();const rememberedThread=localStorage.getItem(ACTIVE_THREAD_STORAGE_KEY);if(!state.active&&rememberedThread)await openThread(rememberedThread);
  }catch(e){if(!e?.silentTransportSwitch)toast(e.message);}
}
async function loadAccount(refresh=false){
  const requestId=accountRequestGate.next();
  try{const response=await fetch(`/api/account${refresh?'?refresh=1':''}`,{cache:'no-store'}),account=await response.json();if(!response.ok)throw new Error(account.error||'Cannot load account');if(!accountRequestGate.isCurrent(requestId))return;state.account=account;renderAccount(account)}catch{if(accountRequestGate.isCurrent(requestId))renderAccount({displayName:null,avatarUrl:null,planType:null,initials:'?'})}
}
function renderAccount(account){
  state.account=account;
  const type=account?.type||'unknown',displayName=type==='unknown'?t('Local account'):account?.displayName?.trim()||t('Local account'),initials=type==='unknown'?'C':account?.initials?.trim()||'C',plan=account?.planType?`${account.planType.charAt(0).toUpperCase()}${account.planType.slice(1)} plan`:type==='apiKey'?t('API key mode'):type==='amazonBedrock'?'Amazon Bedrock':'';
  const profileMenuAvailable=type==='chatgpt';
  $('#accountFooterRow').hidden=false;
  $('#accountName').textContent=displayName;$('#accountMenuName').textContent=displayName;$('#settingsAccountName').textContent=displayName;$('#accountFooterMeta').textContent='';$('#accountMenuSubtitle').textContent=plan;$('#settingsAccountMeta').textContent=plan||t('Codex account');
  $('#accountButton').setAttribute('aria-label','Open profile menu');
  const accessEmail=globalThis.__codexWebuiAccessIdentity?.email;
  const avatarUrl=profileMenuAvailable&&typeof account?.avatarUrl==='string'&&account.avatarUrl.startsWith('/api/account/avatar')?account.avatarUrl:'',profileAvatars=[$('#accountMenuAvatar'),$('#settingsAccountAvatar')],footerAvatar=$('#accountAvatar'),profileAvatarClass=avatar=>`account-avatar${avatar.id==='accountMenuAvatar'?' account-menu-avatar':''}`;for(const avatar of profileAvatars){avatar.dataset.imageUrl=avatarUrl;avatar.className=`${profileAvatarClass(avatar)} account-initials`;avatar.textContent=initials}
  if(profileMenuAvailable){footerAvatar.dataset.imageUrl=avatarUrl;footerAvatar.className='account-avatar account-initials';footerAvatar.textContent=initials;profileAvatars.unshift(footerAvatar)}else{footerAvatar.dataset.imageUrl='';footerAvatar.className='account-avatar account-initials';footerAvatar.textContent=initials}
  if(avatarUrl){const image=new Image;image.alt='';image.src=`${avatarUrl}?v=${Date.now()}`;image.onload=()=>{for(const avatar of profileAvatars){if(avatar.dataset.imageUrl!==avatarUrl)continue;avatar.className=profileAvatarClass(avatar);avatar.replaceChildren(image.cloneNode())}};image.onerror=()=>{for(const avatar of profileAvatars){if(avatar.dataset.imageUrl!==avatarUrl)continue;avatar.className=`${profileAvatarClass(avatar)} account-initials`;avatar.textContent=initials}}}
  if(accessEmail){footerAvatar.dataset.imageUrl='';footerAvatar.className='account-avatar account-initials';footerAvatar.textContent=Array.from(accessEmail.trim())[0]?.toLocaleUpperCase()||'?';$('#accountName').textContent=accessEmail;$('#accountButton').title=accessEmail;$('#accountMenuName').textContent=accessEmail;$('#accountMenuSubtitle').textContent=t('Access identity');}
  if(!profileMenuAvailable)toggleAccountMenu(false);
  const apiMode=!profileMenuAvailable;$('#accountProfile').hidden=apiMode;$('#accountUsage').hidden=true;$('#accountLogout').hidden=apiMode;
  const accountSettingsPage=$('[data-settings-page="profile"]');if(accountSettingsPage){accountSettingsPage.dataset.settingsAvailable=String(!apiMode);if(apiMode&&accountSettingsPage.classList.contains('active'))setSettingsPage('general-settings');filterSettingsNavigation($('#settingsSearch')?.value||'')}
  syncPermissionSettings();syncPermissionControl();
}
function toggleAccountMenu(force){const menu=$('#accountMenu'),open=force??menu.hidden;menu.hidden=!open;$('#accountButton').setAttribute('aria-expanded',String(open))}
const { openSettings, returnToWorkspace, closeSettings, showSettings, setSettingsPage, settingsRoutePage, filterSettingsNavigation, sendKey } = createWorkspaceSettings({
  rpc, onThreadsChanged: loadInitial, useConfigPermissions: () => setPermissionMode('config'),
  chooseModel, chooseEffort, getReviewPreferences: () => reviewPreferences, setReviewPreferences: values => { Object.assign(reviewPreferences, values); saveReviewPreferences(); renderChanges(); }, chooseProject: openFolderPicker,
  $, state, t, reasoningLabel: value => reasoningLabel(value || $('#effortSelect').value), selectedPermission, syncPermissionSettings, toggleAccountMenu, onOpen: () => { workspaceMenu.close(); workspaceChrome.closeFeature(); if(mobileSidebarEnabled())setSidebarOpen(false) },
});

const reasoningLabels={none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra High',max:'Max',ultra:'Ultra'};
function reasoningLabel(value){return t(reasoningLabels[value]||String(value||'Medium'))}
function modelDisplay(model,stripPrefix=false){const value=String(model?.displayName||model?.model||state.selectedModel||'Select model').trim();if(!stripPrefix)return value;return value.replace(/^GPT-/i,'').trim()||value}
function selectedModel(){return state.models.find(x=>x.model===state.selectedModel)}
function renderModels(){
  const saved=localStorage.getItem('codex-webui-model'),selection=selectModelState(state.models,saved);state.selectedModel=selection.model;
  updateEfforts(selection.effort);syncModelLabel();renderModelMenuMain();
}
function chooseModel(model,keepOpen=false){const previous=$('#effortSelect').value;state.selectedModel=model;localStorage.setItem('codex-webui-model',model);updateEfforts(previous);syncModelLabel();if(keepOpen)renderModelMenuMain();else closeModelMenu();toast(`Model: ${modelDisplay(selectedModel())}`)}
function syncModelLabel(){const model=selectedModel();$('#modelLabel').textContent=modelDisplay(model,true);$('#effortLabel').textContent=reasoningLabel($('#effortSelect').value);dispatchEvent(new Event('codex-webui:preferences'))}
function updateEfforts(preferred){
  const model=selectedModel(),effort=$('#effortSelect');effort.innerHTML='';
  const supported=model?.supportedReasoningEfforts||[{reasoningEffort:'medium'}],values=supported.map(item=>item.reasoningEffort).filter(Boolean),saved=localStorage.getItem(`codex-webui-effort:${state.selectedModel}`),selected=[saved,preferred,model?.defaultReasoningEffort,values[0],'medium'].find(value=>values.includes(value))||'medium';
  for(const value of values.length?values:['medium']){const option=document.createElement('option');option.value=value;option.textContent=value;option.selected=value===selected;effort.append(option)}
  $('#effortLabel').textContent=reasoningLabel(effort.value);
}
function contextUsageValue(tokenUsage){const contextWindow=Number(tokenUsage?.modelContextWindow),totalTokens=Number(tokenUsage?.last?.totalTokens);if(!Number.isFinite(contextWindow)||contextWindow<=0||!Number.isFinite(totalTokens)||totalTokens<0)return null;const usedTokens=Math.min(totalTokens,contextWindow),percent=usedTokens/contextWindow*100;return Number.isFinite(percent)?{percent,usedTokens,contextWindow,remainingTokens:Math.max(contextWindow-usedTokens,0)}:null}
function renderContextUsage(){const indicator=$('#contextUsage'),usage=state.active?.id?contextUsageValue(state.tokenUsage.get(state.active.id)):null;if(!indicator)return;if(!usage){indicator.hidden=true;indicator.removeAttribute('data-tooltip');return}const percent=Math.max(0,Math.min(usage.percent,100)),rounded=Math.round(percent),remaining=Math.max(0,100-rounded),usedThousands=Math.round(usage.usedTokens/1000),windowThousands=Math.round(usage.contextWindow/1000),status=rounded>=50?`${rounded}% full`:`${rounded}% used (${remaining}% left)`;indicator.hidden=false;indicator.style.setProperty('--context-percent',String(percent));indicator.setAttribute('aria-label',`Context usage: ${rounded}%`);indicator.dataset.tooltip=`Context window:\n${status}\n${usedThousands}k / ${windowThousands}k tokens used`}
function renderModelMenuMain(){
  const menu=$('#modelMenu'),effort=$('#effortSelect');
  renderReasoningMenu({menu,modelName:modelDisplay(selectedModel(),true),effort:effort.value,values:[...effort.options].map(option=>option.value),reasoningLabel,t,icon:codexIcon,onEffort:value=>chooseEffort(value,true),onReset:()=>{const defaults=selectModelState(state.models);localStorage.removeItem('codex-webui-model');localStorage.removeItem(`codex-webui-effort:${defaults.model}`);state.selectedModel=defaults.model;updateEfforts(defaults.effort);syncModelLabel();renderModelMenuMain();menu.querySelector('#effortSlider')?.focus()},onModels:()=>{renderModelSubmenu();menu.querySelector('[aria-checked=true]')?.focus()}});
}
function renderModelSubmenu(){renderModelOptions({menu:$('#modelMenu'),models:state.models,selected:state.selectedModel,t,icon:codexIcon,display:modelDisplay,onSelect:model=>chooseModel(model),onBack:renderModelMenuMain})}
function chooseEffort(value,keepOpen=false){const effort=$('#effortSelect');if(![...effort.options].some(option=>option.value===value))return;effort.value=value;$('#effortLabel').textContent=reasoningLabel(value);localStorage.setItem(`codex-webui-effort:${state.selectedModel}`,value);if(!keepOpen)closeModelMenu();dispatchEvent(new Event('codex-webui:preferences'));if(!keepOpen)toast(`Reasoning: ${reasoningLabel(value)}`)}
function openModelMenu(view='main'){if(view==='models')renderModelSubmenu();else renderModelMenuMain();$('#modelMenu').hidden=false;$('#modelButton').setAttribute('aria-expanded','true');requestAnimationFrame(()=>$('#effortSlider')?.focus())}
function toggleModelMenu(){const menu=$('#modelMenu');if(menu.hidden)openModelMenu();else closeModelMenu()}
function closeModelMenu(){const menu=$('#modelMenu'),restoreFocus=menu.contains(document.activeElement);menu.hidden=true;if(restoreFocus)$('#modelButton').focus();$('#modelButton').setAttribute('aria-expanded','false')}
const PERMISSION_PROFILE_PREFIX='profile:';
function permissionProfileCwd(){if(state.projectless)return null;const path=state.active?.cwd||state.workspaceContext?.cwd||localStorage.getItem('codex-webui-project')||state.config.defaultCwd||null;return typeof path==='string'&&path.startsWith('~')?state.config.home+path.slice(1):path}
function permissionProfileId(mode=state.permissionMode){return String(mode||'').startsWith(PERMISSION_PROFILE_PREFIX)?String(mode).slice(PERMISSION_PROFILE_PREFIX.length):null}
function permissionModeDefinition(mode=state.permissionMode){if(permissionModes[mode])return{mode,...permissionModes[mode]};const profileId=permissionProfileId(mode),profile=profileId&&state.permissionProfiles.find(item=>item.id===profileId);return profile?{kind:'profile',mode,profileId,label:profile.id,description:profile.description||'Custom permission profile',icon:'file',allowed:profile.allowed!==false}:null}
function permissionModeAvailable(mode=state.permissionMode){const selected=permissionModeDefinition(mode);if(!selected||selected.allowed===false)return false;if(mode==='full-access')return state.permissionVisibility.fullAccess;return true}
function normalizePermissionMode(){if(permissionModeAvailable())return;state.permissionMode='default';localStorage.setItem('codex-webui-permission-mode','default')}
function selectedPermission(){normalizePermissionMode();return permissionModeDefinition()||{mode:'default',...permissionModes.default}}
function setPermissionProfiles(profiles=[]){state.permissionProfiles=normalizePermissionProfiles(profiles);normalizePermissionMode();syncPermissionControl()}
async function loadPermissionProfiles(){if(!state.connected)return;const requestId=permissionProfileRequestGate.next();try{const result=await rpc('permissionProfile/list',{cwd:permissionProfileCwd(),limit:100});if(permissionProfileRequestGate.isCurrent(requestId))setPermissionProfiles(result.data||[])}catch{if(permissionProfileRequestGate.isCurrent(requestId))setPermissionProfiles([])}}
function permissionThreadPolicy(){return threadPolicyFor(selectedPermission())}
function permissionTurnPolicy(cwd){return turnPolicyFor(selectedPermission(),cwd)}
// Authentication type is not a capability signal. The native App Server enforces
// account eligibility and managed policy when applying auto_review.
function renderPermissionMenu(){const list=$('#permissionOptions');if(!list)return;const modes=['default','guardian-approvals','config'];if(state.permissionVisibility.fullAccess)modes.push('full-access');for(const profile of state.permissionProfiles)modes.push(`${PERMISSION_PROFILE_PREFIX}${profile.id}`);renderPermissionOptions({list,options:modes.map(mode=>permissionModeDefinition(mode)).filter(Boolean),selected:state.permissionMode,t,icon:codexIcon,onSelect:choosePermissionMode})}
function syncPermissionSettings(){const autoRow=$('#settingsAutoReviewRow'),autoToggle=$('#settingsAutoReviewToggle'),fullToggle=$('#settingsFullAccessToggle');if(autoRow)autoRow.hidden=true;if(autoToggle)autoToggle.checked=true;if(fullToggle)fullToggle.checked=state.permissionVisibility.fullAccess;syncTaskNotifySettings()}
const TASK_NOTIFY_STORAGE_KEY='codex-webui-task-notify';
function taskNotifyEnabled(){return localStorage.getItem(TASK_NOTIFY_STORAGE_KEY)!=='false'}
function syncTaskNotifySettings(){const toggle=$('#settingsTaskNotifyToggle'),api=notificationApi();if(toggle){toggle.disabled=!api;toggle.checked=Boolean(api&&taskNotifyEnabled()&&api.permission!=='denied')}}
async function setTaskNotifyEnabled(enabled){const api=notificationApi(),on=Boolean(enabled&&api);localStorage.setItem(TASK_NOTIFY_STORAGE_KEY,String(on));if(on&&api.permission==='default'){try{await api.requestPermission()}catch{}}syncTaskNotifySettings();if(on&&api.permission==='denied')toast(t('Browser notifications are blocked'))}
function maybeNotifyTaskCompleted(p){if(!taskNotifyEnabled())return;if(!('Notification'in window)||Notification.permission!=='granted')return;if(document.hasFocus()&&!document.hidden)return;const thread=state.threads.find(x=>x.id===p.threadId),title=thread?.name||t('Task completed');try{new Notification(t('Task completed'),{body:title,tag:`codex-turn-${p.turn?.id||Date.now()}`})}catch{}}
function syncPermissionControl(){normalizePermissionMode();const selected=selectedPermission();$('#modeButton .control-label').textContent=t(state.planMode?'Plan mode':selected.label);$('#modeButton').classList.toggle('active',state.planMode||state.permissionMode!=='default');if($('#settingsPermissionValue'))$('#settingsPermissionValue').textContent=t(selected.label);syncPermissionSettings();renderPermissionMenu()}
function setPermissionMode(mode){if(!permissionModeAvailable(mode))return;const selected=permissionModeDefinition(mode);state.permissionMode=mode;localStorage.setItem('codex-webui-permission-mode',mode);syncPermissionControl();closePermissionMenu();toast(selected.label)}
function setPermissionVisibility(kind,enabled){state.permissionVisibility[kind]=Boolean(enabled);localStorage.setItem(kind==='autoReview'?'codex-webui-permission-auto-review':'codex-webui-permission-full-access',String(Boolean(enabled)));normalizePermissionMode();syncPermissionControl()}
function openPermissionMenu(){closeModelMenu();syncPermissionControl();$('#permissionMenu').hidden=false;$('#modeButton').setAttribute('aria-expanded','true')}
function closePermissionMenu(){const menu=$('#permissionMenu');menu.hidden=true;$('#modeButton').setAttribute('aria-expanded','false')}
function togglePermissionMenu(){if($('#permissionMenu').hidden)openPermissionMenu();else closePermissionMenu()}
function choosePermissionMode(mode){closePermissionMenu();if(mode==='full-access'&&state.permissionMode!=='full-access'){pendingFullAccessAction='select';const dialog=$('#fullAccessDialog');if(!dialog.open)dialog.showModal();return}setPermissionMode(mode)}
async function loadFolders(path=folderBrowse.path){const list=$('#folderList');list.innerHTML='<div class="list-state">Loading folders…</div>';try{const response=await fetch(`/api/folders?path=${encodeURIComponent(path)}`),data=await response.json();if(!response.ok)throw new Error(data.error||'Cannot browse folder');folderBrowse={path:data.path,parent:data.parent,selected:data.path};$('#folderPathInput').value=data.path;$('#folderSelection').textContent=data.path;$('#folderConfirm').disabled=false;$('#folderUp').disabled=!data.parent;list.innerHTML='';for(const folder of data.folders){const b=document.createElement('button');b.type='button';b.className='folder-item';b.innerHTML=`${icons.file}<span>${escapeHtml(folder.name)}</span>`;b.ondblclick=()=>loadFolders(folder.path);b.onclick=()=>{folderBrowse.selected=folder.path;$('#folderSelection').textContent=folder.path;$('#folderConfirm').disabled=false;list.querySelectorAll('.folder-item').forEach(x=>x.classList.remove('selected'));b.classList.add('selected')};list.append(b)}if(!data.folders.length)list.innerHTML='<div class="list-state">No subfolders</div>'}catch(e){list.innerHTML=`<div class="list-state">${escapeHtml(e.message)}</div>`}}
function openFolderPicker(){const dialog=$('#folderDialog');folderBrowse.selected=null;dialog.showModal();loadFolders(state.projectless?(state.config.defaultCwd||'~/projects'):($('#projectPath').textContent||'~/projects'));$('#projectlessOption').classList.toggle('selected',state.projectless)}
async function syncWorkspaceContext(path){const requestId=workspaceContextRequestGate.next();try{const response=await fetch(`/api/workspace/context?cwd=${encodeURIComponent(path)}`,{cache:'no-store'}),context=await response.json();if(!response.ok)throw new Error(context.error||'Workspace context unavailable');if(!workspaceContextRequestGate.isCurrent(requestId)||state.projectless)return;state.workspaceContext=context;if(!state.active)showEmpty()}catch{if(workspaceContextRequestGate.isCurrent(requestId)&&!state.projectless){state.workspaceContext={cwd:path,project:path.split('/').filter(Boolean).at(-1)||path,environment:'Local',branch:'No branch'};if(!state.active)showEmpty()}}}
function syncProjectControl(){const label=$('#composerProjectLabel');$('#composerWorkspaceBar').hidden=Boolean(state.active);label.textContent=state.projectless?t('Choose project'):($('#projectName').textContent||t('Choose project'))}
function refreshComposerPlaceholder(){const followUpType=state.active?(state.active.source==='cloud'?'cloud':'local'):undefined;$('#prompt').placeholder=resolveComposerPlaceholder({followUpType,composerMode:state.composerMode,cloudStartingState:state.cloudStartingState,isBackgroundSubagentsPanelVisible:state.backgroundAgentsVisible,isGoalModeActive:state.goalMode,isPlanModeActive:state.planMode,placeholderText:state.placeholderText,isHome:!state.active})}
function setWorkspace(path){const name=path.split('/').filter(Boolean).at(-1)||path,resolved=path.replace(/^~/,state.config.home);workspaceContextRequestGate.next();state.projectless=false;state.workspaceContext={cwd:resolved,project:name,environment:'Local',branch:null};$('#projectPath').textContent=shortPath(path);$('#projectName').textContent=name;localStorage.setItem('codex-webui-project',path);switchNewTaskDraft();syncProjectControl();if(!state.active)showEmpty();if(!$('#summaryPanel').hidden)syncSummaryPanel();workspaceNavigation.registerProject(resolved);syncWorkspaceContext(resolved);dispatchEvent(new Event('codex-webui:preferences'));dispatchEvent(new Event('codex-webui:workspace-change'));if(state.connected)loadPermissionProfiles()}
function setProjectless(){workspaceContextRequestGate.next();state.projectless=true;state.workspaceContext=null;$('#projectPath').textContent='~';$('#projectName').textContent=t('Tasks');localStorage.setItem('codex-webui-project','~');switchNewTaskDraft();syncProjectControl();if(!state.active){$('#threadPath').textContent='';showEmpty()}if(!$('#summaryPanel').hidden)syncSummaryPanel();if(state.connected)loadPermissionProfiles();dispatchEvent(new Event('codex-webui:workspace-change'))}
function resetReviewState(){state.turnDiffs.clear();state.activeReview=null;reviewPatchState='undo';renderChanges()}
function clearConversationRuntime(){runtimeProgress.clear();state.requestCards.clear();for(const animation of state.motion.values())animation?.destroy?.();state.items.clear();state.turns.clear();state.activities.clear();state.activityItems.clear();state.sideTasks.clear();state.dividers.clear();state.motion.clear();renderSideTasks()}
function rememberActiveThread(id){if(id)localStorage.setItem(ACTIVE_THREAD_STORAGE_KEY,String(id));else localStorage.removeItem(ACTIVE_THREAD_STORAGE_KEY)}
function startNewTask(){conversationLoad?.finish();conversationLoad=null;saveComposerDraft();threadNavigationRequestGate.next();if(mobileSidebarEnabled())setSidebarOpen(false);resetActiveThreadSync();setActiveTurnId('');rememberActiveThread(null);state.active=null;state.goalMode=false;state.composerMentions=[];state.turnWindow=null;clearConversationRuntime();state.changes.clear();resetReviewState();closeComposerAutocomplete();$('#threadTitle').textContent=t('New task');$('#threadPath').textContent=state.projectless?'':$('#projectPath').textContent;restoreComposerDraft();setPlanMode(false);syncProjectControl();renderContextTray();renderContextUsage();resizePrompt();if(!$('#summaryPanel').hidden)syncSummaryPanel();showEmpty();renderThreads();$('#prompt').focus();dispatchEvent(new Event('codex-webui:workspace-change'))}
function useSelectedFolder(){if(!folderBrowse.selected)return;setWorkspace(folderBrowse.selected);$('#folderDialog').close();startNewTask()}
function useProjectless(){setProjectless();$('#folderDialog').close();startNewTask()}
function titleOf(t){return (t.name||t.preview||'Untitled task').replace(/\s+/g,' ').trim().slice(0,110)}
function shortPath(path=''){const home=state.config.home;return home&&path.startsWith(home)?'~'+path.slice(home.length):path}
async function deleteThread(thread){
  if(!thread?.id)return;
  const title=titleOf(thread);
  if(!confirm(t('Delete “{title}”? This permanently deletes the thread and its descendants.',{title})))return;
  try{
    await rpc('thread/delete',{threadId:thread.id});
    const wasActive=state.active?.id===thread.id;
    state.threads=state.threads.filter(item=>item.id!==thread.id);
    await refreshThreadList();
    if(wasActive)startNewTask();else renderThreads();
    composerDrafts.remove(threadDraftKey(thread.id));
    toast(t('Thread deleted'));
  }catch(error){console.error('Could not delete thread',error);toast(t('Could not delete thread'))}
}
const workspaceNavigation = createWorkspaceNavigation({ t, codexIcon, titleOf, shortPath, onOpen: id => { if(mobileSidebarEnabled())setSidebarOpen(false);openThread(id) }, onDelete: deleteThread, menu: workspaceMenu, onAddProject: openFolderPicker, onSelectProject: cwd => { setWorkspace(cwd); startNewTask(); if(mobileSidebarEnabled())setSidebarOpen(false) } });
const workspaceChrome = createWorkspaceChrome({ rpc, $, state, t, codexIcon, menu: workspaceMenu, returnToWorkspace, openSettings, openReview: () => openReviewPanel(), openBrowser: () => openUtilityPanel('browser'), openFolderPicker, startNewTask, setWorkspace: path => path === '~' ? setProjectless() : setWorkspace(path), openThread, searchChats: () => { setSidebarOpen(true); setSidebarSearchOpen(true) }, openImageViewer });

async function forkRequest(payload){const response=await fetch('/api/conversation/fork',{method:'POST',headers:{'content-type':'application/json','x-workspace-request':'1'},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok)throw new Error(t(result.error));return result;}
async function registerFork(thread){state.threads=[thread,...state.threads.filter(item=>item.id!==thread.id)];renderThreads();}
async function forkInNewChat(payload){const navigation=threadNavigationRequestGate.current();const result=await forkRequest(payload);await registerFork(result.thread);if(threadNavigationRequestGate.isCurrent(navigation))await openThread(result.thread.id,result.thread);else toast(t('Fork created. Open it from the sidebar.'));}
const sideChat=createSideChat({root:$('#sideChatPanel'),state,t,rpc,fork:forkRequest,menu:workspaceMenu,icon:codexIcon,getDefaults:()=>({model:state.selectedModel,effort:$('#effortSelect').value,permissionMode:state.permissionMode}),onThreadsChanged:registerFork,respond:respondToCodex,onResolved:removeServerRequest,toast});
const turnPresentation=createTurnPresentation({state,t,icon:codexIcon,toast,fork:forkInNewChat,openReview:openReviewPanel});
const composerTools=createComposerTools({state,t,icon:codexIcon,toast,ensureThread:async()=>{if(state.active)return state.active;const navigation=threadNavigationRequestGate.current();const result=await rpc('thread/start',{cwd:state.workspaceContext?.cwd||state.config.home,model:state.selectedModel,...permissionThreadPolicy()});await registerFork(result.thread);if(!threadNavigationRequestGate.isCurrent(navigation))throw new Error(t('Conversation changed. Open the created chat to set its goal.'));await openThread(result.thread.id,result.thread);return result.thread;},onGoalChanged:(id,goal)=>{if(state.active?.id===id){state.goalMode=goal?.status==='active';refreshComposerPlaceholder();}},addSkill:skill=>{if(!state.composerMentions.some(item=>item.id===skill.id))state.composerMentions.push(skill);renderContextTray();$('#prompt').focus();}});
function beginSideChat(text=''){sidePanelTabs.close('side-chat');openUtilityPanel('side-chat');sideChat.setPrompt(text);}
document.querySelector('#conversation').addEventListener('contextmenu',event=>{const selection=getSelection(),text=selection?.toString().trim();if(!text||text.length>16000||!document.querySelector('#conversation').contains(selection.anchorNode)||!document.querySelector('#conversation').contains(selection.focusNode))return;event.preventDefault();workspaceMenu.open(event.target instanceof Element?event.target:document.querySelector('#conversation'),[{label:'Ask in side chat',icon:'messageSquare',action:()=>beginSideChat(`> ${text.replaceAll('\n','\n> ')}\n\n`)}]);});
addEventListener('codex-webui:side-image',event=>{const {src,title,path}=event.detail;openImageViewer(src,title,path);});
addEventListener('codex-webui:open-side-chat',event=>{const thread=event.detail;sidePanelTabs.close('side-chat');if(overlayPanelsEnabled())setSidePanelOpen(false);void openThread(thread.id,thread);});
const projectOptions=createComposerProjects({anchor:$('#composerProjectButton'),state,t,icon:codexIcon,choose:path=>{startNewTask();path==='~'?setProjectless():setWorkspace(path);},add:openFolderPicker});
composerDelivery=createServerComposerDelivery({anchor:$('#sendButton'),host:$('#composer'),t,icon:codexIcon,menu:workspaceMenu,rpc,importLegacy:importLegacyQueuedMessage,context:()=>({threadId:state.active?.id,turnId:activeTurnId(),ready:state.connected&&!conversationLoad&&!composerSubmission&&!accessSession?.required}),onError:error=>toast(t(threadInputErrorMessage(error)),5200),onChange:syncComposerSubmitState});
const composerAttachments=createComposerAttachments({state,t,menu:workspaceMenu,anchor:document.querySelector('[data-composer-control="add"]'),prompt:$('#prompt'),draftKey:()=>composerDraftKey,toast,setBusy:busy=>{state.attachmentsUploading=busy;syncComposerSubmitState();},openFiles:()=>openUtilityPanel('files'),togglePlan:()=>setPlanMode(!state.planMode),extraItems:()=>composerTools.menuItems(),applyToDraft:(key,mentions)=>{saveComposerDraft();const draft=composerDrafts.get(key);draft.mentions=[...new Map([...draft.mentions,...mentions].map(item=>[item.id,item])).values()];composerDrafts.set(key,draft);if(composerDraftKey===key)restoreComposerDraft(key);}});
const fileBrowser=createFileExplorer({container:$('#sideFileContent'),search:$('#sideFileSearch'),cwd:()=>state.active?.cwd||(state.projectless?state.config.home:state.workspaceContext?.cwd||state.config.defaultCwd),t,menu:workspaceMenu,toast,reference:text=>{const input=$('#prompt');input.value+=`${input.value?' ':''}${text} `;input.dispatchEvent(new Event('input',{bubbles:true}));if(overlayPanelsEnabled())setSidePanelOpen(false);input.focus();},openImage:openImageViewer,openChat:openThread,rpc,isCurrent:()=>!$('#sidePanel').hidden&&!$('#utilityPanelContent').hidden});
addEventListener('codex-webui:attachment-reference',()=>{renderContextTray();syncComposerSubmitState();$('#prompt').focus();});
let filesWorkspaceKey='';
const currentFilesWorkspaceKey=()=>`${state.active?.id||''}:${state.active?.cwd||(state.projectless?state.config.home:state.workspaceContext?.cwd||state.config.defaultCwd)}`;
function refreshWorkspaceFiles(){const key=currentFilesWorkspaceKey();if(key!==filesWorkspaceKey)$('#sideFileSearch').value='';filesWorkspaceKey=key;void fileBrowser.open('files')}
$('#sideFileSearch').oninput=()=>fileBrowser.search();
addEventListener('codex-webui:workspace-change',()=>{if(!$('#sidePanel').hidden&&!$('#utilityPanelContent').hidden&&filesWorkspaceKey!==currentFilesWorkspaceKey())refreshWorkspaceFiles();});
function renderThreads(){workspaceChrome.recordNavigation(state.active?.id, state.projectless ? '~' : state.workspaceContext?.cwd);workspaceNavigation.render({ threads: state.threads, activeId: state.active?.id, query: $('#threadSearch').value, pending: new Set([...state.serverRequests.values()].map(item=>item.params?.threadId).filter(Boolean)), home: state.config.home, connected: state.connected })}

async function openThread(id,fallbackSummary=null){
  const navigationId=threadNavigationRequestGate.next();
  conversationLoad?.finish();conversationLoad=null;
  const listedSummary=state.threads.find(x=>x.id===id),summary=listedSummary||fallbackSummary,deferTransition=Boolean(fallbackSummary&&!listedSummary);
  const current=()=>threadNavigationRequestGate.isCurrent(navigationId);
  const beginLoading=()=>{conversationLoad=createConversationLoading($('#conversation'),{t,retry:()=>void openThread(id,fallbackSummary)});syncComposerSubmitState();return conversationLoad};
  if(!deferTransition){resetActiveThreadSync();setActiveTurnId('');rememberActiveThread(id);saveComposerDraft();state.active=summary||{id,cwd:state.workspaceContext?.cwd||state.config.defaultCwd};state.goalMode=false;restoreComposerDraft(threadDraftKey(id));state.turnWindow=null;clearConversationRuntime();state.changes.clear();resetReviewState();closeComposerAutocomplete();renderContextTray();renderContextUsage();renderHeader();renderThreads();beginLoading()}
  try{
    const result=await rpc('thread/read',{threadId:id,includeTurns:true},{timeoutMs:100000}),thread={...(summary||{}),...result.thread};
    if(!current())return false;
    resetActiveThreadSync();setActiveTurnId('');saveComposerDraft();state.active=thread;state.goalMode=false;void composerTools.refreshGoal(thread.id);restoreComposerDraft(threadDraftKey(thread.id));rememberActiveThread(thread.id);state.turnWindow=null;clearConversationRuntime();state.changes.clear();resetReviewState();closeComposerAutocomplete();renderContextTray();renderContextUsage();renderHeader();renderThreads();
    if(deferTransition)beginLoading();
    const loader=conversationLoad,root=$('#conversation'),turns=thread.turns||[];
    state.turnWindow={...createTurnWindow(turns,DEFAULT_TURN_PAGE_SIZE),threadId:thread.id};
    if(state.turnWindow.hiddenCount)appendOlderMessagesButton(thread,root);
    const total=state.turnWindow.visible.reduce((count,turn)=>count+(turn.items?.length||0),0);
    let rendered=0,lastYield=performance.now();loader.render(0,total);
    // Paint the loading surface before parsing Markdown or building tool logs.
    await new Promise(resolve=>setTimeout(resolve,0));if(!current())return false;
    for(const turn of state.turnWindow.visible){
      if(turn.status==='inProgress'||(turn.items||[]).some(item=>item.type!=='userMessage'))ensureTurnTimeline(turn.id,root).dataset.completed=String(turn.status!=='inProgress');
      for(const item of turn.items||[]){
        upsertItem(item,turn.id,root,false);rendered++;
        if(performance.now()-lastYield>12){loader.render(rendered,total);await new Promise(resolve=>setTimeout(resolve,0));if(!current())return false;lastYield=performance.now()}
      }
      syncWorkedForDivider(turn.id,turnDurationMs(turn));turnPresentation.update(turn.id,turn.status!=='inProgress');runtimeProgress.snapshot(turn);
    }
    loader.render(total,total);loader.finish();conversationLoad=null;syncComposerSubmitState();
    const active=turns.findLast(turn=>turn.status==='inProgress');if(active)syncTurnRuntime(active);
    if(!turns.length)root.innerHTML='<div class="list-state conversation-loading">No conversation history loaded. Send a message to continue.</div>';
    for(const turn of turns)composerDelivery?.snapshot(thread.id,turn);
    renderPendingRequests();runtimeProgress.refresh();scrollOpenedThreadToBottom();scheduleActiveThreadSync(0);return true;
  }catch(e){
    if(!current())return false;
    if(deferTransition&&!conversationLoad){toast(e?.message||'Could not load side task');return false}
    conversationLoad?.fail();return false;
  }
}
function appendOlderMessagesButton(thread,root){const more=document.createElement('button');more.className='load-older';more.textContent=t('Load earlier messages ({count})',{count:state.turnWindow.hiddenCount});more.onclick=()=>renderThread(thread,DEFAULT_TURN_PAGE_SIZE);root.append(more)}

function renderHeader(){const t=state.active;if(!t)return;$('#threadTitle').textContent=titleOf(t);if(t.projectless){state.projectless=true;state.workspaceContext=null;$('#projectName').textContent='Tasks';$('#projectPath').textContent='~';$('#threadPath').textContent=''}else{$('#threadPath').textContent=shortPath(t.cwd);setWorkspace(t.cwd||state.config.home)}syncProjectControl();dispatchEvent(new Event('codex-webui:workspace-change'));refreshComposerPlaceholder();$('#threadSource').textContent=t.source||'local'}
function renderThread(thread,loadMore=0){const root=$('#conversation'),turns=thread.turns||[];state.turnWindow=createTurnWindow(turns,DEFAULT_TURN_PAGE_SIZE,state.turnWindow?.threadId===thread.id?state.turnWindow.start:undefined,loadMore);state.turnWindow.threadId=thread.id;clearConversationRuntime();root.innerHTML='';if(state.turnWindow.hiddenCount)appendOlderMessagesButton(thread,root);for(const turn of state.turnWindow.visible)renderTurn(turn,root);if(!root.children.length)showEmpty();else if(!loadMore)scrollBottom()}
function showEmpty(){ $('#conversation').innerHTML=`<div class="empty-state" id="emptyState">${codexInterfaceMark('empty-codex-mark')}<h1>${t('What should we build?')}</h1></div>`; }

function ensureTurnTimeline(turnId,root=$('#conversation')){let turn=state.turns.get(turnId);if(turn?.isConnected)return turn;turn=document.createElement('article');turn.className='turn assistant-turn native-turn-timeline';turn.dataset.turnId=turnId;turn.dataset.threadId=state.active?.id||'';turn.innerHTML='<div class="worked-for-divider" data-worked-for-divider hidden><span>Worked</span><div></div></div><div class="assistant-body"><div class="turn-event-stream"></div></div><div class="turn-final-slot"></div>';root.append(turn);state.turns.set(turnId,turn);state.dividers.set(turnId,turn.querySelector('[data-worked-for-divider]'));return turn}
function formatWorkedDuration(durationMs){if(!Number.isFinite(durationMs)||durationMs<1000)return null;const seconds=Math.max(1,Math.round(durationMs/1000));if(seconds<60)return`${seconds}s`;const minutes=Math.floor(seconds/60),rest=seconds%60;return rest?`${minutes}m ${rest}s`:`${minutes}m`}
function turnDurationMs(turn={}){if(Number.isFinite(turn.durationMs))return turn.durationMs;if(Number.isFinite(turn.startedAt)&&Number.isFinite(turn.completedAt))return Math.max(0,(turn.completedAt-turn.startedAt)*1000);if(Number.isFinite(turn.startedAtMs)&&Number.isFinite(turn.completedAtMs))return Math.max(0,turn.completedAtMs-turn.startedAtMs);return undefined}
function syncWorkedForDivider(turnId,durationMs){const turn=state.turns.get(turnId),divider=state.dividers.get(turnId);if(!turn||!divider)return;if(Number.isFinite(durationMs))turn.dataset.durationMs=String(durationMs);const hasActivity=Boolean(turn.querySelector('.turn-event-stream')?.children.length),hasFinal=Boolean(turn.querySelector('[data-local-conversation-final-assistant]'));divider.hidden=!(hasActivity&&hasFinal);const duration=formatWorkedDuration(Number(turn.dataset.durationMs));divider.querySelector('span').textContent=duration?`Worked for ${duration}`:'Worked'}
function renderTurn(turn,root=$('#conversation')){if(turn.status==='inProgress'||state.turns.has(turn.id)||(turn.items||[]).some(item=>item.type!=='userMessage'))ensureTurnTimeline(turn.id,root).dataset.completed=String(turn.status!=='inProgress');for(const item of turn.items||[])upsertItem(item,turn.id,root,false);syncWorkedForDivider(turn.id,turnDurationMs(turn));turnPresentation.update(turn.id,turn.status!=='inProgress');runtimeProgress.snapshot(turn);composerDelivery?.snapshot(state.active?.id,turn)}
function textFromInput(content=[]){return content.filter(x=>x.type==='text').map(x=>x.text).join('\n')}
function claimOptimisticUser(item,root){if(String(item.id).startsWith('local-'))return null;const text=textFromInput(item.content),candidates=[...root.querySelectorAll('.user-turn[data-optimistic-user="true"]')];const el=candidates.find(node=>node.querySelector('.user-message')?.textContent===text);if(!el)return null;for(const[id,node]of state.items)if(node===el)state.items.delete(id);delete el.dataset.optimisticUser;state.items.set(item.id,el);return el}
function agentMessageIdFamily(id){const value=String(id||'');return /^item[-_]/.test(value)?'app':/^(?:msg_|host-message-)/.test(value)?'rollout':''}
function claimEquivalentAgentMessage(item,turnId){const family=agentMessageIdFamily(item.id);if(!family)return null;const text=agentMessageText(item,''),commentary=item.phase==='commentary';for(const[id,node]of state.items){if(agentMessageIdFamily(id)===family||node.closest('[data-turn-id]')?.dataset.turnId!==turnId)continue;const body=node.querySelector('.message-text'),existingCommentary=node.dataset.localConversationCommentary!==undefined;if(existingCommentary===commentary&&body?.dataset.raw===text){state.items.set(item.id,node);return node}}return null}
function placeAgentMessage(el,item,timeline){const commentary=item.phase==='commentary',slot=timeline.querySelector(commentary?'.turn-event-stream':'.turn-final-slot');el.className=commentary?'assistant-response assistant-commentary':'assistant-response';if(commentary){delete el.dataset.localConversationFinalAssistant;el.dataset.localConversationCommentary=''}else{delete el.dataset.localConversationCommentary;el.dataset.localConversationFinalAssistant=''}if(el.parentElement!==slot)slot.append(el)}
function imageCwd(item={}){return item.cwd||state.active?.cwd||state.config.defaultCwd||'.'}
function sideTaskStatus(item,threadId){const agent=item.agentsStates?.[threadId];if(agent?.status)return agent.status;if(item.type==='subAgentActivity')return item.kind==='interrupted'?'interrupted':'running';return item.status==='failed'?'errored':item.status==='completed'?'completed':'running'}
function updateSideTasks(item){if(item.type==='collabAgentToolCall'){for(const threadId of item.receiverThreadIds||[]){const previous=state.sideTasks.get(threadId)||{};state.sideTasks.set(threadId,{...previous,threadId,prompt:item.prompt||previous.prompt||'',model:item.model||previous.model||'',reasoningEffort:item.reasoningEffort||previous.reasoningEffort||'',status:sideTaskStatus(item,threadId),message:item.agentsStates?.[threadId]?.message||previous.message||''})}}else if(item.type==='subAgentActivity'){const previous=state.sideTasks.get(item.agentThreadId)||{};state.sideTasks.set(item.agentThreadId,{...previous,threadId:item.agentThreadId,agentPath:item.agentPath||previous.agentPath||'',status:sideTaskStatus(item,item.agentThreadId)})}renderSideTasks()}
function renderSideTasks(){const list=$('#sideTaskList');if(!list)return;list.innerHTML='';for(const task of state.sideTasks.values()){const button=document.createElement('button');button.type='button';button.className='side-task-card';button.dataset.threadId=task.threadId;button.innerHTML=`${codexIcon('messageSquare')}<span class="side-task-copy"><strong>${escapeHtml(task.agentPath||task.model||'Side task')}</strong><small>${escapeHtml(task.message||task.prompt||task.threadId)}</small></span><span class="side-task-status ${escapeHtml(task.status||'running')}">${escapeHtml(task.status||'running')}</span>`;button.onclick=async()=>{button.disabled=true;button.setAttribute('aria-busy','true');await openThread(task.threadId,{id:task.threadId,name:task.agentPath||task.model||'Side task',preview:task.prompt||task.message||'',cwd:state.active?.cwd||state.config.defaultCwd,source:'local',sideTask:true});if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy')}};list.append(button)}if(!state.sideTasks.size)list.innerHTML='<div class="side-task-empty">Side tasks started by this chat will appear here.</div>';const summary=$('#summarySideTasks');if(summary)summary.textContent=state.sideTasks.size?`${state.sideTasks.size} side task${state.sideTasks.size===1?'':'s'}`:'No side tasks'}
function upsertItem(item,turnId,root=$('#conversation'),live=true){
  root.querySelector('#emptyState')?.remove();
  let el=state.items.get(item.id);if(!el&&item.type==='userMessage')el=claimOptimisticUser(item,root);if(!el&&item.type==='agentMessage')el=claimEquivalentAgentMessage(item,turnId);if(!el){
    if(item.type==='userMessage'){el=document.createElement('article');el.className='turn user-turn';if(String(item.id).startsWith('local-'))el.dataset.optimisticUser='true';el.innerHTML='<div class="user-message"></div>';const timeline=state.turns.get(turnId);timeline?.isConnected?root.insertBefore(el,timeline):root.append(el)}
    else if(item.type==='agentMessage'){const timeline=ensureTurnTimeline(turnId,root);el=document.createElement('div');el.innerHTML='<div class="message-text"></div>';placeAgentMessage(el,item,timeline)}
    else if(item.type==='imageGeneration'){const timeline=ensureTurnTimeline(turnId,root);el=document.createElement('div');el.className='assistant-generated-image';timeline.querySelector('.turn-event-stream').append(el)}
    else if(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','subAgentActivity','webSearch','reasoning','plan','imageView'].includes(item.type)){const id=activityItemId(item);el=ensureActivity(turnId,root,id,item.type==='imageView'||item.type==='reasoning');addActivity(item,el,id)}
    else return;
    if(item.type==='userMessage'||item.type==='agentMessage'||item.type==='imageGeneration')state.items.set(item.id,el);
  }
  if(item.type==='userMessage'){el.querySelector('.user-message').textContent=textFromInput(item.content);let images=el.querySelector('.user-message-images');const html=renderItemImages(item,{cwd:imageCwd(item),className:'message-image-grid user-message-images'});if(html){if(!images){images=document.createElement('div');el.prepend(images)}images.outerHTML=html}else images?.remove();}
  if(item.type==='agentMessage'){const timeline=ensureTurnTimeline(turnId,root),body=el.querySelector('.message-text'),text=agentMessageText(item,body.dataset.raw??''),cwd=imageCwd(item);placeAgentMessage(el,item,timeline);body.dataset.raw=text;body.innerHTML=renderAssistantMarkdown(text,{cwd})+renderItemImages(item,{cwd,className:'message-image-grid structured-message-images',excludeText:text});syncWorkedForDivider(turnId)}
  if(item.type==='imageGeneration'){const html=renderItemImages(item,{cwd:imageCwd(item),className:'generated-image-grid'});el.innerHTML=html||`<div class="generated-image-pending ${item.status==='inProgress'?'loading-shimmer':''}">${item.status==='failed'?'Image generation failed':'Generating image'}</div>`}
  if(item.type==='fileChange'){for(const ch of item.changes||[]){const path=ch.path||ch.filePath||'Changed file';state.changes.set(path,ch)}syncTurnReviewFromItems(turnId);renderChanges()}
  if(item.type==='collabAgentToolCall'||item.type==='subAgentActivity')updateSideTasks(item)
  if(item.type==='agentMessage')turnPresentation.update(turnId);
  if(live)scrollBottom();
}
function activityGroupExpansionKey(activity){const threadId=state.active?.id,turnId=activity.closest('[data-turn-id]')?.dataset.turnId,anchor=activity.dataset.activityGroupAnchor;return threadId&&turnId&&anchor?`codex-webui-activity-group:${threadId}:${turnId}:${anchor}`:null}
function savedActivityGroupExpansion(activity){const key=activityGroupExpansionKey(activity),saved=key&&localStorage.getItem(key);return saved==='open'?true:saved==='closed'?false:null}
function setActivityGroupOpen(activity,open,persist=false){const button=activity.querySelector('.activity-summary'),items=activity.querySelector('.activity-items');button.classList.toggle('open',open);items.classList.toggle('open',open);if(persist&&!activity.classList.contains('single')){const key=activityGroupExpansionKey(activity);if(key)localStorage.setItem(key,open?'open':'closed')}}
function ensureActivity(turnId,root,itemId,standalone=false){const turn=ensureTurnTimeline(turnId,root),stream=turn.querySelector('.turn-event-stream'),existing=itemId?turn.querySelector(`[data-item-id="${CSS.escape(String(itemId))}"]`)?.closest('[data-agent-activity-group]'):null;if(existing)return existing;let activity=standalone?null:state.activities.get(turnId);if(!activity?.isConnected||activity.parentElement!==stream||stream.lastElementChild!==activity||activity.dataset.standalone==='true'){activity=document.createElement('div');activity.className='activity-group active';activity.dataset.agentActivityGroup='';activity.dataset.activityGroupAnchor=String(itemId||'activity');if(standalone)activity.dataset.standalone='true';activity.innerHTML=`<button class="activity-summary open"><span class="activity-summary-icon" aria-hidden="true"></span><span class="activity-summary-copy loading-shimmer">Working</span>${icons.chevron}</button><div class="activity-items open"></div>`;activity.querySelector('.activity-summary').onclick=()=>setActivityGroupOpen(activity,!activity.querySelector('.activity-summary').classList.contains('open'),true);stream.append(activity);state.activities.set(turnId,activity)}if(!state.activityItems.has(turnId))state.activityItems.set(turnId,new Map);return activity}
function joinActivityText(value){if(typeof value==='string')return value;if(Array.isArray(value))return value.filter(part=>typeof part==='string').join('\n');return''}
function activityOutput(item){if(item.type==='reasoning')return joinActivityText(item.summary)||joinActivityText(item.content);const output=item.aggregatedOutput??item.output?.aggregatedOutput??item.output;if(typeof output==='string')return output;if(Array.isArray(output))return output.join('\n');return joinActivityText(item.content)||(item.result?JSON.stringify(item.result,null,2):'')}
function commandText(item){return item.command||(item.commandActions||[]).map(action=>action?.command).filter(Boolean).join('\n')||''}
function commandExitCode(item){return item.exitCode??item.output?.exitCode}
function commandFooter(item,data){if(data.active)return{label:'',icon:''};if(item.executionStatus==='interrupted'||item.status==='interrupted'||item.status==='cancelled')return{label:'Stopped',icon:''};const exitCode=commandExitCode(item);if(data.tone==='error')return{label:exitCode==null?'Failed':`Exit code ${exitCode}`,icon:''};return{label:'Success',icon:icons.check}}
function renderCommandShell(out,item,data){if(out.dataset.outputKind!=='command'){out.dataset.outputKind='command';out.className='activity-output command-shell-wrap';out.innerHTML='<div class="command-shell"><div class="command-shell-body"><div class="command-shell-command"><span aria-hidden="true">$</span><code></code></div><div class="command-shell-output"><pre></pre></div></div><div class="command-shell-footer"></div></div>'}const output=activityOutput(item),pre=out.querySelector('.command-shell-output pre'),footer=commandFooter(item,data);out.querySelector('.command-shell-command code').textContent=commandText(item);pre.textContent=output||(data.active?'':'No output');pre.classList.toggle('empty',!output);out.querySelector('.command-shell-footer').innerHTML=`${footer.icon}<span>${footer.label}</span>`}
function inlineFileChangeDiff(change){const raw=unifiedDiffFromFileChanges([change]),review=parseUnifiedDiff(raw);if(!review.hasChanges){const diff=change.diff||change.unified_diff||'';return diff?`<pre>${escapeHtml(diff)}</pre>`:''}return `<div class="file-change-inline-diff">${review.files.flatMap(file=>file.hunks.map(hunk=>`<div class="file-change-inline-hunk"><div class="review-hunk-head">${escapeHtml(hunk.header)}</div><div class="review-lines">${hunk.lines.map(reviewLineHtml).join('')}</div></div>`)).join('')}</div>`}
function renderFileChangeOutput(out,item,data){out.dataset.outputKind='file-change';out.className='activity-output file-change-output';const changes=item.changes||[],legacy=activityOutput(item);if(!changes.length){out.innerHTML=`<div class="file-change-progress ${data.active?'loading-shimmer':''}">${escapeHtml(legacy||(data.active?'Waiting for patch details…':'No patch details'))}</div>`;return}out.innerHTML=changes.map(change=>{const path=change.path||change.filePath||'Changed file',kind=typeof change.kind==='string'?change.kind:change.kind?.type||'update';return `<section class="file-change-output-item"><div class="file-change-output-head">${codexIcon('fileDiff')}<span>${escapeHtml(shortPath(path))}</span><small>${escapeHtml(kind)}</small></div>${inlineFileChangeDiff(change)}</section>`}).join('')}
function isExplorationActivity(item,data=summarizeActivity(item)){return item.type==='commandExecution'&&['read','search','list'].includes(data.category)}
function renderActivityOutput(out,item,data){if(item.type==='imageView'){out.dataset.outputKind='image';out.className='activity-output activity-image-output';out.innerHTML=renderItemImages(item,{cwd:imageCwd(item),className:'activity-image-grid'})||'<div class="message-image-unavailable" data-i18n-ui>Image unavailable</div>';return}if(item.type==='commandExecution'&&data.category==='command'){renderCommandShell(out,item,data);return}if(item.type==='fileChange'){renderFileChangeOutput(out,item,data);return}if(item.type==='reasoning'){const text=activityOutput(item);out.dataset.outputKind='reasoning';out.className='activity-output reasoning-output message-text';out.innerHTML=text?renderAssistantMarkdown(text,{cwd:imageCwd(item)}):'';return}out.dataset.outputKind='plain';out.className='activity-output';out.textContent=isExplorationActivity(item,data)?'':activityOutput(item)||''}
function activityItemExpansionKey(row){const threadId=state.active?.id,turnId=row.closest('[data-turn-id]')?.dataset.turnId,itemId=row.dataset.itemId;return threadId&&turnId&&itemId?`codex-webui-activity-item:${threadId}:${turnId}:${itemId}`:null}
function savedActivityItemExpansion(row){const key=activityItemExpansionKey(row),saved=key&&localStorage.getItem(key);return saved==='open'?true:saved==='closed'?false:null}
function setActivityExpanded(row,expanded,persist=false){row.classList.toggle('expanded',expanded);row.setAttribute('aria-expanded',String(expanded));if(persist){const key=activityItemExpansionKey(row);if(key)localStorage.setItem(key,expanded?'open':'closed')}}
function motionIcon(name){return `<span class="activity-motion" data-animation="${name}"></span>`}
function mountMotion(row,name){const holder=row.querySelector('.activity-motion');if(!holder)return;state.motion.get(row)?.destroy();holder.innerHTML=codexIcon(({ 'edit-files':'fileDiff','list-files':'list','local-context':'file','run-command':'terminal','searching':'search' })[name]||'loaderCircle','workspace-motion-icon');holder.classList.add('workspace-motion-running');state.motion.set(row,{destroy:()=>holder.classList.remove('workspace-motion-running','workspace-motion-paused'),pause:()=>holder.classList.add('workspace-motion-paused'),play:()=>holder.classList.remove('workspace-motion-paused')})}
function activityIconName(item,data=summarizeActivity(item)){if(item.type==='reasoning')return null;if(data.tone==='error')return'triangleAlert';if(item.type==='fileChange')return'fileDiff';if(data.category==='image')return'image';if(data.category==='read')return'file';if(data.category==='search'||item.type==='webSearch')return'search';if(data.category==='list')return'list';if(data.category==='command')return'terminal';return'wrench'}
function stopMotion(row,tone){const animation=state.motion.get(row);animation?.destroy();state.motion.delete(row);const holder=row.querySelector('.activity-motion'),turnId=row.closest('[data-turn-id]')?.dataset.turnId,item=state.activityItems.get(turnId)?.get(row.dataset.itemId),data=item?summarizeActivity(item):{tone};if(!holder)return;const icon=activityIconName(item||{},data);holder.innerHTML=icon?codexIcon(icon):''}
function activityItemId(item){return String(item.id||item.callId||item.requestId||`${item.type}-${Date.now()}`)}
function joinActivityParts(parts){return parts.length<2?parts[0]||'Worked':`${parts.slice(0,-1).join(', ')} and ${parts.at(-1)}`}
function completedActivitySummary(items){const summaries=items.map(item=>({item,data:summarizeActivity(item)})),commands=summaries.filter(({item,data})=>item.type==='commandExecution'&&data.category==='command').length,explored=summaries.some(({data})=>['read','search','list'].includes(data.category)&&data.tone!=='error'),edits=summaries.filter(({item,data})=>item.type==='fileChange'&&data.tone!=='error').reduce((count,{item})=>count+Math.max(1,item.changes?.length||0),0),web=summaries.some(({item,data})=>item.type==='webSearch'&&data.tone!=='error'),images=summaries.some(({data})=>data.category==='image'&&data.tone!=='error'),failed=summaries.some(({data})=>data.tone==='error'),parts=[],add=(leading,following)=>parts.push(parts.length?following:leading);if(edits)add(edits===1?'Edited a file':'Edited files',edits===1?'edited a file':'edited files');if(explored)add('Read files','read files');if(commands)add(commands===1?'Ran a command':'Ran commands',commands===1?'ran a command':'ran commands');if(web)add('Searched the web','searched the web');if(images)add('Viewed images','viewed images');if(!parts.length&&failed)return'Activity failed';return joinActivityParts(parts)}
function completedActivityPrimaryItem(items){const summaries=items.map(item=>({item,data:summarizeActivity(item)})),find=predicate=>summaries.find(predicate)?.item;return find(({item,data})=>item.type==='fileChange'&&data.tone!=='error')||find(({data})=>['read','search','list'].includes(data.category)&&data.tone!=='error')||find(({data})=>data.category==='command'&&data.tone!=='error')||find(({item,data})=>item.type==='webSearch'&&data.tone!=='error')||find(({data})=>data.category==='image'&&data.tone!=='error')||items.find(item=>summarizeActivity(item).tone==='error')||items[0]}
function setActivitySummaryIcon(activity,item){const holder=activity.querySelector('.activity-summary-icon'),icon=item&&activityIconName(item);if(holder){holder.hidden=!icon;holder.innerHTML=icon?codexIcon(icon):''}}
function commandRowSummary(item,data,expanded){if(data.active)return data.label;const interrupted=item.executionStatus==='interrupted'||item.status==='interrupted'||item.status==='cancelled',command=commandText(item);if(expanded)return interrupted?'Stopped command':'Ran command';return`${interrupted?'Stopped':'Ran'}${command?` ${command}`:' command'}`}
function updateCommandRowSummary(row,item,data,expanded=row.classList.contains('expanded')){const summary=row.querySelector('.activity-name');if(summary)summary.textContent=commandRowSummary(item,data,expanded)}
function updateActivitySummary(activity){const turn=activity.closest('[data-turn-id]'),turnId=turn?.dataset.turnId,allItems=state.activityItems.get(turnId),rows=[...activity.querySelectorAll('.activity-item')],items=rows.map(row=>allItems?.get(row.dataset.itemId)).filter(Boolean),summary=activity.querySelector('.activity-summary-copy');if(!turn||!summary)return;activity.classList.toggle('single',items.length===1);const activeItem=items.findLast?.(item=>summarizeActivity(item).active)||[...items].reverse().find(item=>summarizeActivity(item).active),savedOpen=savedActivityGroupExpansion(activity);if(activeItem){const data=summarizeActivity(activeItem);setActivitySummaryIcon(activity,activeItem);summary.textContent=data.label;summary.classList.add('loading-shimmer');activity.classList.add('active');setActivityGroupOpen(activity,items.length===1||(savedOpen??true))}else{setActivitySummaryIcon(activity,completedActivityPrimaryItem(items));summary.textContent=completedActivitySummary(items);summary.classList.remove('loading-shimmer');activity.classList.remove('active');setActivityGroupOpen(activity,items.length===1||(savedOpen??false))}syncWorkedForDivider(turnId)}
function addActivity(item,activity,id=activityItemId(item)){const data=summarizeActivity(item),turn=activity.closest('[data-turn-id]'),turnId=turn.dataset.turnId,items=state.activityItems.get(turnId)||new Map,box=activity.querySelector('.activity-items');items.set(id,item);state.activityItems.set(turnId,items);let row=box.querySelector(`[data-item-id="${CSS.escape(id)}"]`);if(!row){row=document.createElement('div');row.className='activity-item entering';row.dataset.itemId=id;box.append(row);const out=document.createElement('div');out.className='activity-output';box.append(out)}const imageView=item.type==='imageView',reasoning=item.type==='reasoning',command=item.type==='commandExecution'&&data.category==='command',fileChange=item.type==='fileChange',wasActive=row.dataset.activityWasActive==='true',savedExpanded=savedActivityItemExpansion(row),existingExpanded=row.dataset.expansionInitialized?row.classList.contains('expanded'):imageView,expanded=reasoning?(data.active?true:wasActive?false:(savedExpanded??existingExpanded)):(savedExpanded??existingExpanded);row.dataset.expansionInitialized='true';row.dataset.activityWasActive=String(data.active);row.className=`activity-item ${command?'command-activity ':''}${reasoning?'reasoning-activity ':''}${imageView?'image-activity ':''}${fileChange?'file-change-activity ':''}${data.active?'active':'settled'} ${data.tone}`;if(command){state.motion.get(row)?.destroy();state.motion.delete(row);row.innerHTML=`<span class="activity-command-icon">${icons.terminal}</span><div class="activity-copy"><div class="activity-name ${data.active?'loading-shimmer':''}">${escapeHtml(commandRowSummary(item,data,expanded))}</div></div><span class="activity-command-chevron">${icons.chevron}</span>`}else if(reasoning){state.motion.get(row)?.destroy();state.motion.delete(row);row.innerHTML=`<div class="activity-copy"><div class="activity-name ${data.active?'loading-shimmer':''}">${escapeHtml(data.label)}</div></div><span class="activity-reasoning-chevron">${icons.chevron}</span>`}else{const detail=shortPath(data.detail||'');row.innerHTML=`${motionIcon(data.animation)}<div class="activity-copy"><div class="activity-name ${data.active?'loading-shimmer':''}"><span class="activity-label">${escapeHtml(data.label)}</span>${detail?` <span class="activity-detail">${escapeHtml(detail)}</span>`:''}</div></div><span class="activity-result">${fileChange?icons.chevron:''}</span>`}const out=row.nextElementSibling;renderActivityOutput(out,item,data);const reasoningOutput=reasoning&&!!activityOutput(item),expandable=imageView||command||fileChange||(reasoning&&!data.active&&reasoningOutput)||(!reasoning&&!isExplorationActivity(item,data)&&!!activityOutput(item));if(reasoning&&data.active&&reasoningOutput){row.removeAttribute('role');row.removeAttribute('aria-expanded');row.tabIndex=-1;row.classList.add('expanded')}else if(expandable){row.setAttribute('role','button');row.tabIndex=0;setActivityExpanded(row,expanded)}else{row.removeAttribute('role');row.removeAttribute('aria-expanded');row.tabIndex=-1;row.classList.remove('expanded')}row.onclick=expandable?()=>{const next=!row.classList.contains('expanded');setActivityExpanded(row,next,true);if(command)updateCommandRowSummary(row,item,data,next)}:null;row.onkeydown=expandable?event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();row.click()}}:null;if(!command&&!reasoning){if(data.active)mountMotion(row,data.animation);else stopMotion(row,data.tone)}updateActivitySummary(activity)}
function diffForTurn(turnId){return state.turnDiffs.get(turnId)||null}
function recordTurnReview(turnId,raw,source='fileChange'){if(!turnId||!raw)return null;const existing=state.turnDiffs.get(turnId);if(source!=='native'&&existing?.source==='native')return existing;const review=parseUnifiedDiff(raw);if(!review.hasChanges)return null;review.turnId=turnId;review.raw=raw;review.source=source;state.turnDiffs.set(turnId,review);state.activeReview=review;renderChanges();turnPresentation.update(turnId);return review}
function syncTurnReviewFromItems(turnId){const items=state.activityItems.get(turnId),changes=items?[...items.values()].flatMap(item=>item?.type==='fileChange'&&Array.isArray(item.changes)?item.changes:[]):[],raw=unifiedDiffFromFileChanges(changes);if(raw)recordTurnReview(turnId,raw)}
function saveReviewPreferences(){localStorage.setItem('codex-webui-review-preferences',JSON.stringify(reviewPreferences));dispatchEvent(new Event('codex-webui:preferences'))}
function reviewLineHtml(line){if(!line)return '<div class="review-line empty"><span class="review-sign"></span><code></code></div>';return `<div class="review-line ${line.type}"><span class="review-sign">${line.type==='add'?'+':line.type==='delete'?'−':' '}</span><code>${escapeHtml(line.text)}</code></div>`}
function reviewHunkHtml(hunk){if(reviewPreferences.mode==='split'){return `<div class="review-split-lines">${splitDiffHunk(hunk).map(row=>`<div class="review-split-row"><div class="review-side old">${reviewLineHtml(row.left)}</div><div class="review-side new">${reviewLineHtml(row.right)}</div></div>`).join('')}</div>`}return `<div class="review-lines">${hunk.lines.map(reviewLineHtml).join('')}</div>`}
function syncReviewControls(review){const has=!!review?.hasChanges;$('#reviewMode').disabled=!has;$('#reviewWrap').disabled=!has;$('#reviewExpand').disabled=!has;$('#reviewPatch').disabled=!state.config.capabilities?.reviewWrite||!has||!state.active?.id||!review?.turnId;$('#reviewMode').title=reviewPreferences.mode==='unified'?'Switch to split diff':'Switch to unified diff';$('#reviewWrap').title=reviewPreferences.wrap?'Disable word wrap':'Enable word wrap';$('#reviewExpand').title=reviewPreferences.expanded?'Collapse all diffs':'Expand all diffs';$('#reviewPatch').title=reviewPatchState==='undo'?'Undo changes':'Reapply changes';$('#reviewPatch').innerHTML=codexIcon(reviewPatchState==='undo'?'undo':'redo')}
function renderChanges(){const list=$('#changeList'),review=state.activeReview||[...state.turnDiffs.values()].at(-1)||null,reviewVisible=document.body.classList.contains('side-panel-open')&&!$('#reviewPanelContent').hidden;document.body.classList.toggle('review-split-open',reviewVisible&&reviewPreferences.mode==='split'&&!!review?.hasChanges&&innerWidth>1200);list.dataset.mode=reviewPreferences.mode;list.classList.toggle('wrap',reviewPreferences.wrap);if(review?.hasChanges){$('#changeCount').textContent=review.fileCount;$('#changeSummary').textContent=`${review.fileCount} changed file${review.fileCount===1?'':'s'}`;$('#reviewStats').innerHTML=`<span class="plus">+${review.linesAdded}</span><span class="minus">−${review.linesDeleted}</span>`;list.innerHTML='';for(const file of review.files){const section=document.createElement('section');section.className='review-file';section.dataset.path=file.path;section.innerHTML=`<button class="review-file-head" aria-expanded="${reviewPreferences.expanded}">${codexIcon('chevronDown','review-chevron')}<span class="review-file-name">${escapeHtml(shortPath(file.path))}</span><span class="review-file-stats"><span class="plus">+${file.linesAdded}</span><span class="minus">−${file.linesDeleted}</span></span></button><div class="review-hunks"${reviewPreferences.expanded?'':' hidden'}></div>`;const body=section.querySelector('.review-hunks');for(const hunk of file.hunks){const h=document.createElement('div');h.className='review-hunk';h.innerHTML=`<div class="review-hunk-head">${escapeHtml(hunk.header)}</div>${reviewHunkHtml(hunk)}`;body.append(h)}section.querySelector('.review-file-head').onclick=e=>{const open=e.currentTarget.getAttribute('aria-expanded')==='true';e.currentTarget.setAttribute('aria-expanded',String(!open));body.hidden=open};list.append(section)}syncReviewControls(review);return}$('#reviewStats').textContent='';$('#changeCount').textContent=state.changes.size;$('#changeSummary').textContent=state.changes.size?`${state.changes.size} changed file${state.changes.size===1?'':'s'}`:'No changes yet';list.innerHTML='';for(const [path,ch] of state.changes){const el=document.createElement('div');el.className='change-item';el.innerHTML=`<div class="change-path">${icons.file}<span>${escapeHtml(shortPath(path))}</span></div><div class="change-stats"><span class="plus">+${ch.additions||0}</span> <span class="minus">−${ch.deletions||0}</span></div>`;list.append(el)}if(!state.changes.size)list.innerHTML='<div class="panel-empty">Changes made by Codex will appear here.</div>';syncReviewControls(null)}
async function applyActiveReviewPatch(){if(!state.config.capabilities?.reviewWrite){toast(t('Review writes are disabled by the server'));return}const review=state.activeReview;if(!review?.turnId||!state.active?.id)return;const action=reviewPatchState,button=$('#reviewPatch');button.disabled=true;button.innerHTML=codexIcon('loaderCircle','review-loading');try{const response=await fetch('/api/review/patch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({threadId:state.active.id,turnId:review.turnId,action})}),result=await response.json();if(!response.ok)throw new Error(result.error||'Review patch failed');reviewPatchState=action==='undo'?'reapply':'undo';toast(action==='undo'?'Changes reverted':'Changes reapplied')}catch(error){toast(error.message)}finally{syncReviewControls(review)}}
function applyTerminalInteraction(p){const itemId=String(p.itemId),current=state.activityItems.get(p.turnId)?.get(itemId);if(current?.type!=='commandExecution')return;let buffer=current.terminalInputBuffer||'',commands=[];for(const char of String(p.stdin||'')){if(char==='\r'||char==='\n'){const command=buffer.trim();if(command)commands.push(command);buffer='';continue}if(char==='\u0003'){buffer='';continue}if(char==='\b'||char==='\u007f'){buffer=buffer.slice(0,-1);continue}buffer+=char}const actions=[...(current.commandActions||[]),...commands.map(command=>({type:'unknown',command}))];upsertItem({...current,status:'inProgress',terminalInputBuffer:buffer,commandActions:actions},p.turnId)}

function onNotification(method,p){
  sideChat.notify(method,p);
  if(method==='host/delivery/changed'||method==='host/submissions/changed'){composerDelivery?.notification();return;}
  if(method==='thread/goal/updated'&&p.threadId===state.active?.id){state.goalMode=p.goal?.status==='active';refreshComposerPlaceholder();}
  if(method==='serverRequest/resolved'){removeServerRequest(p.requestId);return}
  if(['turn/completed','thread/status/changed'].includes(method))workspaceNavigation.notify(p.threadId);
  if(method==='turn/completed')composerDelivery?.snapshot(p.threadId||state.active?.id,p.turn);
  if(isForeignConversationEvent(method,p,state.active?.id)){if(method==='turn/completed'){maybeNotifyTaskCompleted(p);refreshThreadsSoon()}return}
  // The initial read owns the history surface until it is fully rendered.
  // Reconcile from the native latest-turn snapshot afterwards rather than
  // replaying deltas that may already be included in the read response.
  if(conversationLoad && /^(item\/|turn\/|thread\/status\/changed$)/.test(method)){
    if(method==='turn/completed'){maybeNotifyTaskCompleted(p);refreshThreadsSoon()}
    return;
  }
  if(method==='account/updated')loadAccount(true);
  else if(method==='thread/started'){if(!p.thread.ephemeral){state.threads.unshift(p.thread);renderThreads()}}
  else if(method==='thread/name/updated'){const t=state.threads.find(x=>x.id===p.threadId);if(t)t.name=p.name;renderThreads();renderHeader()}
  else if(method==='turn/started'){if(!p.threadId||p.threadId===state.active?.id)setActiveTurnId(p.turn?.id||'');scheduleActiveThreadSync(0)}
  else if(method==='item/started')upsertItem({...p.item,status:'inProgress'},p.turnId);
  else if(method==='item/completed'){const status=['failed','declined','interrupted','cancelled','canceled'].includes(p.item?.status)?p.item.status:'completed';upsertItem({...p.item,status},p.turnId)}
  else if(method==='item/agentMessage/delta'){let el=state.items.get(p.itemId);if(!el){upsertItem({id:p.itemId,type:'agentMessage',text:''},p.turnId);el=state.items.get(p.itemId)}const body=el.querySelector('.message-text');body.dataset.raw=(body.dataset.raw||'')+p.delta;body.innerHTML=renderAssistantMarkdown(body.dataset.raw,{cwd:imageCwd()});scrollBottom()}
  else if(method==='item/reasoning/summaryPartAdded')upsertReasoningDelta(p,null);
  else if(method==='item/reasoning/summaryTextDelta')upsertReasoningDelta(p,'summary');
  else if(method==='item/reasoning/textDelta')upsertReasoningDelta(p,'content');
  else if(method==='item/commandExecution/outputDelta'){const turn=state.turns.get(p.turnId),row=turn?.querySelector(`[data-item-id="${CSS.escape(p.itemId)}"]`),item=state.activityItems.get(p.turnId)?.get(String(p.itemId));if(item)item.aggregatedOutput=(item.aggregatedOutput||'')+(p.delta||'');if(row){const target=row.nextElementSibling.querySelector('.command-shell-output pre')||row.nextElementSibling;target.textContent=(target.classList.contains('empty')?'':target.textContent||'')+(p.delta||'');target.classList.remove('empty')}}
  else if(method==='item/commandExecution/terminalInteraction')applyTerminalInteraction(p)
  else if(method==='item/fileChange/outputDelta'){const itemId=String(p.itemId),current=state.activityItems.get(p.turnId)?.get(itemId),item=current?.type==='fileChange'?{...current,status:'inProgress'}:{id:itemId,type:'fileChange',status:'inProgress',changes:[]};item.aggregatedOutput=(item.aggregatedOutput||'')+(p.delta||'');upsertItem(item,p.turnId)}
  else if(method==='item/fileChange/patchUpdated'){const itemId=String(p.itemId),current=state.activityItems.get(p.turnId)?.get(itemId),item=current?.type==='fileChange'?{...current,status:'inProgress',changes:p.changes||[]}:{id:itemId,type:'fileChange',status:'inProgress',changes:p.changes||[]};upsertItem(item,p.turnId)}
  else if(method==='turn/diff/updated'){if(p.threadId&&state.active?.id&&p.threadId!==state.active.id)return;recordTurnReview(p.turnId,p.diff||'','native')}
  else if(method==='turn/completed'){if((!p.threadId||p.threadId===state.active?.id)&&(!p.turn?.id||activeTurnId()===p.turn.id))setActiveTurnId('');if(p.turn?.items)for(const i of p.turn.items)upsertItem(i,p.turn.id);if(p.turn?.id){syncWorkedForDivider(p.turn.id,turnDurationMs(p.turn));turnPresentation.update(p.turn.id,true);}maybeNotifyTaskCompleted(p);scheduleActiveThreadSync(0);refreshThreadsSoon()}
  else if(method==='thread/tokenUsage/updated'){const threadId=p.threadId||state.active?.id;if(threadId&&p.tokenUsage)state.tokenUsage.set(threadId,p.tokenUsage);if(threadId===state.active?.id)renderContextUsage()}
  else if(method==='thread/status/changed'){if(p.threadId===state.active?.id){state.active.status=p.status;scheduleActiveThreadSync(0)}refreshThreadsSoon()}
  else if(method==='error')toast(p.error?.message||p.message||'Codex error');
  runtimeProgress.notify(method,p);
}
function upsertReasoningDelta(p,field){const itemId=String(p.itemId),items=state.activityItems.get(p.turnId),current=items?.get(itemId),item=current?.type==='reasoning'?{...current,status:'inProgress'}:{id:itemId,type:'reasoning',status:'inProgress',summary:[],content:[]};if(field){const index=field==='summary'?(p.summaryIndex??0):(p.contentIndex??0),parts=Array.isArray(item[field])?[...item[field]]:[];while(parts.length<=index)parts.push('');parts[index]=(parts[index]||'')+(p.delta||'');item[field]=parts}upsertItem(item,p.turnId);scrollBottom()}
function setApprovalWaiting(group,itemId,waiting){if(!group)return;const row=itemId?group.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`):null,summary=group.querySelector('.activity-summary-copy');group.classList.toggle('waiting-approval',waiting);if(waiting){summary.textContent='Waiting for approval';summary.classList.remove('loading-shimmer');if(row){row.querySelector('.activity-name')?.classList.remove('loading-shimmer');state.motion.get(row)?.pause()}}else{if(row){row.querySelector('.activity-name')?.classList.add('loading-shimmer');state.motion.get(row)?.play()}updateActivitySummary(group)}}
function approvalIcon(kind){return kind==='network'?codexIcon('globe'):kind==='patch'?codexIcon('fileDiff'):kind==='permission'?codexIcon('shield'):codexIcon('terminal')}
function approvalBody(model,p){if(model.kind==='exec'||model.kind==='network')return `<div class="approval-command"><code>${escapeHtml(p.command||model.title)}</code></div>`;if(model.kind==='patch'){const review=diffForTurn(p.turnId);return review?.hasChanges?`<button type="button" class="approval-review-link">${codexIcon('fileDiff')}<span>Review ${review.fileCount} changed file${review.fileCount===1?'':'s'}</span><span class="plus">+${review.linesAdded}</span><span class="minus">−${review.linesDeleted}</span></button>`:''}return permissionRows(p.permissions).map(row=>`<div class="permission-row"><span>${escapeHtml(row.label)}</span><code>${escapeHtml(shortPath(row.value))}</code></div>`).join('')}
function removeServerRequest(id){const request=state.serverRequests.get(id),p=request?.params,turn=p?.turnId&&state.turns.get(p.turnId),row=p?.itemId&&turn?.querySelector(`[data-item-id="${CSS.escape(String(p.itemId))}"]`);if(row)setApprovalWaiting(row.closest('.activity-group'),p.itemId,false);sideChat.resolveRequest(id);state.requestCards.get(id)?.remove();state.requestCards.delete(id);state.serverRequests.delete(id);renderThreads();runtimeProgress.refresh()}
function renderPendingRequests(){for(const request of state.serverRequests.values())void onServerRequest(request)}
async function syncPendingRequests(){
  try{const result=await rpc('host/requests/list');const ids=new Set((result.data||[]).map(request=>request.id));for(const id of state.serverRequests.keys())if(!ids.has(id))removeServerRequest(id);for(const request of result.data||[])await onServerRequest(request)}catch{}
}
async function onServerRequest(req){const old=state.serverRequests.get(req.id);if(old&&old.requestEpoch!==req.requestEpoch)removeServerRequest(req.id);state.serverRequests.set(req.id,req);runtimeProgress.refresh();workspaceNavigation.notify(req.params?.threadId);renderThreads();if(sideChat.handleRequest(req))return;const p=req.params||{};if(p.threadId&&p.threadId!==state.active?.id)return;if(conversationLoad)return;if(state.requestCards.get(req.id)?.isConnected)return;if(req.method==='item/tool/requestUserInput'){const card=createUserInputCard(req,{translate:t,onSubmit:async result=>{await respondToCodex(req.id,result,undefined,req.requestEpoch);removeServerRequest(req.id)}});$('#conversation').append(card);state.requestCards.set(req.id,card);scrollBottom();return}if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(req.method)){void respondToCodex(req.id,null,{code:-32601,message:'Unsupported request'},req.requestEpoch).catch(error=>{if(!error?.silentTransportSwitch)toast(error.message)});return}const group=ensureActivity(p.turnId||'approval',$('#conversation'),p.itemId),model=buildApprovalModel(req),card=document.createElement('section');card.className='approval-card';card.dataset.codexApprovalSurface='';card.innerHTML=`<div class="approval-content"><div class="approval-identity">${approvalIcon(model.kind)}<span>${escapeHtml(model.identity)}</span></div><div class="approval-title">${escapeHtml(model.title)}</div>${model.subtitle?`<div class="approval-subtitle">${escapeHtml(shortPath(model.subtitle))}</div>`:''}${model.reason?`<div class="approval-reason"><span>Reason</span><p>${escapeHtml(model.reason)}</p></div>`:''}</div><div class="approval-body">${approvalBody(model,p)}</div><form class="approval-actions">${model.leading?`<button type="button" class="approval-leading">${escapeHtml(model.leading.label)}</button>`:''}<div class="approval-actions-main"><button type="button" class="approval-deny">${escapeHtml(model.deny.label)}</button>${model.scoped?`<div class="approval-split"><button type="submit" class="approval-primary" autofocus>${escapeHtml(model.primary.label)}</button><button type="button" class="approval-menu-toggle" aria-label="Approval options" aria-expanded="false">${codexIcon('chevronDown')}</button><div class="approval-menu" hidden><button type="button" class="approval-scoped">${escapeHtml(model.scoped.label)}</button></div></div>`:`<button type="submit" class="approval-primary" autofocus>${escapeHtml(model.primary.label)}</button>`}</div></form>`;group.after(card);state.requestCards.set(req.id,card);setApprovalWaiting(group,p.itemId,true);const answer=(decision)=>{setApprovalWaiting(group,p.itemId,decision!==model.deny.decision);card.querySelectorAll('button').forEach(b=>b.disabled=true);respondToCodex(req.id,model.kind==='permission'?decision:{decision},undefined,req.requestEpoch).then(()=>removeServerRequest(req.id)).catch(error=>{if(card.isConnected)card.querySelectorAll('button').forEach(b=>b.disabled=false);if(!error?.silentTransportSwitch)toast(error.message)})};card.querySelector('form').onsubmit=e=>{e.preventDefault();answer(model.primary.decision)};card.querySelector('.approval-deny').onclick=()=>answer(model.deny.decision);card.querySelector('.approval-scoped')?.addEventListener('click',()=>answer(model.scoped.decision));card.querySelector('.approval-leading')?.addEventListener('click',()=>answer(model.leading.decision));card.querySelector('.approval-review-link')?.addEventListener('click',()=>openReviewPanel(diffForTurn(p.turnId)));const menuToggle=card.querySelector('.approval-menu-toggle'),menu=card.querySelector('.approval-menu');menuToggle?.addEventListener('click',()=>{const open=menu.hidden;menu.hidden=!open;menuToggle.setAttribute('aria-expanded',String(open))});scrollBottom()}
const slashCommandCatalog=[
  {id:'side',title:'Side chat',description:'Ask about the current chat without interrupting it',icon:'messageSquare'},
  {id:'model',title:'Model',description:'Choose model and reasoning effort',icon:'wrench'},
  {id:'plan',title:'Plan mode',description:'Turn plan mode on',icon:'list'},
  {id:'project',title:'Project',description:'Choose project for new tasks',icon:'folderOpen'},
  {id:'reasoning',title:'Reasoning',description:'Choose reasoning effort',icon:'wrench'},
  {id:'init',title:'Init',description:'Create an AGENTS.md file with instructions for Codex',icon:'file'},
  {id:'mcp',title:'MCP',description:'Show MCP server status',icon:'wrench'},
  {id:'compact',title:'Compact',description:"Compact this task's context",icon:'list',requiresThread:true},
  {id:'status',title:'Status',description:'Show task id, context usage, and rate limits',icon:'info',requiresThread:true},
];
function closeComposerAutocomplete(){const menu=$('#composerAutocomplete');autocompleteState.requestId++;menu.hidden=true;menu.replaceChildren();delete menu.dataset.type;autocompleteState.match=null;autocompleteState.items=[];autocompleteState.selected=0;autocompleteState.message=''}
function renderComposerAutocomplete(){const menu=$('#composerAutocomplete'),items=autocompleteState.items;menu.innerHTML='';menu.dataset.type=autocompleteState.match?.type||'';menu.setAttribute('aria-label',autocompleteState.match?.type==='slash'?'Slash command menu':'Mention menu');if(!items.length){const empty=document.createElement('div');empty.className='autocomplete-empty';empty.textContent=autocompleteState.message||(autocompleteState.match?.type==='mention'?'Type to search for files':'No commands');menu.append(empty)}else for(const[index,item]of items.entries()){const button=document.createElement('button');button.type='button';button.className='autocomplete-item'+(index===autocompleteState.selected?' selected':'');button.dataset.autocompleteId=item.id;button.role='option';button.setAttribute('aria-selected',String(index===autocompleteState.selected));button.innerHTML=`${codexIcon(item.icon||'file')}<span class="autocomplete-copy"><strong class="autocomplete-title">${escapeHtml(item.title)}</strong><small class="autocomplete-description">${escapeHtml(item.description)}</small></span>`;button.onpointerdown=event=>event.preventDefault();button.onclick=()=>selectComposerAutocomplete(index);menu.append(button)}menu.hidden=false}
function currentComposerCwd(){if(state.projectless&&!state.active)return'';const path=state.active?.cwd||$('#projectPath').textContent||state.config.defaultCwd;return path.startsWith('~')?state.config.home+path.slice(1):path}
async function searchMentionSuggestions(match){const query=match.query.trim(),requestId=++autocompleteState.requestId;if(!query){autocompleteState.items=[];autocompleteState.message=state.projectless&&!state.active?'Choose a project to mention files':'Type to search for files';renderComposerAutocomplete();return}const tasks=state.threads.filter(thread=>titleOf(thread).toLowerCase().includes(query.toLowerCase())).slice(0,5).map(thread=>({id:`task:${thread.id}`,source:'task',threadId:thread.id,title:titleOf(thread),description:`Task · ${shortPath(thread.cwd)}`,icon:'messageSquare'})),cwd=currentComposerCwd();if(!cwd){autocompleteState.items=[{id:'choose-project',source:'action',title:'Choose project',description:'Select a project to mention files',icon:'folderOpen'},...tasks];autocompleteState.selected=0;autocompleteState.message='';renderComposerAutocomplete();return}autocompleteState.items=[];autocompleteState.message='Searching files…';renderComposerAutocomplete();try{const response=await fetch(`/api/files/search?cwd=${encodeURIComponent(cwd)}&query=${encodeURIComponent(query)}`,{cache:'no-store'}),data=await response.json();if(!response.ok)throw new Error(data.error||'File search unavailable');if(requestId!==autocompleteState.requestId||autocompleteState.match?.type!=='mention'||autocompleteState.match.query!==match.query)return;const files=(data.items||[]).map(item=>{const parts=item.path.split('/');return{id:`${item.kind}:${item.path}`,source:item.kind,path:item.path,title:parts.at(-1),description:parts.length>1?parts.slice(0,-1).join('/'):(item.kind==='folder'?'Folder':'File'),icon:item.kind==='folder'?'folderOpen':'file'}});autocompleteState.items=[...files,...tasks];autocompleteState.selected=0;autocompleteState.message=autocompleteState.items.length?'':'No files or tasks found';renderComposerAutocomplete()}catch(error){if(requestId!==autocompleteState.requestId)return;autocompleteState.items=tasks;autocompleteState.message=tasks.length?'':error.message;renderComposerAutocomplete()}}
function updateComposerAutocomplete(){const input=$('#prompt'),match=getComposerAutocomplete(input.value,input.selectionStart??input.value.length);if(!match){closeComposerAutocomplete();return}autocompleteState.match=match;autocompleteState.selected=0;if(match.type==='slash'){autocompleteState.requestId++;const query=match.query.trim().toLowerCase();autocompleteState.items=slashCommandCatalog.filter(item=>(!item.requiresThread||state.active)&&(item.id.includes(query)||item.title.toLowerCase().includes(query)));autocompleteState.message='';renderComposerAutocomplete();return}searchMentionSuggestions(match)}
function moveComposerAutocomplete(delta){if(!autocompleteState.items.length)return;autocompleteState.selected=(autocompleteState.selected+delta+autocompleteState.items.length)%autocompleteState.items.length;renderComposerAutocomplete()}
function setPlanMode(active){state.planMode=Boolean(active);refreshComposerPlaceholder();syncPermissionControl()}
function applyAutocompleteToken(match,replacement){const input=$('#prompt'),result=applyComposerSuggestion(input.value,match,replacement);input.value=result.text;input.setSelectionRange(result.cursor,result.cursor);resizePrompt()}
function renderContextTray(){const tray=$('#composerContextTray');tray.innerHTML='';for(const mention of state.composerMentions){const chip=document.createElement('div');chip.className='composer-context-chip';chip.dataset.contextId=mention.id;chip.innerHTML=`${attachmentThumbnail(mention)||codexIcon(mention.icon||'file')}<span>${escapeHtml(mention.title)}</span><button type="button" aria-label="Remove ${escapeHtml(mention.title)}">${codexIcon('x')}</button>`;chip.lastElementChild.onclick=()=>{state.composerMentions=state.composerMentions.filter(item=>item.id!==mention.id);renderContextTray();syncComposerSubmitState()};tray.append(chip)}tray.hidden=!state.composerMentions.length;saveComposerDraft()}
function selectComposerAutocomplete(index=autocompleteState.selected){const item=autocompleteState.items[index],match=autocompleteState.match;if(!item||!match)return;const id=item.id;if(item.source==='action'&&id==='choose-project'){closeComposerAutocomplete();openFolderPicker()}else if(item.source==='file'||item.source==='folder'){applyAutocompleteToken(match,`@${item.path}`);if(!state.composerMentions.some(mention=>mention.id===item.id))state.composerMentions.push({...item});renderContextTray();closeComposerAutocomplete()}else if(item.source==='task'){applyAutocompleteToken(match,`@${item.title}`);if(!state.composerMentions.some(mention=>mention.id===item.id))state.composerMentions.push({...item});renderContextTray();closeComposerAutocomplete()}else{if(id==='side'){closeComposerAutocomplete();$('#prompt').value='';resizePrompt();saveComposerDraft();beginSideChat();return;}if(id==='init')applyAutocompleteToken(match,'/init');closeComposerAutocomplete();if(id==='plan'){setPlanMode(!state.planMode);$('#prompt').value='';resizePrompt()}else if(id==='model'){ $('#prompt').value='';resizePrompt();openModelMenu()}else if(id==='reasoning'){ $('#prompt').value='';resizePrompt();openModelMenu()}else if(id==='project'){ $('#prompt').value='';resizePrompt();openFolderPicker()}else if(id==='mcp'){ $('#prompt').value='';resizePrompt();toast('MCP status requires the native desktop status surface.')}else if(id==='compact'){ $('#prompt').value='';resizePrompt();toast('Compact requires the native desktop command bridge.')}else if(id==='status'){ $('#prompt').value='';resizePrompt();toast(state.active?.id?`Task ${state.active.id}`:'No active task')}}requestAnimationFrame(()=>$('#prompt').focus())}
function handlePromptInput(){resizePrompt();updateComposerAutocomplete()}
function handlePromptKeydown(event){if(event.isComposing||event.keyCode===229)return;const open=!$('#composerAutocomplete').hidden;if(open){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();moveComposerAutocomplete(event.key==='ArrowDown'?1:-1);return}if((event.key==='Enter'&&!event.shiftKey)||event.key==='Tab'){event.preventDefault();selectComposerAutocomplete();return}if(event.key==='Escape'){event.preventDefault();closeComposerAutocomplete();return}}if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229&&(sendKey()==='enter'||event.metaKey||event.ctrlKey)){event.preventDefault();$('#composer').requestSubmit()}}
async function submitPrompt(event){
  event.preventDefault();
  if(accessSession?.required||composerSubmission||composerAttachments.busy)return;
  closeComposerAutocomplete();closePermissionMenu();
  if(conversationLoad)return;
  const input=$('#prompt'),rawText=input.value,text=rawText.trim(),turnId=activeTurnId();
  if(/^\/side(?:\s|$)/.test(text)){input.value='';resizePrompt();saveComposerDraft();beginSideChat(text.replace(/^\/side\s*/,''));return;}
  const hasAttachments=state.composerMentions.some(item=>item.source==='attachment'||item.source==='skill');if(!text&&!turnId&&!hasAttachments)return;
  saveComposerDraft();
  const navigationId=threadNavigationRequestGate.current(),target=state.active?{...state.active}:null;
  const model=state.selectedModel,effort=$('#effortSelect').value,planMode=state.planMode;
  const cwd=target?.cwd||$('#projectPath').textContent.replace(/^~/,state.config.home),projectless=state.projectless;
  const threadPolicy=permissionThreadPolicy(),turnPolicy=permissionTurnPolicy(cwd);
  const submitted={text:rawText,mentions:state.composerMentions.map(item=>({...item}))};
  let draftKey=composerDraftKey,targetId=target?.id,optimistic=null,resumed=false,submissionId=crypto.randomUUID(),submissionAttempted=false;
  const isCurrent=()=>threadNavigationRequestGate.isCurrent(navigationId)&&state.active?.id===targetId;
  const ensureCurrent=()=>{if(!isCurrent())throw Object.assign(new Error('Conversation changed. Your message was kept as a draft; it was not sent.'),{navigationCancelled:true})};
  function restoreInput(){
    saveComposerDraft();
    composerDrafts.set(draftKey,mergeComposerDrafts(submitted,composerDrafts.get(draftKey)));
    if(composerDraftKey===draftKey)restoreComposerDraft(draftKey);
    if(accessSession?.required)accessSession.preserveDraft();
  }
  async function resumeTarget(){
    const result=await rpc('thread/resume',{threadId:targetId});
    ensureCurrent();
    state.active={...state.active,...result.thread};renderHeader();resumed=true;
  }
  composerSubmission={navigationId};syncComposerSubmitState();
  try{
    if(turnId&&!text&&!hasAttachments){if(targetId)await rpc('turn/interrupt',{threadId:targetId,turnId});return}

    input.value='';state.composerMentions=[];renderContextTray();resizePrompt();
    const uploaded=await composerAttachments.prepare(submitted.mentions,cwd,targetId);ensureCurrent();
    const skills=await composerTools.prepare(submitted.mentions,cwd);ensureCurrent();
    const fullText=[text,...uploaded.map(item=>`Attached file ${JSON.stringify(item.name)}: ${item.path}`)].filter(Boolean).join('\n');
    const nativeInput=[...(fullText?[{type:'text',text:fullText,text_elements:[]}]:[]),...uploaded.filter(item=>item.image).map(item=>({type:'localImage',path:item.path})),...skills];
    if(turnId&&composerDelivery.mode==='queue'){
      await composerAttachments.prepare(submitted.mentions,cwd,targetId,true);ensureCurrent();
      submissionAttempted=true;
      await composerDelivery.enqueue({id:submissionId,threadId:targetId,...submitted,params:{threadId:targetId,input:nativeInput,model,effort,collaborationMode:collaborationMode(planMode,model,effort),cwd,...turnPolicy}});
      return;
    }
    if(turnId){
      if(target?.canAcceptDirectInput!==true)await resumeTarget();
      ensureCurrent();
      await composerAttachments.prepare(submitted.mentions,cwd,targetId,true);ensureCurrent();
      try{submissionAttempted=true;await rpc('turn/steer',{threadId:targetId,expectedTurnId:turnId,input:nativeInput,clientUserMessageId:submissionId})}
      catch(error){
        if(resumed||bridgeErrorCode(error)!==THREAD_NOT_FOUND)throw error;
        // Retry only a definitive missing-thread rejection, never an uncertain send.
        ensureCurrent();await resumeTarget();ensureCurrent();
        submissionId=crypto.randomUUID();await rpc('turn/steer',{threadId:targetId,expectedTurnId:turnId,input:nativeInput,clientUserMessageId:submissionId});
      }
      return;
    }
    if(!target){
      const result=await rpc('thread/start',{cwd,model,...threadPolicy,sessionStartSource:'startup'});
      ensureCurrent();
      // Transfer any typing done while creation was pending to the new thread.
      saveComposerDraft();const newer=composerDrafts.get(draftKey);composerDrafts.remove(draftKey);
      state.active={...result.thread,projectless};targetId=state.active.id;draftKey=threadDraftKey(targetId);
      composerDrafts.set(draftKey,newer);restoreComposerDraft(draftKey);rememberActiveThread(targetId);
      state.threads=[state.active,...state.threads.filter(thread=>thread.id!==targetId)];
      renderContextUsage();renderHeader();renderThreads();$('#conversation').innerHTML='';
    }else if(target.canAcceptDirectInput!==true)await resumeTarget();
    ensureCurrent();
    await composerAttachments.prepare(submitted.mentions,cwd,targetId,true);ensureCurrent();
    const item={id:'local-'+crypto.randomUUID(),type:'userMessage',content:nativeInput};
    upsertItem(item,'optimistic');optimistic={id:item.id,node:state.items.get(item.id)};
    submissionAttempted=true;
    const result=await rpc('turn/start',{threadId:targetId,input:nativeInput,clientUserMessageId:submissionId,model,effort,collaborationMode:collaborationMode(planMode,model,effort),cwd,...turnPolicy});
    if(isCurrent()&&result?.turn)syncTurnRuntime(result.turn);
  }catch(error){
    if(optimistic){optimistic.node?.remove();if(state.items.get(optimistic.id)===optimistic.node)state.items.delete(optimistic.id)}
    const uncertain=submissionAttempted&&(error?.silentTransportSwitch||['SUBMISSION_UNKNOWN','RPC_TIMEOUT','RPC_DISCONNECTED'].includes(String(error?.code))||['AbortError','TimeoutError','TypeError','SyntaxError'].includes(error?.name));
    if(uncertain){composerDelivery.uncertain({id:submissionId,threadId:targetId,text:submitted.text,mentions:submitted.mentions});void composerDelivery.sync();}
    else if(text||hasAttachments)restoreInput();
    if(uncertain)toast(t('Delivery uncertain; check status'),5200);
    else if(!error?.silentTransportSwitch)toast(t(error.navigationCancelled?error.message:threadInputErrorMessage(error)),5200);
  }finally{composerSubmission=null;syncComposerSubmitState()}
}
async function importLegacyQueuedMessage(entry){
  if(entry.threadId!==state.active?.id)throw Error(t('Open the conversation before importing its paused messages.'));
  const cwd=entry.cwd||state.active?.cwd;
  const uploaded=await composerAttachments.prepare(entry.mentions||[],cwd,entry.threadId,true);
  const skills=await composerTools.prepare(entry.mentions||[],cwd);
  const text=[String(entry.text||'').trim(),...uploaded.map(item=>`Attached file ${JSON.stringify(item.name)}: ${item.path}`)].filter(Boolean).join('\n');
  const input=[...(text?[{type:'text',text,text_elements:[]}]:[]),...uploaded.filter(item=>item.image).map(item=>({type:'localImage',path:item.path})),...skills];
  await composerDelivery.enqueue({id:entry.id,threadId:entry.threadId,text:entry.text,mentions:entry.mentions||[],paused:true,params:{threadId:entry.threadId,input,model:entry.model,effort:entry.effort,collaborationMode:collaborationMode(entry.planMode,entry.model,entry.effort),cwd,...entry.turnPolicy}});
}
function invalidatePendingApprovals(){
  if(state.serverRequests.size)toast(t('Pending approvals from the earlier connection are no longer actionable. Native approval recovery may be unavailable.'),7000);
  for(const id of [...state.serverRequests.keys()])removeServerRequest(id);
}
function threadSummarySignature(threads){return JSON.stringify(threads.map(thread=>[thread.id,thread.updatedAt,thread.recencyAt,thread.status]))}
function applyThreadSummaries(threads){const nextSignature=threadSummarySignature(threads),changed=nextSignature!==threadListSignature;threadListSignature=nextSignature;state.threads=threads;const summary=state.active&&threads.find(thread=>thread.id===state.active.id);if(summary){const turns=state.active.turns;state.active={...state.active,...summary,turns};if(summary.status?.type==='active')scheduleActiveThreadSync(0)}if(changed)renderThreads()}
function scheduleThreadListRefresh(delay=THREAD_LIST_POLL_MS){if(accessSession?.required)return;clearTimeout(threadListTimer);threadListTimer=setTimeout(refreshThreadList,document.visibilityState==='hidden'?Math.max(delay,8000):delay)}
async function refreshThreadList(){if(threadListInFlight){scheduleThreadListRefresh(1000);return}threadListInFlight=true;try{const result=await rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc'});applyThreadSummaries(result.data||[])}catch{}finally{threadListInFlight=false;scheduleThreadListRefresh()}}
function refreshThreadsSoon(){scheduleThreadListRefresh(600)}
function resetActiveThreadSync(){activeThreadSyncGeneration++;clearTimeout(activeThreadSyncTimer);activeThreadSyncTimer=null;activeThreadSyncSignature=''}
function scheduleActiveThreadSync(delay=ACTIVE_THREAD_SYNC_IDLE_MS){if(accessSession?.required)return;clearTimeout(activeThreadSyncTimer);if(!state.active)return;activeThreadSyncTimer=setTimeout(syncActiveThread,document.visibilityState==='hidden'?Math.max(delay,6000):delay)}
async function latestThreadTurn(threadId){try{const live=await rpc('host/thread/live',{threadId});if(live?.active&&live.turn)return live.turn}catch{}try{const result=await rpc('thread/turns/list',{threadId,limit:1,sortDirection:'desc',itemsView:'full'});return result.data?.[0]||null}catch{const result=await rpc('thread/read',{threadId,includeTurns:true});return result.thread?.turns?.at(-1)||null}}
function activeTurnId(){return $('#sendButton')?.dataset.turnId||''}
function syncComposerSubmitState(){const button=$('#sendButton');if(!button)return;const sending=Boolean(composerSubmission);button.disabled=Boolean(conversationLoad)||sending||Boolean(state.attachmentsUploading);button.setAttribute('aria-busy',String(sending));const mode=sending?'sending':activeTurnId()?($('#prompt').value.trim()||state.composerMentions.some(item=>item.source==='attachment'||item.source==='skill')?(composerDelivery?.mode==='queue'?'queue':'steer'):'stop'):'send',label=sending?'Sending message…':mode==='stop'?'Stop':mode==='steer'?'Steer':mode==='queue'?'Queue message':'Send message';button.dataset.submitMode=mode;button.classList.toggle('stop',mode==='stop');button.classList.toggle('steer',mode==='steer');button.innerHTML=codexIcon(sending?'loaderCircle':mode==='stop'?'square':'arrowUp');button.title=t(label);button.setAttribute('aria-label',t(label));composerDelivery?.refresh()}
function setActiveTurnId(turnId=''){const button=$('#sendButton');if(!button)return;button.dataset.turnId=turnId||'';syncComposerSubmitState()}
function syncTurnRuntime(turn){const active=turn?.status==='inProgress';if(active)setActiveTurnId(turn.id);else if(activeTurnId()===turn?.id)setActiveTurnId('')}
function syncTurnSnapshot(turn,threadId=state.active?.id){if(conversationLoad||!turn||!threadId||threadId!==state.active?.id)return false;const root=$('#conversation'),nearBottom=root.scrollHeight-root.scrollTop-root.clientHeight<80,turns=state.active.turns||[],index=turns.findIndex(existing=>existing.id===turn.id);if(index<0)turns.push(turn);else turns[index]=turn;state.active.turns=turns;root.querySelectorAll('.conversation-loading').forEach(node=>node.remove());renderTurn(turn,root);syncTurnRuntime(turn);if(nearBottom)scrollBottom();return true}
async function syncActiveThread(){if(activeThreadSyncInFlight||conversationLoad||!state.active){scheduleActiveThreadSync();return}const generation=activeThreadSyncGeneration,threadId=state.active.id;activeThreadSyncInFlight=true;let nextDelay=ACTIVE_THREAD_SYNC_IDLE_MS;try{const turn=await latestThreadTurn(threadId);if(generation!==activeThreadSyncGeneration||threadId!==state.active?.id)return;if(turn){runtimeProgress.confirmed(turn.id);const signature=JSON.stringify(turn);nextDelay=turn.status==='inProgress'?ACTIVE_THREAD_SYNC_ACTIVE_MS:ACTIVE_THREAD_SYNC_IDLE_MS;if(signature!==activeThreadSyncSignature){activeThreadSyncSignature=signature;syncTurnSnapshot(turn,threadId)}}}catch{}finally{activeThreadSyncInFlight=false;if(generation===activeThreadSyncGeneration&&threadId===state.active?.id)scheduleActiveThreadSync(nextDelay)}}
function resizePrompt(){saveComposerDraft();const e=$('#prompt');e.style.height='auto';e.style.height=Math.min(190,e.scrollHeight)+'px';syncComposerSubmitState()}
function scrollBottom(){if(conversationLoad)return;requestAnimationFrame(()=>{$('#conversation').scrollTop=$('#conversation').scrollHeight})}
function scrollOpenedThreadToBottom(){const root=$('#conversation'),apply=()=>{root.scrollTop=root.scrollHeight};requestAnimationFrame(()=>{apply();requestAnimationFrame(apply)})}
function escapeHtml(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function toast(text,duration=2200){const e=$('#toast');e.textContent=text;e.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove('show'),duration)}
function syncSummaryPanel(){const workspace=state.projectless?'No project':($('#projectName').textContent||'Local workspace');$('#summaryWorkspace').textContent=workspace;$('#summaryBranch').textContent=state.projectless?'':state.active?.source==='remote'?'Remote workspace':'Local workspace'}
function overlayPanelsEnabled(){return innerWidth<=720}
function setOverlayBackgroundInert(inert){
  const drawer=mobileSidebarEnabled()&&$('#sidebar').classList.contains('mobile-open');
  $('.topbar').inert=false;
  for(const child of $('.topbar').children)child.inert=inert&&!child.classList.contains('top-actions');
  for(const child of $('.top-actions').children)child.inert=inert&&child.id!=='toggleSidePanel';
  $('#sidebar').inert=inert||(mobileSidebarEnabled()?!drawer:document.body.classList.contains('sidebar-hidden'));
  for(const selector of ['.conversation-shell','.bottom-panel'])$(selector).inert=inert||drawer||document.body.classList.contains('side-panel-maximized');
}
function focusPanel(panel,closeButton){if(!overlayPanelsEnabled())return;if(mobileSidebarEnabled())setSidebarOpen(false);setOverlayBackgroundInert(true);panel.setAttribute('aria-modal','true');requestAnimationFrame(()=>closeButton.focus())}
function restorePanelFocus(panel,target){panel.setAttribute('aria-modal','false');if(!document.body.classList.contains('side-panel-open')&&!document.body.classList.contains('summary-panel-open'))setOverlayBackgroundInert(false);if(overlayPanelsEnabled()&&target?.isConnected)requestAnimationFrame(()=>target.focus())}
function syncOverlayPanelMode(){const overlay=overlayPanelsEnabled(),sideOpen=document.body.classList.contains('side-panel-open'),summaryOpen=document.body.classList.contains('summary-panel-open');setOverlayBackgroundInert(overlay&&(sideOpen||summaryOpen));$('#sidePanel').setAttribute('aria-modal',String(overlay&&sideOpen));$('#summaryPanel').setAttribute('aria-modal',String(overlay&&summaryOpen));if(overlay){const panel=summaryOpen?$('#summaryPanel'):sideOpen?$('#sidePanel'):null,close=summaryOpen?$('#closeSummaryPanel'):sideOpen?$('#closeSidePanel'):null;if(panel&&close&&!panel.contains(document.activeElement))requestAnimationFrame(()=>close.focus())}renderChanges()}
function setSidebarOpen(open){
  const sidebar=$('#sidebar'),mobile=mobileSidebarEnabled(),restoreFocus=!open&&sidebar.contains(document.activeElement);
  if(open&&!mobile&&innerWidth<=(document.body.classList.contains('side-chat-open')?1200:1000)){if(document.body.classList.contains('side-panel-open'))setSidePanelOpen(false);if(document.body.classList.contains('summary-panel-open'))setSummaryPanelOpen(false);}
  sidebar.removeAttribute('data-swiping');sidebar.style.removeProperty('--drawer-offset');
  $('#sidebarBackdrop').hidden=!mobile||!open;
  document.body.classList.toggle('sidebar-hidden',!mobile&&!open);
  sidebar.classList.toggle('mobile-open',mobile&&open);
  const visible=mobile?open:!document.body.classList.contains('sidebar-hidden');
  setOverlayBackgroundInert(overlayPanelsEnabled()&&(document.body.classList.contains('side-panel-open')||document.body.classList.contains('summary-panel-open')));
  $('#toggleSidebar').setAttribute('aria-expanded',String(visible));$('#toggleSidebar').setAttribute('aria-pressed',String(visible));
  if(!open){toggleAccountMenu(false);workspaceMenu.close();if(restoreFocus)$('#toggleSidebar').focus({preventScroll:true});}
}
installDrawerDismiss($('#sidebar'),{enabled:()=>mobileSidebarEnabled()&&$('#sidebar').classList.contains('mobile-open')&&!$('#sidebar').inert,close:()=>setSidebarOpen(false)});
function syncSidebarLayout(){document.documentElement.classList.toggle('mobile-device',(matchMedia('(pointer:coarse)').matches||navigator.maxTouchPoints>0)&&innerWidth<=980);const mobile=mobileSidebarEnabled();if(innerWidth>720&&innerWidth<=(document.body.classList.contains('side-chat-open')?1200:1000)&&(document.body.classList.contains('side-panel-open')||document.body.classList.contains('summary-panel-open')))setSidebarOpen(false);if(mobile===sidebarLayoutMobile)return;sidebarLayoutMobile=mobile;toggleAccountMenu(false);(mobile?$('#sidebar .sidebar-footer'):$('.workspace-rail')).append($('#dockAccount'));setSidebarOpen(!mobile&&!(innerWidth<=1200&&document.body.classList.contains('side-chat-open')&&document.body.classList.contains('side-panel-open')))}
function setBrowserStatus(text,tone='ready'){const status=$('#browserStatus');status.dataset.tone=tone;$('#browserStatusText').textContent=text}
function updateBrowserControls(){const current=browserState.history[browserState.index]||'';$('#browserBack').disabled=browserState.index<=0;$('#browserForward').disabled=browserState.index<0||browserState.index>=browserState.history.length-1;$('#browserRefresh').disabled=!current;for(const link of [$('#browserOpenExternal'),$('#browserNoticeExternal')]){link.hidden=!current;if(current)link.href=current}}
function showBrowserNotice(title,description){$('#browserNoticeTitle').textContent=title;$('#browserNoticeDescription').textContent=description;$('#browserNotice').hidden=false;$('#browserLoading').hidden=true;$('#browserFrameShell').setAttribute('aria-busy','false');setBrowserStatus(title,'error')}
function finishBrowserLoad(requestId){if(requestId!==browserState.loadRequest)return;clearTimeout(browserState.loadTimer);$('#browserLoading').hidden=true;$('#browserNotice').hidden=true;$('#browserFrameShell').setAttribute('aria-busy','false');setBrowserStatus('Loaded. If the page is blank, the site may block embedding.','loaded')}
function navigateBrowser(value,{push=true}={}){const result=normalizeBrowserUrl(value);if(result.error){showBrowserNotice('Invalid address',result.error);$('#browserUrl').setAttribute('aria-invalid','true');return false}const url=result.url;$('#browserUrl').removeAttribute('aria-invalid');$('#browserUrl').value=url;if(push&&browserState.history[browserState.index]!==url){browserState.history=browserState.history.slice(0,browserState.index+1);browserState.history.push(url);browserState.index=browserState.history.length-1}const requestId=++browserState.loadRequest,frame=$('#browserFrame');clearTimeout(browserState.loadTimer);$('#browserEmpty').hidden=true;$('#browserNotice').hidden=true;$('#browserLoading').hidden=false;frame.hidden=false;frame.setAttribute('sandbox',browserSandboxFor(url,location.href));$('#browserFrameShell').setAttribute('aria-busy','true');setBrowserStatus('Loading page...','loading');updateBrowserControls();frame.onload=()=>finishBrowserLoad(requestId);frame.onerror=()=>requestId===browserState.loadRequest&&showBrowserNotice('Page could not be loaded','The site did not complete the embedded request. Open it externally to continue.');frame.src=url;browserState.loadTimer=setTimeout(()=>{if(requestId===browserState.loadRequest)showBrowserNotice('Page may have blocked embedding','This site did not finish loading in the panel. It may block embedded browsers; you can open it externally instead.')},10000);return true}
function moveBrowserHistory(delta){const next=browserState.index+delta;if(next<0||next>=browserState.history.length)return;browserState.index=next;navigateBrowser(browserState.history[next],{push:false});updateBrowserControls()}
function openBrowserPanel(){setSidePanelOpen(true,false);setSidePanelView('browser','Browser');updateBrowserControls();if(browserState.index<0&&!overlayPanelsEnabled())requestAnimationFrame(()=>$('#browserUrl').focus())}
function setSidePanelView(view,title){
  document.body.classList.toggle('side-chat-open',view==='side-chat');if(view==='side-chat'&&innerWidth<=1200)setSidebarOpen(false);
  const panels={launcher:'#sidePanelLauncher',review:'#reviewPanelContent',browser:'#browserPanel',terminal:'#sideTerminalPanel','side-task':'#sideTaskPanel','side-chat':'#sideChatPanel',utility:'#utilityPanelContent'};
  if(!panels[view])return;
  for(const [kind,selector] of Object.entries(panels))$(selector).hidden=kind!==view;
  sidePanelTabs.activate(view,false);
  $('#sidePanelTitle').textContent=title||({launcher:'New tab',review:'Review',browser:'Browser',terminal:'Terminal','side-task':'Side tasks','side-chat':'Side chat',utility:'Files'})[view];
  renderChanges();
  if(view==='terminal')requestAnimationFrame(()=>{initializeTerminal(terminalStates.side);fitTerminal(terminalStates.side);if(!overlayPanelsEnabled())terminalStates.side.term?.focus()});
  if(view==='utility')refreshWorkspaceFiles();if(view==='side-task')renderSideTasks();if(view==='side-chat')sideChat.open();else sideChat.close();
}
function closeSidePanelTool(kind){
  if(kind==='terminal')disposeTerminal(terminalStates.side);if(kind==='side-chat')sideChat.dispose();
  if(kind==='browser'){
    clearTimeout(browserState.loadTimer);browserState.loadRequest++;browserState.history=[];browserState.index=-1;
    const frame=$('#browserFrame');frame.onload=frame.onerror=null;frame.removeAttribute('src');frame.hidden=true;
    $('#browserEmpty').hidden=false;$('#browserLoading').hidden=true;$('#browserNotice').hidden=true;$('#browserUrl').value='';
    $('#browserFrameShell').setAttribute('aria-busy','false');setBrowserStatus('Ready');updateBrowserControls();
  }
}
function openReviewPanel(review=null){state.activeReview=review||[...state.turnDiffs.values()].at(-1)||state.activeReview;setSidePanelOpen(true,false);setSidePanelView('review','Review')}
function openUtilityPanel(kind){
  if(kind==='browser'){openBrowserPanel();return}
  if(kind==='terminal'||kind==='side-task'||kind==='side-chat'){setSidePanelOpen(true,false);setSidePanelView(kind);return}
  if(kind!=='files')return;
  setSidePanelOpen(true,false);setSidePanelView('utility','Files');
}
function setSidePanelOpen(open,reset=true){const panel=$('#sidePanel'),trigger=$('#toggleSidePanel'),wasOpen=!panel.hidden;if(open){setSummaryPanelOpen(false);if(innerWidth<=1000)setSidebarOpen(false);if(!wasOpen){sidePanelReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:trigger;panel.hidden=false;document.body.classList.add('side-panel-open');trigger.setAttribute('aria-pressed','true');trigger.setAttribute('aria-expanded','true')}if(reset)setSidePanelView('launcher','New tab');if(!wasOpen){focusPanel(panel,$('#closeSidePanel'));if(!$('#sideTerminalPanel').hidden)initializeTerminal(terminalStates.side);if(!$('#sideChatPanel').hidden)sideChat.open()}}else{sideChat.close();panel.hidden=true;document.body.classList.remove('side-panel-open','review-split-open','side-panel-maximized');trigger.setAttribute('aria-pressed','false');trigger.setAttribute('aria-expanded','false');restorePanelFocus(panel,sidePanelReturnFocus);sidePanelReturnFocus=null}}
function setSummaryPanelOpen(open){const panel=$('#summaryPanel'),trigger=$('#toggleSummaryPanel');if(open){setSidePanelOpen(false,false);if(innerWidth<=1000)setSidebarOpen(false);summaryPanelReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:trigger;panel.hidden=false;document.body.classList.add('summary-panel-open');trigger.setAttribute('aria-pressed','true');trigger.setAttribute('aria-expanded','true');syncSummaryPanel();focusPanel(panel,$('#closeSummaryPanel'))}else{panel.hidden=true;document.body.classList.remove('summary-panel-open');trigger.setAttribute('aria-pressed','false');trigger.setAttribute('aria-expanded','false');restorePanelFocus(panel,summaryPanelReturnFocus);summaryPanelReturnFocus=null}}
function closeImageViewer(){const dialog=$('#imageViewer');if(dialog.open)dialog.close()}
function openImageViewer(source,title='Image',path=''){const dialog=$('#imageViewer'),image=$('#imageViewerImage');imageViewerReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;$('#imageViewerTitle').textContent=title||'Image';$('#imageViewerPath').textContent=path||title||'';$('#imageViewerError').hidden=true;image.hidden=false;image.alt=title||'';image.src=source;$('#imageViewerOriginal').href=source;if(!dialog.open)dialog.showModal();requestAnimationFrame(()=>$('#closeImageViewer').focus())}
function currentTerminalCwd(){const path=state.active?.cwd||localStorage.getItem('codex-webui-project')||state.config.defaultCwd||$('#projectPath').textContent||'.';return path.startsWith('~')?state.config.home+path.slice(1):path}
function terminalIsVisible(terminalState){const host=$(`#${terminalState.hostId}`);return Boolean(host?.checkVisibility())}
function fitTerminal(terminalState){const host=$(`#${terminalState.hostId}`);if(!terminalState.fit||!terminalIsVisible(terminalState)||host.clientWidth<1||host.clientHeight<1)return;try{terminalState.fit.fit()}catch{}}
function sendTerminalResize(terminalState){const ws=terminalState.ws,term=terminalState.term;if(ws?.readyState===WebSocket.OPEN&&term)ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}))}
function setTerminalStatus(terminalState,message,retry=false){terminalState.status=message;if(terminalState===terminalStates.side){$('#sideTerminalStatus').textContent=t(message);$('#sideTerminalRetry').hidden=!retry}}
function disposeTerminal(terminalState){
  clearTimeout(terminalState.reconnectTimer);terminalState.generation=(terminalState.generation||0)+1;
  if(terminalState.ws){terminalState.ws.onopen=terminalState.ws.onmessage=terminalState.ws.onerror=terminalState.ws.onclose=null;terminalState.ws.close();terminalState.ws=null}
  terminalState.resizeObserver?.disconnect();terminalState.term?.dispose();
  terminalState.term=null;terminalState.fit=null;terminalState.resizeObserver=null;terminalState.failures=0;
  const host=$(`#${terminalState.hostId}`);host.replaceChildren();host.dataset.connected='false';
}
function connectTerminal(terminalState){
  if(accessSession?.required)return;
  if(!state.config.capabilities?.terminal){setTerminalStatus(terminalState,'Terminal is disabled by the server');return}
  if(terminalState.ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(terminalState.ws.readyState))return;
  clearTimeout(terminalState.reconnectTimer);
  const generation=terminalState.generation||0,proto=location.protocol==='https:'?'wss:':'ws:',host=$(`#${terminalState.hostId}`),ws=new WebSocket(`${proto}//${location.host}/terminal?cwd=${encodeURIComponent(currentTerminalCwd())}`);
  terminalState.ws=ws;ws.binaryType='arraybuffer';host.dataset.connected='false';setTerminalStatus(terminalState,'Connecting…');
  ws.onopen=()=>{if(terminalState.ws!==ws)return;host.dataset.connected='true';setTerminalStatus(terminalState,'Connected');requestAnimationFrame(()=>{fitTerminal(terminalState);sendTerminalResize(terminalState)})};
  ws.onmessage=async event=>{const data=event.data instanceof Blob?new Uint8Array(await event.data.arrayBuffer()):event.data instanceof ArrayBuffer?new Uint8Array(event.data):String(event.data);if(terminalState.ws===ws){terminalState.failures=0;terminalState.term?.write(data)}};
  ws.onerror=()=>ws.close();
  ws.onclose=async event=>{
    if(terminalState.ws!==ws)return;
    host.dataset.connected='false';terminalState.ws=null;
    if(await accessSession?.check()||generation!==(terminalState.generation||0))return;
    if(event.code===1000||event.code===1011){setTerminalStatus(terminalState,event.code===1000?'Terminal exited':'Terminal unavailable',true);return}
    terminalState.failures=(terminalState.failures||0)+1;
    setTerminalStatus(terminalState,'Connection lost',true);
    if(terminalIsVisible(terminalState)&&terminalState.failures<=3)terminalState.reconnectTimer=setTimeout(()=>{if(generation===(terminalState.generation||0)&&terminalIsVisible(terminalState))connectTerminal(terminalState)},1000);
  };
}
function initializeTerminal(terminalState){if(terminalState.term){connectTerminal(terminalState);requestAnimationFrame(()=>fitTerminal(terminalState));return}const dark=matchMedia('(prefers-color-scheme:dark)').matches,host=$(`#${terminalState.hostId}`),term=new Terminal({cursorBlink:true,cursorStyle:'block',fontFamily:'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace',fontSize:12,lineHeight:1.2,scrollback:5000,theme:dark?{background:'#181818',foreground:'#f2f2f2',cursor:'#f2f2f2',selectionBackground:'#3b4a5a'}:{background:'#ffffff',foreground:'#0d0d0d',cursor:'#0d0d0d',selectionBackground:'#c8dcf4'}}),fit=new FitAddon;term.loadAddon(fit);term.open(host);terminalState.term=term;terminalState.fit=fit;term.onData(data=>{const ws=terminalState.ws;if(ws?.readyState===WebSocket.OPEN)ws.send(new TextEncoder().encode(data))});term.onResize(()=>sendTerminalResize(terminalState));terminalState.resizeObserver=new ResizeObserver(()=>requestAnimationFrame(()=>fitTerminal(terminalState)));terminalState.resizeObserver.observe(host);connectTerminal(terminalState);globalThis.__codexTerminals=terminalStates;if(terminalState===terminalStates.bottom)globalThis.__codexTerminal={term,fit,state:terminalState}}
function setBottomPanelView(kind='launcher'){const launcher=kind==='launcher',terminal=kind==='terminal',labels={browser:['Browser','globe','Open Browser from the right panel to keep it beside the chat.'],files:['Files','folderOpen','Choose or switch the local project folder available to this WebUI.']};$('#bottomPanelLauncher').hidden=!launcher;$('#terminalHost').hidden=!terminal;$('#bottomPanelUtility').hidden=launcher||terminal;$('#bottomPanelTab').textContent=launcher?'New tab':terminal?'Terminal':labels[kind]?.[0]||'New tab';if(launcher)return;bottomPanelLastView=kind;if(terminal){initializeTerminal(terminalStates.bottom);requestAnimationFrame(()=>{fitTerminal(terminalStates.bottom);terminalStates.bottom.term?.focus()});return}const[title,icon,description]=labels[kind];$('#bottomPanelIcon').innerHTML=codexIcon(icon);$('#bottomPanelUtilityTitle').textContent=title;$('#bottomPanelDescription').textContent=description;const action=$('#bottomPanelAction');action.hidden=kind!=='files';action.textContent='Choose project folder';action.onclick=kind==='files'?openFolderPicker:null}
function setBottomPanelOpen(open){const panel=$('#bottomPanel');panel.hidden=!open;document.body.classList.toggle('bottom-panel-open',open);$('#toggleBottomPanel').setAttribute('aria-pressed',String(open));$('#toggleBottomPanel').setAttribute('aria-expanded',String(open));if(open)setBottomPanelView('terminal')}
function setSidebarSearchOpen(open){const panel=$('#sidebarSearchPanel'),input=$('#threadSearch');panel.hidden=!open;$('#sidebarSearchButton').setAttribute('aria-expanded',String(open));if(open){requestAnimationFrame(()=>input.focus());return}if(input.value){input.value='';renderThreads()}}
function setSidebarHelpOpen(open){$('#sidebarHelpMenu').hidden=!open;$('#sidebarHelpButton').setAttribute('aria-expanded',String(open))}

$('#sideTerminalRetry').onclick=()=>{terminalStates.side.failures=0;connectTerminal(terminalStates.side)};$('#openSidePanelTab').onclick=()=>setSidePanelView('launcher','New tab');for(const action of document.querySelectorAll('[data-side-panel-action]'))action.onclick=()=>action.dataset.sidePanelAction==='review'?openReviewPanel():openUtilityPanel(action.dataset.sidePanelAction);$('#browserAddressForm').onsubmit=event=>{event.preventDefault();navigateBrowser($('#browserUrl').value)};$('#browserBack').onclick=()=>moveBrowserHistory(-1);$('#browserForward').onclick=()=>moveBrowserHistory(1);$('#browserRefresh').onclick=()=>browserState.index>=0&&navigateBrowser(browserState.history[browserState.index],{push:false});$('#bottomPanelTab').onclick=()=>setBottomPanelView();for(const action of document.querySelectorAll('[data-bottom-panel-action]'))action.onclick=()=>setBottomPanelView(action.dataset.bottomPanelAction);$('#reviewMode').onclick=()=>{reviewPreferences.mode=reviewPreferences.mode==='unified'?'split':'unified';saveReviewPreferences();renderChanges()};$('#reviewWrap').onclick=()=>{reviewPreferences.wrap=!reviewPreferences.wrap;saveReviewPreferences();renderChanges()};$('#reviewExpand').onclick=()=>{reviewPreferences.expanded=!reviewPreferences.expanded;saveReviewPreferences();renderChanges()};$('#reviewPatch').onclick=applyActiveReviewPatch;$('#composer').addEventListener('submit',submitPrompt);$('#prompt').addEventListener('input',handlePromptInput);$('#prompt').addEventListener('keydown',handlePromptKeydown);$('#threadSearch').addEventListener('input',renderThreads);$('#modelButton').addEventListener('click',toggleModelMenu);$('#modeButton').onclick=togglePermissionMenu;$('#confirmFullAccess').onclick=()=>{const action=pendingFullAccessAction;$('#fullAccessDialog').close();if(action==='enable')setPermissionVisibility('fullAccess',true);else setPermissionMode('full-access');pendingFullAccessAction='select'};$('#fullAccessDialog').addEventListener('close',()=>{pendingFullAccessAction='select';syncPermissionSettings()});document.querySelector('[data-composer-control="dictation"]').onclick=()=>toast('Dictation requires the native desktop audio bridge.');$('#newTask').onclick=startNewTask;$('#composerProjectButton').onclick=()=>projectOptions.open();$('#projectlessOption').onclick=useProjectless;$('#accountButton').onclick=e=>{e.stopPropagation();toggleAccountMenu()};$('#folderGo').onclick=()=>loadFolders($('#folderPathInput').value);$('#folderPathInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();loadFolders(e.currentTarget.value)}};$('#folderUp').onclick=()=>folderBrowse.parent&&loadFolders(folderBrowse.parent);$('#folderConfirm').onclick=useSelectedFolder;$('#toggleSummaryPanel').onclick=()=>setSummaryPanelOpen($('#summaryPanel').hidden);$('#closeImageViewer').onclick=closeImageViewer;$('#imageViewerImage').onload=()=>{$('#imageViewerImage').hidden=false;$('#imageViewerError').hidden=true};$('#imageViewerImage').onerror=()=>{$('#imageViewerImage').hidden=true;$('#imageViewerError').hidden=false};$('#imageViewer').addEventListener('click',event=>{if(event.target===event.currentTarget)closeImageViewer()});$('#imageViewer').addEventListener('close',()=>{const image=$('#imageViewerImage');image.removeAttribute('src');if(imageViewerReturnFocus?.isConnected)imageViewerReturnFocus.focus();imageViewerReturnFocus=null});function mobileSidebarEnabled(){return document.documentElement.classList.contains('mobile-device')||innerWidth<=720}
$('#sidebarSearchButton').onclick=event=>{event.stopPropagation();setSidebarSearchOpen($('#sidebarSearchPanel').hidden)};$('#sidebarSearchClose').onclick=()=>setSidebarSearchOpen(false);$('#sidebarHelpButton').onclick=event=>{event.stopPropagation();setSidebarHelpOpen($('#sidebarHelpMenu').hidden)};$('#sidebarHelpSettings').onclick=()=>{setSidebarHelpOpen(false);openSettings('general-settings')};$('#sidebarHelpShortcuts').onclick=()=>{setSidebarHelpOpen(false);openSettings('keyboard-shortcuts')};$('#accountSettings').onclick=()=>openSettings('general-settings');$('#accountProfile').onclick=()=>openSettings('profile');$('#accountUsage').onclick=()=>openSettings('profile');$('#accountShortcuts').onclick=()=>openSettings('keyboard-shortcuts');for(const button of document.querySelectorAll('[data-settings-page]'))button.onclick=()=>setSettingsPage(button.dataset.settingsPage);$('#settingsAutoReviewToggle').onchange=event=>setPermissionVisibility('autoReview',event.currentTarget.checked);$('#settingsTaskNotifyToggle').onchange=event=>setTaskNotifyEnabled(event.currentTarget.checked);$('#settingsFullAccessToggle').onchange=event=>{if(!event.currentTarget.checked){setPermissionVisibility('fullAccess',false);return}event.currentTarget.checked=false;pendingFullAccessAction='enable';const dialog=$('#fullAccessDialog');if(!dialog.open)dialog.showModal()};$('#accountLogout').onclick=async()=>{if(!confirm('Log out?'))return;try{await rpc('account/logout');toggleAccountMenu(false);await loadAccount(true)}catch(error){toast(error.message)}};$('#settingsDialog').addEventListener('cancel',event=>{event.preventDefault();closeSettings()});

$('#sidebarBackdrop').onclick=()=>setSidebarOpen(false);
$('#sidebarNotificationsButton').onclick=()=>workspaceNavigation.toggleNotifications();
$('#composerEnvironmentButton').onclick=()=>openSettings('runtime');
$('#themeSelect').value=document.documentElement.dataset.themePreference||'system';
$('#themeSelect').onchange=event=>{const preference=event.currentTarget.value;localStorage.setItem('codex-remote-web-theme',preference);document.documentElement.dataset.themePreference=preference;applyWorkspaceTheme()};
function applyWorkspaceTheme(){const preference=document.documentElement.dataset.themePreference||'system';document.documentElement.dataset.theme=preference==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):preference;document.querySelector('meta[name=theme-color]').content=document.documentElement.dataset.theme==='dark'?'#27272a':'#ededee'}
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',applyWorkspaceTheme);
applyWorkspaceTheme();
const panelSizing=installPanelSizing({sidebar:$('#sidebar'),panel:$('#sidePanel'),shell:$('.app-shell'),maximize:$('#maximizeSidePanel'),t,onChange:()=>{syncOverlayPanelMode();for(const terminalState of Object.values(terminalStates))requestAnimationFrame(()=>fitTerminal(terminalState));}});
$('#languageSelect').value=i18n.preference;
$('#languageSelect').onchange=event=>i18n.setPreference(event.currentTarget.value);
function refreshLocalizedRuntime(){
  runtimeProgress.refresh();conversationLoad?.refresh();
  sidePanelTabs.refresh();panelSizing.sync();
  $('#languageSelect').value=i18n.preference;
  if(!state.active){$('#threadTitle').textContent=t('New task');showEmpty()}
  renderThreads();
  if(!folderBrowse.selected)$('#folderSelection').textContent=t('No folder selected');
  if(state.account)renderAccount(state.account);else renderAccount(null);
  syncPermissionControl();syncModelLabel();refreshComposerPlaceholder();renderContextUsage();renderChanges();
  syncComposerSubmitState();
  if(!$('#modelMenu').hidden)renderModelMenuMain();
  if($('#settingsDialog').open){const current=document.querySelector('[data-settings-page].active')?.dataset.settingsPage||settingsRoutePage()||'general-settings';setSettingsPage(current,{updateRoute:false});filterSettingsNavigation($('#settingsSearch').value)}
}
i18n.subscribe(refreshLocalizedRuntime);
refreshLocalizedRuntime();
$('#toggleSidePanel').onclick=()=>setSidePanelOpen($('#sidePanel').hidden,false);$('#toggleBottomPanel').onclick=()=>setBottomPanelOpen($('#bottomPanel').hidden);$('#closeBottomPanel').onclick=()=>setBottomPanelOpen(false);$('#toggleSidebar').onclick=()=>setSidebarOpen(mobileSidebarEnabled()?!$('#sidebar').classList.contains('mobile-open'):document.body.classList.contains('sidebar-hidden'));$('#closeSidePanel').onclick=()=>setSidePanelOpen(false);$('#closeSummaryPanel').onclick=()=>setSummaryPanelOpen(false);document.addEventListener('click',e=>{const target=e.target instanceof Element?e.target:null,image=target?.closest('[data-image-src]');if(image){e.preventDefault();openImageViewer(image.dataset.imageSrc,image.dataset.imageTitle||image.querySelector('img')?.alt||'Image',image.dataset.imagePath||'');return}if(target?.closest('a[data-file-download]'))return;const citation=target?.closest('a[data-file-reference]');if(!citation)return;e.preventDefault();dispatchEvent(new CustomEvent('codex-webui:file-reference',{detail:{path:citation.dataset.fileReference,lineStart:Number(citation.dataset.fileLineStart)||null,lineEnd:Number(citation.dataset.fileLineEnd)||null}}))});document.addEventListener('click',e=>{const path=e.composedPath();if(!path.includes($('#modelPicker')))closeModelMenu();if(!path.includes($('#permissionPicker')))closePermissionMenu();if(!path.includes($('#accountMenu'))&&!path.includes($('#accountButton')))toggleAccountMenu(false);if(!path.includes($('#sidebarSearchPanel'))&&!path.includes($('#sidebarSearchButton')))setSidebarSearchOpen(false);if(!path.includes($('#sidebarHelpMenu'))&&!path.includes($('#sidebarHelpButton')))setSidebarHelpOpen(false)});document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')return;scheduleThreadListRefresh(0);scheduleActiveThreadSync(0)});addEventListener('keydown',e=>{if(e.target instanceof Element&&(e.target.closest('.terminal-host')||(e.key!=='Escape'&&e.target.closest('.cm-editor'))))return;if(e.key==='Escape'){if($('#imageViewer').open){e.preventDefault();closeImageViewer();return}if($('#folderDialog').open||$('#fullAccessDialog').open||document.querySelector('.composer-goal-dialog[open], #sideFullAccessDialog[open], .side-file-dialog[open]'))return;if(e.defaultPrevented)return;if(!$('#sidebarSearchPanel').hidden){e.preventDefault();setSidebarSearchOpen(false);return}if(!$('#sidebarHelpMenu').hidden){e.preventDefault();setSidebarHelpOpen(false);return}if(!$('#accountMenu').hidden){e.preventDefault();toggleAccountMenu(false);$('#accountButton').focus();return}if($('#settingsDialog').open){e.preventDefault();closeSettings();return}if(panelSizing.isMaximized()){e.preventDefault();panelSizing.setMaximized(false);return}closeModelMenu();closePermissionMenu();toggleAccountMenu(false);if(mobileSidebarEnabled()&&$('#sidebar').classList.contains('mobile-open'))setSidebarOpen(false);else if(document.body.classList.contains('side-panel-open'))setSidePanelOpen(false);else if(document.body.classList.contains('summary-panel-open'))setSummaryPanelOpen(false)}if((e.metaKey||e.ctrlKey)&&e.key===','){e.preventDefault();openSettings();return}if($('#settingsDialog').open||$('#workspaceFeatureDialog').open)return;if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();startNewTask()}if((e.metaKey||e.ctrlKey)&&e.key==='b'){e.preventDefault();$('#toggleSidebar').click()}if((e.metaKey||e.ctrlKey)&&e.key==='j'){e.preventDefault();$('#toggleBottomPanel').click()}});addEventListener('resize',()=>{syncOverlayPanelMode();syncSidebarLayout();for(const terminalState of Object.values(terminalStates))requestAnimationFrame(()=>fitTerminal(terminalState))});
globalThis.__codexWebuiDebug={notify:onNotification,request:onServerRequest,state,browserState,navigateBrowser,renderChanges,renderAccount,renderHeader,refreshComposerPlaceholder,setProjectless,openImageViewer,openThread,loadInitial,startNewTask,setSidebarOpen,openSettings,closeSettings,settingsRoutePage,selectedPermission,permissionThreadPolicy,permissionTurnPolicy,setPermissionMode,setPermissionProfiles,setPermissionVisibility,renderPermissionMenu,filterAppModels,renderModels,syncTurnSnapshot,recordTurnReview,scrollOpenedThreadToBottom};
function syncRuntimeCapabilities(){for(const button of document.querySelectorAll('[data-bottom-panel-action=terminal],[data-side-panel-action=terminal]')){button.disabled=!state.config.capabilities?.terminal;if(button.disabled)button.title=t('Terminal is disabled by the server')}syncReviewControls(state.activeReview)}
async function boot(){const savedProject=localStorage.getItem('codex-webui-project');syncSidebarLayout();syncPermissionControl();try{state.config=await fetch('/api/config').then(r=>r.json());syncRuntimeCapabilities()}catch{}if(state.config.projectless||savedProject==='~')setProjectless();else setWorkspace(savedProject||state.config.defaultCwd||'.');refreshComposerPlaceholder();const initialSettingsPage=settingsRoutePage();if(initialSettingsPage)showSettings(initialSettingsPage,{updateRoute:false});connect()}
boot();

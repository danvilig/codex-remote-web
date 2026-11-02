import { createSideChatRequest } from './side-chat-requests.js';
import { createComposerDelivery } from './composer-delivery.js';
import { agentMessageText, renderAssistantMarkdown, renderItemImages } from './rendering.js';
import { createComposerAttachments, attachmentThumbnail } from './composer-attachments.js';
import { createComposerTools } from './composer-tools.js';
import { createFileExplorer } from './file-explorer.js';
import { createTurnPresentation } from './turn-presentation.js';
import { permissionModes, normalizePermissionProfiles, turnPolicyFor, renderReasoningMenu, renderModelOptions, renderPermissionOptions } from './composer-controls.js';
import { collaborationMode } from './conversation-policy.js';
import { selectModelState } from './ui-core.js';
import { summarizeActivity } from '../src/shared/codex-surfaces.js';

export function createSideChat({root,state,t,rpc,menu,icon,getDefaults,onThreadsChanged,respond,onResolved,toast}) {
  let source=null,workspace=null,thread=null,contextTurns=new Set(),busy=false,uploading=false,turnId='',generation=0,timer,visible=false,profiles=[];
  let sessionId=crypto.randomUUID();
  let delivery=null,sending=false;
  let model='',effort='medium',permission='default';
  const side={active:null,workspaceContext:null,projectless:false,planMode:false,goalMode:false,composerMentions:[],get config(){return state.config;}};
  const view={turns:new Map(),turnDiffs:new Map()},requests=new Map();
  const node=(tag,className='',text='')=>{const n=document.createElement(tag);n.className=className;n.textContent=text;return n;};
  const button=(label,glyph,className='')=>{const n=node('button',className);n.type='button';n.title=t(label);n.setAttribute('aria-label',t(label));n.innerHTML=icon(glyph);return n;};
  const heading=node('div','side-chat-context'),context=node('span'),open=button('Save as regular chat','arrowUp','side-chat-open-button');open.hidden=true;heading.append(context,open);
  const messages=node('div','side-chat-messages conversation');messages.setAttribute('aria-live','polite');
  const empty=node('div','side-chat-empty empty-state');empty.innerHTML=icon('messageSquare');empty.append(node('h2','',t('Side chat')),node('p','',t('Side chats are temporary. Close this tab to discard the conversation.')));
  const dock=node('div','side-chat-dock'),form=node('form','composer side-chat-composer');
  const tray=node('div','composer-context-tray');tray.hidden=true;tray.setAttribute('aria-label',t('Attached context'));
  const input=node('textarea');input.rows=1;input.placeholder=t('Work with Codex');input.setAttribute('aria-label',t('Side chat message'));
  const footer=node('div','composer-footer'),left=node('div','composer-left'),right=node('div','composer-right');
  const add=button('Add','plus','composer-circle-button add-control');add.setAttribute('aria-haspopup','menu');add.setAttribute('aria-expanded','false');add.dataset.sideComposer='add';
  const permissions=button('Change permissions','shield','composer-text-button approval-control');permissions.dataset.sideComposer='permissions';permissions.setAttribute('aria-haspopup','menu');permissions.setAttribute('aria-expanded','false');
  const models=button('Reasoning and model','chevronDown','composer-text-button model-trigger');models.dataset.sideComposer='model';models.setAttribute('aria-haspopup','dialog');models.setAttribute('aria-expanded','false');
  const send=button('Send','arrowUp','send-button');send.type='submit';send.dataset.sideComposer='send';
  const stop=button('Stop','x','send-button side-chat-stop');stop.hidden=true;
  const status=node('p','settings-note side-chat-status');status.role='status';status.hidden=true;
  left.append(add,permissions);right.append(models,send,stop);footer.append(left,right);form.append(tray,input,footer);dock.append(form,status);root.replaceChildren(heading,messages,dock);
  const modelMenu=node('div','model-menu side-chat-popover');modelMenu.hidden=true;modelMenu.role='dialog';modelMenu.setAttribute('aria-label',t('Side chat model'));
  const permissionMenu=node('div','permission-menu side-chat-popover');permissionMenu.hidden=true;permissionMenu.role='menu';permissionMenu.setAttribute('aria-label',t('Side chat permissions'));
  const permissionList=node('div','permission-options');permissionMenu.append(permissionList);document.body.append(modelMenu,permissionMenu);
  const confirmation=document.querySelector('#fullAccessDialog').cloneNode(true);confirmation.id='sideFullAccessDialog';confirmation.removeAttribute('aria-labelledby');confirmation.setAttribute('aria-label',t('Turn on Full Access?'));
  for(const element of confirmation.querySelectorAll('[id]'))element.removeAttribute('id');confirmation.querySelector('.danger').onclick=()=>{permission='full-access';confirmation.close();syncChoices();};document.body.append(confirmation);
  const fileDialog=node('dialog','side-file-dialog');fileDialog.setAttribute('aria-label',t('Project files'));
  const fileHead=node('div','explorer-toolbar');fileHead.append(node('strong','',t('Project files')));const fileClose=button('Close','x','explorer-icon-button');fileClose.onclick=()=>fileDialog.close();fileHead.append(fileClose);
  const fileSearch=node('input','settings-input');fileSearch.type='search';fileSearch.placeholder=t('Search project files');fileSearch.setAttribute('aria-label',t('Search project files'));
  const fileContainer=node('div','side-file-picker-content');fileDialog.append(fileHead,fileSearch,fileContainer);document.body.append(fileDialog);
  const files=createFileExplorer({container:fileContainer,search:fileSearch,cwd:()=>workspace,t,menu,toast,openImage:(src,title,path)=>dispatchEvent(new CustomEvent('codex-webui:side-image',{detail:{src,title,path}})),reference:text=>{side.composerMentions.push({id:`side-file:${text}`,source:'file',title:text,path:text.slice(1),icon:'file'});renderTray();fileDialog.close();input.focus();},isCurrent:()=>fileDialog.open});
  fileSearch.oninput=()=>files.search();fileDialog.onclose=()=>files.close();
  const goalTools=createComposerTools({scope:'side',state:side,t,icon,toast,ensureThread,onGoalChanged:(_,goal)=>{side.goalMode=goal?.status==='active';sync();},addSkill:item=>{if(!side.composerMentions.some(existing=>existing.id===item.id))side.composerMentions.push(item);renderTray();input.focus();}});
  const attachments=createComposerAttachments({scope:'side',state:side,t,menu,anchor:add,prompt:input,draftKey:()=>`side-chat:${sessionId}`,toast,setBusy:value=>{uploading=value;sync();},openFiles:()=>{fileSearch.value='';fileDialog.showModal();void files.open();},togglePlan:()=>{side.planMode=!side.planMode;sync();},extraItems:async()=>(await goalTools.menuItems()).map(item=>item.label==='Goal'?{...item,disabled:true,description:'Goals require a regular chat'}:item),applyToDraft:(key,items)=>{if(key!==`side-chat:${sessionId}`)return;side.composerMentions=[...new Map([...side.composerMentions,...items].map(item=>[item.id,item])).values()];renderTray();}});
  delivery=createComposerDelivery({key:'side',anchor:send,host:form,t,icon,menu,context:()=>({threadId:thread?.id,turnId,ready:state.connected&&!busy&&!uploading}),dispatch:dispatchQueued,onError:error=>toast(error.message),onChange:sync,notice:'Side chat queues are temporary and close with this side chat.'});
  const presentation=createTurnPresentation({state:view,t,icon,toast,fork:payload=>saveAsChat(payload.turnId),openReview:()=>open.click(),getCwd:()=>thread?.cwd||workspace});
  const reasoningLabels={none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra High',max:'Max',ultra:'Ultra'};
  const reasoningLabel=value=>t(reasoningLabels[value]||value);
  const modelObject=()=>state.models.find(item=>item.model===model);
  const display=(item,short=false)=>{const name=item?.displayName||item?.model||t('Select model');return short?name.replace(/^GPT-/i,''):name;};
  function options() {
    const values=Object.entries(permissionModes).filter(([key])=>key!=='full-access'||state.permissionVisibility.fullAccess).map(([mode,item])=>({mode,...item}));
    return [...values,...profiles.map(profile=>({kind:'profile',mode:`profile:${profile.id}`,profileId:profile.id,label:profile.id,description:profile.description||'Custom permission profile',icon:'file',allowed:profile.allowed!==false}))];
  }
  function selectedPermission(){return options().find(item=>item.mode===permission&&item.allowed!==false)||{mode:'default',...permissionModes.default};}
  function syncChoices() {
    const selected=selectModelState(state.models,model);model=selected.model;
    if(!selected.efforts.includes(effort))effort=selected.effort;
    const policy=selectedPermission();permission=policy.mode;
    permissions.innerHTML=icon(policy.icon);const label=node('span','control-label',t(policy.label));permissions.append(label);permissions.title=t(policy.description);permissions.setAttribute('aria-label',t('Change permissions'));
    models.replaceChildren(node('span','side-model-name',display(modelObject(),true)),node('span','side-effort-label',reasoningLabel(effort)));models.insertAdjacentHTML('beforeend',icon('chevronDown','chevron'));
  }
  function closePickers(){modelMenu.hidden=permissionMenu.hidden=true;models.setAttribute('aria-expanded','false');permissions.setAttribute('aria-expanded','false');}
  function place(popover,anchor){const bounds=anchor.getBoundingClientRect();popover.hidden=false;popover.style.width=`${Math.min(310,innerWidth-24)}px`;const box=popover.getBoundingClientRect();popover.style.left=`${Math.max(12,Math.min(bounds.right-box.width,innerWidth-box.width-12))}px`;popover.style.top=`${Math.max(12,bounds.top-box.height-8)}px`;}
  function renderModelMain(){const selection=selectModelState(state.models,model);renderReasoningMenu({menu:modelMenu,modelName:display(modelObject(),true),effort,values:selection.efforts,reasoningLabel,t,icon,prefix:'side',onEffort:value=>{effort=value;syncChoices();},onReset:()=>{const defaults=selectModelState(state.models);model=defaults.model;effort=defaults.effort;syncChoices();renderModelMain();modelMenu.querySelector('input').focus();},onModels:()=>{renderModelOptions({menu:modelMenu,models:state.models,selected:model,t,icon,display,onSelect:value=>{model=value;effort=selectModelState(state.models,model).effort;syncChoices();closePickers();models.focus();},onBack:()=>{renderModelMain();place(modelMenu,models);},prefix:'side'});place(modelMenu,models);modelMenu.querySelector('[aria-checked=true]')?.focus();}});}
  models.onclick=()=>{const opening=modelMenu.hidden;closePickers();if(!opening)return;renderModelMain();place(modelMenu,models);models.setAttribute('aria-expanded','true');modelMenu.querySelector('input')?.focus();};
  permissions.onclick=()=>{const opening=permissionMenu.hidden;closePickers();if(!opening)return;renderPermissionOptions({list:permissionList,options:options(),selected:permission,t,icon,onSelect:mode=>{closePickers();if(mode==='full-access'&&permission!==mode)confirmation.showModal();else{permission=mode;syncChoices();}permissions.focus();}});place(permissionMenu,permissions);permissions.setAttribute('aria-expanded','true');permissionMenu.querySelector('[aria-checked=true]')?.focus();};
  document.addEventListener('pointerdown',event=>{if(![modelMenu,permissionMenu,models,permissions].some(element=>element.contains(event.target)))closePickers();});
  document.addEventListener('keydown',event=>{const current=!modelMenu.hidden?modelMenu:!permissionMenu.hidden?permissionMenu:null;if(!current)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();const anchor=current===modelMenu?models:permissions;closePickers();anchor.focus();}else if(current===permissionMenu&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=[...permissionList.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();}});
  addEventListener('resize',closePickers);
  addEventListener('codex-webui:preferences',()=>{if(visible){syncChoices();sync();}});
  function resize(){input.style.height='auto';input.style.height=`${Math.min(190,Math.max(52,input.scrollHeight))}px`;}
  function renderTray(){tray.replaceChildren();for(const mention of side.composerMentions){const chip=node('div','composer-context-chip');chip.innerHTML=attachmentThumbnail(mention)||icon(mention.icon||'file');const name=node('span','',mention.title);name.dataset.i18nIgnore='';const remove=button(t('Remove {name}',{name:mention.title}),'x');remove.onclick=()=>{side.composerMentions=side.composerMentions.filter(item=>item.id!==mention.id);renderTray();};chip.append(name,remove);tray.append(chip);}tray.hidden=!side.composerMentions.length;sync();}
  function sync(){const hasInput=Boolean(input.value.trim()||side.composerMentions.length);open.disabled=busy||uploading||Boolean(turnId);send.disabled=busy||uploading||!hasInput;send.hidden=Boolean(turnId)&&!hasInput&&!sending;stop.hidden=!turnId||hasInput||sending;send.setAttribute('aria-busy',String(sending));send.dataset.submitMode=sending?'sending':turnId?(delivery?.mode==='queue'?'queue':'steer'):'send';send.innerHTML=icon(sending?'loaderCircle':'arrowUp');const label=sending?'Sending message…':turnId?(delivery?.mode==='queue'?'Queue message':'Steer'):'Send';send.setAttribute('aria-label',t(label));send.title=t(label);context.textContent=source?t('Based on {name}',{name:source.name||source.id}):t('A separate chat in the current project.');status.hidden=!status.textContent;form.classList.toggle('plan-mode',side.planMode);input.placeholder=t(side.planMode?'Describe a plan':'Work with Codex');delivery?.refresh();resize();}
  function render(turns){
    const position=messages.scrollTop,following=messages.scrollHeight-position-messages.clientHeight<64;empty.remove();
    for(const turn of (turns||[]).filter(item=>!contextTurns.has(item.id))){
      let article=view.turns.get(turn.id);
      if(!article){article=node('article','turn assistant-turn native-turn-timeline');article.dataset.turnId=turn.id;article.dataset.threadId=thread.id;article.innerHTML='<div class="assistant-body"><div class="turn-event-stream"></div></div><div class="worked-for-divider" hidden><span>Worked</span><div></div></div><div class="turn-final-slot"></div>';messages.append(article);view.turns.set(turn.id,article);}
      const signature=JSON.stringify(turn.items);
      if(article.dataset.signature!==signature){article.dataset.signature=signature;const stream=article.querySelector('.turn-event-stream'),final=article.querySelector('.turn-final-slot');stream.replaceChildren();final.replaceChildren();
        let user=messages.querySelector(`[data-side-user="${CSS.escape(turn.id)}"]`);
        for(const item of turn.items||[]){
          if(item.type==='userMessage'){if(!user){user=node('article','turn user-turn');user.dataset.sideUser=turn.id;messages.insertBefore(user,article);}const text=node('div','user-message',(item.content||[]).filter(part=>part.type==='text').map(part=>part.text).join('\n'));text.dataset.i18nIgnore='';user.replaceChildren(text);const images=renderItemImages(item,{cwd:thread.cwd,className:'message-image-grid user-message-images'});if(images)user.insertAdjacentHTML('afterbegin',images);}
          else if(item.type==='agentMessage'){const response=node('div',item.phase==='commentary'?'assistant-response assistant-commentary':'assistant-response side-chat-answer'),body=node('div','message-text');body.dataset.raw=agentMessageText(item);body.innerHTML=renderAssistantMarkdown(body.dataset.raw,{cwd:thread.cwd})+renderItemImages(item,{cwd:thread.cwd});response.append(body);(item.phase==='commentary'?stream:final).append(response);}
          else {const summary=summarizeActivity(item);const details=node('details','side-chat-activity'),label=node('summary','',t(summary.label||item.type));const body=node('pre','',item.aggregatedOutput||summary.detail||'');body.dataset.i18nIgnore='';details.append(label,body);stream.append(details);}
        }
      }
      presentation.update(turn.id,turn.status!=='inProgress');
    }
    if(!messages.childElementCount)messages.append(empty);
    messages.scrollTop=following?messages.scrollHeight:position;
  }
  async function sideRequest(action,extra={},key=sessionId,keepalive=false){
    const response=await fetch('/api/conversation/side-chat',{method:'POST',headers:{'content-type':'application/json','x-workspace-request':'1'},body:JSON.stringify({action,sessionId:key,...extra}),keepalive});
    const result=await response.json();if(!response.ok)throw Error(t(response.status===404?'The server is older than this page. Update the running WebUI service.':result.error));return result;
  }
  async function refresh(){
    if(!thread)return;const id=thread.id,request=generation;
    try{const snapshot=await sideRequest('snapshot');if(request!==generation||thread?.id!==id)return;turnId=snapshot.activeTurnId;render(snapshot.turns);sync();for(const turn of snapshot.turns)delivery.snapshot(id,turn);}
    catch{if(request!==generation)return;status.textContent=t('Temporary side chat is unavailable or expired. Your draft was kept.');sync();}
    clearTimeout(timer);if(thread)timer=setTimeout(refresh,visible?(turnId?500:3000):30000);
  }
  let creating=null;
  async function ensureThread(){
    if(thread){await sideRequest('snapshot');return thread;}if(creating)return creating;
    const key=sessionId;
    const pending=(async()=>{const snapshot=await sideRequest('create',{...(source?{sourceThreadId:source.id}:{}),cwd:workspace},key);if(key!==sessionId){void sideRequest('release',{},key).catch(()=>{});throw Error(t('Side chat closed'));}thread=snapshot.thread;side.active=thread;contextTurns=new Set();open.hidden=false;void refresh();return thread;})();
    creating=pending;try{return await pending;}finally{if(creating===pending)creating=null;}
  }
  async function saveAsChat(turnId){
    if(!thread||busy||uploading)return;
    busy=true;sync();
    try{const result=await sideRequest('promote',turnId?{turnId}:{});toast(t('Side chat saved as context. Send a message to continue.'));await onThreadsChanged(result.thread);dispatchEvent(new CustomEvent('codex-webui:open-side-chat',{detail:result.thread}));}
    catch(error){toast(error.message);}finally{busy=false;sync();}
  }
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||uploading||(!input.value.trim()&&!side.composerMentions.length))return;
    const request=generation,activeId=turnId;const submitted={text:input.value,mentions:side.composerMentions.map(item=>({...item})),model,effort,permission:selectedPermission(),plan:side.planMode};
    if(activeId&&delivery.mode==='queue'){try{delivery.enqueue({threadId:thread.id,waitTurnId:activeId,...submitted});input.value='';side.composerMentions=[];renderTray();}catch(error){toast(error.message);}return;}
    busy=true;sending=true;status.textContent='';sync();
    try{const target=await ensureThread();await sendPrepared(submitted,target,request,activeId);if(request!==generation)return;if(input.value===submitted.text)input.value='';const sentIds=new Set(submitted.mentions.map(item=>item.id));side.composerMentions=side.composerMentions.filter(item=>!sentIds.has(item.id));renderTray();await refresh();
    }catch(error){if(request!==generation)return;status.textContent=t('Side chat could not send. Your draft is kept; it was not retried.');toast(error.message);}finally{busy=false;sending=false;sync();}
  };
  async function sendPrepared(submitted,target,request,activeId=''){
    const check=()=>{if(request!==generation||target.id!==thread?.id)throw Error(t('Side chat closed'));};check();
    const uploaded=await attachments.prepare(submitted.mentions,target.cwd,target.id),skills=await goalTools.prepare(submitted.mentions,target.cwd);check();
    const text=[submitted.text.trim(),...submitted.mentions.filter(item=>item.source==='file').map(item=>`@${item.path}`),...uploaded.map(item=>`Attached file ${JSON.stringify(item.name)}: ${item.path}`)].filter(Boolean).join('\n');
    const input=[...(text?[{type:'text',text,text_elements:[]}]:[]),...uploaded.filter(item=>item.image).map(item=>({type:'localImage',path:item.path})),...skills];await attachments.prepare(submitted.mentions,target.cwd,target.id,true);check();
    const result=await rpc(activeId?'turn/steer':'turn/start',activeId?{threadId:target.id,expectedTurnId:activeId,input}:{threadId:target.id,input,cwd:target.cwd,...turnPolicyFor(submitted.permission,target.cwd),model:submitted.model,effort:submitted.effort,collaborationMode:collaborationMode(submitted.plan,submitted.model,submitted.effort)});check();
    turnId=activeId||result.turn?.id||'';
  }
  async function dispatchQueued(entry){
    const request=generation,target=thread;busy=true;sending=true;sync();
    try{const snapshot=await sideRequest('snapshot');if(request!==generation||target?.id!==thread?.id)throw Error(t('Side chat closed'));if(snapshot.activeTurnId){turnId=snapshot.activeTurnId;return {waitingFor:turnId};}await sendPrepared(entry,target,request);await refresh();}
    finally{busy=false;sending=false;sync();}
  }
  input.oninput=sync;input.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();form.requestSubmit();}};
  stop.onclick=async()=>{if(!thread||!turnId||busy)return;stop.disabled=true;try{await rpc('turn/interrupt',{threadId:thread.id,turnId});}catch(error){toast(error.message);}finally{stop.disabled=false;}};
  open.onclick=()=>{void saveAsChat();};
  addEventListener('pagehide',event=>{if(!event.persisted&&(thread||creating))void sideRequest('release',{},sessionId,true).catch(()=>{});});
  return {
    setPrompt(text){input.value=text;sync();input.focus();},
    open(){visible=true;if(!workspace){source=state.active?{...state.active}:null;workspace=source?.cwd||(state.projectless?state.config.home:state.workspaceContext?.cwd||state.config.defaultCwd);side.workspaceContext={cwd:workspace};const defaults=getDefaults();model=defaults.model;effort=defaults.effort;permission=defaults.permissionMode;profiles=[...state.permissionProfiles];void rpc('permissionProfile/list',{cwd:workspace,limit:100}).then(result=>{profiles=normalizePermissionProfiles(result.data);syncChoices();}).catch(()=>{});}syncChoices();sync();if(thread)void refresh();else if(!messages.children.length)messages.append(empty);},
    close(){visible=false;closePickers();menu.close();},
    dispose(){const key=sessionId;sessionId=crypto.randomUUID();generation++;delivery.clear();clearTimeout(timer);if(thread||creating)void sideRequest('release',{},key).catch(()=>{});thread=null;source=null;workspace=null;creating=null;turnId='';side.active=null;side.composerMentions=[];side.planMode=false;side.goalMode=false;view.turns.clear();view.turnDiffs.clear();requests.clear();messages.replaceChildren();input.value='';status.textContent='';open.hidden=true;document.querySelector('.composer-goal-dialog[data-composer-scope=side]')?.close();fileDialog.close();confirmation.close();files.close();renderTray();this.close();},
    resolveRequest(id){requests.get(id)?.remove();requests.delete(id);},
    handleRequest(req){if(req.params?.threadId!==thread?.id)return false;if(requests.has(req.id))return true;const card=createSideChatRequest(req,{t,icon,respond,requestEpoch:req.requestEpoch,onResolved:id=>{requests.get(id)?.remove();requests.delete(id);onResolved(id);},toast});if(!card)return false;messages.append(card);requests.set(req.id,card);return true;},
    notify(method,p){if(method==='serverRequest/resolved'){requests.get(p.requestId)?.remove();requests.delete(p.requestId);return;}if(p.threadId!==thread?.id)return;if(method==='turn/completed'){if(p.turn?.id===turnId)turnId='';sync();delivery.snapshot(p.threadId,p.turn);}if(method==='thread/goal/updated')side.goalMode=p.goal?.status==='active';if(['turn/completed','item/completed','item/started'].includes(method))void refresh();},
    get threadId(){return thread?.id;}
  };
}

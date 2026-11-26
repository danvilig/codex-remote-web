// Shared controls and policy conversion for the main and side composers.
export const permissionModes = {
  config: {kind:'native',label:'Codex configuration',description:'Use approval and sandbox defaults from Codex configuration',icon:'file'},
  default: {kind:'legacy',label:'Ask for approval',description:'Always ask for permission before editing external files or using the internet',icon:'shield',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'workspace-write'},
  'guardian-approvals': {kind:'legacy',label:'Approve for me',description:'Only ask for actions detected as potentially unsafe',icon:'shield',approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandbox:'workspace-write'},
  'full-access': {kind:'legacy',label:'Full access',description:'Unrestricted access to the internet and any file on your computer',icon:'terminal',approvalPolicy:'never',approvalsReviewer:'user',sandbox:'danger-full-access'},
};
export function normalizePermissionProfiles(profiles = []) {
  const reserved = new Set([...Object.keys(permissionModes), 'custom']), seen = new Set();
  return (Array.isArray(profiles) ? profiles : []).flatMap(profile => {
    if (!profile || typeof profile.id !== 'string') return [];
    const id = profile.id.trim(), key = id.toLocaleLowerCase();
    if (!id || id.startsWith(':') || reserved.has(key) || seen.has(key)) return [];
    seen.add(key);
    return [{ id, description: typeof profile.description === 'string' ? profile.description : '', allowed: profile.allowed !== false }];
  });
}
export function threadPolicyFor(selected) {
  if(selected.kind==='native')return {};
  if(selected.kind==='profile')return {permissions:selected.profileId};
  return {approvalPolicy:selected.approvalPolicy,approvalsReviewer:selected.approvalsReviewer,sandbox:selected.sandbox};
}
export function turnPolicyFor(selected,cwd) {
  if(selected.kind==='native')return {};
  if(selected.kind==='profile')return {permissions:selected.profileId,approvalPolicy:null,approvalsReviewer:null};
  const sandboxPolicy=selected.sandbox==='danger-full-access'?{type:'dangerFullAccess'}:{type:'workspaceWrite',writableRoots:cwd?[cwd]:[],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false};
  return {permissions:null,approvalPolicy:selected.approvalPolicy,approvalsReviewer:selected.approvalsReviewer,sandboxPolicy};
}
const element=(tag,className='',text='')=>{const node=document.createElement(tag);node.className=className;node.textContent=text;return node;};
export function renderReasoningMenu({menu,modelName,effort,values,reasoningLabel,t,icon,onEffort,onReset,onModels,prefix=''}) {
  const id=name=>prefix?prefix+name[0].toUpperCase()+name.slice(1):name;
  menu.innerHTML=`<div class="model-menu-view model-menu-view-main"><div class="effort-heading"><strong></strong><button type="button" class="effort-reset">${icon('undo')}</button></div><button type="button" class="model-submenu-button"><span class="model-submenu-value"></span>${icon('chevronRight')}</button><div class="effort-slider-shell"><div class="effort-slider-dots" aria-hidden="true">${values.map(()=>'<i></i>').join('')}</div><input type="range" class="effort-slider" min="0" step="1"></div></div>`;
  const label=menu.querySelector('strong'),slider=menu.querySelector('input'),shell=menu.querySelector('.effort-slider-shell'),reset=menu.querySelector('.effort-reset'),models=menu.querySelector('.model-submenu-button');
  label.id=id('effortCurrentLabel');slider.id=id('effortSlider');reset.id=id('effortReset');models.id=id('modelSubmenuButton');
  reset.title=t('Reset model and reasoning');reset.setAttribute('aria-label',reset.title);reset.onclick=onReset;
  models.querySelector('span').textContent=modelName;models.onclick=onModels;
  slider.max=String(Math.max(0,values.length-1));slider.value=String(Math.max(0,values.indexOf(effort)));slider.disabled=values.length<2;slider.setAttribute('aria-label',t('Reasoning effort'));
  const sync=()=>{shell.style.setProperty('--effort-progress',`${values.length>1?Number(slider.value)/(values.length-1)*100:0}%`);label.textContent=reasoningLabel(values[slider.value]);slider.setAttribute('aria-valuetext',label.textContent);};
  slider.oninput=()=>{onEffort(values[slider.value]);sync();};sync();
}
export function renderModelOptions({menu,models,selected,t,icon,display,onSelect,onBack,prefix=''}) {
  const view=element('div','model-menu-view model-menu-view-models'),head=element('div','model-menu-title-row'),back=element('button','model-menu-back');
  back.type='button';back.id=prefix?prefix+'ModelMenuBack':'modelMenuBack';back.setAttribute('aria-label',t('Back'));back.innerHTML=icon('chevronLeft');back.onclick=onBack;
  const title=element('h2','model-menu-title',t('Model'));
  const searchBox=element('label','model-search'),search=element('input'),list=element('div','model-menu-list model-list');
  const empty=element('p','model-search-empty',t('No matching models'));
  search.type='search';search.placeholder=t('Search models');search.setAttribute('aria-label',search.placeholder);
  searchBox.innerHTML=icon('search');searchBox.append(search);empty.role='status';empty.hidden=true;
  head.append(back,title);view.append(head,searchBox,list,empty);menu.replaceChildren(view);
  const options=models.map(model=>{
    const name=display(model),button=element('button','model-option');
    button.type='button';button.dataset.model=model.model;button.setAttribute('aria-pressed',String(model.model===selected));
    const copy=element('span','model-option-copy');copy.dataset.i18nIgnore='';copy.append(element('strong','',name));
    if(model.description)copy.append(element('small','',model.description));
    const check=element('span','model-check');if(model.model===selected)check.innerHTML=icon('check');
    button.append(copy,check);button.onclick=()=>onSelect(model.model);list.append(button);
    return {button,terms:`${name} ${model.model} ${model.description||''}`.toLocaleLowerCase()};
  });
  const filter=()=>{
    const query=search.value.trim().toLocaleLowerCase();
    for(const {button,terms} of options)button.hidden=!terms.includes(query);
    empty.hidden=options.some(({button})=>!button.hidden);
  };
  search.oninput=filter;filter();
  view.onkeydown=event=>{
    const visible=options.filter(({button})=>!button.hidden).map(({button})=>button);
    const index=visible.indexOf(event.target);
    if(event.target===search&&event.key==='Escape'&&search.value){
      event.preventDefault();event.stopPropagation();search.value='';filter();return;
    }
    if(event.target===search&&event.key==='Enter'){
      event.preventDefault();if(visible.length===1&&!event.isComposing)visible[0].click();return;
    }
    if(event.target!==search&&index<0)return;
    const target=event.key==='ArrowDown'?visible[index+1]||visible[0]:event.key==='ArrowUp'?(index<0?visible.at(-1):visible[index-1]||search):index>=0&&event.key==='Home'?visible[0]:index>=0&&event.key==='End'?visible.at(-1):null;
    if(target){event.preventDefault();target.focus({preventScroll:true});target.scrollIntoView({block:'nearest'});}
  };
  // On touchscreens, leave typing opt-in so opening the picker does not raise the keyboard.
  return ()=> (matchMedia('(pointer:coarse)').matches ? list.querySelector('[aria-pressed=true]')||list.querySelector('button')||back : search).focus({preventScroll:true});
}
export function renderPermissionOptions({list,options,selected,t,icon,onSelect}) {
  list.replaceChildren();
  for(const option of options){const checked=option.mode===selected,button=element('button','permission-option');button.type='button';button.dataset.permissionMode=option.mode;button.role='menuitemradio';button.disabled=option.allowed===false;button.setAttribute('aria-checked',String(checked));const glyph=element('span','permission-option-icon'),copy=element('span','permission-option-copy'),check=element('span','permission-option-check');glyph.innerHTML=icon(option.icon);copy.append(element('strong','',t(option.optionLabel||option.label)),element('small','',t(option.allowed===false?'Not allowed by managed settings':option.description)));if(checked)check.innerHTML=icon('check');button.append(glyph,copy,check);button.onclick=()=>onSelect(option.mode);list.append(button);}
}

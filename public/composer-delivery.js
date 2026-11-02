// Queues belong to this browser tab. Reloaded entries require an explicit resume;
// a failed or uncertain request is never resent automatically.
export function createComposerDelivery({key,store,anchor,host,t,icon,menu,context,dispatch,onError,onChange=()=>{},notice='Queued in this tab. Reloading pauses sending.'}) {
  let mode='steer',busy=false,entries=[];
  try { entries=JSON.parse(store?.getItem(key)||'[]').map(entry=>({...entry,status:'paused'})); } catch { entries=[]; }
  const choice=document.createElement('button');choice.type='button';choice.className='composer-delivery-choice composer-text-button';choice.setAttribute('aria-haspopup','menu');
  anchor.before(choice);
  const list=document.createElement('section');list.className='composer-queue';list.dataset.i18nIgnore='';list.setAttribute('aria-label',t('Queued messages'));host.append(list);
  const save=(strict=false)=>{try{store?.setItem(key,JSON.stringify(entries));}catch(error){if(strict)throw error;onError(error);}};
  let signature='';
  function refresh() {
    const current=context(),visible=entries.filter(entry=>entry.threadId===current.threadId);
    choice.hidden=!current.turnId;choice.disabled=busy||!current.ready;
    choice.textContent=t(mode==='queue'?'Queue':'Steering');choice.title=t('Message delivery');choice.setAttribute('aria-label',t('Message delivery'));
    list.setAttribute('aria-label',t('Queued messages'));list.hidden=!visible.length;
    const next=JSON.stringify([visible,busy,current.turnId,current.ready,t('Queued messages'),t(notice)]);
    if(next===signature)return;signature=next;list.replaceChildren();
    for(const entry of visible){
      const row=document.createElement('div');row.className='composer-queue-row';row.dataset.queueId=entry.id;row.dataset.status=entry.status;
      const copy=document.createElement('span');copy.className='composer-queue-copy';
      const label=document.createElement('small');label.textContent=t(entry.status==='sending'?'Sending message…':entry.status==='failed'?'Send failed; retry manually':entry.status==='paused'?'Queue paused':entry.status==='ready'?'Ready to send':'Queued after current turn');
      const text=document.createElement('span');text.textContent=entry.text||entry.mentions?.map(item=>item.title).join(', ')||t('Attachments');copy.append(label,text);row.append(copy);
      if(['paused','failed'].includes(entry.status)){
        const resume=document.createElement('button');resume.type='button';resume.textContent=t('Resume queued message');resume.disabled=busy;
        resume.onclick=()=>{entry.status=current.turnId?'waiting':'ready';entry.waitTurnId=current.turnId;save();refresh();void pump();};row.append(resume);
      }
      const cancel=document.createElement('button');cancel.type='button';cancel.innerHTML=icon('x');cancel.setAttribute('aria-label',t('Cancel queued message'));cancel.disabled=entry.status==='sending';
      cancel.onclick=()=>{entries=entries.filter(item=>item!==entry);save();refresh();void pump();};row.append(cancel);list.append(row);
    }
    if(visible.length){const note=document.createElement('small');note.className='composer-queue-note';note.textContent=t(notice);list.append(note);}
  }
  choice.onclick=()=>menu.open(choice,[
    {label:t('Steering'),description:t('Add instructions to the running turn'),icon:mode==='steer'?'check':'arrowUp',action:()=>{mode='steer';refresh();onChange();}},
    {label:t('Queue'),description:t('Send after the current turn finishes'),icon:mode==='queue'?'check':'clock',action:()=>{mode='queue';refresh();onChange();}},
  ]);
  async function pump(){
    const current=context();if(busy||!current.ready||current.turnId)return;
    const entry=entries.find(item=>item.threadId===current.threadId);
    if(!entry||entry.status!=='ready')return;
    busy=true;entry.status='sending';save();refresh();onChange();
    try{
      const result=await dispatch(entry);
      if(result?.waitingFor){entry.status='waiting';entry.waitTurnId=result.waitingFor;}
      else entries=entries.filter(item=>item!==entry);
    }catch(error){entry.status='failed';onError(error);}
    finally{busy=false;save();refresh();onChange();}
  }
  refresh();
  return {
    get mode(){return mode;},
    get busy(){return busy;},
    refresh,
    enqueue(data){
      if(entries.filter(item=>item.threadId===data.threadId).length>=20)throw Error(t('Queue is full'));
      const entry={...structuredClone(data),id:crypto.randomUUID(),status:'waiting'};entries.push(entry);
      try{save(true);}catch(error){entries=entries.filter(item=>item!==entry);throw error;}
      refresh();return entry;
    },
    snapshot(threadId,turn){
      if(!turn?.id)return;
      let changed=false;
      for(const entry of entries)if(entry.threadId===threadId&&entry.status==='waiting'&&entry.waitTurnId===turn.id&&turn.status!=='inProgress'){entry.status=turn.status==='completed'?'ready':'paused';changed=true;}
      if(changed)save();refresh();queueMicrotask(()=>void pump());
    },
    clear(){entries=[];save();refresh();},
    dispose(){choice.remove();list.remove();},
  };
}

// Main-thread queues live in the gateway so closing a tab cannot lose or replay
// them. Ephemeral Side chats deliberately continue to use the tab-local helper.
export function createServerComposerDelivery({anchor,host,t,icon,menu,context,rpc,onError,onChange=()=>{},importLegacy}) {
  let mode='steer',entries=[],receipts=[],pending=false,loading=false,disposed=false,signature='',editing=null,lastSync=0,legacy=[];
  try{legacy=JSON.parse(sessionStorage.getItem('codex-webui-message-queue')||'[]');if(!Array.isArray(legacy))legacy=[];}catch{}
  let recovery=[];
  try{recovery=JSON.parse(sessionStorage.getItem('codex-webui-uncertain-messages')||'[]');if(!Array.isArray(recovery))recovery=[];receipts=[...recovery];}catch{}
  const saveRecovery=()=>{try{sessionStorage.setItem('codex-webui-uncertain-messages',JSON.stringify(recovery));}catch{}};
  const choice=document.createElement('button');choice.type='button';choice.className='composer-delivery-choice composer-text-button';choice.setAttribute('aria-haspopup','menu');anchor.before(choice);
  const list=document.createElement('section');list.className='composer-queue';list.dataset.i18nIgnore='';host.append(list);
  function button(label,action){const node=document.createElement('button');node.type='button';node.textContent=t(label);node.setAttribute('aria-label',t(label));node.disabled=pending||!context().ready;node.onclick=action;return node;}
  async function mutate(action,entry,extra={}) {
    if(pending)return;pending=true;refresh();
    try{
      try{await rpc('host/delivery/mutate',{action,payload:{id:entry.id,version:entry.version,...extra}});}
      catch(error){
        // Cancel and pause express intent for the same immutable message ID.
        // Refresh a status-only conflict once; edits/order changes always ask
        // the user to review concurrent modifications instead.
        if(!['cancel','pause'].includes(action)||error?.code!=='QUEUE_CONFLICT')throw error;
        const current=(await rpc('host/delivery/list',{threadId:entry.threadId})).entries?.find(item=>item.id===entry.id);
        if(!current||['sending','unknown'].includes(current.status))throw error;
        await rpc('host/delivery/mutate',{action,payload:{id:entry.id,version:current.version,...extra}});
      }
      editing=null;
    }
    catch(error){onError(error);}
    finally{pending=false;await sync();refresh();onChange();}
  }
  async function checkReceipt(id){if(pending)return;pending=true;refresh();try{await rpc('host/submissions/reconcile',{id});await sync();}catch(error){onError(error);}finally{pending=false;refresh();}}
  function refresh() {
    const current=context(),visible=entries.filter(entry=>entry.threadId===current.threadId),uncertain=receipts.filter(entry=>entry.threadId===current.threadId&&(['prepared','dispatching','unknown'].includes(entry.status)||(entry.status==='rejected'&&entry.localRecovery))&&!visible.some(item=>item.id===entry.id));
    choice.hidden=!current.turnId;choice.disabled=pending||!current.ready;choice.textContent=t(mode==='queue'?'Queue':'Steering');choice.title=t('Message delivery');choice.setAttribute('aria-label',t('Message delivery'));
    list.setAttribute('aria-label',t('Queued messages'));list.hidden=!visible.length&&!uncertain.length&&!legacy.length;
    const next=JSON.stringify([visible,uncertain,pending,current.ready,current.turnId,t('Queue paused'),editing,legacy.length]);
    if(next===signature)return;signature=next;
    // Do not replace a focused editor because a background poll returned.
    const editor=list.querySelector('.composer-queue-editor');if(editor&&editing&&editor.contains(document.activeElement)&&!pending)return;
    list.replaceChildren();
    if(legacy.length&&importLegacy){
      const row=document.createElement('div');row.className='composer-queue-row';
      const label=document.createElement('span');label.className='composer-queue-copy';label.textContent=t('Messages from the previous tab queue are paused.');
      const migrate=button('Import paused messages',async()=>{
        pending=true;refresh();
        try{for(const entry of [...legacy]){await importLegacy(entry);legacy=legacy.filter(item=>item!==entry);sessionStorage.setItem('codex-webui-message-queue',JSON.stringify(legacy));}}
        catch(error){onError(error);}finally{pending=false;await sync();refresh();}
      });row.append(label,migrate);list.append(row);
    }
    for(const entry of visible){
      const row=document.createElement('div');row.className='composer-queue-row';row.dataset.queueId=entry.id;row.dataset.status=entry.status;
      const copy=document.createElement('span');copy.className='composer-queue-copy';const label=document.createElement('small');
      label.textContent=t(entry.status==='sending'?'Sending message…':entry.status==='unknown'?'Delivery uncertain; check status':entry.status==='failed'?'Send failed; retry manually':entry.status==='paused'?'Queue paused':'Queued after current turn');
      const text=document.createElement('span');text.textContent=entry.text||entry.mentions?.map(item=>item.title).join(', ')||t('Attachments');copy.append(label,text);row.append(copy);
      if(editing===entry.id){const editor=document.createElement('div');editor.className='composer-queue-editor';const input=document.createElement('textarea');input.value=entry.text;input.setAttribute('aria-label',t('Edit queued message'));const save=button('Save queued message',()=>void mutate('edit',entry,{text:input.value}));editor.append(input,save,button('Cancel edit',()=>{editing=null;refresh();}));input.onkeydown=event=>{event.stopPropagation();if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();void mutate('edit',entry,{text:input.value});}};row.append(editor);}
      if(entry.status==='unknown')row.append(button('Check delivery status',()=>void checkReceipt(entry.id)));
      else if(entry.status!=='sending'){
        if(['paused','failed'].includes(entry.status)&&!entry.submissionStatus)row.append(button('Resume queued message',()=>void mutate('resume',entry)));
        const more=button('Queued message actions',()=>menu.open(more,[
          ...(!entry.submissionStatus?[{label:t('Edit queued message'),icon:'file',action:()=>{editing=entry.id;refresh();list.querySelector('textarea')?.focus();}},{label:t('Send now'),description:t('Steer the current turn, or start when idle'),icon:'arrowUp',action:()=>void mutate('sendNow',entry)}]:[]),
          {label:t('Move up'),icon:'arrowUp',action:()=>void mutate('reorder',entry,{direction:-1})},
          {label:t('Move down'),icon:'chevronDown',action:()=>void mutate('reorder',entry,{direction:1})},
          {label:t('Pause queued message'),icon:'square',action:()=>void mutate('pause',entry)},
          {label:t('Cancel queued message'),icon:'x',action:()=>void mutate('cancel',entry)},
        ]));more.innerHTML=icon('ellipsis');row.append(more);
        const cancel=button('Cancel queued message',()=>void mutate('cancel',entry));cancel.innerHTML=icon('x');row.append(cancel);
      }
      list.append(row);
    }
    for(const receipt of uncertain){
      const row=document.createElement('div');row.className='composer-queue-row';row.dataset.submissionId=receipt.id;row.dataset.status=receipt.status;
      const label=document.createElement('span');label.className='composer-queue-copy';label.textContent=t(receipt.status==='rejected'?'Send rejected; copy recovery text':'Delivery uncertain; check status');row.append(label);
      if(receipt.status!=='rejected')row.append(button('Check delivery status',()=>void checkReceipt(receipt.id)));
      if(receipt.text)row.append(button('Copy recovery text',()=>navigator.clipboard.writeText(receipt.text).catch(onError)));
      if(receipt.status==='rejected'&&receipt.localRecovery)row.append(button('Dismiss recovered message',()=>{recovery=recovery.filter(item=>item.id!==receipt.id);receipts=receipts.filter(item=>item.id!==receipt.id);saveRecovery();refresh();}));
      list.append(row);
    }
    if(visible.length||uncertain.length){const note=document.createElement('small');note.className='composer-queue-note';note.textContent=t(uncertain.length||visible.some(entry=>entry.status==='unknown')?'Unconfirmed messages are never resent automatically.':'Queued messages continue while this tab is closed. A gateway restart pauses the queue.');list.append(note);}
  }
  async function sync() {
    if(disposed||loading||!context().ready)return;loading=true;lastSync=Date.now();
    try{
      const [queue,submissions]=await Promise.all([rpc('host/delivery/list',{}),rpc('host/submissions/list',{}).catch(()=>({data:[]}))]);
      if(disposed)return;entries=queue.entries||[];
      const remote=submissions.data||submissions.entries||[];
      // A lost enqueue response may not have a submission receipt yet. Keep
      // local recovery text until the gateway positively confirms acceptance.
      for(const item of [...recovery]){
        if(entries.some(entry=>entry.id===item.id)){recovery=recovery.filter(entry=>entry.id!==item.id);continue;}
        const receipt=await rpc('host/submissions/get',{id:item.id}).catch(()=>null);
        if(receipt?.status==='accepted')recovery=recovery.filter(entry=>entry.id!==item.id);
        else if(receipt?.status==='rejected')Object.assign(item,{status:'rejected',localRecovery:true,error:receipt.error});
      }
      saveRecovery();receipts=[...remote.map(item=>({...recovery.find(entry=>entry.id===item.id),...item})),...recovery.filter(item=>!remote.some(entry=>entry.id===item.id))];refresh();
    }catch(error){if(!error?.silentTransportSwitch)onError(error);}finally{loading=false;}
  }
  choice.onclick=()=>menu.open(choice,[{label:t('Steering'),description:t('Add instructions to the running turn'),icon:mode==='steer'?'check':'arrowUp',action:()=>{mode='steer';refresh();onChange();}},{label:t('Queue'),description:t('Send after the current turn finishes'),icon:mode==='queue'?'check':'clock',action:()=>{mode='queue';refresh();onChange();}}]);
  const timer=setInterval(()=>void sync(),2000);refresh();
  return {
    get mode(){return mode;},get busy(){return pending;},refresh,
    async enqueue(data){const id=data.id||crypto.randomUUID();pending=true;refresh();try{const entry=await rpc('host/delivery/mutate',{action:'enqueue',payload:{...data,id}});entries=entries.filter(item=>item.id!==id);entries.push(entry);return entry;}finally{pending=false;void sync();refresh();}},
    snapshot(){if(Date.now()-lastSync>800)void sync();},
    notification(){void sync();},
    sync,
    uncertain(receipt){const value={...receipt,status:'unknown',localRecovery:true};if(!recovery.some(item=>item.id===receipt.id))recovery.push(value);saveRecovery();if(!receipts.some(item=>item.id===receipt.id))receipts.push(value);refresh();},
    clear(){/* Clearing the UI must never delete durable server messages. */},
    dispose(){disposed=true;clearInterval(timer);choice.remove();list.remove();},
  };
}

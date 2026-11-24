import { attachmentThumbnail, uploadComposerFile } from './composer-attachments.js';

function updateDeliveryToggle(button, mode, t) {
  const steering = mode === 'steer';
  button.textContent = t(steering ? 'Steering' : 'Queue');
  button.title = t(steering ? 'Switch to Queue' : 'Switch to Steering');
  button.setAttribute('aria-label', t('Queue / Steering'));
  button.setAttribute('aria-pressed', String(steering));
}

function messagePreview(entry, t) {
  const names = entry.mentions?.filter(item => item.icon !== 'image').map(item => item.title).join(', ');
  return entry.text || names || (entry.mentions?.length ? t('Attachments') : '');
}

function queueEditor(edit, { t, icon, cwd, ready, save, cancel, refresh }) {
  const editor=document.createElement('div');
  editor.className='composer-queue-editor';
  const input=document.createElement('textarea');
  input.value=edit.text;
  input.setAttribute('aria-label',t('Edit queued message'));
  input.oninput=()=>{edit.text=input.value;};
  input.onkeydown=event=>{
    event.stopPropagation();
    if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();commit.click();}
  };
  editor.append(input);
  if(edit.entry.mentions?.length||edit.added.length){
    const tray=document.createElement('div');
    tray.className='composer-queue-attachments';
    for(const item of [...edit.entry.mentions||[],...edit.added]){
      const chip=document.createElement('span');
      chip.className='composer-context-chip';
      const thumbnail=attachmentThumbnail(item);
      chip.innerHTML=thumbnail||icon(item.icon||'file');
      if(!thumbnail){
        const name=document.createElement('span');
        name.textContent=item.title;
        chip.append(name);
      }
      if(edit.added.includes(item)){
        const remove=control('Remove {name}',()=>{edit.added=edit.added.filter(attachment=>attachment!==item);refresh();},icon('x'),{name:item.title});
        chip.append(remove);
      }
      tray.append(chip);
    }
    editor.append(tray);
  }
  function control(label,action,markup,params){
    const button=document.createElement('button');
    button.type='button';
    button.title=t(label,params);
    button.setAttribute('aria-label',button.title);
    if(markup)button.innerHTML=markup;
    else button.textContent=button.title;
    button.onclick=action;
    return button;
  }
  const files=document.createElement('input');
  files.type='file';files.accept='image/*';files.multiple=true;files.hidden=true;
  files.setAttribute('aria-label',t('Add images'));
  async function addImages(images){
    if(!ready||edit.uploading||!images.length)return;
    if(images.length+edit.added.length+(edit.entry.mentions?.filter(item=>item.source==='attachment').length||0)>20||
      images.some(file=>!file.type.startsWith('image/')||file.size>20*1024*1024)){
      edit.error='Choose up to 20 images, at most 20 MiB each.';refresh();return;
    }
    edit.uploading=true;edit.error='';refresh();
    try{
      for(const file of images){
        const image=await uploadComposerFile(file,cwd,t);
        if(image.icon!=='image')throw new Error(t('This image format is not supported.'));
        edit.added.push(image);
      }
    }catch(error){edit.error=error.message||'Upload failed';}
    finally{edit.uploading=false;refresh();}
  }
  files.onchange=()=>void addImages([...files.files]);
  input.onpaste=event=>{
    const images=[...event.clipboardData.files].filter(file=>file.type.startsWith('image/'));
    if(images.length){event.preventDefault();event.stopPropagation();void addImages(images);}
  };
  const add=control('Add images',()=>files.click(),icon('image'));
  add.disabled=!ready||edit.uploading;
  const commit=control('Save queued message',save);
  commit.disabled=!ready||edit.uploading;
  const cancelButton=control('Cancel edit',cancel);
  if(edit.uploading||edit.error){
    const status=document.createElement('span');status.role='status';status.textContent=t(edit.uploading?'Uploading images…':edit.error);editor.append(status);
  }
  editor.append(files,add,commit,cancelButton);
  return editor;
}

// Queues belong to this browser tab. Reloaded entries require an explicit resume;
// a failed or uncertain request is never resent automatically.
export function createComposerDelivery({key,store,anchor,host,t,icon,context,dispatch,onError,onChange=()=>{},notice='Queued in this tab. Reloading pauses sending.'}) {
  let mode='queue',busy=false,entries=[],editing=null;
  try { entries=JSON.parse(store?.getItem(key)||'[]').map(entry=>({...entry,status:'paused'})); } catch { entries=[]; }
  const choice=document.createElement('button');choice.type='button';choice.className='composer-delivery-choice composer-text-button';
  anchor.before(choice);
  const list=document.createElement('section');list.className='composer-queue';list.dataset.i18nIgnore='';list.setAttribute('aria-label',t('Queued messages'));host.prepend(list);
  const save=(strict=false)=>{try{store?.setItem(key,JSON.stringify(entries));}catch(error){if(strict)throw error;onError(error);}};
  let signature='';
  function refresh() {
    const current=context(),visible=entries.filter(entry=>entry.threadId===current.threadId);
    choice.disabled=busy;
    updateDeliveryToggle(choice,mode,t);
    list.setAttribute('aria-label',t('Queued messages'));list.hidden=!visible.length;
    const next=JSON.stringify([visible,busy,current.turnId,current.ready,t('Queued messages'),t(notice),editing?.entry.id,editing?.added,editing?.uploading,editing?.error]);
    if(next===signature)return;signature=next;list.replaceChildren();
    for(const entry of visible){
      const row=document.createElement('div');row.className='composer-queue-row';row.dataset.queueId=entry.id;row.dataset.status=entry.status;
      if(editing?.entry===entry){
        const edit=editing;
        row.append(queueEditor(edit,{
          t,icon,cwd:current.cwd,ready:!busy&&current.ready,refresh,
          cancel:()=>{editing=null;refresh();void pump();},
          save:()=>{
            const mentions=[...entry.mentions||[],...edit.added];
            if(!edit.text.trim()&&!mentions.length){edit.error='Enter a message or add an image.';refresh();return;}
            const previous={text:entry.text,mentions:entry.mentions};
            Object.assign(entry,{text:edit.text,mentions});
            try{save(true);}
            catch(error){Object.assign(entry,previous);edit.error=error.message;refresh();return;}
            editing=null;refresh();void pump();
          },
        }));
        list.append(row);continue;
      }
      const copy=document.createElement('span');copy.className='composer-queue-copy';
      const label=document.createElement('small');label.textContent=t(entry.status==='sending'?'Sending message…':entry.status==='failed'?'Send failed; retry manually':entry.status==='paused'?'Queue paused':entry.status==='ready'?'Ready to send':'Queued after current turn');
      const text=document.createElement('span');text.textContent=messagePreview(entry,t)||t('Attachments');copy.append(label,text);row.append(copy);
      if(['paused','failed'].includes(entry.status)){
        const resume=document.createElement('button');resume.type='button';resume.textContent=t('Resume queued message');resume.disabled=busy;
        resume.onclick=()=>{entry.status=current.turnId?'waiting':'ready';entry.waitTurnId=current.turnId;save();refresh();void pump();};row.append(resume);
      }
      const cancel=document.createElement('button');cancel.type='button';cancel.innerHTML=icon('x');cancel.setAttribute('aria-label',t('Cancel queued message'));cancel.disabled=entry.status==='sending';
      cancel.onclick=()=>{entries=entries.filter(item=>item!==entry);save();refresh();void pump();};row.append(cancel);list.append(row);
      if(entry.status!=='sending'){
        const edit=document.createElement('button');edit.type='button';edit.title=t('Edit queued message');edit.setAttribute('aria-label',edit.title);edit.innerHTML=icon('squarePen');
        edit.onclick=()=>{editing={entry,text:entry.text||'',added:[],uploading:false,error:''};refresh();list.querySelector('textarea')?.focus();};
        row.insertBefore(edit,cancel);
      }
    }
    if(visible.length){const note=document.createElement('small');note.className='composer-queue-note';note.textContent=t(notice);list.append(note);}
  }
  choice.onclick=()=>{mode=mode==='queue'?'steer':'queue';refresh();onChange();};
  async function pump(){
    const current=context();if(busy||!current.ready||current.turnId)return;
    const entry=entries.find(item=>item.threadId===current.threadId);
    if(!entry||entry.status!=='ready'||editing?.entry===entry)return;
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
    clear(){entries=[];editing=null;save();refresh();},
    dispose(){choice.remove();list.remove();},
  };
}

// Main-thread queues live in the gateway so closing a tab cannot lose or replay
// them. Ephemeral Side chats deliberately continue to use the tab-local helper.
export function createServerComposerDelivery({anchor,host,t,icon,menu,context,rpc,onError,onAccepted=()=>{},onChange=()=>{},onCopied=()=>{},importLegacy}) {
  let mode='queue',entries=[],receipts=[],pending=false,loading=false,disposed=false,signature='',editing=null,lastSync=0,legacy=[];
  let checking=null,feedback=null,receiptRevision=0;
  const readOptions={timeoutMs:12000,timeoutMessage:'Delivery status check timed out. Try again.'};
  try{legacy=JSON.parse(sessionStorage.getItem('codex-webui-message-queue')||'[]');if(!Array.isArray(legacy))legacy=[];}catch{}
  let recovery=[];
  try{recovery=JSON.parse(sessionStorage.getItem('codex-webui-uncertain-messages')||'[]');if(!Array.isArray(recovery))recovery=[];receipts=[...recovery];}catch{}
  const saveRecovery=()=>{try{sessionStorage.setItem('codex-webui-uncertain-messages',JSON.stringify(recovery));}catch{}};
  const choice=document.createElement('button');choice.type='button';choice.className='composer-delivery-choice composer-text-button';anchor.before(choice);
  const list=document.createElement('section');list.className='composer-queue';list.dataset.i18nIgnore='';
  const status=document.createElement('p');status.className='composer-delivery-status';status.role='status';status.dataset.i18nIgnore='';host.prepend(list,status);
  function button(label,action,{local=false}={}){const node=document.createElement('button');node.type='button';node.textContent=t(label);node.setAttribute('aria-label',t(label));node.disabled=!local&&(pending||!context().ready);node.onclick=action;return node;}
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
    }
    catch(error){onError(error);}
    finally{pending=false;await sync();refresh();onChange();}
  }
  async function checkReceipt(id){
    if(checking||!(context().canCheck??context().ready))return;
    const threadId=context().threadId;
    checking=id;feedback={threadId,label:'Checking delivery status…'};refresh();
    try{
      const receipt=await rpc('host/submissions/reconcile',{id},readOptions);
      const labels={
        accepted:'Message received by Codex.',
        rejected:'Codex did not accept this message.',
        prepared:'The gateway is preparing this message.',
        dispatching:'The gateway is waiting for Codex to confirm.',
        unknown:'Delivery is still unconfirmed.',
      };
      feedback={threadId,id,label:receipt?labels[receipt.status]||labels.unknown:'The gateway has no receipt for this message yet.'};
      if(receipt?.status==='accepted'||receipt?.status==='rejected'){
        receiptRevision++;
        recovery=recovery.flatMap(item=>item.id!==id?[item]:receipt.status==='rejected'?[{...item,status:'rejected',error:receipt.error}]:[]);
        saveRecovery();
        receipts=receipts.filter(item=>item.id!==id).concat(recovery.filter(item=>item.id===id));
        if(receipt.status==='accepted')onAccepted(receipt);
      }
      void sync();
    }catch(error){
      feedback={threadId,id,label:error?.code==='RPC_TIMEOUT'?'Delivery status check timed out. Try again.':'Could not check delivery status. Try again.'};
    }finally{checking=null;refresh();}
  }
  function checkButton(id){
    const node=button(checking===id?'Checking delivery status…':'Check delivery status',()=>void checkReceipt(id),{local:true});
    node.disabled=Boolean(checking)||!(context().canCheck??context().ready);
    return node;
  }
  function dismissReceipt(receipt){
    receiptRevision++;
    const local=recovery.find(item=>item.id===receipt.id);
    recovery=recovery.filter(item=>item.id!==receipt.id);
    if(receipt.status==='rejected')receipts=receipts.filter(item=>item.id!==receipt.id);
    else recovery.push({...local,id:receipt.id,threadId:receipt.threadId,dismissed:true});
    if(feedback?.id===receipt.id)feedback=null;
    saveRecovery();refresh();
  }
  async function saveEdit(){
    const edit=editing;
    if(!edit||pending||edit.uploading||!context().ready)return;
    const entry=edit.entry;
    const data={id:entry.id,text:edit.text,attachmentIds:edit.added.map(item=>item.id)};
    if(!data.text.trim()&&!entry.mentions?.some(item=>item.source==='attachment')&&!data.attachmentIds.length){
      edit.error='Enter a message or add an image.';refresh();return;
    }
    const apply=version=>rpc('host/delivery/mutate',{action:'edit',payload:{...data,version}},readOptions);
    pending=true;edit.error='';refresh();
    try{
      let updated;
      try{updated=await apply(entry.version);}
      catch(error){
        if(error?.code!=='QUEUE_CONFLICT')throw error;
        const current=(await rpc('host/delivery/list',{threadId:entry.threadId},readOptions)).entries.find(item=>item.id===entry.id);
        if(!current||!['queued','waiting','paused','failed'].includes(current.status)||current.submissionStatus||
          current.text!==entry.text||JSON.stringify(current.mentions)!==JSON.stringify(entry.mentions)||
          JSON.stringify(current.params)!==JSON.stringify(entry.params))throw error;
        updated=await apply(current.version);
      }
      receiptRevision++;
      entries=entries.map(item=>item.id===updated.id?updated:item);
      if(editing===edit)editing=null;
    }catch(error){
      edit.error=error?.code==='QUEUE_CONFLICT'?'This queued message changed. Your edit is still here.':error.message;
    }finally{pending=false;refresh();void sync();}
  }
  function refresh() {
    const current=context(),visible=entries.filter(entry=>entry.threadId===current.threadId);
    const edit=editing?.entry.threadId===current.threadId?editing:null;
    const uncertain=receipts.filter(entry=>entry.threadId===current.threadId&&(['prepared','dispatching','unknown'].includes(entry.status)||(entry.status==='rejected'&&entry.localRecovery))&&!visible.some(item=>item.id===entry.id)&&!recovery.some(item=>item.id===entry.id&&item.dismissed));
    const message=feedback&&feedback.threadId===current.threadId?t(feedback.label):'';
    if(status.textContent!==message)status.textContent=message;
    choice.disabled=pending;updateDeliveryToggle(choice,mode,t);
    list.setAttribute('aria-label',t('Queued messages'));list.hidden=!visible.length&&!uncertain.length&&!legacy.length&&!edit;
    const next=JSON.stringify([visible,uncertain,pending,checking,current.ready,current.canCheck,t('Queue paused'),edit?.entry.id,edit?.added,edit?.uploading,edit?.error,legacy.length]);
    if(next===signature)return;signature=next;
    const focus=list.querySelector('.composer-queue-editor textarea:focus');
    const selection=focus&&[focus.selectionStart,focus.selectionEnd];
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
    const rows=edit&&!visible.some(entry=>entry.id===edit.entry.id)?[...visible,edit.entry]:visible;
    for(const entry of rows){
      const row=document.createElement('div');row.className='composer-queue-row';row.dataset.queueId=entry.id;row.dataset.status=entry.status;
      if(edit?.entry.id===entry.id){
        row.append(queueEditor(edit,{
          t,icon,cwd:edit.entry.params?.cwd||current.cwd,ready:current.ready&&!pending,
          save:()=>void saveEdit(),cancel:()=>{editing=null;refresh();},refresh,
        }));
        list.append(row);continue;
      }
      const copy=document.createElement('span');copy.className='composer-queue-copy';const label=document.createElement('small');
      label.textContent=t(entry.status==='sending'?'Sending message…':entry.status==='unknown'?'Delivery uncertain; check status':entry.status==='failed'?'Send failed; retry manually':entry.status==='paused'?'Queue paused':'Queued after current turn');
      const text=document.createElement('span');text.textContent=messagePreview(entry,t)||t('Attachments');copy.append(label,text);row.append(copy);
      if(entry.status==='unknown')row.append(checkButton(entry.id));
      else if(entry.status!=='sending'){
        if(['paused','failed'].includes(entry.status)&&!entry.submissionStatus)row.append(button('Resume queued message',()=>void mutate('resume',entry)));
        const more=button('Queued message actions',()=>menu.open(more,[
          ...(!entry.submissionStatus?[{label:t('Edit queued message'),icon:'file',action:()=>{editing={entry,text:entry.text||'',added:[],uploading:false,error:''};refresh();list.querySelector('textarea')?.focus();}},{label:t('Send now'),description:t('Steer the current turn, or start when idle'),icon:'arrowUp',action:()=>void mutate('sendNow',entry)}]:[]),
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
      const label=document.createElement('span');label.className='composer-queue-copy';
      const state=document.createElement('small');state.textContent=t(receipt.status==='rejected'?'Send rejected; copy recovery text':'Delivery uncertain; check status');label.append(state);
      const preview=document.createElement('span');
      preview.textContent=messagePreview(receipt,t);
      if(preview.textContent)label.append(preview);
      row.append(label);
      if(receipt.status!=='rejected')row.append(checkButton(receipt.id));
      if(receipt.text)row.append(button('Copy recovery text',async()=>{try{await navigator.clipboard.writeText(receipt.text);onCopied();}catch{onError(new Error(t('Could not copy the recovery text.')));}},{local:true}));
      row.append(button('Dismiss recovered message',()=>dismissReceipt(receipt),{local:true}));
      list.append(row);
    }
    if(visible.length||uncertain.length){const note=document.createElement('small');note.className='composer-queue-note';note.textContent=t(uncertain.length||visible.some(entry=>entry.status==='unknown')?'Unconfirmed messages are never resent automatically.':'Queued messages continue while this tab is closed. A gateway restart pauses the queue.');list.append(note);}
    if(selection){
      const input=list.querySelector('.composer-queue-editor textarea');
      input?.focus({preventScroll:true});input?.setSelectionRange(...selection);
    }
  }
  async function sync() {
    if(disposed||loading||!(context().canCheck??context().ready))return;loading=true;lastSync=Date.now();
    const revision=receiptRevision;
    try{
      const [queue,submissions]=await Promise.all([rpc('host/delivery/list',{},readOptions),rpc('host/submissions/list',{},readOptions)]);
      if(disposed||revision!==receiptRevision)return;entries=queue.entries||[];
      const remote=submissions.data||submissions.entries||[];
      // A lost enqueue response may not have a submission receipt yet. Keep
      // local recovery text until the gateway positively confirms acceptance.
      for(const item of [...recovery]){
        if(entries.some(entry=>entry.id===item.id)){recovery=recovery.filter(entry=>entry.id!==item.id);continue;}
        const receipt=await rpc('host/submissions/get',{id:item.id},readOptions).catch(()=>null);
        if(disposed||revision!==receiptRevision)return;
        if(receipt?.status==='accepted')recovery=recovery.filter(entry=>entry.id!==item.id);
        else if(receipt?.status==='rejected')Object.assign(item,{status:'rejected',localRecovery:true,error:receipt.error});
      }
      saveRecovery();receipts=[...remote.map(item=>({...recovery.find(entry=>entry.id===item.id),...item})),...recovery.filter(item=>!remote.some(entry=>entry.id===item.id))];refresh();
    }catch(error){if(!error?.silentTransportSwitch&&error?.code!=='RPC_TIMEOUT')onError(error);}finally{loading=false;}
  }
  choice.onclick=()=>{mode=mode==='queue'?'steer':'queue';refresh();onChange();};
  const timer=setInterval(()=>void sync(),2000);refresh();
  return {
    get mode(){return mode;},get busy(){return pending;},refresh,
    async enqueue(data,options){const id=data.id||crypto.randomUUID();pending=true;refresh();try{const entry=await rpc('host/delivery/mutate',{action:'enqueue',payload:{...data,id}},options);entries=entries.filter(item=>item.id!==id);entries.push(entry);return entry;}finally{pending=false;void sync();refresh();}},
    snapshot(){if(Date.now()-lastSync>800)void sync();},
    notification(){void sync();},
    sync,
    uncertain(receipt){const value={...receipt,status:'unknown',localRecovery:true};if(!recovery.some(item=>item.id===receipt.id))recovery.push(value);saveRecovery();if(!receipts.some(item=>item.id===receipt.id))receipts.push(value);refresh();},
    clear(){/* Clearing the UI must never delete durable server messages. */},
    dispose(){disposed=true;clearInterval(timer);choice.remove();list.remove();status.remove();},
  };
}

import { buildApprovalModel, permissionRows } from '../src/shared/codex-surfaces.js';
import { createUserInputCard } from './user-input.js';

// Native decisions keep their structured payloads; all model-provided copy is text.
export function createSideChatRequest(req,{t,icon,respond,requestEpoch,onResolved,toast}) {
  if(req.method==='item/tool/requestUserInput')return createUserInputCard(req,{translate:t,onSubmit:async result=>{await respond(req.id,result,undefined,requestEpoch);onResolved(req.id);}});
  if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(req.method))return null;
  const model=buildApprovalModel(req),p=req.params||{},card=document.createElement('section');card.className='approval-card';card.dataset.codexApprovalSurface='';
  const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
  const content=node('div','approval-content',''),identity=node('div','approval-identity','');identity.innerHTML=icon(model.kind==='patch'?'fileDiff':model.kind==='permission'?'shield':'terminal');identity.append(node('span','',model.identity));content.append(identity,node('div','approval-title',t(model.title)));
  if(model.subtitle)content.append(node('div','approval-subtitle',model.subtitle));if(model.reason)content.append(node('p','approval-reason',model.reason));
  const body=node('div','approval-body','');
  if(p.command){const code=node('pre','approval-command',p.command);body.append(code);}
  if(model.kind==='permission')for(const item of permissionRows(p.permissions)){const row=node('div','permission-row','');row.append(node('span','',t(item.label)),node('code','',item.value));body.append(row);}
  const form=node('form','approval-actions',''),actions=node('div','approval-actions-main','');
  const answer=async decision=>{card.querySelectorAll('button').forEach(b=>b.disabled=true);try{await respond(req.id,model.kind==='permission'?decision:{decision},undefined,requestEpoch);onResolved(req.id);}catch(error){card.querySelectorAll('button').forEach(b=>b.disabled=false);toast(error.message);}};
  const button=(spec,cls)=>{const b=node('button',cls,t(spec.label));b.type='button';b.onclick=()=>void answer(spec.decision);return b;};
  if(model.leading)form.append(button(model.leading,'approval-leading'));
  actions.append(button(model.deny,'approval-deny'));if(model.scoped)actions.append(button(model.scoped,'approval-scoped'));
  actions.append(button(model.primary,'approval-primary'));form.append(actions);form.onsubmit=e=>e.preventDefault();card.append(content,body,form);return card;
}

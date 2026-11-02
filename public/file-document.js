import { marked } from 'marked';
import { codexIcon } from './codex-icons.js';
import { renderFileMarkdown } from './rendering.js';
import { createCodeEditor, highlightCode, highlightFences } from './code-editor.js';

export function mountFileDocument({body,toolbar,model,filename,cwd,t,save,toast}) {
  const node = (tag,cls='',text='')=>{const el=document.createElement(tag);el.className=cls;el.textContent=text;return el;};
  const button = (label,glyph,action)=>{const b=node('button','explorer-icon-button');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.innerHTML=codexIcon(glyph);b.onclick=action;return b;};
  let editing = false, source = !/\.(md|markdown|mdown)$/i.test(filename), editor = null, inline = null, blocks = [], disposed = false, saving = false, error = '', timer;
  const markdown = !source;
  const actions=node('div','explorer-document-actions');
  const edit=button('Edit file','squarePen',()=>{finishInline();editing=!editing;error='';render();});
  edit.disabled=!model.writable;
  const saveButton=button('Save file','save',()=>void persist());
  const discard=button('Discard changes','undo',()=>{if(!dirty()||confirm(t('Discard unsaved file changes?'))){finishInline(false);model.text=model.savedText;error='';render();}});
  const reload=button('Reload file','refreshCw',()=>void reloadDocument());
  const toggle=markdown ? button('View source','file',()=>{finishInline();source=!source;toggle.title=source?'Preview':'View source';toggle.setAttribute('aria-label',toggle.title);toggle.setAttribute('aria-pressed',String(source));render();}) : null;
  if(toggle){toggle.setAttribute('aria-pressed','false');actions.append(toggle);}
  actions.append(edit,saveButton,discard,reload);toolbar.insertBefore(actions,toolbar.lastChild);
  const status=node('div','explorer-document-status');status.role='status';status.setAttribute('aria-live','polite');body.before(status);
  const name=toolbar.querySelector('.explorer-preview-name');
  function dirty(){return model.text!==model.savedText;}
  function sync(){
    saveButton.disabled=!model.writable||!dirty()||saving;discard.disabled=!dirty()||saving;reload.disabled=saving;edit.disabled=!model.writable||saving;if(toggle)toggle.disabled=saving;
    edit.setAttribute('aria-pressed',String(editing));name?.classList.toggle('is-dirty',dirty());
    status.textContent=error||(saving?'Saving…':!model.writable?(model.editingUnavailable?'Update the running WebUI service to edit files.':'Read only'):dirty()?'Unsaved changes':editing&&!source?'Click a block to edit Markdown.':'');
    if(error&&dirty()){const copy=node('button','explorer-copy-draft','Copy draft');copy.type='button';copy.onclick=async()=>{try{await navigator.clipboard.writeText(model.text);toast(t('Copied'));}catch{toast(t('Copy failed. Select the answer and copy it.'));}};status.append(copy);}
    status.classList.toggle('is-error',Boolean(error));status.hidden=!status.textContent;
  }
  async function persist(){
    if(saving||!model.writable||!dirty())return;
    finishInline();saving=true;error='';sync();
    const text=model.text,expected=model.revision;
    try {
      const result=await save({text,revision:expected});
      model.savedText=text;model.revision=result.revision;
      if(!disposed)toast(t('File saved'));
    } catch(e){
      error=e.code==='FILE_CONFLICT'?'This file changed on disk. Your draft is kept. Copy it before reloading.':e.code==='FILE_READ_ONLY'?'This file is read only. Your draft is kept.':e.code==='FILE_TOO_LARGE'?'This file exceeds the 256 KiB editing limit.':'Unable to save the file. Your draft is kept. Check the connection and permissions.';
    } finally {saving=false;if(!disposed)sync();}
  }
  async function reloadDocument(){
    if(dirty()&&!confirm(t('Discard unsaved file changes?')))return;
    saving=true;sync();
    try {const fresh=await save(null);finishInline(false);Object.assign(model,{...fresh,savedText:fresh.text});error='';if(!disposed)render();}
    catch{error='Unable to reload this file. Your draft is kept.';}
    finally{saving=false;if(!disposed)sync();}
  }
  function changed(text){model.text=text;error='';sync();}
  function destroyEditor(){editor?.destroy();editor=null;}
  function finishInline(renderAfter=true){
    if(!inline)return;
    clearTimeout(timer);inline.editor.destroy();inline=null;
    if(renderAfter&&!disposed)renderMarkdown();
  }
  function renderFragment(element,text,links){element.innerHTML=renderFileMarkdown(text,{cwd,links});highlightFences(element);}
  function activate(offset){
    if(!editing||saving)return;
    if(inline){if(offset>=inline.originalEnd)offset+=inline.end-inline.originalEnd;finishInline();}
    const block=blocks.find(b=>offset>=b.from&&offset<b.to)||blocks.at(-1);if(!block)return;
    const host=block.element;host.replaceChildren();host.classList.add('is-editing');host.removeAttribute('tabindex');host.removeAttribute('role');host.removeAttribute('aria-label');
    const input=node('div','markdown-block-editor'),live=node('div','markdown-block-live'),done=node('button','markdown-block-done','Done');done.type='button';host.append(input,done,live);
    done.dataset.i18nUi='';done.dataset.editorUi='Done';done.textContent=t('Done');
    // Blank lines separate blocks. Keep them outside the editable slice so an
    // ordinary paragraph/title replacement cannot merge its following block.
    const rawBlock=model.text.slice(block.from,block.to),breaks=rawBlock.match(/(?:\r?\n){2,}$/)?.[0]||'';
    const separator=breaks ? breaks.slice(breaks.startsWith('\r\n')?2:1) : '';
    const editableEnd=block.to-separator.length;
    const state={from:block.from,end:editableEnd,originalEnd:editableEnd,element:host,editor:null};inline=state;
    const raw=model.text.slice(state.from,state.end);
    renderFragment(live,raw,block.links);
    state.editor=createCodeEditor({parent:input,text:raw,filename:'document.md',label:t('Edit Markdown block'),onSave:()=>void persist(),onDone:()=>{finishInline();edit.focus();},onChange:text=>{
      changed(model.text.slice(0,state.from)+text+model.text.slice(state.end));state.end=state.from+text.length;
      clearTimeout(timer);timer=setTimeout(()=>{if(inline===state)renderFragment(live,text,block.links);},100);
    }});
    done.onclick=()=>{finishInline();edit.focus();};state.editor.focus();
  }
  function renderMarkdown(){
    body.className='explorer-preview-body message-text explorer-markdown';body.replaceChildren();blocks=[];
    const tokens=marked.lexer(model.text,{gfm:true,breaks:true});
    // Some lexers normalize line endings. Fall back to one source-backed block
    // rather than risk losing bytes, whitespace or an unsupported construct.
    const exact=tokens.every(token=>typeof token.raw==='string')&&tokens.map(token=>token.raw).join('')===model.text;
    const parts=exact?tokens:[{raw:model.text,type:'document'}];let offset=0;
    for(const part of parts){
      const from=offset;offset+=part.raw.length;
      const el=node('div','markdown-file-block');el.dataset.i18nIgnore='';
      renderFragment(el,part.raw,tokens.links);
      const block={from,to:offset,element:el,links:tokens.links};blocks.push(block);
      if(editing&&part.raw.trim()&&part.type!=='def'&&part.type!=='space'){
        el.tabIndex=0;el.role='group';el.setAttribute('aria-label',t('Edit Markdown block'));
        el.onclick=event=>{if(inline?.element===el||event.target.closest('a,button,input,textarea,[contenteditable=true]'))return;activate(from);};
        el.onkeydown=event=>{if(event.target===el&&['Enter',' '].includes(event.key)){event.preventDefault();activate(from);}};
      }
      body.append(el);
    }
    if(editing&&!model.text){const host=node('div','markdown-file-block'),empty=node('button','markdown-block-empty',t('Start writing Markdown'));empty.type='button';empty.dataset.i18nUi='';empty.dataset.editorUi='Start writing Markdown';empty.onclick=()=>{blocks=[{from:0,to:0,element:host,links:{}}];activate(0);};host.append(empty);body.append(host);}
  }
  function render(){
    destroyEditor();finishInline(false);body.dataset.i18nIgnore='';
    if(!source)renderMarkdown();
    else if(editing){
      body.className='explorer-preview-body is-code-editor';body.replaceChildren();
      editor=createCodeEditor({parent:body,text:model.text,filename,label:t('File editor'),onChange:changed,onSave:()=>void persist()});editor.focus();
    }else{
      body.className='explorer-preview-body has-code';
      const code=node('pre','explorer-code'),lines=node('pre','explorer-line-numbers',Array.from({length:model.text.split('\n').length},(_,i)=>i+1).join('\n'));
      lines.setAttribute('aria-hidden','true');body.replaceChildren(lines,code);void highlightCode(code,model.text,filename);
    }
    sync();
  }
  // Editor Mod-s handles its own event; preview mode also supports saving.
  function keydown(event){if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();void persist();}}
  body.parentElement.addEventListener('keydown',keydown);
  const parent=body.parentElement;
  const unsubscribe=globalThis.__codexWebuiI18n?.subscribe(()=>{
    editor?.view.contentDOM.setAttribute('aria-label',t('File editor'));
    inline?.editor?.view.contentDOM.setAttribute('aria-label',t('Edit Markdown block'));
    for(const block of blocks)if(block.element.hasAttribute('aria-label'))block.element.setAttribute('aria-label',t('Edit Markdown block'));
    for(const element of body.querySelectorAll('[data-editor-ui]'))element.textContent=t(element.dataset.editorUi);
  });
  render();
  return {destroy(){disposed=true;clearTimeout(timer);unsubscribe?.();destroyEditor();finishInline(false);parent.removeEventListener('keydown',keydown);actions.remove();status.remove();}};
}

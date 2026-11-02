import { test, expect } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createServerComposerDelivery } from '../../public/composer-delivery.js';

async function fixture(run:any) {
  const dom=new JSDOM('<form><button></button></form>',{url:'http://localhost/'});
  const previous={document:globalThis.document,storage:globalThis.sessionStorage,navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator')};
  globalThis.document=dom.window.document;globalThis.sessionStorage=dom.window.sessionStorage;
  const copied:string[]=[];Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async(text:string)=>{copied.push(text);}}}});
  let queue:any;
  const setup=(rpc:any,extra:any={})=>queue=createServerComposerDelivery({anchor:document.querySelector('button'),host:document.querySelector('form'),t:(text:string)=>text,icon:()=>'',menu:{open(){}},context:()=>({threadId:'thread-A',turnId:'active',ready:true}),rpc,onError:(error:any)=>{throw error;},...extra});
  try{await run({setup,copied,storage:dom.window.sessionStorage});}
  finally{queue?.dispose();globalThis.document=previous.document;globalThis.sessionStorage=previous.storage;if(previous.navigator)Object.defineProperty(globalThis,'navigator',previous.navigator);else delete (globalThis as any).navigator;dom.window.close();}
}
const id='00000000-0000-4000-8000-000000000001';

test('unknown remote receipts retain local recovery text; late rejection stays copyable until explicit dismissal',()=>fixture(async({setup,copied,storage}:any)=>{
  let status='unknown';const calls:string[]=[];
  const queue=setup(async(method:string)=>{calls.push(method);if(method==='host/delivery/list')return {entries:[]};if(method==='host/submissions/list')return {data:status==='unknown'?[{id,threadId:'thread-A',status}]:[]};if(method==='host/submissions/get')return {id,threadId:'thread-A',status,error:status==='rejected'?{message:'Rejected'}:undefined};});
  queue.uncertain({id,threadId:'thread-A',text:'Original message text'});await queue.sync();
  expect(document.querySelector('[data-submission-id]')?.getAttribute('data-status')).toBe('unknown');
  (document.querySelector('[aria-label="Copy recovery text"]') as HTMLButtonElement).click();await Bun.sleep(0);expect(copied).toEqual(['Original message text']);
  status='rejected';await queue.sync();expect(document.querySelector('[data-submission-id]')?.getAttribute('data-status')).toBe('rejected');
  expect(document.body.textContent).toContain('Send rejected; copy recovery text');
  expect(JSON.parse(storage.getItem('codex-webui-uncertain-messages'))[0].text).toBe('Original message text');
  (document.querySelector('[aria-label="Copy recovery text"]') as HTMLButtonElement).click();await Bun.sleep(0);expect(copied).toEqual(['Original message text','Original message text']);
  expect(calls.some(method=>method==='host/delivery/mutate'||method==='turn/start'||method==='turn/steer')).toBe(false);
  (document.querySelector('[aria-label="Dismiss recovered message"]') as HTMLButtonElement).click();expect(document.querySelector('[data-submission-id]')).toBeNull();expect(JSON.parse(storage.getItem('codex-webui-uncertain-messages'))).toEqual([]);
}));

test('accepted receipt clears local uncertainty and legacy import banner disappears after importing paused entries',()=>fixture(async({setup,storage}:any)=>{
  storage.setItem('codex-webui-message-queue',JSON.stringify([{id,threadId:'thread-A',text:'Old tab entry'}]));
  const imported:any[]=[];
  const queue=setup(async(method:string)=>method==='host/delivery/list'?{entries:[]}:method==='host/submissions/list'?{data:[]}:{id,threadId:'thread-A',status:'accepted'},{importLegacy:async(entry:any)=>{imported.push(entry);}});
  queue.uncertain({id,threadId:'thread-A',text:'Accepted text'});await queue.sync();expect(document.querySelector('[data-submission-id]')).toBeNull();expect(JSON.parse(storage.getItem('codex-webui-uncertain-messages'))).toEqual([]);
  (document.querySelector('[aria-label="Import paused messages"]') as HTMLButtonElement).click();await Bun.sleep(0);await Bun.sleep(0);
  expect(imported).toHaveLength(1);expect(document.querySelector('[aria-label="Import paused messages"]')).toBeNull();expect(JSON.parse(storage.getItem('codex-webui-message-queue'))).toEqual([]);
}));

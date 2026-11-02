import { test, expect } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createComposerDelivery } from '../../public/composer-delivery.js';

test('queued messages wait for their turn, retain submission settings, and never retry uncertain sends', async () => {
  const dom=new JSDOM('<form><button></button></form>'),previous=globalThis.document;globalThis.document=dom.window.document;
  let current={threadId:'A',turnId:'first',ready:true},fail=false;
  const sent:any[]=[],errors:any[]=[],store=new Map();
  const options={key:'q',store:{getItem:key=>store.get(key),setItem:(key,value)=>store.set(key,value)},anchor:document.querySelector('button'),host:document.querySelector('form'),t:s=>s,icon:()=>'',menu:{open(){}},context:()=>current,dispatch:async entry=>{sent.push(entry);if(fail)throw Error('uncertain response');current.turnId='next';},onError:error=>errors.push(error)};
  const queue=createComposerDelivery(options);
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  try{
    queue.enqueue({threadId:'A',waitTurnId:'first',text:'one',mentions:[],model:'selected-at-submit',effort:'high'});
    queue.enqueue({threadId:'A',waitTurnId:'first',text:'two',mentions:[]});
    queue.snapshot('B',{id:'first',status:'completed'});await tick();expect(sent.length).toBe(0);
    current.turnId='';queue.snapshot('A',{id:'first',status:'completed'});await tick();
    expect(sent.length).toBe(1);expect(sent[0].model).toBe('selected-at-submit');expect(sent[0].effort).toBe('high');
    expect(document.querySelectorAll('.composer-queue-row').length).toBe(1);
    fail=true;current.turnId='';queue.snapshot('A',{id:'next',status:'completed'});await tick();
    expect(sent.length).toBe(2);expect(errors.length).toBe(1);
    queue.snapshot('A',{id:'next',status:'completed'});await tick();expect(sent.length).toBe(2);
    expect(document.querySelector('.composer-queue-row')!.getAttribute('data-status')).toBe('failed');
    queue.dispose();
    const restored=createComposerDelivery({...options,anchor:document.querySelector('button')});
    try{expect(document.querySelector('.composer-queue-row')!.getAttribute('data-status')).toBe('paused');restored.snapshot('A',{id:'next',status:'completed'});await tick();expect(sent.length).toBe(2);}finally{restored.dispose();}
  }finally{queue.dispose();globalThis.document=previous;dom.window.close();}
});

test('interrupted turns pause the queue and cancellation never dispatches a message', async () => {
  const dom=new JSDOM('<form><button></button></form>'),previous=globalThis.document;globalThis.document=dom.window.document;
  let calls=0;
  const queue=createComposerDelivery({key:'q',anchor:document.querySelector('button'),host:document.querySelector('form'),t:s=>s,icon:()=>'',menu:{open(){}},context:()=>({threadId:'A',turnId:'',ready:true}),dispatch:async()=>{calls++;},onError(){}});
  try{
    queue.enqueue({threadId:'A',waitTurnId:'one',text:'Wait for approval',mentions:[]});
    queue.snapshot('A',{id:'one',status:'interrupted'});await new Promise(resolve=>setTimeout(resolve,0));
    expect(document.querySelector('.composer-queue-row')!.getAttribute('data-status')).toBe('paused');expect(calls).toBe(0);
    (document.querySelector('[aria-label="Cancel queued message"]') as HTMLButtonElement).click();expect(document.querySelectorAll('.composer-queue-row').length).toBe(0);expect(calls).toBe(0);
  }finally{queue.dispose();globalThis.document=previous;dom.window.close();}
});

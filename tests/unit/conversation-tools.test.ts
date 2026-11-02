import { expect, test } from 'bun:test';
import { createConversationTools } from '../../src/server/services/conversation-tools.js';
import { createCustomizationService } from '../../src/server/services/customization.js';

test('fork uses the inclusive native boundary without mutating or executing the source', async () => {
  const calls: any[] = [];
  const tools = createConversationTools(async (method, params) => { calls.push({method,params}); return {thread:{id:'fork'}}; });
  expect(await tools.fork({threadId:'source',turnId:'turn-1'})).toEqual({thread:{id:'fork'}});
  expect(calls).toEqual([{method:'thread/fork',params:{threadId:'source',lastTurnId:'turn-1',ephemeral:false}}]);
  for(const payload of [{threadId:''},{threadId:'source',config:{}},{threadId:'source',turnId:7}]) await expect(tools.fork(payload)).rejects.toThrow();
  expect(calls.length).toBe(1);
  await expect(createConversationTools(async()=>({thread:{id:'source'}})).fork({threadId:'source'})).rejects.toThrow();
});

test('goals require explicit user objectives and preserve native pause/resume/clear semantics', async () => {
  const calls: any[]=[];
  const tools=createConversationTools(async(method,params)=>{calls.push({method,params});return {goal:null};});
  await tools.goal({threadId:'source',action:'set',objective:'  Fix this  ',tokenBudget:2000});
  await tools.goal({threadId:'source',action:'get'});
  await tools.goal({threadId:'source',action:'pause'});
  await tools.goal({threadId:'source',action:'resume'});
  await tools.goal({threadId:'source',action:'clear'});
  expect(calls).toEqual([
    {method:'thread/goal/set',params:{threadId:'source',objective:'Fix this',tokenBudget:2000,origin:'user'}},
    {method:'thread/goal/get',params:{threadId:'source'}},
    {method:'thread/goal/set',params:{threadId:'source',status:'paused',origin:'user'}},
    {method:'thread/goal/set',params:{threadId:'source',status:'active',origin:'user'}},
    {method:'thread/goal/clear',params:{threadId:'source',origin:'user'}}
  ]);
  for(const payload of [ {action:'set',objective:''}, {action:'set',objective:'x',tokenBudget:-1}, {action:'set',objective:'x',tokenBudget:1.5}, {action:'complete'}, {action:'set',objective:'x',origin:'agent'} ]) await expect(tools.goal({threadId:'source',...payload})).rejects.toThrow();
  expect(calls.length).toBe(5);
});

test('composer tools resolve only currently enabled native skills and reject stale or forged paths', async () => {
  let enabled=true; const calls:any[]=[];
  const service=createCustomizationService(async(method,params)=>{
    calls.push({method,params});
    return method==='skills/list'?{data:[{skills:[{name:'visualize:visualize',path:'/private/plugin/SKILL.md',enabled,description:'Draw',secret:'SECRET'}]}]}:{marketplaces:[]};
  },{privateRoot:'/private',home:'/home',browseRoots:['/home']});
  const listed=await service.composerTools('/home/project');
  expect(listed.items.length).toBe(1);
  expect(JSON.stringify(listed)).not.toMatch(/private|SECRET|SKILL.md/);
  const id=listed.items[0].id;
  expect(await service.resolveComposerTools('/home/project',{ids:[id]})).toEqual({items:[{type:'skill',name:'visualize:visualize',path:'/private/plugin/SKILL.md'}]});
  expect(calls).toContainEqual({method:'skills/list',params:{cwds:['/home/project'],forceReload:true}});
  enabled=false;
  await expect(service.resolveComposerTools('/home/project',{ids:[id]})).rejects.toThrow();
  for(const payload of [{ids:['/forged/SKILL.md']},{ids:[id,id]},{ids:[id],path:'/forged'},{ids:'bad'}]) await expect(service.resolveComposerTools('/home/project',payload)).rejects.toThrow();
  expect((await service.composerTools('/home/project')).items).toEqual([]);
});

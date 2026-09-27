import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FieldService } from '../src/service.js';
import { createApp } from '../src/api.js';
import { sceneSvg } from '../src/drawing.js';
import type { TaskSnapshot } from '../src/models.js';
import { ADOPTED_RULES, RULE } from '@field-agent/core';

const directories:string[]=[],services:FieldService[]=[];
function setup(){const dir=mkdtempSync(join(tmpdir(),'field-test-'));directories.push(dir);const service=new FieldService(dir);services.push(service);return service;}
afterEach(()=>{for(const service of services.splice(0))if(service.store.db.open)service.store.close();for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});
const token='integration-test-token-only';
const json=(body:unknown,key?:string)=>({method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body)});

describe('durable deterministic workflow',()=>{
  it('preserves legacy task evidence without resuming or exposing removed runtime state',async()=>{
    let s=setup();const t=s.createTask({title:'existing work'});await s.replay(t.id,'normal');
    const saved={...s.getTask(t.id),run:{status:'running'}};
    s.store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(saved),t.id);
    s.store.db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, task_id TEXT, status TEXT); CREATE TABLE sessions (task_id TEXT PRIMARY KEY, path TEXT);");
    s.store.db.prepare('INSERT INTO jobs VALUES(?,?,?)').run('old-run',t.id,'running');
    s.store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(t.id,'legacy-session');
    const dir=s.dataDir;s.store.close();s=new FieldService(dir);services.push(s);
    expect(s.getTask(t.id)).toMatchObject({title:'existing work',observations:saved.observations,facts:saved.facts});
    expect(s.getTask(t.id)).not.toHaveProperty('run');
    expect(s.listTasks()[0]).not.toHaveProperty('run');
    expect(s.store.db.prepare('SELECT status FROM jobs WHERE id=?').get('old-run')).toEqual({status:'running'});
    expect(s.store.db.prepare('SELECT path FROM sessions WHERE task_id=?').get(t.id)).toEqual({path:'legacy-session'});
    expect(s.cancel(t.id).state).toBe('cancelled');
    expect(s.getTask(t.id).observations).toEqual(saved.observations);
  });
  it.each(['.','..','../outside'])('rejects a task ID that could escape its task directory: %s',id=>{
    const s=setup();expect(()=>s.createTask({id})).toThrow('IDの形式');
  });
  it('restarts with an open request; a repeated answer is idempotent; unknown becomes pass only after confirmed evidence',async()=>{
    let s=setup();const t=s.createTask({id:'resume'});await s.replay(t.id,'missing');
    expect(s.getTask(t.id).validation?.rule.status).toBe('unknown');
    const req=s.requestEvidence(t.id,{kind:'capture',reason:'重力基準を含めて撮影',fields:['orientation','verticalReference']});
    const dir=s.dataDir;s.store.close();s=new FieldService(dir);services.push(s);
    expect(s.getTask(t.id).requests[0].status).toBe('open');
    await s.replay(t.id,'normal');
    const answer={id:'retry',requestId:req.id,observationIds:['normal-initial']};
    const first=s.answer(t.id,answer);s.answer(t.id,answer);
    expect(s.getTask(t.id).revision).toBe(first.revision);
    expect(s.getTask(t.id).requests[0].status).toBe('answered');
    const artifact=s.prepareArtifact(t.id);
    expect(artifact.validation.rule.status).toBe('pass');expect(artifact.synthetic).toBe(true);
    expect(artifact.validation.taskRevision).toBe(first.revision);
    expect(artifact.adoptedRules).toHaveLength(ADOPTED_RULES.length);
    expect(artifact.validation.rules).toHaveLength(ADOPTED_RULES.length);
  });
  it('matching incorrect drawings still fail and final artifacts retain that failure',async()=>{
    const s=setup(),t=s.createTask();await s.replay(t.id,'matching_wrong');
    const artifact=s.prepareArtifact(t.id);
    expect(artifact.validation.comparison.status).toBe('match');expect(artifact.validation.rule.status).toBe('fail');
    expect(artifact.unresolved).toContain(`${RULE.title}: 不適合は未解消`);
    expect(s.getTask(t.id).state).toBe('review_ready');
  });
  it('retains a pressure failure even when orientation and the drawing match',async()=>{
    const s=setup(),t=s.createTask();await s.replay(t.id,'pressure_exceeded');
    const artifact=s.prepareArtifact(t.id);
    expect(artifact.validation.rule.status).toBe('pass');
    expect(artifact.validation.comparison.status).toBe('match');
    const failure=artifact.validation.rules.find(rule=>rule.status==='fail');
    expect(failure).toBeDefined();
    expect(artifact.unresolved).toContain(`${failure!.title}: 不適合は未解消`);
    expect(artifact.scope).toContain('水理充足');
  });
  it('requires missing installation records and preserves unknown after an unavailable answer',async()=>{
    const s=setup(),t=s.createTask();await s.replay(t.id,'normal');
    const current=s.getTask(t.id);
    s.reviewFacts(t.id,{baseRevision:current.revision,facts:{installationTorqueFtLb:{value:null,confirmed:false,evidenceIds:[],source:'manual'}}});
    expect(s.getTask(t.id).validation?.rule.status).toBe('pass');
    expect(s.getTask(t.id).validation?.missingInputs).toContain('installationTorqueFtLb');
    expect(()=>s.prepareArtifact(t.id)).toThrow('未確認項目');
    const request=s.requestEvidence(t.id,{kind:'confirmation',reason:'施工時トルクの記録を確認',fields:['installationTorqueFtLb']});
    s.answer(t.id,{id:'no-torque-record',requestId:request.id,observationIds:[],unavailableReason:'施工記録なし'});
    const artifact=s.prepareArtifact(t.id);
    expect(artifact.validation.rules.some(rule=>rule.status==='unknown'&&rule.missingInputs.includes('installationTorqueFtLb'))).toBe(true);
    expect(artifact.unresolved).toContain('施工記録なし');
  });
  it('does not let an AI pressure candidate confirm itself',async()=>{
    const s=setup(),t=s.createTask();await s.replay(t.id,'normal');
    s.reviewFacts(t.id,{baseRevision:s.getTask(t.id).revision,facts:{workingPressurePsi:{value:null,confirmed:false,evidenceIds:[],source:'manual'}}});
    s.proposeFacts(t.id,{id:'pressure-candidate',targetId:'H1',reason:'記録上は100 psiの候補',facts:{workingPressurePsi:{value:100,confirmed:true,source:'manual',evidenceIds:['normal-initial']}}});
    const current=s.getTask(t.id);
    expect(current.facts.workingPressurePsi).toMatchObject({value:100,confirmed:false,source:'model'});
    expect(current.validation?.rules.some(rule=>rule.status==='unknown'&&rule.missingInputs.includes('workingPressurePsi.confirmation'))).toBe(true);
  });
  it('never reuses the artifact or result version after confirmation is removed',async()=>{
    const s=setup(),t=s.createTask();await s.replay(t.id,'normal');const artifact=s.prepareArtifact(t.id);
    const before=s.getTask(t.id);
    const after=s.reviewFacts(t.id,{baseRevision:before.revision,facts:{orientation:{value:null,confirmed:false,evidenceIds:[],source:'manual'}}});
    expect(after.artifact).toBeNull();expect(after.validation?.rule.status).toBe('unknown');
    expect(after.validation?.taskRevision).toBeGreaterThan(artifact.taskRevision);
    expect(()=>s.prepareArtifact(t.id)).toThrow('未確認項目');
    expect(()=>s.reviewFacts(t.id,{baseRevision:before.revision,facts:{}})).toThrow('更新');
  });
  it('invalidates cached results from an older adopted rule on restart',async()=>{
    let s=setup();const t=s.createTask();await s.replay(t.id,'normal');const artifact=s.prepareArtifact(t.id);
    const old=s.getTask(t.id);old.validation!.rule.versions.ruleVersion='old-version';s.store.save(old);
    const dir=s.dataDir;s.store.close();s=new FieldService(dir);services.push(s);
    const current=s.getTask(t.id);expect(current.artifact).toBeNull();expect(current.revision).toBeGreaterThan(artifact.taskRevision);
    expect(current.validation?.rule.versions.ruleVersion).toBe(RULE.version);expect(current.validation?.taskRevision).toBe(current.revision);
  });
  it('invalidates an artifact when any non-orientation rule changes',async()=>{
    let s=setup();const t=s.createTask();await s.replay(t.id,'normal');const artifact=s.prepareArtifact(t.id);
    const old=s.getTask(t.id);old.validation!.rules[1].versions.sourceRevision='older-source';s.store.save(old);
    const dir=s.dataDir;s.store.close();s=new FieldService(dir);services.push(s);
    const current=s.getTask(t.id);
    expect(current.artifact).toBeNull();expect(current.revision).toBeGreaterThan(artifact.taskRevision);
    expect(current.validation?.rules[1].versions.sourceRevision).toBe(ADOPTED_RULES[1].sourceRevision);
  });
  it('migrates an old five-field task without inventing newly required facts',async()=>{
    let s=setup();const t=s.createTask();await s.replay(t.id,'normal');s.prepareArtifact(t.id);
    const old=s.getTask(t.id);
    old.facts=Object.fromEntries(Object.entries(old.facts).filter(([key])=>['model','installation','mounting','orientation','verticalReference'].includes(key))) as typeof old.facts;
    delete (old.validation as unknown as Record<string,unknown>).rules;
    s.store.save(old);
    const dir=s.dataDir;s.store.close();s=new FieldService(dir);services.push(s);
    const current=s.getTask(t.id);
    expect(current.artifact).toBeNull();expect(current.facts.model.value).toBe('TY3231');
    expect(current.facts.installationTorqueFtLb).toMatchObject({value:null,confirmed:false});
    expect(current.validation?.rules).toHaveLength(ADOPTED_RULES.length);
    expect(()=>s.prepareArtifact(t.id)).toThrow('未確認項目');
  });
  it('keeps unknown in a completed report when a missing input is explicitly unavailable',async()=>{
    const s=setup(),t=s.createTask();await s.replay(t.id,'missing');
    const req=s.requestEvidence(t.id,{kind:'capture',reason:'取付方向と重力の根拠',fields:['orientation','verticalReference']});
    s.answer(t.id,{id:'no-access',requestId:req.id,observationIds:[],unavailableReason:'天井内にアクセスできない'});
    const report=s.prepareArtifact(t.id);
    expect(report.validation.rule.status).toBe('unknown');expect(report.unresolved).toContain('天井内にアクセスできない');
  });
  it('model candidates cannot confirm themselves or overwrite manual confirmation',async()=>{
    const s=setup(),t=s.createTask();await s.replay(t.id,'missing');
    s.proposeFacts(t.id,{id:'model-proposal',targetId:'H1',reason:'画面で下を向いているように見える',facts:{orientation:{value:'pendent',confirmed:true,source:'manual',evidenceIds:['missing-initial']}}});
    let current=s.getTask(t.id);expect(current.facts.orientation.confirmed).toBe(false);expect(current.validation?.rule.status).toBe('unknown');
    await s.replay(t.id,'nonconforming');
    s.proposeFacts(t.id,{id:'second-proposal',targetId:'H1',reason:'カタログはpendent',facts:{orientation:{value:'pendent',confirmed:true,source:'fixture',evidenceIds:['nonconforming-initial']}}});
    current=s.getTask(t.id);expect(current.facts.orientation.value).toBe('upright');expect(current.validation?.rule.status).toBe('fail');
  });
  it('rejects evidence from another target and measurements with malformed input',async()=>{
    const s=setup(),t=s.createTask();await s.addObservation(t.id,{id:'another',targetId:'H2',capturedAt:new Date().toISOString(),source:'fixture',synthetic:true},Buffer.from(sceneSvg('pendent')));
    expect(()=>s.reviewFacts(t.id,{baseRevision:s.getTask(t.id).revision,facts:{model:{value:'TY3231',confirmed:true,source:'manual',evidenceIds:['another']}}})).toThrow('同じ対象');
    expect(()=>s.addMeasurement(t.id,{} as never)).toThrow('形式');
  });
  it('replay retransmission does not duplicate evidence or mutate versions',async()=>{
    const s=setup(),t=s.createTask();await s.replay(t.id,'normal');const first=s.getTask(t.id);await s.replay(t.id,'normal');
    expect(s.getTask(t.id).revision).toBe(first.revision);expect(s.getTask(t.id).observations).toHaveLength(1);
  });
  it('plan updates expire requests and regenerate comparison independently',async()=>{
    const s=setup(),t=s.createTask();await s.replay(t.id,'normal');
    const req=s.requestEvidence(t.id,{kind:'capture',reason:'確認',fields:['orientation']});
    s.updatePlan(t.id,'upright',s.getTask(t.id).revision);
    expect(s.getTask(t.id).requests[0].status).toBe('superseded');
    expect(s.getTask(t.id).validation?.comparison.status).toBe('different');
    expect(s.getTask(t.id).validation?.rule.status).toBe('pass');
    expect(()=>s.answer(t.id,{id:'late',requestId:req.id,observationIds:['normal-initial']})).toThrow('古い図面');
  });
  it('bounds crops and separates unverified obstruction findings from rule compliance',async()=>{
    const s=setup(),t=s.createTask();await s.replay(t.id,'obstacle');
    await expect(s.cropImage(t.id,'obstacle-initial',{x:9999,y:0,width:1,height:1})).rejects.toThrow('画像外');
    expect((await s.cropImage(t.id,'obstacle-initial',{x:0,y:0,width:10,height:10})).mimeType).toBe('image/jpeg');
    s.recordFinding(t.id,{id:'obstruction',targetId:'H1',description:'下側に障害物候補。散水障害の判定は未実施。',evidenceIds:['obstacle-initial']});
    const artifact=s.prepareArtifact(t.id);expect(artifact.validation.rule.status).toBe('pass');expect(artifact.findings[0].status).toBe('unverified');expect(artifact.unresolved[0]).toContain('障害物候補');
  });
  it('cancelled jobs reject late mutations',async()=>{
    const s=setup(),t=s.createTask();s.cancel(t.id);
    expect(()=>s.requestEvidence(t.id,{kind:'capture',reason:'late',fields:['orientation']})).toThrow('キャンセル');
    expect(()=>s.validateTask(t.id)).toThrow('キャンセル');
    await expect(s.replay(t.id,'normal')).rejects.toThrow('キャンセル');
  });
});

describe('same API for web, replay, and camera',()=>{
  it('resolves an SF permit edition without turning it into a compliance result or task mutation',async()=>{
    const s=setup(),app=createApp(s,{token});
    const evidence={value:'san_francisco',confirmed:true,source:'fixture',evidenceIds:['permit']};
    const facts={jurisdiction:evidence,standard:{...evidence,value:'nfpa13'},permitKind:{...evidence,value:'new_building_site_permit'},
      sitePermitCodeCycle:{...evidence,value:'2022'},architecturalPermitCodeCycle:{...evidence,value:'2022'},editionElection:{...evidence,value:'permit_basis'}};
    const input={facts,context:{targetId:'project',taskRevision:1,observations:[{id:'permit',targetId:'project'}]}};
    const response=await app.request('/api/rules/san-francisco/resolve-edition',json(input));
    expect(response.status).toBe(200);
    const result=await response.json() as Record<string,unknown>;
    expect(result).toMatchObject({status:'resolved',nfpa13Edition:'2022'});
    expect(s.listTasks()).toHaveLength(0);
    const missing=await app.request('/api/rules/san-francisco/resolve-edition',json({...input,facts:{...facts,sitePermitCodeCycle:{...facts.sitePermitCodeCycle,confirmed:false}}}));
    expect(await missing.json()).toMatchObject({status:'unknown',nfpa13Edition:null});
    const malformed=await app.request('/api/rules/san-francisco/resolve-edition',json({facts:{},context:{}}));
    expect(malformed.status).toBe(400);
  });
  it('lists all adopted rules and preserves numeric facts through the HTTP boundary',async()=>{
    const s=setup(),app=createApp(s,{token}),t=s.createTask();await s.replay(t.id,'normal');
    const registry=await app.request('/api/rules',{headers:{Authorization:`Bearer ${token}`}});
    expect((await registry.json() as {id:string}[]).map(rule=>rule.id)).toEqual(ADOPTED_RULES.map(rule=>rule.id));
    const writeFact=(value:unknown)=>app.request(`/api/tasks/${t.id}/facts`,json({baseRevision:s.getTask(t.id).revision,facts:{installationTorqueFtLb:{value,confirmed:true,evidenceIds:['normal-initial'],source:'manual'}}}));
    expect((await writeFact('10')).status).toBe(400);
    expect((await writeFact(-1)).status).toBe(400);
    expect((await writeFact(11.5)).status).toBe(200);
    expect(s.getTask(t.id).facts.installationTorqueFtLb?.value).toBe(11.5);
    const unknown=await app.request(`/api/tasks/${t.id}/facts`,json({baseRevision:s.getTask(t.id).revision,facts:{inventedRule:{value:'pass',confirmed:true,evidenceIds:['normal-initial'],source:'manual'}}}));
    expect(unknown.status).toBe(400);
  });
  it('saves and deduplicates an answer without an agent runtime',async()=>{
    const s=setup(),t=s.createTask();await s.replay(t.id,'normal');
    const request=s.requestEvidence(t.id,{kind:'capture',reason:'追加',fields:['orientation']});
    const app=createApp(s,{token});
    const input={id:'manual-answer',requestId:request.id,observationIds:['normal-initial']};
    const response=await app.request(`/api/tasks/${t.id}/answers`,json(input));
    expect(response.status).toBe(200);expect(s.getTask(t.id).requests[0].status).toBe('answered');
    const revision=s.getTask(t.id).revision;
    expect((await app.request(`/api/tasks/${t.id}/answers`,json(input))).status).toBe(200);
    expect(s.getTask(t.id).revision).toBe(revision);
    expect((await app.request(`/api/tasks/${t.id}/run`,json({}))).status).toBe(404);
    const health=await app.request('/api/health',{headers:{Authorization:`Bearer ${token}`}});
    expect(await health.json()).toEqual({ok:true,ruleId:RULE.id});
  });
  it('authenticates, handles multipart retries, serves images, and rejects changed duplicate payloads',async()=>{
    const s=setup(),app=createApp(s,{token});
    expect((await app.request('/api/tasks')).status).toBe(401);
    const created=await app.request('/api/tasks',json({title:'HTTP replay'},'http-task'));
    expect(created.status).toBe(201);const t=await created.json() as TaskSnapshot;
    const make=()=>{const form=new FormData();form.set('metadata',JSON.stringify({id:'http-image',targetId:'H1',capturedAt:'2026-09-26T12:00:00Z',source:'fixture',synthetic:true}));form.set('image',new File([sceneSvg('pendent')],'scene.svg',{type:'image/svg+xml'}));return form;};
    const send=()=>app.request(`/api/tasks/${t.id}/observations`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:make()});
    const [first,retry]=await Promise.all([send(),send()]);expect(first.status).toBe(201);expect(retry.status).toBe(201);expect(s.getTask(t.id).observations).toHaveLength(1);
    const asset=await app.request(`/api/tasks/${t.id}/assets/http-image.jpg`,{headers:{Authorization:`Bearer ${token}`}});
    expect(asset.headers.get('content-type')).toBe('image/jpeg');expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect((await app.request('/api/tasks',json({title:'different'},'http-task'))).status).toBe(409);
    expect((await app.request(`/api/tasks/${t.id}/measurements`,json({}))).status).toBe(400);
    expect((await app.request(`/api/tasks/${t.id}/artifact`,{headers:{Authorization:`Bearer ${token}`}})).status).toBe(409);
  });
});

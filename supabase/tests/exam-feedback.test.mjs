import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,readdir} from 'node:fs/promises'
import test from 'node:test'
import {PGlite} from '@electric-sql/pglite'

// Entirely invented questions and images. No original exam content or keys.
const pack={exam:{id:'feedback-fixture',version:1,title:'Synthetic',course:'Test',source_name:'Fixture',source_sha256:'a'.repeat(64),introduction:'',duration_minutes:60},package_sha256:'b'.repeat(64),
 questions:[
  [1,2,[['multiple',['a','b']]]], [2,2,[['multiple',['a','b','c']]]], [3,2,[['multiple',['a']]]],
  [4,3,[['multiple',['a','b']],['multiple',['c']]]], [5,2,[['single','a']]],
  [6,3,[['select','a'],['select','b'],['select','c']]], [41,2,[['select','a']]], [42,4,[['text',null]]]
 ].map(([number,max,fields])=>({number,title:'Synthetic '+number,kind:fields[0][0]==='multiple'?'multiple':'mixed',max_points:max,source_pages:[9,10],
  review_status:number===41?'manual':'verified',review_note:'Synthetic',grading:number===41?'unverified':number===42?'self':'automatic',
  correct:number===41||number===42?{}:Object.fromEntries(fields.map(([,key],i)=>['p'+i,key])),guide_assets:['guide-9','guide-10'],
  prompt:{blocks:fields.map((_,i)=>({type:'field',id:'p'+i})),fields:fields.map(([kind],i)=>({id:'p'+i,label:'Field '+i,kind,options:['a','b','c','d'].map(id=>({id,text:'Option '+id}))}))}})),
 assets:[{id:'guide-10',number:1,purpose:'guide',base64:'BOTTOM'},{id:'guide-9',number:1,purpose:'guide',base64:'TOP'},{id:'prompt',number:1,purpose:'prompt',base64:'PROMPT'}]
}

test('versioned grading, gated image-free feedback and source-order guidance',async t=>{
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`)
 const dir=new URL('../migrations/',import.meta.url),files=(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()
 const upgrade='20261123112345_exam_answer_feedback_and_partial_scoring.sql'
 assert.ok(files.includes(upgrade))
 for(const f of files.filter(f=>f<upgrade))await db.exec(await readFile(new URL(f,dir),'utf8'))
 const owner=randomUUID(),other=randomUUID(),outsider=randomUUID()
 for(const uid of [owner,other,outsider])await db.query('insert into auth.users values($1)',[uid])
 await db.query('select exam_private.import_package($1,$2)',[pack,owner]);await db.query('select exam_private.import_package($1,$2)',[pack,other])
 const as=async(id,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role '+role)}
 const rpc=async(name,args=[])=>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as r`,args)).rows[0].r
 const denied=(promise,code='42501')=>assert.rejects(promise,e=>e.code===code)
 const start=(feedback='each',id=randomUUID())=>rpc('exam_attempt_start',[id,pack.exam.id,1,feedback,'practice',false])
 const save=(id,n,answer,submit=true,revision=0,request=randomUUID())=>rpc('exam_response_save',[id,n,revision,answer,submit,request])
 await as(owner);const historical=await start(),oldId=historical.attempt.id
 await save(oldId,1,{p0:['a']});const original=await rpc('exam_attempt_get',[oldId])
 await db.exec('reset role')
 const privateBefore=(await db.query("select jsonb_agg(to_jsonb(q)) as rows from exam_private.questions q")).rows[0].rows
 for(const f of files.filter(f=>f>=upgrade))await db.exec(await readFile(new URL(f,dir),'utf8'))
 await as(owner)
 await t.test('migration keeps v1 attempts, stored scores and locked answers; new attempts use v2',async()=>{
  const restored=await rpc('exam_attempt_get',[oldId])
  assert.deepEqual(restored.responses,original.responses);assert.equal(restored.attempt.scoring_version,1)
  assert.equal((await save(oldId,2,{p0:['a']})).responses.find(r=>r.number===2).auto_points,0)
  assert.equal((await rpc('exam_feedback',[oldId,1])).auto_points,0)
  assert.equal((await start()).attempt.scoring_version,2)
  await db.exec('reset role');assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(q)) as rows from exam_private.questions q')).rows[0].rows,privateBefore);await as(owner)
 })
 await t.test('all requested scores, blanks, fractions, multi-field budget and no negative or early full score',async()=>{
  for(const [number,answer,points] of [
   [1,{p0:['a','b']},2],[1,{p0:['a']},1],[1,{p0:['a','b','d']},1],[1,{p0:['a','d']},0],[1,{p0:['d']},0],[1,{},0],[1,{p0:[]},0],
   [2,{p0:['a']},.6666],[2,{p0:['a','b']},1.3333],[2,{p0:['a','b','c']},2],[2,{p0:['a','b','c','d']},1],
   [3,{p0:['a']},2],[3,{p0:['a','d']},1],[4,{p0:['a'],p1:['c']},2],[4,{p0:['a','b'],p1:['c']},3],
   [5,{p0:'a'},2],[5,{p0:'d'},0],[6,{p0:'a',p1:'b',p2:'d'},0],[41,{p0:'a'},null],[42,{p0:'Free text'},null]
  ]){
   const a=await start(),id=a.attempt.id,request=randomUUID(),saved=await save(id,number,answer,true,0,request)
   assert.equal(saved.responses.find(r=>r.number===number).auto_points,points)
   assert.deepEqual((await save(id,number,answer,true,0,request)).responses,saved.responses)
   assert.deepEqual((await rpc('exam_attempt_get',[id])).responses,saved.responses)
  }
 })
 await t.test('feedback is gated for both modes, small, versioned, and reports actual stored score',async()=>{
  const a=await start(),id=a.attempt.id
  await denied(rpc('exam_feedback',[id,1]));await denied(rpc('exam_guidance',[id,1]))
  await save(id,1,{p0:['a','d']},false);await denied(rpc('exam_feedback',[id,1]))
  await save(id,1,{p0:['a','d']},true,1)
  const feedback=await rpc('exam_feedback',[id,1]);assert.equal(feedback.auto_points,0);assert.equal(feedback.scoring_version,2)
  assert.equal(feedback.correct_choices,1);assert.equal(feedback.incorrect_choices,1);assert.deepEqual(feedback.correct,{p0:['a','b']})
  assert.doesNotMatch(JSON.stringify(feedback),/TOP|BOTTOM|base64|source_name/);assert.ok(JSON.stringify(feedback).length<1000)
  await denied(save(id,1,{p0:['a','b']},false,2),'22023')
  assert.deepEqual((await rpc('exam_guidance',[id,1])).assets.map(a=>a.base64),['TOP','BOTTOM'])
  const b=await start('end'),end=b.attempt.id
  await denied(save(end,1,{p0:['a']},true),'22023');await save(end,1,{p0:['a']},false)
  await denied(rpc('exam_feedback',[end,1]));await denied(rpc('exam_guidance',[end,1]))
  await rpc('exam_attempt_submit',[end,1]);assert.equal((await rpc('exam_feedback',[end,1])).auto_points,1)
  const manual=await rpc('exam_feedback',[end,41]);assert.equal(manual.available,false);assert.deepEqual(manual.correct,{});assert.equal(manual.auto_points,null)
  assert.equal((await rpc('exam_feedback',[end,6])).correct_fields,0)
  const c=await start();await save(c.attempt.id,6,{p0:'a',p1:'d',p2:'c'})
  const match=await rpc('exam_feedback',[c.attempt.id,6]);assert.equal(match.correct_fields,2);assert.equal(match.total_fields,3)
  assert.doesNotMatch(JSON.stringify(await rpc('exam_attempt_get',[end])),/"correct"|guide_assets|base64/)
  await as(other);await denied(rpc('exam_feedback',[id,1]));await denied(rpc('exam_guidance',[id,1]))
  await as(outsider);await denied(rpc('exam_feedback',[id,1]))
  await as('','anon');await denied(rpc('exam_feedback',[id,1]))
  await as(owner);await denied(db.query('select exam_private.grade_response($1,1,1,$2,2::smallint)',[pack.exam.id,{}]))
  await denied(db.query('update public.exam_attempts set scoring_version=2 where id=$1',[oldId]))
 })
})

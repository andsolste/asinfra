import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

// Synthetic material only. The copyrighted import remains outside Git and CI.
export const syntheticPackage = () => ({ exam: { id:'fixture', version:1, title:'Test exam', course:'Fixture', source_name:'Fixture', source_sha256:'a'.repeat(64), introduction:'Synthetic', duration_minutes:60 }, package_sha256:'b'.repeat(64),
  questions: [
    {number:1,kind:'notes',max_points:0,grading:'self'},
    {number:2,kind:'single',max_points:2,grading:'automatic',correct:{p1:'b'}},
    {number:3,kind:'multiple',max_points:3,grading:'automatic',correct:{p1:['a','c']}},
    {number:4,kind:'text',max_points:4,grading:'self'},
    {number:5,kind:'matching',max_points:1,grading:'automatic',correct:{p1:'a'}},
    {number:6,kind:'visual',max_points:2,grading:'unverified',review_status:'manual'},
  ].map(q => ({title:'Synthetic '+q.number,source_pages:[1],review_status:'verified',review_note:'Fixture',correct:{},guide_assets:['guide'],...q,
    guide_assets:[`guide-${q.number}`],prompt:{blocks:[{type:'field',id:'p1'}],fields:[{id:'p1',label:'Answer',kind:q.kind==='notes'||q.kind==='text'?'text':q.kind==='multiple'?'multiple':'select',options:[{id:'a',text:'A'},{id:'b',text:'B'},{id:'c',text:'C'}]}]}})),
  assets:[1,2,3,4,5,6].flatMap(number => [{id:`guide-${number}`,number,purpose:'guide',base64:'secret-guidance'},{id:`prompt-${number}`,number,purpose:'prompt',base64:'clean-figure'}]) })

test('exam engine: real PostgreSQL, private content, versioned attempts, feedback gates and own-user access', async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;
    alter default privileges in schema public grant all on tables to anon,authenticated;
    alter default privileges in schema public grant execute on functions to anon,authenticated;`)
  const dir = new URL('../migrations/',import.meta.url)
  for (const f of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(f,dir),'utf8'))
  const owner=randomUUID(),other=randomUUID(),outsider=randomUUID()
  for (const id of [owner,other,outsider]) await db.query('insert into auth.users values($1)',[id])
  const pack=syntheticPackage()
  for (const id of [owner,other]) await db.query('select exam_private.import_package($1,$2)',[pack,id])
  const as = async (id,role='authenticated') => {await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role '+role)}
  const rpc = async (name,args=[]) => (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as r`,args)).rows[0].r
  const denied=(promise,code='42501')=>assert.rejects(promise,e=>e.code===code)
  const start=(feedback='each',id=randomUUID())=>rpc('exam_attempt_start',[id,'fixture',1,feedback,'practice',false])
  const save=(a,n,rev,answer,submit=false,id=randomUUID())=>rpc('exam_response_save',[a,n,rev,answer,submit,id])
  await as(owner)
  const a=await start(),aid=a.attempt.id
  await t.test('catalogue/get contain no keys or guidance; guide assets cannot be fetched through prompt RPC',async()=>{
    assert.equal((await rpc('exam_catalogue')).exams.length,1)
    assert.doesNotMatch(JSON.stringify(a),/secret-guidance|"correct"|guide_assets/)
    assert.equal((await rpc('exam_prompt_asset',[aid,'prompt-2'])).base64,'clean-figure')
    await denied(rpc('exam_prompt_asset',[aid,'guide-2']));await denied(rpc('exam_guidance',[aid,2]))
    await denied(db.query('select * from exam_private.keys')); await denied(db.query('select exam_private.import_package($1)',[pack]))
  })
  await t.test('draft autosave, request retry, frozen revision, invalid fields and submitted locks',async()=>{
    const request=randomUUID(); const saved=await save(aid,2,0,{p1:'b'},false,request)
    assert.equal(saved.responses[0].auto_points,null)
    assert.deepEqual((await save(aid,2,0,{p1:'b'},false,request)).responses,saved.responses)
    await denied(save(aid,2,0,{p1:'a'}),'40001');await denied(save(aid,2,1,{p1:'no'}),'22023')
    await denied(save(aid,2,1,{unexpected:'b'}),'22023'); await denied(save(aid,3,0,{p1:['a','a']}),'22023')
    const locked=await save(aid,2,1,{p1:'b'},true);assert.equal(locked.responses[0].auto_points,2)
    await denied(save(aid,2,2,{p1:'a'}),'22023');assert.equal((await rpc('exam_guidance',[aid,2])).correct.p1,'b')
  })
  await t.test('checkbox proportional credit and penalty, long answer and self assessment',async()=>{
    const full=await save(aid,3,0,{p1:['c','a']},true);assert.equal(full.responses.find(r=>r.number===3).auto_points,3)
    await save(aid,4,0,{p1:'My response'},true)
    const rated=await rpc('exam_self_assess',[aid,4,1,'partial',randomUUID()]);assert.equal(rated.responses.find(r=>r.number===4).self_assessment,'partial')
    await denied(rpc('exam_self_assess',[aid,4,1,'full',randomUUID()]),'40001')
    await denied(rpc('exam_self_assess',[aid,2,2,'full',randomUUID()]))
    const b=await start();const bad=await save(b.attempt.id,3,0,{p1:['a','b']},true);assert.equal(bad.responses[0].auto_points,.5)
  })
  await t.test('whole attempt gate, stale final submit, blanks, unverified and idempotent final submit',async()=>{
    let b=await start('end');const id=b.attempt.id
    await denied(save(id,2,0,{p1:'b'},true),'22023')
    b=await save(id,2,0,{p1:'b'});await denied(rpc('exam_guidance',[id,2]))
    await denied(rpc('exam_attempt_submit',[id,0]),'40001')
    const final=await rpc('exam_attempt_submit',[id,b.attempt.revision]);assert.ok(final.attempt.submitted_at)
    assert.equal(final.responses.find(r=>r.number===3).auto_points,0);assert.equal(final.responses.find(r=>r.number===6).auto_points,null)
    assert.deepEqual((await rpc('exam_guidance',[id,6])).correct,{})
    assert.deepEqual((await rpc('exam_attempt_submit',[id,0])).responses,final.responses)
    await denied(save(id,5,1,{p1:'a'}),'22023')
  })
  await t.test('two users, own rows only, no direct writes, anonymous/no-grant access denied',async()=>{
    await as(other);assert.equal((await db.query('select * from public.exam_attempts')).rows.length,0)
    assert.equal((await db.query('select * from public.exam_responses')).rows.length,0)
    await denied(rpc('exam_attempt_get',[aid]));await denied(save(aid,5,0,{p1:'a'}))
    await denied(db.query('update public.exam_responses set auto_points=100'))
    await denied(db.query('insert into public.exam_attempts(id,user_id,exam_id,version,feedback,mode) values($1,$2,\'fixture\',1,\'end\',\'practice\')',[randomUUID(),other]))
    await as(outsider);assert.equal((await rpc('exam_catalogue')).exams.length,0);await denied(start())
    await as('', 'anon');await denied(rpc('exam_catalogue'))
    await db.exec('reset role');await denied(db.query('select exam_private.import_package($1)',[{...pack,package_sha256:'c'.repeat(64)}]),'22023')
  })
})

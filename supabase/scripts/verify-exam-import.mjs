// Local disposable PostgreSQL only. Never connects to the hosted project.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { validatePackage } from './prepare-exam-import.mjs'
const path=process.argv[2]
if(!path)throw Error('Usage: node supabase/scripts/verify-exam-import.mjs PRIVATE.json')
const data=validatePackage(JSON.parse(await readFile(path,'utf8'))),db=new PGlite()
try {
  await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`)
  const dir=new URL('../migrations/',import.meta.url)
  for(const f of(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(f,dir),'utf8'))
  const user=randomUUID(),attempt=randomUUID();await db.query('insert into auth.users values($1)',[user])
  await db.query('select exam_private.import_package($1,$2)',[data,user])
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated')
  const rpc=async(name,args)=>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as r`,args)).rows[0].r
  const first=await rpc('exam_attempt_start',[attempt,data.exam.id,data.exam.version,'each','practice',false])
  assert.equal(first.questions.length,data.questions.length);assert.doesNotMatch(JSON.stringify(first),/"correct"|guide_assets|content_base64/)
  for(const q of data.questions){
    assert.deepEqual(first.questions.find(x=>x.number===q.number).prompt,q.prompt)
    for(const b of q.prompt.blocks.filter(b=>b.type==='image'))assert.equal((await rpc('exam_prompt_asset',[attempt,b.asset])).base64,data.assets.find(a=>a.id===b.asset).base64)
    const answer=q.grading==='automatic'?q.correct:Object.fromEntries(q.prompt.fields.map(f=>[f.id,f.kind==='text'?'Lokalt kontrollsvar':f.options[0].id]))
    const saved=await rpc('exam_response_save',[attempt,q.number,0,answer,true,randomUUID()])
    assert.equal(saved.responses.find(r=>r.number===q.number).auto_points,q.grading==='automatic'?q.max_points:null)
    const guide=await rpc('exam_guidance',[attempt,q.number]);assert.equal(guide.assets.length,q.guide_assets.length)
  }
  console.log({questions:data.questions.length,scored:data.questions.filter(q=>q.max_points>0).length,fields:data.questions.reduce((n,q)=>n+q.prompt.fields.length,0),points:data.questions.reduce((n,q)=>n+q.max_points,0),assets:data.assets.length,manual:data.questions.filter(q=>q.review_status==='manual').map(q=>q.number),status:'All imported prompts, figures, keys and guidance verified locally'})
} finally {await db.close()}

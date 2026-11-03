import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,readdir} from 'node:fs/promises'
import test from 'node:test'
import {PGlite} from '@electric-sql/pglite'

test('full logical-day corrections: atomic derived start, durable cutover and canonical reads',async t=>{
  const db=new PGlite();t.after(()=>db.close())
  await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;
    alter default privileges in schema public grant all on tables to anon,authenticated;
    alter default privileges in schema public grant execute on functions to anon,authenticated;`)
  const dir=new URL('../migrations/',import.meta.url),migration='20261103180000_expand_flow_segment_correction_bounds.sql'
  for(const file of(await readdir(dir)).filter(n=>n.endsWith('.sql')&&n<migration).sort())await db.exec(await readFile(new URL(file,dir),'utf8'))
  await db.exec(`create or replace function pg_catalog.clock_timestamp() returns timestamptz language sql volatile as $$ select current_setting('flow.test_now')::timestamptz $$;
    create or replace function pg_catalog.statement_timestamp() returns timestamptz language sql stable as $$ select current_setting('flow.test_now')::timestamptz $$;`)
  const clock=time=>db.query("select set_config('flow.test_now',$1,false)",[time])
  async function user(id,role='authenticated'){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role '+role)}
  async function fixture(){await db.exec('reset role');const id=randomUUID();await db.query('insert into auth.users values($1)',[id]);await user(id);await clock('2026-11-04T12:00Z');return id}
  const result=async(sql,args=[])=>(await db.query(sql,args)).rows[0].result
  const row=id=>result('select to_jsonb(s) as result from public.flow_work_segments s where id=$1',[id])
  const day=id=>result('select to_jsonb(d) as result from public.flow_work_days d where id=$1',[id])
  const snap=id=>result('select public.flow_work_day_snapshot($1) as result',[id])
  const marker=()=>result('select to_jsonb(c) as result from public.flow_timer_cutovers c')
  const denied=(p,code)=>assert.rejects(p,e=>e.code===code)
  async function native(from='2026-11-03T08:07:03.123456Z',to='2026-11-03T08:46:04.654321Z',options={}){
    const id=randomUUID(),segment=randomUUID();if(!options.transaction)await db.exec('begin')
    try{
      await db.query("insert into public.flow_work_days(id,timezone,logical_date,boundary_at,cutoff_at,started_at) values($1,$2,'2000-01-01','2000-01-01','2000-01-02',$3)",[id,options.zone??'UTC',from])
      await db.query('insert into public.flow_work_segments(id,work_day_id,started_at,ended_at,area_id,task_id) values($1,$2,$3,$4,$5,$6)',[segment,id,from,to,options.area??null,options.task??null])
      for(const [a,b]of options.extra??[])await db.query('insert into public.flow_work_segments(work_day_id,started_at,ended_at) values($1,$2,$3)',[id,a,b])
      if(options.end)await db.query('update public.flow_work_days set ended_at=$1 where id=$2',[options.end,id])
      if(!options.transaction)await db.exec('commit');return await row(segment)
    }catch(e){if(!options.transaction)await db.exec('rollback');throw e}
  }
  const correct=(old,desired={},expected={})=>{
    const next={...old,...desired},prev={...old,...expected}
    return result('select public.flow_work_segment_correct($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result',
      [old.id,old.work_day_id,prev.started_at,prev.ended_at,prev.area_id,prev.task_id,next.started_at,next.ended_at,next.area_id,next.task_id])
  }
  const fixed=(before,after)=>assert.deepEqual({...after,started_at:before.started_at},before)
  // Seed an old row whose first period was previously moved later. Installation
  // must not silently backfill its recorded start or change any production row.
  const firstUser=await fixture(),existing=await native()
  await correct(existing,{started_at:'2026-11-03T08:10Z'})
  const tables=['flow_work_days','flow_work_segments','flow_timer_cutovers','study_sessions','study_session_segments']
  const dump=async()=>Object.fromEntries(await Promise.all(tables.map(async name=>[name,(await db.query(`select to_jsonb(t) as row from public.${name} t`)).rows])))
  const beforeInstall=await dump();await db.exec('reset role');await db.exec(await readFile(new URL(migration,dir),'utf8'));await user(firstUser)

  await t.test('migration installs without changing old data or rewriting existing non-derived starts',async()=>{assert.deepEqual(await dump(),beforeInstall)})
  await t.test('first closed period moves earlier/later across the original envelope; derived start changes and lifecycle stays frozen',async()=>{
    await fixture();let s=await native(undefined,undefined,{end:'2026-11-03T08:46:04.654321Z'});const original=await day(s.work_day_id),cutover=await marker()
    let corrected=await correct(s,{started_at:'2026-11-03T08:06:00.000001Z'})
    fixed(original,corrected.work_day);assert.equal(corrected.work_day.started_at,corrected.segments[0].started_at)
    assert.equal(corrected.segments[0].ended_at,s.ended_at);assert.deepEqual(await marker(),cutover)
    s=await row(s.id);corrected=await correct(s,{started_at:'2026-11-03T09:00Z',ended_at:'2026-11-03T09:30Z'})
    fixed(original,corrected.work_day);assert.equal(Date.parse(corrected.work_day.started_at),Date.parse('2026-11-03T09:00Z'))
    assert.ok(Date.parse(corrected.work_day.started_at)>Date.parse(corrected.work_day.ended_at));assert.deepEqual(await marker(),cutover)
  })
  await t.test('moving first period past another derives the actual minimum; direct day edits cannot forge it',async()=>{
    await fixture();const s=await native(undefined,undefined,{extra:[['2026-11-03T10:00Z','2026-11-03T11:00Z']]})
    const corrected=await correct(s,{started_at:'2026-11-03T12:00Z',ended_at:'2026-11-03T13:00Z'})
    assert.equal(Date.parse(corrected.work_day.started_at),Date.parse('2026-11-03T10:00Z'))
    await denied(db.query("update public.flow_work_days set started_at='2026-11-03T04:00Z' where id=$1",[s.work_day_id]),'23514')
    for(const field of ['logical_date','timezone','boundary_at','cutoff_at']){
      const value={logical_date:"'2026-11-04'",timezone:"'Europe/Oslo'",boundary_at:"'2026-11-03T03:00Z'",cutoff_at:"'2026-11-04T05:00Z'"}[field]
      await denied(db.query(`update public.flow_work_days set ${field}=${value} where id=$1`,[s.work_day_id]),'23514')
    }
  })
  await t.test('closed last period extends across midnight up to inclusive cutoff, without changing ended_at or reopening',async()=>{
    await fixture();const s=await native('2026-11-03T20:00Z','2026-11-03T21:00Z',{end:'2026-11-03T21:00Z'}),original=await day(s.work_day_id)
    await correct(s,{ended_at:'2026-11-04T02:30Z'})
    const updated=await correct(await row(s.id),{ended_at:original.cutoff_at})
    assert.equal(updated.work_day.ended_at,original.ended_at);assert.equal(updated.segments[0].ended_at,original.cutoff_at)
    assert.equal((await result("select public.flow_work_state('UTC') as result")).current,null)
    await denied(db.query('update public.flow_work_days set ended_at=null where id=$1',[s.work_day_id]),'23514')
  })
  await t.test('active day stays paused/running as before; full editing of an open period requires Pause',async()=>{
    await fixture();await clock('2026-11-03T12:00Z')
    const s=await native(undefined,undefined,{extra:[['2026-11-03T10:00Z',null]]}),before=await snap(s.work_day_id)
    const corrected=await correct(s,{started_at:'2026-11-03T08:06Z'})
    assert.equal(corrected.work_day.ended_at,null);assert.deepEqual(corrected.segments[1],before.segments[1])
    const open=corrected.segments.find(s=>s.ended_at===null)
    await denied(correct(open,{started_at:'2026-11-03T09:00Z',ended_at:'2026-11-03T11:00Z'}),'22023')
    // Preserve 34B's explicit finish-only recovery for the observed open period.
    const paused=await correct(open,{ended_at:'2026-11-03T11:00Z'})
    assert.ok(paused.segments.every(s=>s.ended_at));assert.equal(paused.work_day.ended_at,null)
  })
  await t.test('logical boundary and server-now bounds are enforced, including direct table writes',async()=>{
    await fixture();await clock('2026-11-03T12:00Z');const s=await native(),before=await day(s.work_day_id)
    for(const [fields,code]of [
      [{started_at:'2026-11-03T03:59:59.999999Z'},'22023'],[{started_at:before.cutoff_at,ended_at:before.cutoff_at},'22023'],
      [{ended_at:'2026-11-04T04:00:00.000001Z'},'22023'],[{ended_at:'2026-11-03T12:00:00.000001Z'},'22008'],
    ]){await denied(correct(s,fields),code);assert.deepEqual(await row(s.id),s);assert.deepEqual(await day(s.work_day_id),before)}
    await denied(db.query("update public.flow_work_segments set ended_at='2026-11-03T12:00:00.000001Z' where id=$1",[s.id]),'22008')
    await correct(s,{started_at:before.boundary_at,ended_at:'2026-11-03T12:00Z'})
  })
  await t.test('overlap and invalid attribution roll back segment, derived start and any cutoff reconciliation',async()=>{
    await fixture();const s=await native(undefined,undefined,{extra:[['2026-11-03T09:00Z','2026-11-03T10:00Z']]});const before=await snap(s.work_day_id)
    await denied(correct(s,{started_at:'2026-11-03T04:00Z',ended_at:'2026-11-03T09:30Z'}),'23P01')
    await denied(correct(s,{started_at:'2026-11-03T04:00Z',task_id:randomUUID()}),'23503')
    assert.deepEqual((await snap(s.work_day_id)).work_day,before.work_day);assert.deepEqual(await row(s.id),s)
    await fixture();await clock('2026-11-03T12:00Z');const open=await native('2026-11-03T08:07Z',null)
    await clock('2026-11-04T12:00Z');await denied(correct(open,{ended_at:'2026-11-03T10:00Z'}),'40001')
    assert.equal((await row(open.id)).ended_at,null);assert.equal((await day(open.work_day_id)).ended_at,null)
  })
  await t.test('durable cutover permits safe earlier closed correction, rejects legacy overlap in BOTH directions and never revives old timers',async()=>{
    await fixture();const session=randomUUID(),legacy=randomUUID()
    await db.query("insert into public.study_sessions(id,started_at,ended_at) values($1,'2026-11-03T08:00Z','2026-11-03T08:07Z')",[session])
    await db.query("insert into public.study_session_segments(id,session_id,started_at,ended_at) values($1,$2,'2026-11-03T08:00Z','2026-11-03T08:05Z')",[legacy,session])
    const s=await native('2026-11-03T08:07Z'),cutover=await marker()
    await correct(s,{started_at:'2026-11-03T08:06Z'});assert.deepEqual(await marker(),cutover)
    await denied(correct(await row(s.id),{started_at:'2026-11-03T08:04Z'}),'23P01')
    await denied(db.query("update public.study_session_segments set ended_at='2026-11-03T08:06:30Z' where id=$1",[legacy]),'23514')
    await denied(result("select public.study_session_history_edit($1,null,'Old client','2026-11-03T08:00Z','2026-11-03T08:07Z',$2::jsonb) as result",[session,JSON.stringify([{started_at:'2026-11-03T08:00Z',ended_at:'2026-11-03T08:06:30Z'}])]),'23514')
    await denied(db.query('update public.study_sessions set ended_at=null where id=$1',[session]),'23514')
    await denied(db.query("insert into public.flow_work_segments(work_day_id,started_at,ended_at) values($1,'2026-11-03T05:00Z','2026-11-03T06:00Z')",[s.work_day_id]),'23514')
    await denied(db.query("update public.flow_timer_cutovers set activated_at='2026-11-03T04:00Z'"),'42501')
    assert.deepEqual(await marker(),cutover)
  })
  await t.test('first activity remains atomic; mismatched direct insert and an empty day cannot commit',async()=>{
    await fixture();const id=randomUUID()
    await denied(db.query("insert into public.flow_work_days(id,timezone,logical_date,boundary_at,cutoff_at,started_at) values($1,'UTC','2000-01-01','2000-01-01','2000-01-02','2026-11-03T08:07Z')",[id]),'23514')
    await db.exec('begin')
    await db.query("insert into public.flow_work_days(id,timezone,logical_date,boundary_at,cutoff_at,started_at) values($1,'UTC','2000-01-01','2000-01-01','2000-01-02','2026-11-03T08:07Z')",[id])
    await denied(db.query("insert into public.flow_work_segments(work_day_id,started_at,ended_at) values($1,'2026-11-03T08:08Z','2026-11-03T08:46Z')",[id]),'23514')
    await db.exec('rollback');assert.equal((await db.query('select * from public.flow_timer_cutovers')).rows.length,0)
    // Creation + legitimate correction in one transaction still validates the final derived start.
    await db.exec('begin');const s=await native(undefined,undefined,{transaction:true});await correct(s,{started_at:'2026-11-03T08:06Z'});await db.exec('commit')
  })
  for(const [zone,from,expectedHours]of [['Europe/Oslo','2026-03-28T08:07Z',23],['Europe/Oslo','2026-10-24T08:07Z',25]])await t.test(`stored 04:00 DST day spans ${expectedHours} hours without moving logical date`,async()=>{
    await fixture();const s=await native(from,new Date(Date.parse(from)+60000).toISOString(),{zone}),d=(await snap(s.work_day_id)).work_day
    assert.equal((Date.parse(d.cutoff_at)-Date.parse(d.boundary_at))/3600000,expectedHours)
    const corrected=await correct(s,{started_at:d.boundary_at,ended_at:d.cutoff_at});fixed(d,corrected.work_day)
    assert.equal((await result("select public.flow_statistics('day',$1,'UTC') as result",[d.logical_date])).total,expectedHours*3600000)
  })
  await t.test('zero-minute and microsecond corrections derive exact start, idempotent lost-reply retry and stale four-field rejection',async()=>{
    await fixture();const s=await native(),desired={started_at:'2026-11-03T08:06:00.000001Z',ended_at:'2026-11-03T08:06:00.000001Z'}
    const once=await correct(s,desired);await correct(s,desired);assert.deepEqual(await row(s.id),once.segments[0])
    assert.equal(once.work_day.started_at,once.segments[0].started_at);assert.equal((await result("select public.flow_statistics('total') as result")).total,0)
    for(const key of ['started_at','ended_at','area_id','task_id']){
      const expected={[key]:key.endsWith('_at')?'2026-11-03T08:05Z':randomUUID()}
      await denied(correct(once.segments[0],{ended_at:'2026-11-03T08:07Z'},expected),'40001')
    }
    await correct(once.segments[0],{started_at:'2026-11-03T08:05Z',ended_at:'2026-11-03T08:07Z'})
    await denied(correct(s,desired),'40001')
  })
  await t.test('all canonical totals and export include work beyond lifecycle end; existing manifests invalidate',async()=>{
    await fixture();const area=randomUUID();await db.query("insert into public.subjects(id,name) values($1,'Area')",[area])
    const task=await result("select public.flow_task_save($1,'Task','',$2,null) as result",[randomUUID(),area])
    const s=await native(undefined,undefined,{area,task:task.id,end:'2026-11-03T08:46:04.654321Z'})
    const oldExport=await result("select public.flow_export_start('total',null,'UTC') as result")
    const corrected=await correct(s,{started_at:'2026-11-03T08:06:00.123456Z',ended_at:'2026-11-03T10:00:00.654321Z'})
    const total=6840530.865
    for(const kind of ['day','week','month','total'])assert.equal((await result('select public.flow_statistics($1,$2,\'UTC\') as result',[kind,'2026-11-03'])).total,total)
    assert.equal((await result('select public.flow_task_time($1) as result',[task.id])).work_milliseconds,total)
    assert.equal((await result("select public.flow_area_statistics($1,'UTC') as result",[area])).total.total,total)
    const history=await result('select public.flow_history() as result');assert.equal(history.rows[0].started_at,corrected.work_day.started_at)
    const exported=await result("select public.flow_export_start('total',null,'UTC') as result")
    assert.equal(BigInt(exported.rows[0].work_microseconds),6840530865n)
    await denied(result('select public.flow_export_rows($1::jsonb,500) as result',[JSON.stringify({job:oldExport.job_id,after:0})]),'40001')
  })
  await t.test('authenticated-only invoker RPC and trigger helper, two-owner isolation and immutable ownership',async()=>{
    const a=await fixture(),s=await native();await fixture()
    assert.equal((await db.query('select * from public.flow_work_segments')).rows.length,0)
    await denied(correct(s,{started_at:'2026-11-03T08:06Z'}),'42501')
    await user(a);assert.deepEqual(await row(s.id),s)
    await db.exec('reset role')
    for(const signature of ['public.flow_work_segment_correct(uuid,uuid,timestamptz,timestamptz,uuid,uuid,timestamptz,timestamptz,uuid,uuid)','public.flow_sync_day_start()']){
      const fn=(await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure',[signature])).rows[0]
      assert.equal(fn.prosecdef,false);assert.ok(fn.proconfig.includes('search_path=""'))
      assert.equal((await db.query("select has_function_privilege('anon',$1,'EXECUTE') as ok",[signature])).rows[0].ok,false)
    }
    assert.equal((await db.query("select has_function_privilege('authenticated','public.flow_sync_day_start()','EXECUTE') as ok")).rows[0].ok,false)
    await user('', 'anon');await denied(correct(s),'42501');await user('');await denied(correct(s),'42501')
  })
})

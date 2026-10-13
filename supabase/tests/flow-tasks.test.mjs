import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('Flow tasks: canonical SQL, direct writes, two owners and native timer', async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
    alter default privileges in schema public grant all on tables to anon,authenticated;
    alter default privileges in schema public grant execute on functions to anon,authenticated;`)
  const dir=new URL('../migrations/',import.meta.url)
  for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,dir),'utf8'))
  await db.exec(`create or replace function pg_catalog.clock_timestamp() returns timestamptz
    language sql volatile as $$ select current_setting('flow.test_now')::timestamptz $$`)
  const clock=time=>db.query("select set_config('flow.test_now',$1,false)",[time])
  async function user(id) { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]); await db.exec('set role authenticated') }
  async function fixture() {
    await db.exec('reset role'); const id=randomUUID(),area=randomUUID()
    await db.query('insert into auth.users values($1)',[id]); await user(id); await clock('2026-10-13T08:00Z')
    await db.query("insert into public.subjects(id,name) values($1,'Area')",[area]); return {id,area}
  }
  const result=async(sql,args=[]) => (await db.query(sql,args)).rows[0].result
  const save=(id,title='Task',area=null,deadline=null,expected=null,description='')=>result(
    'select public.flow_task_save($1,$2,$3,$4,$5,$6) as result',[id,title,description,area,deadline,expected])
  const status=(task,value)=>result('select public.flow_task_status($1,$2,$3) as result',[task.id,value,task.updated_at])
  const state=()=>result("select public.flow_work_state('UTC') as result")
  const taskTime=id=>result('select public.flow_task_time($1) as result',[id])
  async function start(task) {
    return result("select public.flow_work_day_start($1,$2,'UTC',$3,$4,$5) as result",
      [randomUUID(),randomUUID(),(await state()).next_boundary_at,task?.area_id??null,task?.id??null])
  }
  const change=(snapshot,next,task=null)=>result('select public.flow_work_activity($1,$2,$3,$4,$5,$6) as result',
    [snapshot.work_day.id,snapshot.segments.find(s=>!s.ended_at)?.id??null,snapshot.segments.length,next,task?.area_id??null,task?.id??null])
  const denied=(promise,code)=>assert.rejects(promise,error=>!code||error.code===code)

  await t.test('create trims, derives timestamps, retry token never edits; no-op update does not advance version',async()=>{
    const a=await fixture(),id=randomUUID()
    const task=await save(id,'  Work  ',a.area,'2026-10-13T14:00Z')
    assert.equal(task.title,'Work'); assert.equal(task.updated_at,task.created_at); assert.equal(task.completed_at,null)
    await clock('2026-10-13T09:00Z'); assert.deepEqual(await save(id,'Overwrite'),task)
    const noOp=await save(id,'Work',a.area,task.deadline_at,task.updated_at); assert.equal(noOp.updated_at,task.updated_at)
    const edit=await save(id,'New title',a.area,null,task.updated_at,'Details'); assert.notEqual(edit.updated_at,task.updated_at)
    await denied(save(id,'Stale',null,null,task.updated_at),'40001')
    await denied(save(randomUUID(),' '),'23514'); await denied(save(randomUUID(),'x'.repeat(201)),'23514')
    await denied(save(randomUUID(),'Valid',null,null,null,'x'.repeat(2001)),'23514')
    await denied(save(randomUUID(),'Valid',null,'infinity'),'23514')
    await denied(db.query('delete from public.flow_tasks where id=$1',[id]),'42501')
  })
  await t.test('direct completion pauses atomically at server time; spoofed times ignored; reopen never starts work',async()=>{
    await fixture(); const id=randomUUID(),task=await save(id); const first=await start(task)
    await clock('2026-10-13T08:30Z')
    const complete=await result("with changed as (update public.flow_tasks set status='completed',completed_at='2030-01-01',updated_at='2030-01-01' where id=$1 returning *) select to_jsonb(changed) as result from changed",[id])
    const paused=(await state()).current
    assert.equal(paused.work_day.ended_at,null); assert.equal(paused.segments[0].ended_at,complete.completed_at)
    assert.equal(Date.parse(complete.completed_at),Date.parse('2026-10-13T08:30Z'))
    assert.equal((await taskTime(id)).work_milliseconds,1800000)
    await clock('2026-10-13T09:00Z'); assert.deepEqual(await status(task,'completed'),complete)
    const reopened=await status(complete,'active'); assert.equal(reopened.completed_at,null)
    assert.ok((await state()).current.segments.every(s=>s.ended_at))
    await denied(status(task,'completed'),'40001','A delayed completion cannot undo a reopen')
    assert.deepEqual((await change(first,randomUUID(),complete)).segments,paused.segments)
  })
  await t.test('running task can edit text/deadline but not area; closed attribution survives move and rename',async()=>{
    const a=await fixture(),task=await save(randomUUID(),'Original',a.area); let snapshot=await start(task)
    await denied(save(task.id,'Moved',null,null,task.updated_at),'23514')
    await clock('2026-10-13T08:10Z'); const edit=await save(task.id,'Renamed',a.area,'2026-10-13T12:00Z',task.updated_at)
    snapshot=await change(snapshot,null)
    const moved=await save(task.id,'Renamed',null,null,edit.updated_at)
    assert.equal((await state()).current.segments[0].area_id,a.area)
    await clock('2026-10-13T08:20Z'); snapshot=await change(snapshot,randomUUID(),moved)
    await clock('2026-10-13T08:30Z'); await status(moved,'completed')
    const periods=(await state()).current.segments
    assert.equal(periods[0].area_id,a.area); assert.equal(periods[1].area_id,null)
    assert.equal((await taskTime(task.id)).work_milliseconds,1200000)
  })
  await t.test('archived area cannot create/start/move there; existing task remains editable and detachable',async()=>{
    const a=await fixture(),task=await save(randomUUID(),'Old area',a.area)
    await db.query('update public.subjects set is_archived=true where id=$1',[a.area])
    await denied(start(task),'23503'); await denied(save(randomUUID(),'New',a.area),'23503')
    const edit=await save(task.id,'Still exists',a.area,null,task.updated_at)
    const detached=await save(task.id,'Still exists',null,null,edit.updated_at)
    assert.equal((await start(detached)).segments[0].area_id,null)
  })
  await t.test('cutoff completion closes at stored cutoff, not late completion; totals include ended days only once',async()=>{
    await fixture(); await clock('2026-10-14T03:50Z'); const task=await save(randomUUID()); const snapshot=await start(task)
    await clock('2026-10-14T04:15Z'); const completed=await status(task,'completed')
    assert.equal((await state()).current,null)
    const final=await result('select public.flow_work_day_snapshot($1) as result',[snapshot.work_day.id])
    assert.equal(final.segments[0].ended_at,final.work_day.cutoff_at)
    assert.equal(Date.parse(completed.completed_at),Date.parse('2026-10-14T04:15Z'))
    assert.equal((await taskTime(task.id)).work_milliseconds,600000)
    const active=await status(completed,'active'); await start(active)
    await clock('2026-10-14T04:25Z'); assert.equal((await taskTime(task.id)).work_milliseconds,1200000)
  })
  await t.test('same user lock: complete then stale resume/switch cannot resurrect completed work',async()=>{
    await fixture(); const task=await save(randomUUID()); let snapshot=await start(task)
    await clock('2026-10-13T08:10Z'); const done=await status(task,'completed')
    assert.deepEqual((await change(snapshot,randomUUID(),task)).segments,(await state()).current.segments)
    snapshot=(await state()).current
    await denied(change(snapshot,randomUUID(),task),'23514')
    assert.ok((await state()).current.segments.every(s=>s.ended_at))
    assert.deepEqual(await status(task,'completed'),done)
    await denied(db.query('update public.flow_work_segments set ended_at=null where task_id=$1',[task.id]),'23514')
    await denied(db.query("update public.flow_tasks set status='overdue' where id=$1",[task.id]),'23514')
    const unchanged=await result("with changed as (update public.flow_tasks set updated_at='2030-01-01',completed_at='2030-01-01' where id=$1 returning *) select to_jsonb(changed) as result from changed",[task.id])
    assert.equal(unchanged.updated_at,done.updated_at); assert.equal(unchanged.completed_at,done.completed_at)
  })
  await t.test('two-user RLS: read/edit/complete/reopen/link/aggregate, anon and function privileges',async()=>{
    const a=await fixture(),task=await save(randomUUID(),'A',a.area); await start(task)
    const b=await fixture(); assert.equal((await db.query('select * from public.flow_tasks')).rows.length,0)
    assert.equal((await db.query("update public.flow_tasks set title='Hacked' where id=$1 returning id",[task.id])).rows.length,0)
    await denied(save(task.id,'Hacked',null,null,task.updated_at),'22023')
    await denied(status(task,'completed'),'22023'); await denied(status(task,'active'),'22023')
    await denied(save(randomUUID(),'Link',a.area),'23503'); await denied(taskTime(task.id),'22023')
    const own=await save(randomUUID(),'B'); await user(a.id)
    await denied(taskTime(own.id),'22023'); assert.equal((await taskTime(task.id)).work_milliseconds,0)
    await db.exec('reset role')
    for(const sig of ['flow_task_save(uuid,text,text,uuid,timestamptz,timestamptz)','flow_task_status(uuid,text,timestamptz)','flow_task_time(uuid)']) {
      const row=(await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure',['public.'+sig])).rows[0]
      assert.equal(row.prosecdef,false); assert.ok(row.proconfig.includes('search_path=""'))
      assert.equal((await db.query("select has_function_privilege('anon',$1,'EXECUTE') as ok",['public.'+sig])).rows[0].ok,false)
    }
    await db.exec('set role anon'); await denied(taskTime(task.id),'42501'); await denied(db.query('select * from public.flow_tasks'),'42501')
    await user(b.id)
  })
})

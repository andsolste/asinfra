import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('unified Flow history/statistics: real canonical SQL and RLS', async t => {
  const db=new PGlite(); t.after(()=>db.close())
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;
    alter default privileges in schema public grant all on tables to anon,authenticated;
    alter default privileges in schema public grant execute on functions to anon,authenticated;`)
  const dir=new URL('../migrations/',import.meta.url)
  for(const file of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,dir),'utf8'))
  await db.exec(`create or replace function pg_catalog.clock_timestamp() returns timestamptz language sql volatile as $$ select current_setting('flow.test_now')::timestamptz $$;
    create or replace function pg_catalog.statement_timestamp() returns timestamptz language sql stable as $$ select current_setting('flow.test_now')::timestamptz $$;`)
  const clock=at=>db.query("select set_config('flow.test_now',$1,false)",[at])
  async function user(id) { await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated') }
  async function fixture() {
    await db.exec('reset role');const id=randomUUID(),area=randomUUID()
    await db.query('insert into auth.users values($1)',[id]);await user(id);await clock('2026-10-19T12:00:00Z')
    await db.query("insert into public.subjects(id,name,code) values($1,'ASInfra','ASI')",[area]);return {id,area}
  }
  const result=async(sql,args=[]) => (await db.query(sql,args)).rows[0].result
  const stats=(kind='total',date=null,zone='UTC',area=null,only=false,task=null)=>result('select public.flow_statistics($1,$2,$3,$4,$5,$6) as result',[kind,date,zone,area,only,task])
  const history=(limit=25,cursor=null)=>result('select public.flow_history($1,$2::jsonb) as result',[limit,cursor?JSON.stringify(cursor):null])
  async function legacy(start,end,area=null,periods=[[start,end]],id=randomUUID()) {
    await db.query("insert into public.study_sessions(id,subject_id,description,started_at,ended_at) values($1,$2,'Same as task title',$3,$4)",[id,area,start,end])
    for(const [a,b] of periods) await db.query('insert into public.study_session_segments(session_id,started_at,ended_at) values($1,$2,$3)',[id,a,b])
    return id
  }
  async function native(start,end,area=null,task=null,zone='UTC',extra=[]) {
    const day=randomUUID(),seg=randomUUID()
    await db.exec('begin')
    try {
      await db.query("insert into public.flow_work_days(id,timezone,logical_date,boundary_at,cutoff_at,started_at) values($1,$2,'2000-01-01','2000-01-01','2000-01-02',$3)",[day,zone,start])
      await db.query('insert into public.flow_work_segments(id,work_day_id,area_id,task_id,started_at,ended_at) values($1,$2,$3,$4,$5,$6)',[seg,day,area,task,start,end])
      for(const [a,b,ar,ta] of extra) await db.query('insert into public.flow_work_segments(work_day_id,started_at,ended_at,area_id,task_id) values($1,$2,$3,$4,$5)',[day,a,b,ar??null,ta??null])
      if(end && !extra.some(x=>x[1]===null)) await db.query('update public.flow_work_days set ended_at=cutoff_at where id=$1',[day])
      await db.exec('commit');return {day,seg}
    } catch(error) { await db.exec('rollback');throw error }
  }
  const saveTask=(title,area)=>result('select public.flow_task_save($1,$2,\'\',$3,null) as result',[randomUUID(),title,area])
  const denied=(promise,code)=>assert.rejects(promise,e=>!code||e.code===code)
  const ms=(a,b)=>Date.parse(b)-Date.parse(a)

  await t.test('legacy only / native only / combined totals, Annet, same area identity and deleted subject',async()=>{
    const a=await fixture();const deleted=randomUUID()
    await db.query("insert into public.subjects(id,name) values($1,'Deleted')",[deleted])
    await legacy('2026-10-17T08:00Z','2026-10-17T10:00Z',a.area,[['2026-10-17T08:00Z','2026-10-17T08:30Z'],['2026-10-17T09:30Z','2026-10-17T10:00Z']])
    await legacy('2026-10-17T11:00Z','2026-10-17T11:15Z',deleted);await db.query('delete from public.subjects where id=$1',[deleted])
    assert.equal((await stats()).total,75*60000)
    await native('2026-10-18T08:00Z','2026-10-18T09:00Z',a.area)
    await native('2026-10-19T08:00Z','2026-10-19T08:30Z')
    const total=await stats();assert.equal(total.total,165*60000)
    assert.equal(total.areas.find(x=>x.id===a.area).work,120*60000)
    assert.equal(total.areas.find(x=>x.id===null).work,45*60000)
    assert.equal(total.days.length,0);assert.equal(total.contributions.filter(x=>x.source==='legacy-study').every(x=>x.task_id===null),true)
    for(const zone of ['UTC','Europe/Oslo','America/New_York',null,'bad-zone']) assert.equal((await stats('total',null,zone)).total,total.total)
    await fixture();await native('2026-10-18T08:00Z','2026-10-18T09:00Z');assert.equal((await stats()).total,3600000)
  })
  await t.test('legacy splits at 04:00, never midnight, in UTC/Oslo/New York with DST 23/25-hour days',async()=>{
    for(const [zone,day,from,to,hours] of [
      ['UTC','2026-10-18','2026-10-18T04:00Z','2026-10-19T04:00Z',24],
      ['Europe/Oslo','2026-03-28','2026-03-28T03:00Z','2026-03-29T02:00Z',23],
      ['Europe/Oslo','2026-10-24','2026-10-24T02:00Z','2026-10-25T03:00Z',25],
      ['America/New_York','2026-03-07','2026-03-07T09:00Z','2026-03-08T08:00Z',23],
      ['America/New_York','2026-10-31','2026-10-31T08:00Z','2026-11-01T09:00Z',25],
    ]) {
      await fixture();await clock('2027-01-01T12:00Z');await legacy(new Date(Date.parse(from)-600000).toISOString(),new Date(Date.parse(to)+1200000).toISOString())
      const selected=await stats('day',day,zone);assert.equal(selected.total,hours*3600000)
      assert.equal(selected.days[0].date,day);assert.equal((await stats()).total,hours*3600000+1800000)
      assert.equal((await stats('week',day,zone)).total,hours*3600000+(new Date(day+'T12:00Z').getUTCDay()===0?600000:1800000))
      assert.equal((await stats('month',day,zone)).total,hours*3600000+(day.endsWith('-31')?600000:1800000))
      assert.equal(selected.total,selected.areas.reduce((n,x)=>n+x.work,0))
    }
  })
  await t.test('03:59:59 / 04:00, midnight, week/month/year/leap boundaries and fractional precision',async()=>{
    await fixture();await clock('2029-01-01T12:00Z')
    await legacy('2026-10-18T23:30Z','2026-10-19T04:20Z')
    assert.equal((await stats('day','2026-10-18')).total,270*60000)
    assert.equal((await stats('day','2026-10-19')).total,20*60000)
    assert.equal((await stats('week','2026-10-18')).total,270*60000)
    assert.equal((await stats('week','2026-10-19')).total,20*60000)
    await legacy('2026-11-01T03:59:59Z','2026-11-01T04:00:00Z')
    assert.equal((await stats('month','2026-10-15')).total,290*60000+1000)
    await legacy('2027-01-01T03:50Z','2027-01-01T04:20Z')
    assert.equal((await stats('month','2026-12-15')).total,600000);assert.equal((await stats('month','2027-01-15')).total,1200000)
    await legacy('2028-03-01T03:59:59.123456Z','2028-03-01T04:00:00.987654Z')
    assert.equal((await stats('day','2028-02-29')).total,876.544)
    assert.equal((await stats('month','2028-02-10')).days.length,29)
    assert.equal((await stats('day','2028-03-01')).total,987.654)
  })
  await t.test('invalid legacy zone preserves timezone-independent area total; native current date stays frozen',async()=>{
    const a=await fixture();await legacy('2026-10-17T08:00Z','2026-10-17T09:00Z',a.area)
    const resultA=await result("select public.flow_area_statistics($1,'bad-zone') as result",[a.area])
    assert.equal(resultA.total.total,3600000);assert.equal(resultA.day,null)
    await native('2026-10-18T08:00Z','2026-10-18T09:00Z',a.area)
    const past=await result("select public.flow_area_statistics($1,'bad-zone') as result",[a.area])
    assert.equal(past.day,null,'Past stored date must not be relabelled as today')
    assert.equal(past.total.total,7200000)
    await fixture()
    await clock('2026-10-19T03:00Z');await native('2026-10-18T23:00Z',null,null,null,'UTC')
    const today=await stats('day',null,'Europe/Oslo')
    assert.equal(today.period.anchor,'2026-10-18');assert.equal(today.total,4*3600000)
  })
  await t.test('native grouping is frozen logical date even when display timezone changes; open cutoff clips at server time',async()=>{
    await fixture();await clock('2026-10-19T01:30Z')
    const row=await native('2026-10-18T23:30Z',null,null,null,'Europe/Oslo')
    for(const zone of ['UTC','America/New_York','Pacific/Auckland',null,'bad-zone']) {
      const selected=await stats('day','2026-10-18',zone);assert.equal(selected.total,7200000)
      assert.equal((await stats('day','2026-10-19',zone)).total,0)
    }
    assert.equal((await stats('day','2026-10-18',null)).legacy_timezone_error,'invalid-timezone')
    await clock('2026-10-19T05:00Z');assert.equal((await stats()).total,9000000)
    const page=await history();assert.equal(page.rows[0].id,row.day);assert.equal(page.rows[0].source,'flow')
    assert.equal(page.rows[0].snapshot.work_day.logical_date,'2026-10-18')
    // Read-only RPCs must not mutate the timer merely to show expired history.
    assert.equal((await db.query('select ended_at from public.flow_work_days where id=$1',[row.day])).rows[0].ended_at,null)
  })
  await t.test('area details and moved/completed tasks use segment attribution; legacy descriptions never become tasks',async()=>{
    const a=await fixture();const other=randomUUID()
    await db.query("insert into public.subjects(id,name) values($1,'Second')",[other])
    await legacy('2026-10-17T08:00Z','2026-10-17T08:30Z',a.area)
    const task=await saveTask('Same as task title',a.area)
    await native('2026-10-18T08:00Z','2026-10-18T09:00Z',a.area,task.id)
    await db.query('update public.flow_tasks set area_id=$1 where id=$2',[other,task.id])
    await native('2026-10-19T08:00Z',null,other,task.id)
    let selected=await stats('total',null,'UTC',null,false,task.id)
    assert.equal(selected.total,5*3600000);assert.equal(selected.task_today,4*3600000);assert.equal(selected.task_current,4*3600000)
    await result("select public.flow_task_status($1,'completed',(select updated_at from public.flow_tasks where id=$1)) as result",[task.id])
    await db.query('update public.subjects set is_archived=true where id=$1',[a.area])
    const area=await result("select public.flow_area_statistics($1,'UTC') as result",[a.area])
    assert.equal(area.total.total,90*60000);assert.equal(area.total.areas[0].is_archived,true)
    assert.equal(area.total.contributions.find(x=>x.task_id===task.id).work,3600000)
    assert.equal(area.total.contributions.find(x=>x.source==='legacy-study').task_id,null)
    assert.equal(area.day.total,0);assert.equal(area.week.total,0);assert.equal(area.month.total,90*60000)
    assert.equal((await stats('total',null,'UTC',other,true)).total,4*3600000)
  })
  await t.test('one cursor spans >1000 legacy segments and multiple native/legacy record pages, no duplicates or dropped source',async()=>{
    const a=await fixture();await clock('2027-01-01T12:00Z')
    await db.exec(`insert into public.study_sessions(subject_id,description,started_at,ended_at)
      select '${a.area}','bulk','2026-01-01T04:00Z'::timestamptz+i*interval '1 minute','2026-01-01T04:00Z'::timestamptz+(i+1)*interval '1 minute' from generate_series(0,1104) i;
      insert into public.study_session_segments(session_id,started_at,ended_at) select id,started_at,ended_at from public.study_sessions where user_id=auth.uid();`)
    for(let i=1;i<=32;i++) {const date=new Date(Date.UTC(2026,1,i,8));await native(date.toISOString(),new Date(date.getTime()+60000).toISOString(),a.area)}
    assert.equal((await stats()).total,(1105+32)*60000)
    assert.equal((await stats('month','2026-01-15')).total,1105*60000)
    let cursor=null,rows=[]
    do {const page=await history(100,cursor);rows.push(...page.rows);cursor=page.next_cursor} while(cursor)
    assert.equal(rows.length,1137);assert.equal(new Set(rows.map(x=>x.source+':'+x.id)).size,1137)
    assert.equal(rows.filter(x=>x.source==='flow').length,32)
    for(let i=1;i<rows.length;i++) assert.ok(Date.parse(rows[i-1].started_at)>=Date.parse(rows[i].started_at))
    const first=await history(25);await legacy('2025-12-31T20:00Z','2025-12-31T20:01Z',a.area)
    const second=await history(25,first.next_cursor);assert.equal(second.rows.length,25)
    assert.ok(second.rows.every(x=>!first.rows.some(y=>x.id===y.id&&x.source===y.source)))
  })
  await t.test('source tie-breaker and opaque microsecond cursor keep same UUID in both sources',async()=>{
    await fixture()
    const at='2026-10-18T08:00:00.123456Z'
    const day=await native(at,'2026-10-18T09:00Z')
    await legacy(at,at,null,[],day.day)
    await legacy('2026-10-18T08:00:00.123455Z','2026-10-18T08:00:00.123455Z',null,[])
    const first=await history(1),second=await history(1,first.next_cursor),third=await history(1,second.next_cursor)
    assert.equal(first.rows[0].source,'legacy-study');assert.equal(second.rows[0].source,'flow')
    assert.equal(first.rows[0].id,second.rows[0].id)
    assert.match(first.next_cursor.at,/123456/);assert.match(second.next_cursor.at,/123456/)
    assert.match(third.rows[0].started_at,/123455/);assert.equal(third.next_cursor,null)
  })
  await t.test('attribution correction changes totals, never timestamps; optimistic check, closed-only and rollback',async()=>{
    const a=await fixture(),task=await saveTask('Completed task',a.area)
    const day=await native('2026-10-18T08:00Z','2026-10-18T09:00Z',a.area,null,'UTC',[
      ['2026-10-18T09:00Z','2026-10-18T09:30Z',null,null],['2026-10-18T10:00Z','2026-10-18T10:30Z',null,null]])
    await result("select public.flow_task_status($1,'completed',(select updated_at from public.flow_tasks where id=$1)) as result",[task.id])
    const before=await history()
    await result('select public.flow_history_attribute($1,$2,$3,$4,null) as result',[day.seg,a.area,task.id,a.area])
    assert.equal((await stats('total',null,'UTC',null,false,task.id)).total,3600000)
    const after=await history();assert.deepEqual(after.rows[0].snapshot.work_day,before.rows[0].snapshot.work_day)
    assert.deepEqual(after.rows[0].snapshot.segments.map(s=>[s.started_at,s.ended_at]),before.rows[0].snapshot.segments.map(s=>[s.started_at,s.ended_at]))
    await denied(result('select public.flow_history_attribute($1,null,null,$2,null) as result',[day.seg,a.area]),'40001')
    assert.equal(after.rows[0].snapshot.segments[0].ended_at,after.rows[0].snapshot.segments[1].started_at,'Switch has no invented gap')
    await native('2026-10-19T08:00Z',null)
    const current=(await result("select public.flow_work_state('UTC') as result")).current.segments[0]
    await denied(result('select public.flow_history_attribute($1,$2,null,null,null) as result',[current.id,a.area]),'22023')
  })
  await t.test('legacy corrections/deletion still work, new editor rejects cross-record overlap and refreshes totals',async()=>{
    const a=await fixture();const first=await legacy('2026-10-17T08:00Z','2026-10-17T09:00Z',a.area)
    await legacy('2026-10-17T10:00Z','2026-10-17T11:00Z',a.area)
    const edit=(start,end)=>result('select public.flow_history_edit_legacy($1,$2,\'Fixed\',$3,$4,$5::jsonb) as result',
      [first,a.area,start,end,JSON.stringify([{started_at:start,ended_at:end}])])
    await denied(edit('2026-10-17T08:00Z','2026-10-17T10:30Z'),'22023')
    assert.equal((await stats()).total,7200000)
    await edit('2026-10-17T08:00Z','2026-10-17T08:30Z');assert.equal((await stats()).total,5400000)
    await result('select public.study_session_history_delete($1) as result',[first]);assert.equal((await stats()).total,3600000)
  })
  await t.test('two-user RLS/invoker view, invalid queries and anonymous denial',async()=>{
    const a=await fixture(),task=await saveTask('A',a.area);await legacy('2026-10-17T08:00Z','2026-10-17T09:00Z',a.area)
    const nativeA=await native('2026-10-18T08:00Z','2026-10-18T09:00Z',a.area,task.id)
    const b=await fixture();assert.equal((await stats()).total,0);assert.deepEqual((await history()).rows,[])
    await denied(stats('total',null,'UTC',a.area,true),'22023');await denied(stats('total',null,'UTC',null,false,task.id),'22023')
    await denied(result('select public.flow_history_attribute($1,null,null,$2,$3) as result',[nativeA.seg,a.area,task.id]),'22023')
    assert.equal((await db.query('select * from public.flow_read_segments')).rows.length,0)
    await denied(history(101),'22023');await denied(history(10,{at:'infinity',id:randomUUID(),source:'flow'}),'22023')
    await denied(stats('year'),'22023');await denied(stats('day','infinity'),'22023')
    await user(a.id);assert.equal((await stats()).total,7200000)
    await db.exec('reset role')
    for(const sig of ['flow_history(integer,jsonb)','flow_statistics(text,date,text,uuid,boolean,uuid)','flow_area_statistics(uuid,text)','flow_history_attribute(uuid,uuid,uuid,uuid,uuid)','flow_history_edit_legacy(uuid,uuid,text,timestamptz,timestamptz,jsonb)']) {
      const row=(await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure',['public.'+sig])).rows[0]
      assert.equal(row.prosecdef,false);assert.ok(row.proconfig.includes('search_path=""'))
      assert.equal((await db.query("select has_function_privilege('anon',$1,'EXECUTE') as ok",['public.'+sig])).rows[0].ok,false)
    }
    await db.exec('set role anon');await denied(stats(),'42501');await denied(history(),'42501');await denied(db.query('select * from public.flow_read_segments'),'42501')
    await user(b.id)
  })
})

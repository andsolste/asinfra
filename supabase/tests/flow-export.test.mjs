import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('Flow export: canonical slices, manifest consistency and two-user RLS',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close())
  await db.exec(`create role anon nologin;create role authenticated nologin;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;
    alter default privileges in schema public grant all on tables to anon,authenticated;
    alter default privileges in schema public grant execute on functions to anon,authenticated;`)
  const dir=new URL('../migrations/',import.meta.url)
  for(const f of(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(f,dir),'utf8'))
  await db.exec(`create or replace function pg_catalog.clock_timestamp() returns timestamptz language sql volatile as $$ select current_setting('flow.test_now')::timestamptz $$;
    create or replace function pg_catalog.statement_timestamp() returns timestamptz language sql stable as $$ select current_setting('flow.test_now')::timestamptz $$;`)
  const clock=time=>db.query("select set_config('flow.test_now',$1,false)",[time])
  async function user(id){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated')}
  async function fixture(now='2027-01-02T12:00Z'){
    await db.exec('reset role');const id=randomUUID(),area=randomUUID();await db.query('insert into auth.users values($1)',[id]);await user(id);await clock(now)
    await db.query("insert into public.subjects(id,name,code) values($1,'Norsk område 🧭','ASI')",[area]);return {id,area}
  }
  const result=async(sql,args=[])=>(await db.query(sql,args)).rows[0].result
  const start=(kind='total',date=null,zone='UTC')=>result('select public.flow_export_start($1,$2,$3) as result',[kind,date,zone])
  const page=(cursor,limit=500)=>result('select public.flow_export_rows($1::jsonb,$2) as result',[JSON.stringify(cursor),limit])
  const discard=id=>result('select public.flow_export_discard($1) as result',[id])
  const stats=(kind='total',date=null,zone='UTC')=>result('select public.flow_statistics($1,$2,$3) as result',[kind,date,zone])
  const sum=rows=>rows.reduce((n,r)=>n+BigInt(r.work_microseconds),0n)
  const denied=(p,code)=>assert.rejects(p,e=>e.code===code)
  async function all(kind='total',date=null,zone='UTC'){
    const first=await start(kind,date,zone),rows=[...first.rows];let next=first.next_cursor
    while(next){assert.equal(next.after,rows.length);const p=await page(next);assert.ok(p.rows.length);rows.push(...p.rows);assert.ok(rows.length<=first.total_rows);next=p.next_cursor}
    assert.equal(rows.length,first.total_rows)
    assert.equal(new Set(rows.map(r=>r.source+':'+r.segment_id+':'+r.flow_date)).size,rows.length)
    assert.ok(Math.abs(Number(sum(rows))/1000-first.statistics.total)<=.001)
    assert.ok(Math.abs(Number(sum(rows))/1000-(await stats(kind,date,zone)).total)<=.001)
    return {...first,rows}
  }
  async function legacy(from,to,area=null,description='Lesing, "øving"\nNorsk 🧭',segments=[[from,to]]){
    const id=randomUUID();await db.query('insert into public.study_sessions(id,subject_id,description,started_at,ended_at) values($1,$2,$3,$4,$5)',[id,area,description,from,to])
    for(const [a,b]of segments)await db.query('insert into public.study_session_segments(session_id,started_at,ended_at) values($1,$2,$3)',[id,a,b]);return id
  }
  async function native(from,to,area=null,task=null,zone='UTC'){
    const id=randomUUID(),seg=randomUUID();await db.exec('begin')
    try{
      await db.query("insert into public.flow_work_days(id,timezone,logical_date,boundary_at,cutoff_at,started_at) values($1,$2,'2000-01-01','2000-01-01','2000-01-02',$3)",[id,zone,from])
      await db.query('insert into public.flow_work_segments(id,work_day_id,area_id,task_id,started_at,ended_at) values($1,$2,$3,$4,$5,$6)',[seg,id,area,task,from,to])
      if(to)await db.query('update public.flow_work_days set ended_at=cutoff_at where id=$1',[id])
      await db.exec('commit');return {id,seg}
    }catch(e){await db.exec('rollback');throw e}
  }
  const task=area=>result("select public.flow_task_save($1,'React, TypeScript og \"tester\"','Oppgavebeskrivelse',$2,'2027-01-03T12:00Z') as result",[randomUUID(),area])

  await t.test('day/week/month/total exactly match statistics; native attribution, archived/completed metadata and Annet',async()=>{
    const a=await fixture()
    await legacy('2026-10-18T03:50Z','2026-10-18T04:20Z',a.area)
    await legacy('2026-10-19T03:50Z','2026-10-19T04:20Z')
    const work=await task(a.area);await native('2026-10-20T23:00Z','2026-10-21T01:00Z',a.area,work.id,'UTC')
    await db.query('update public.flow_tasks set area_id=null where id=$1',[work.id])
    await result("select public.flow_task_status($1,'completed',(select updated_at from public.flow_tasks where id=$1)) as result",[work.id])
    await db.query('update public.subjects set is_archived=true where id=$1',[a.area])
    for(const [kind,date]of [['day','2026-10-17'],['day','2026-10-18'],['day','2026-10-19'],['day','2026-10-20'],['week','2026-10-18'],['week','2026-10-19'],['month','2026-10-01'],['total',null]])await all(kind,date)
    const exported=await all(),row=exported.rows.find(r=>r.source==='flow')
    assert.equal(row.flow_date,'2026-10-20');assert.equal(row.timezone,'UTC');assert.equal(row.area_id,a.area)
    assert.equal(row.area_archived,true);assert.equal(row.task_status,'completed');assert.equal(row.task_title,work.title)
    assert.ok(row.task_deadline);assert.equal(row.description,'Oppgavebeskrivelse')
    const old=exported.rows.filter(r=>r.source==='legacy-study')
    assert.ok(old.every(r=>r.task_id===null&&r.task_title===null&&r.task_deadline===null));assert.match(old[0].description,/Norsk 🧭/)
    assert.ok(old.some(r=>r.area_id===null&&r.area_name==='Annet'))
    assert.equal(sum(exported.rows),10800000000n)
  })
  await t.test('legacy DST slices use canonical 04:00 bounds in UTC/Oslo/New York, never fixed 24-hour arithmetic',async()=>{
    for(const [zone,date,from,to,hours]of [
      ['UTC','2026-10-18','2026-10-18T04:00Z','2026-10-19T04:00Z',24],
      ['Europe/Oslo','2026-03-28','2026-03-28T03:00Z','2026-03-29T02:00Z',23],
      ['Europe/Oslo','2026-10-24','2026-10-24T02:00Z','2026-10-25T03:00Z',25],
      ['America/New_York','2026-03-07','2026-03-07T09:00Z','2026-03-08T08:00Z',23],
      ['America/New_York','2026-10-31','2026-10-31T08:00Z','2026-11-01T09:00Z',25],
    ]){
      await fixture();await legacy(new Date(Date.parse(from)-600000).toISOString(),new Date(Date.parse(to)+1200000).toISOString())
      const d=await all('day',date,zone);assert.equal(sum(d.rows),BigInt(hours)*3600000000n);assert.equal(d.rows.length,1)
      assert.equal(d.rows[0].timezone,zone);assert.equal(d.rows[0].flow_date,date)
      await all('week',date,zone);await all('month',date,zone)
      const total=await all('total',null,zone);assert.equal(total.rows.length,3)
      assert.equal(sum((await all('total',null,'UTC')).rows),sum(total.rows),'Lifetime duration is zone-independent')
    }
  })
  await t.test('03:59:59/04:00, midnight, month/year/leap-day and exact microseconds are split without rounding',async()=>{
    await fixture('2029-01-01T12:00Z')
    await legacy('2026-11-01T03:59:59Z','2026-11-01T04:00Z')
    await legacy('2027-01-01T03:50Z','2027-01-01T04:20Z')
    await legacy('2028-03-01T03:59:59.123456Z','2028-03-01T04:00:00.987654Z')
    assert.equal(sum((await all('month','2026-10-01')).rows),1000000n)
    assert.equal(sum((await all('month','2026-11-01')).rows),0n)
    assert.equal(sum((await all('month','2026-12-01')).rows),600000000n)
    assert.equal(sum((await all('month','2027-01-01')).rows),1200000000n)
    assert.equal(sum((await all('day','2028-02-29')).rows),876544n)
    assert.equal(sum((await all('day','2028-03-01')).rows),987654n)
    const total=await all();assert.ok(total.rows.some(r=>r.started_at.includes('123456')))
  })
  await t.test('frozen server reference tolerates running/pause/switch after export start; no future work leaks into later pages',async()=>{
    await fixture('2026-10-19T12:00Z');const d=await native('2026-10-19T10:00Z',null)
    const first=await start();assert.equal(sum(first.rows),7200000000n)
    await clock('2026-10-19T12:05Z')
    await result('select public.flow_work_activity($1,$2,1,null,null,null) as result',[d.id,d.seg])
    await clock('2026-10-19T12:10Z')
    await result('select public.flow_work_activity($1,null,1,$2,null,null) as result',[d.id,randomUUID()])
    const same=await page({job:first.job_id,after:0})
    assert.deepEqual(same.rows,first.rows);assert.equal(same.server_time,first.server_time)
    assert.equal(sum(same.rows),7200000000n)
  })
  await t.test('correction, deletion and changed metadata abort the job rather than mixing snapshots',async()=>{
    const a=await fixture();const id=await legacy('2026-10-18T08:00Z','2026-10-18T09:00Z',a.area)
    let job=await start();await db.query("update public.subjects set name='Endret' where id=$1",[a.area])
    await denied(page({job:job.job_id,after:0}),'40001')
    job=await start();await result("select public.flow_history_edit_legacy($1,$2,'Korrigert','2026-10-18T08:00Z','2026-10-18T08:30Z',$3::jsonb) as result",[id,a.area,JSON.stringify([{started_at:'2026-10-18T08:00Z',ended_at:'2026-10-18T08:30Z'}])])
    await denied(page({job:job.job_id,after:0}),'40001')
    job=await start();await result('select public.study_session_history_delete($1) as result',[id]);await denied(page({job:job.job_id,after:0}),'40001')
    assert.equal((await all()).rows.length,0)
  })
  await t.test('>1000 rows, both sources, splitting, timestamp ties and microseconds have stable complete pagination',async()=>{
    const a=await fixture()
    await db.exec(`insert into public.study_sessions(subject_id,description,started_at,ended_at)
      select '${a.area}','bulk','2026-01-01T04:00Z'::timestamptz+i*interval '1 minute','2026-01-01T04:00Z'::timestamptz+i*interval '1 minute'+interval '0.123456 seconds' from generate_series(0,1104) i;
      insert into public.study_session_segments(session_id,started_at,ended_at) select id,started_at,ended_at from public.study_sessions where user_id=auth.uid();`)
    await legacy('2026-01-01T03:59:59.123456Z','2026-01-01T04:00:00.987654Z')
    await legacy('2026-01-01T04:00Z','2026-01-01T04:00:00.123456Z')
    await native('2026-01-02T23:30Z','2026-01-03T01:00Z',a.area)
    const first=await start();assert.equal(first.rows.length,500);assert.equal(first.total_rows,1109)
    await db.exec("set timezone='America/New_York'")
    const second=await page(first.next_cursor,500)
    await db.exec("set timezone='Europe/Oslo'")
    const third=await page(second.next_cursor,500)
    await db.exec("set timezone='UTC'")
    const rows=[...first.rows,...second.rows,...third.rows];assert.equal(third.next_cursor,null)
    assert.deepEqual(rows.map(r=>r.ordinal),Array.from({length:1109},(_,i)=>i+1))
    assert.equal(new Set(rows.map(r=>r.source+':'+r.segment_id+':'+r.flow_date)).size,1109)
    assert.equal(rows.filter(r=>r.source==='flow').length,1)
    assert.equal(sum(rows),BigInt(Math.round(first.statistics.total*1000)))
  })
  await t.test('empty exports, invalid zones/periods/cursors, expiry/discard and immutable server manifest',async()=>{
    const a=await fixture('2026-10-19T12:00Z')
    for(const kind of ['day','week','month','total']){const empty=await all(kind,'2026-10-19');assert.deepEqual(empty.rows,[]);assert.equal(empty.next_cursor,null)}
    await denied(start('year'),'22023');await denied(start('day','2026-10-19','bad-zone'),'22023');await denied(start('total',null,null),'22023')
    const forged=await result(`insert into public.flow_export_jobs(id,user_id,display_timezone,requested_kind,reference_at,expires_at,fingerprint,total_rows,statistics)
      values($1,$2,'UTC','total','2999-01-01','3999-01-01','fake',999,'{"total":999}') returning to_jsonb(flow_export_jobs) as result`,[randomUUID(),randomUUID()])
    assert.equal(forged.user_id,a.id);assert.equal(Date.parse(forged.reference_at),Date.parse('2026-10-19T12:00Z'));assert.equal(forged.total_rows,0)
    await denied(db.query("update public.flow_export_jobs set reference_at='2999-01-01' where id=$1",[forged.id]),'42501')
    const job=await start();await denied(page({job:job.job_id,after:-1}),'22023');await denied(page({job:job.job_id,after:1}),'22023')
    await denied(page({job:job.job_id,after:0,cutoff:'2999-01-01'}),'22023');await denied(page({job:job.job_id,after:0},1001),'22023')
    await discard(job.job_id);await denied(page({job:job.job_id,after:0}),'42501')
    const expiring=await start();await clock('2026-10-19T12:31Z');await denied(page({job:expiring.job_id,after:0}),'42501')
    await start();assert.equal((await db.query('select count(*)::int as n from public.flow_export_jobs')).rows[0].n,1)
  })
  await t.test('two users and anon: manifests, cursors and all new public RPCs preserve RLS/invoker boundaries',async()=>{
    const a=await fixture();await legacy('2026-10-18T08:00Z','2026-10-18T09:00Z',a.area);const job=await start()
    const b=await fixture();assert.equal((await start()).total_rows,0)
    await denied(page({job:job.job_id,after:0}),'42501');await discard(job.job_id)
    assert.equal((await db.query('select * from public.flow_export_jobs where id=$1',[job.job_id])).rows.length,0)
    await user(a.id);assert.equal((await page({job:job.job_id,after:0})).total_rows,1)
    await db.exec('reset role')
    for(const sig of ['flow_export_start(text,date,text)','flow_export_rows(jsonb,integer)','flow_export_discard(uuid)']){
      const p=(await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure',['public.'+sig])).rows[0]
      assert.equal(p.prosecdef,false);assert.ok(p.proconfig.includes('search_path=""'))
      assert.equal((await db.query("select has_function_privilege('anon',$1,'EXECUTE') as ok",['public.'+sig])).rows[0].ok,false)
    }
    await db.exec('set role anon');await denied(start(),'42501');await denied(page({job:job.job_id,after:0}),'42501');await denied(discard(job.job_id),'42501')
    await denied(db.query('select * from public.flow_export_jobs'),'42501');await user(b.id)
  })
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('native corrections: canonical SQL, full expected state, recovery and two-owner RLS', async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;
    alter default privileges in schema public grant execute on functions to anon,authenticated;`)
  const dir = new URL('../migrations/', import.meta.url)
  for (const file of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, dir), 'utf8'))
  await db.exec(`create or replace function pg_catalog.clock_timestamp() returns timestamptz language sql volatile as $$ select current_setting('flow.test_now')::timestamptz $$;
    create or replace function pg_catalog.statement_timestamp() returns timestamptz language sql stable as $$ select current_setting('flow.test_now')::timestamptz $$;`)
  const clock = time => db.query("select set_config('flow.test_now',$1,false)", [time])
  async function user(id, role = 'authenticated') { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); await db.exec('set role ' + role) }
  async function fixture() {
    await db.exec('reset role'); const id = randomUUID(), area = randomUUID()
    await db.query('insert into auth.users values($1)', [id]); await user(id); await clock('2026-10-22T22:30Z')
    await db.query("insert into public.subjects(id,name) values($1,'Area')", [area]); return { id, area }
  }
  const result = async (sql, args = []) => (await db.query(sql, args)).rows[0].result
  const segment = id => result('select to_jsonb(s) as result from public.flow_work_segments s where id=$1', [id])
  async function native(from = '2026-10-21T18:00Z', to = '2026-10-21T22:00Z', area = null, task = null, extra = [], dayEnd = null) {
    const day = randomUUID(), id = randomUUID(); await db.exec('begin')
    try {
      await db.query("insert into public.flow_work_days(id,timezone,logical_date,boundary_at,cutoff_at,started_at) values($1,'UTC','2000-01-01','2000-01-01','2000-01-02',$2)", [day, from])
      await db.query('insert into public.flow_work_segments(id,work_day_id,started_at,ended_at,area_id,task_id) values($1,$2,$3,$4,$5,$6)', [id, day, from, to, area, task])
      for (const [a,b] of extra) await db.query('insert into public.flow_work_segments(work_day_id,started_at,ended_at) values($1,$2,$3)', [day, a, b])
      if (to) await db.query('update public.flow_work_days set ended_at=coalesce($2::timestamptz,cutoff_at) where id=$1', [day, dayEnd])
      await db.exec('commit'); return await segment(id)
    } catch (e) { await db.exec('rollback'); throw e }
  }
  const correct = (old, desired = {}, expected = {}) => {
    const next = { ...old, ...desired }, prev = { ...old, ...expected }
    return result('select public.flow_work_segment_correct($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result',
      [old.id, old.work_day_id, prev.started_at, prev.ended_at, prev.area_id, prev.task_id, next.started_at, next.ended_at, next.area_id, next.task_id])
  }
  const denied = (p, code) => assert.rejects(p, e => e.code === code)

  await t.test('execute is authenticated-only and function requires auth.uid; owner isolation does not reveal foreign periods', async () => {
    const a = await fixture(), row = await native()
    await user('', 'anon'); await denied(correct(row), '42501')
    await user(''); await denied(correct(row), '42501')
    await fixture(); await denied(correct(row), '42501')
    await user(a.id); assert.equal((await segment(row.id)).started_at, row.started_at)
    const fn = await db.query("select prosecdef,proconfig from pg_proc where oid='public.flow_work_segment_correct(uuid,uuid,timestamptz,timestamptz,uuid,uuid,timestamptz,timestamptz,uuid,uuid)'::regprocedure")
    assert.equal(fn.rows[0].prosecdef, false); assert.ok(fn.rows[0].proconfig.some(v => v.startsWith('search_path=')))
  })
  for (const fields of [
    { started_at: '2026-10-21T18:15Z' }, { ended_at: '2026-10-21T20:15Z' },
    { started_at: '2026-10-21T18:15Z', ended_at: '2026-10-21T20:15Z' },
  ]) await t.test('closed period edits ' + Object.keys(fields).join('/'), async () => {
    await fixture(); const row = await native(), before = await result('select to_jsonb(d) as result from public.flow_work_days d where id=$1', [row.work_day_id])
    const snapshot = await correct(row, fields), actual = snapshot.segments.find(s => s.id === row.id)
    for (const [key, value] of Object.entries(fields)) assert.equal(Date.parse(actual[key]), Date.parse(value))
    assert.deepEqual(snapshot.work_day, before); assert.equal(snapshot.segments.length, 1)
  })
  await t.test('open forgotten period closes at explicit historical end; day remains paused and resume is explicit', async () => {
    await fixture(); const row = await native('2026-10-22T18:00Z', null)
    const snapshot = await correct(row, { ended_at: '2026-10-22T20:15Z' })
    assert.equal(snapshot.work_day.ended_at, null); assert.equal(snapshot.segments.length, 1)
    assert.equal(Date.parse(snapshot.segments[0].ended_at), Date.parse('2026-10-22T20:15Z'))
    const current = await result("select public.flow_work_state('UTC') as result")
    assert.ok(current.current.segments.every(s => s.ended_at !== null))
    const total = await result("select public.flow_statistics('total') as result"); assert.equal(total.total, 135 * 60000)
  })
  await t.test('zero length neutralizes work without deleting; empty range inside another interval is valid', async () => {
    await fixture(); const row = await native('2026-10-21T18:00Z', '2026-10-21T19:00Z', null, null, [['2026-10-21T20:00Z', '2026-10-21T21:00Z']])
    const other = (await result('select public.flow_work_day_snapshot($1) as result', [row.work_day_id])).segments.find(s => s.id !== row.id)
    await correct(other, { started_at: '2026-10-21T18:30Z', ended_at: '2026-10-21T18:30Z' })
    assert.equal((await result("select public.flow_statistics('total') as result")).total, 3600000)
    assert.equal((await db.query('select count(*) from public.flow_work_segments where work_day_id=$1', [row.work_day_id])).rows[0].count, 2)
  })
  for (const [name, fields, code] of [
    ['future', { ended_at: '2026-10-22T23:00Z' }, '22008'],
    ['before day', { started_at: '2026-10-22T17:59Z', ended_at: '2026-10-22T20:00Z' }, '22023'],
    ['after cutoff', { ended_at: '2026-10-23T04:01Z' }, '22023'],
    ['at cutoff start', { started_at: '2026-10-23T04:00Z', ended_at: '2026-10-23T04:00Z' }, '22023'],
    ['negative', { ended_at: '2026-10-22T17:00Z' }, '22023'],
    ['infinite end', { ended_at: 'infinity' }, '22023'], ['infinite start', { started_at: '-infinity' }, '22023'],
    ['null start', { started_at: null }, '22023'], ['null end cannot reopen', { ended_at: null }, '22023'],
  ]) await t.test('rejects ' + name, async () => {
    await fixture(); const row = await native('2026-10-22T18:00Z', '2026-10-22T20:00Z')
    await denied(correct(row, fields), code); assert.deepEqual(await segment(row.id), row)
  })
  await t.test('native overlap is rejected by unchanged table guards; touching intervals remain valid', async () => {
    await fixture(); const row = await native('2026-10-21T18:00Z', '2026-10-21T19:00Z', null, null, [['2026-10-21T20:00Z', '2026-10-21T21:00Z']])
    await denied(correct(row, { ended_at: '2026-10-21T20:30Z' }), '23P01')
    await correct(row, { ended_at: '2026-10-21T20:00Z' })
  })
  await t.test('closed day end and original work-day identity cannot be bypassed', async () => {
    await fixture(); const row = await native('2026-10-21T18:00Z', '2026-10-21T22:00Z', null, null, [], '2026-10-21T22:00Z')
    await denied(correct(row, { ended_at: '2026-10-21T22:01Z' }), '22023')
    await denied(correct({ ...row, work_day_id: randomUUID() }, { ended_at: '2026-10-21T20:00Z' }), '42501')
    assert.deepEqual(await segment(row.id), row)
  })
  await t.test('new activity after observation cannot be paused by an old open expected state', async () => {
    await fixture(); const row = await native('2026-10-22T18:00Z', null), next = randomUUID()
    await result('select public.flow_work_activity($1,$2,1,$3,null,null) as result', [row.work_day_id, row.id, next])
    await denied(correct(row, { ended_at: '2026-10-22T20:15Z' }), '40001')
    assert.equal((await segment(next)).ended_at, null)
  })
  for (const field of ['started_at', 'ended_at', 'area_id', 'task_id']) await t.test('stale expected ' + field, async () => {
    await fixture(); const row = await native()
    const wrong = field.includes('_at') ? '2026-10-21T19:00Z' : randomUUID()
    await denied(correct(row, { ended_at: '2026-10-21T20:15Z' }, { [field]: wrong }), '40001')
    assert.deepEqual(await segment(row.id), row)
  })
  await t.test('cutoff reconciliation makes expected open state stale, fresh closed state can be corrected', async () => {
    await fixture(); const row = await native('2026-10-22T18:00Z', null); await clock('2026-10-23T08:00Z')
    await denied(correct(row, { ended_at: '2026-10-22T20:15Z' }), '40001')
    const closed = await result('select public.flow_work_day_snapshot($1) as result', [row.work_day_id])
    assert.equal(Date.parse(closed.segments[0].ended_at), Date.parse(closed.work_day.cutoff_at))
    const corrected = await correct(closed.segments[0], { ended_at: '2026-10-22T20:15Z' })
    assert.equal(corrected.work_day.ended_at, closed.work_day.ended_at)
    assert.equal((await result("select public.flow_statistics('total') as result")).total, 135 * 60000)
  })
  await t.test('same desired state acknowledges retry without rebasing; newer different state conflicts', async () => {
    await fixture(); const row = await native(), desired = { ended_at: '2026-10-21T20:15Z' }
    await correct(row, desired); const once = await segment(row.id)
    await correct(row, desired); assert.deepEqual(await segment(row.id), once)
    await correct(once, { ended_at: '2026-10-21T20:00Z' })
    await denied(correct(row, desired), '40001')
  })
  await t.test('time and attribution correct together; archived/completed and unchanged moved attribution survive', async () => {
    const a = await fixture(), task = await result("select public.flow_task_save($1,'Task','',$2,null) as result", [randomUUID(), a.area])
    const row = await native('2026-10-21T18:00Z', '2026-10-21T22:00Z')
    await db.query('update public.subjects set is_archived=true where id=$1', [a.area])
    await result("select public.flow_task_status($1,'completed',$2) as result", [task.id, task.updated_at])
    const updated = (await correct(row, { ended_at: '2026-10-21T20:15Z', area_id: a.area, task_id: task.id })).segments[0]
    assert.equal(updated.area_id, a.area); assert.equal(updated.task_id, task.id)
    await db.query('update public.flow_tasks set area_id=null where id=$1', [task.id])
    await correct(updated, { ended_at: '2026-10-21T20:00Z' })
    const wrongArea = randomUUID(); await db.query("insert into public.subjects(id,name) values($1,'Other')", [wrongArea])
    await denied(correct(await segment(row.id), { area_id: wrongArea }), '23503')
  })
  await t.test('statistics, task totals, history and new export read corrected canonical work; no other owner changes', async () => {
    const a = await fixture(), task = await result("select public.flow_task_save($1,'Task','',$2,null) as result", [randomUUID(), a.area])
    const row = await native('2026-10-21T18:00:00.123456Z', '2026-10-21T22:00:00.123456Z', a.area, task.id)
    const b = await fixture(), foreign = await native(); await user(a.id)
    const oldExport = await result("select public.flow_export_start('total',null,'UTC') as result")
    const desired = { ended_at: '2026-10-21T20:15:00.123456Z' }; await correct(row, desired)
    const stats = await result("select public.flow_statistics('total') as result")
    assert.equal(stats.total, 135 * 60000); assert.equal(stats.areas[0].work, stats.total)
    assert.equal((await result('select public.flow_task_time($1) as result', [task.id])).work_milliseconds, stats.total)
    const history = await result('select public.flow_history() as result'); assert.ok(history.rows[0].snapshot.segments[0].started_at.includes('.123456'))
    const exported = await result("select public.flow_export_start('total',null,'UTC') as result")
    assert.equal(BigInt(exported.rows[0].work_microseconds), 8100000000n)
    await denied(result('select public.flow_export_rows($1::jsonb,500) as result', [JSON.stringify({ job: oldExport.job_id, after: 0 })]), '40001')
    await user(b.id); assert.deepEqual(await segment(foreign.id), foreign)
  })
})

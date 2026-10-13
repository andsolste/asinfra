import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('native Flow workday: atomic cutover, stale tabs, server cutoff and ownership', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
  `)
  const dir = new URL('../migrations/', import.meta.url)
  for (const file of (await readdir(dir)).filter(x => x.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, dir), 'utf8'))
  // Deterministic SERVER clock only inside this disposable database, never in a
  // migration/API. Real PostgreSQL timezone/constraints/RLS/transactions still run.
  await db.exec(`create or replace function pg_catalog.clock_timestamp() returns timestamptz
    language sql volatile as $$ select current_setting('flow.test_now')::timestamptz $$`)
  const clock = time => db.query("select set_config('flow.test_now',$1,false)", [time])
  async function user(id) {
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id])
    await db.exec('set role authenticated')
  }
  async function fixture() {
    await db.exec('reset role')
    const id = randomUUID(), area = randomUUID()
    await db.query('insert into auth.users values($1)', [id])
    await user(id)
    await clock('2026-10-13T08:00:00Z')
    await db.query("insert into public.subjects(id,name,code) values($1,'ASInfra','ASI')", [area])
    return { id, area }
  }
  const result = async (sql, args = []) => (await db.query(sql, args)).rows[0].result
  const state = (zone = 'UTC') => result('select public.flow_work_state($1) as result', [zone])
  async function start(area = null, task = null, zone = 'UTC', token = {}) {
    const command = { day: token.day ?? randomUUID(), segment: token.segment ?? randomUUID(),
      boundary: token.boundary ?? (await state(zone)).next_boundary_at, zone, area, task }
    const snapshot = await result('select public.flow_work_day_start($1,$2,$3,$4,$5,$6) as result',
      [command.day, command.segment, zone, command.boundary, area, task])
    return { snapshot, command }
  }
  const replay = command => start(command.area, command.task, command.zone, command)
  const change = (snapshot, next, area = null, task = null, expected = undefined, count = undefined) => result(
    'select public.flow_work_activity($1,$2,$3,$4,$5,$6) as result',
    [snapshot.work_day.id, expected === undefined ? snapshot.segments.find(s => s.ended_at === null)?.id ?? null : expected,
      count ?? snapshot.segments.length, next, area, task])
  const legacy = (action, session, area = null, segment = null) => result(
    'select public.study_session_transition($1,$2,$3,\'Legacy work\',$4) as result', [action, session, area, segment])
  const denied = (promise, code) => assert.rejects(promise, error => !code || error.code === code)

  await t.test('login/read/invalid timezone create no day, marker or segment', async () => {
    await fixture()
    assert.equal((await state()).current, null)
    const bad = await state('not-a-zone')
    assert.equal(bad.next_boundary_at, null)
    assert.equal(bad.next_cutoff_at, null)
    for (const table of ['flow_work_days', 'flow_work_segments', 'flow_timer_cutovers']) {
      assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0)
    }
    await denied(db.query('insert into public.flow_timer_cutovers(user_id,activated_at) values(auth.uid(),now())'), '23514')
    await denied(start(null, null, 'not-a-zone', { boundary: '2026-10-13T04:00Z' }), '22023')
  })

  await t.test('running legacy cutover uses one boundary, preserves work and guards old tabs/direct writes', async () => {
    const { area } = await fixture(), session = randomUUID(), oldSegment = randomUUID()
    await legacy('start', session, area, oldSegment)
    assert.equal((await state()).legacy_active, true)
    await clock('2026-10-13T09:00:00Z')
    const begun = await start(area)
    assert.equal(begun.snapshot.segments[0].started_at, begun.snapshot.work_day.started_at)
    const old = await result('select public.study_session_snapshot($1) as result', [session])
    assert.equal(old.session.ended_at, begun.snapshot.work_day.started_at)
    assert.equal(old.segments[0].ended_at, begun.snapshot.work_day.started_at)
    assert.equal(Date.parse(old.segments[0].ended_at) - Date.parse(old.segments[0].started_at), 3600000)
    assert.equal((await state()).legacy_active, false)
    assert.deepEqual((await replay(begun.command)).snapshot.segments, begun.snapshot.segments)
    await denied(legacy('start', randomUUID(), area, randomUUID()), '23514')
    // Old resume on the now-finished ID is harmless, not new work.
    assert.equal((await legacy('resume', session, null, randomUUID())).session.ended_at, old.session.ended_at)
    await denied(db.query('update public.study_sessions set ended_at=null where id=$1', [session]), '23514')
    await denied(db.query('insert into public.study_session_segments(session_id,started_at) values($1,clock_timestamp())', [session]), '23514')
    assert.equal((await result('select public.study_session_history() as result'))[0].session.id, session)
    await denied(db.query('update public.study_session_segments set ended_at=$1 where id=$2', ['2026-10-13T10:00Z',oldSegment]), '23514')
    const nativeBefore = (await state()).current
    await result(`select public.study_session_history_edit($1,$2,'Corrected',$3,$4,$5::jsonb) as result`,
      [session, area, old.session.started_at, old.session.ended_at, JSON.stringify(old.segments.map(s => ({ started_at: s.started_at, ended_at: s.ended_at })))])
    await result('select public.study_session_history_delete($1) as result', [session])
    assert.deepEqual((await state()).current.segments, nativeBefore.segments)
    await denied(db.query('delete from public.flow_timer_cutovers'), '42501')
  })

  await t.test('paused legacy cutover never fills its gap; another unactivated user keeps legacy timer', async () => {
    const a = await fixture(), session = randomUUID(), segment = randomUUID()
    await legacy('start', session, a.area, segment)
    await clock('2026-10-13T08:10:00Z'); await legacy('pause', session, null, segment)
    await clock('2026-10-13T09:00:00Z'); await start()
    const old = await result('select public.study_session_snapshot($1) as result', [session])
    assert.equal(Date.parse(old.segments[0].ended_at) - Date.parse(old.segments[0].started_at), 600000)
    assert.equal(Date.parse(old.session.ended_at), Date.parse('2026-10-13T09:00Z'))
    const b = await fixture()
    assert.equal((await legacy('start', randomUUID(), b.area, randomUUID())).session.ended_at, null)
  })

  await t.test('direct standalone day cannot commit an empty day or permanent cutover marker', async () => {
    await fixture()
    await denied(db.query(`insert into public.flow_work_days(logical_date,timezone,boundary_at,cutoff_at,started_at)
      values('2026-10-13','UTC','2026-10-13T04:00Z','2026-10-14T04:00Z',clock_timestamp())`), '23514')
    assert.equal((await state()).current, null)
    assert.equal((await db.query('select * from public.flow_timer_cutovers')).rows.length, 0)
    assert.equal((await start()).snapshot.segments.length, 1)
  })

  await t.test('direct native periods cannot overlap previously closed legacy work', async () => {
    const { area } = await fixture(), session = randomUUID(), day = randomUUID()
    await db.query("insert into public.study_sessions(id,subject_id,started_at,ended_at) values($1,$2,'2026-10-13T06:00Z','2026-10-13T07:00Z')", [session,area])
    await db.query("insert into public.study_session_segments(session_id,started_at,ended_at) values($1,'2026-10-13T06:00Z','2026-10-13T07:00Z')", [session])
    await db.exec('begin')
    await db.query(`insert into public.flow_work_days(id,logical_date,timezone,boundary_at,cutoff_at,started_at)
      values($1,'2026-10-13','UTC','2026-10-13T04:00Z','2026-10-14T04:00Z','2026-10-13T06:30Z')`, [day])
    await denied(db.query(`insert into public.flow_work_segments(work_day_id,started_at,ended_at)
      values($1,'2026-10-13T06:30Z','2026-10-13T06:45Z')`, [day]), '23514')
    await db.exec('rollback')
    assert.equal((await state()).current, null)
    assert.equal((await start()).snapshot.segments.length, 1)
  })

  await t.test('invalid first activity rolls back day, cutover AND legacy close', async () => {
    const { area } = await fixture(), session = randomUUID(), segment = randomUUID()
    await legacy('start', session, area, segment)
    await db.query('update public.subjects set is_archived=true where id=$1', [area])
    await denied(start(area), '23503')
    assert.equal((await state()).legacy_active, true)
    assert.equal((await state()).current, null)
    assert.equal((await db.query('select * from public.flow_timer_cutovers')).rows.length, 0)
    assert.equal((await result('select public.study_session_snapshot() as result')).segments[0].ended_at, null)
    await denied(db.query(`insert into public.flow_work_days(logical_date,timezone,boundary_at,cutoff_at,started_at)
      values('2026-10-13','UTC','2026-10-13T04:00Z','2026-10-14T04:00Z',clock_timestamp())`), '23514')
  })

  await t.test('Annet, area-only, task+area and task-without-area; archive/completion and ownership', async () => {
    const a = await fixture()
    const task = randomUUID(), loose = randomUUID()
    await db.query("insert into public.flow_tasks(id,area_id,title) values($1,$2,'Task')", [task, a.area])
    await db.query("insert into public.flow_tasks(id,title) values($1,'Task without area')", [loose])
    let current = (await start()).snapshot
    assert.equal(current.segments[0].area_id, null)
    await clock('2026-10-13T08:01:00Z'); current = await change(current, randomUUID(), a.area)
    await clock('2026-10-13T08:02:00Z'); current = await change(current, randomUUID(), a.area, task)
    await clock('2026-10-13T08:03:00Z'); current = await change(current, randomUUID(), null, loose)
    assert.equal(current.segments.at(-1).task_id, loose)
    for (let i = 1; i < current.segments.length; i++) assert.equal(current.segments[i - 1].ended_at, current.segments[i].started_at)
    await denied(change(current, randomUUID(), a.area, loose), '23514')
    await db.query("update public.flow_tasks set status='completed',completed_at=now() where id=$1", [loose])
    // Task migration makes direct completion close current work atomically.
    current = (await state()).current
    await denied(change(current, randomUUID(), null, loose), '23514')
    await db.query('update public.subjects set is_archived=true where id=$1', [a.area])
    await denied(change(current, randomUUID(), a.area), '23503')
    assert.ok((await state()).current.segments.at(-1).ended_at, 'Completion pauses; rejected changes never restart work')
    const b = await fixture()
    await denied(start(a.area), '23503')
    await denied(start(null, loose), '23503')
    assert.equal((await db.query('select * from public.flow_timer_cutovers')).rows.length, 0)
    const own = (await start(b.area)).snapshot
    await user(a.id)
    await denied(change(own, randomUUID()), '22023')
    assert.equal((await db.query('select * from public.flow_timer_cutovers where user_id=$1', [b.id])).rows.length, 0)
    await denied(db.query('insert into public.flow_timer_cutovers(user_id,activated_at) values($1,now())', [b.id]), '42501')
  })

  await t.test('future-dated legacy history requires correction, not fabricated cutover time', async () => {
    const { area } = await fixture(), session = randomUUID()
    await db.query("insert into public.study_sessions(id,subject_id,started_at,ended_at) values($1,$2,'2026-10-13T08:00Z','2026-10-13T12:00Z')", [session,area])
    await db.query("insert into public.study_session_segments(session_id,started_at,ended_at) values($1,'2026-10-13T08:00Z','2026-10-13T12:00Z')", [session])
    await denied(start(), '22023')
    assert.equal((await state()).current, null)
    assert.equal((await db.query('select * from public.flow_timer_cutovers')).rows.length, 0)
  })

  await t.test('pause/resume/versioned stale tabs/retry UUIDs and stale idle starts', async () => {
    await fixture()
    const begun = await start(), initial = begun.snapshot
    await clock('2026-10-13T08:10:00Z'); const paused = await change(initial, null)
    assert.equal(Date.parse(paused.segments[0].ended_at), Date.parse('2026-10-13T08:10:00Z'))
    await clock('2026-10-13T08:20:00Z'); const next = randomUUID(), resumed = await change(paused, next)
    assert.equal(resumed.work_day.id, initial.work_day.id)
    assert.equal(resumed.segments.length, 2)
    assert.deepEqual((await change(paused, next)).segments, resumed.segments)
    assert.deepEqual((await change(initial, null)).segments, resumed.segments, 'Stale pause cannot close another tab')
    await clock('2026-10-13T08:30:00Z'); const pausedAgain = await change(resumed, null)
    assert.deepEqual((await change(paused, randomUUID())).segments, pausedAgain.segments, 'Delayed resume across a newer pause cycle is stale')
    assert.deepEqual((await start()).snapshot.segments, pausedAgain.segments, 'Stale idle start cannot resume/switch an existing day')
    assert.deepEqual((await replay(begun.command)).snapshot.segments, pausedAgain.segments)
    assert.ok(pausedAgain.segments.every(s => s.ended_at !== null))
  })

  await t.test('before/exact/after 04:00: server recovery closes cutoff, never auto-starts next day', async () => {
    await fixture(); await clock('2026-10-14T03:59:59Z')
    const begun = await start(), old = begun.snapshot
    assert.equal(old.work_day.logical_date, '2026-10-13')
    await clock('2026-10-14T04:00:00Z')
    assert.equal((await state()).current, null)
    const finished = await result('select public.flow_work_day_snapshot($1) as result', [old.work_day.id])
    assert.equal(finished.segments[0].ended_at, finished.work_day.cutoff_at)
    assert.equal(finished.work_day.ended_at, finished.work_day.cutoff_at)
    assert.equal((await db.query('select * from public.flow_work_days')).rows.length, 1)
    await clock('2026-10-14T05:00:00Z')
    assert.equal((await state()).current, null)
    assert.equal((await replay(begun.command)).snapshot.work_day.id, old.work_day.id, 'Lost old start response cannot create tomorrow work')
    await denied(start(null, null, 'UTC', { boundary: begun.command.boundary }), '22023')
    const tomorrow = (await start()).snapshot
    assert.equal(tomorrow.work_day.logical_date, '2026-10-14')
    assert.equal(Date.parse(tomorrow.work_day.started_at), Date.parse('2026-10-14T05:00Z'))
    assert.equal((await replay(begun.command)).snapshot.work_day.id, tomorrow.work_day.id, 'Old replay must not hide current newer day')
  })

  await t.test('frozen IANA zone and server start across UTC/Oslo/New York DST 23/25-hour days', async () => {
    for (const [zone, at, hours] of [
      ['UTC', '2026-03-28T08:00Z', 24],
      ['Europe/Oslo', '2026-03-28T08:00Z', 23],
      ['Europe/Oslo', '2026-10-24T08:00Z', 25],
      ['America/New_York', '2026-03-07T12:00Z', 23],
      ['America/New_York', '2026-10-31T12:00Z', 25],
    ]) {
      await fixture(); await clock(at)
      const begun = (await start(null, null, zone)).snapshot
      assert.equal(begun.work_day.timezone, zone)
      assert.equal((Date.parse(begun.work_day.cutoff_at) - Date.parse(begun.work_day.boundary_at)) / 3600000, hours)
      assert.equal((await state('Pacific/Auckland')).current.work_day.timezone, zone)
      assert.equal((await state(null)).current.work_day.timezone, zone, 'Missing browser zone still recovers frozen active day')
      await clock(begun.work_day.cutoff_at)
      assert.equal((await state(zone)).current, null)
    }
  })

  await t.test('grants/RLS/invoker/search_path and permanent marker after native day admin deletion', async () => {
    const a = await fixture(), begun = await start()
    await db.exec('reset role')
    for (const sig of ['flow_work_state(text)', 'flow_work_day_start(uuid,uuid,text,timestamptz,uuid,uuid)', 'flow_work_activity(uuid,uuid,integer,uuid,uuid,uuid)']) {
      const row = (await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', ['public.' + sig])).rows[0]
      assert.equal(row.prosecdef, false); assert.ok(row.proconfig.includes('search_path=""'))
      assert.equal((await db.query("select has_function_privilege('anon',$1,'EXECUTE') as ok", ['public.' + sig])).rows[0].ok, false)
    }
    await db.query('delete from public.flow_work_days where id=$1', [begun.snapshot.work_day.id])
    await user(a.id)
    await denied(legacy('start', randomUUID(), a.area, randomUUID()), '23514')
    await db.exec('set role anon')
    await denied(state(), '42501')
    await denied(db.query('select * from public.flow_timer_cutovers'), '42501')
    await db.exec('reset role')
    await db.query('delete from auth.users where id=$1', [a.id])
    assert.equal((await db.query('select * from public.flow_timer_cutovers where user_id=$1', [a.id])).rows.length, 0)
  })
})

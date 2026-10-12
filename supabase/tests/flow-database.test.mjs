import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

// Real PostgreSQL/WASM, stubbed managed Auth only. Never connects to hosted Supabase.
test('Flow foundation: populated migration, compatibility, ownership, day bounds and atomic work', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const users = [randomUUID(), randomUUID()]
  const areas = [randomUUID(), randomUUID()]
  const days = [randomUUID(), randomUUID()]
  const tasks = [randomUUID(), randomUUID()]
  const legacySession = randomUUID(), legacySegment = randomUUID()
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
  for (const user of users) await db.query('insert into auth.users values($1)', [user])
  const directory = new URL('../migrations/', import.meta.url)
  const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()
  const migration = '20261012180000_create_flow_foundation.sql'
  for (const file of files.filter(file => file < migration)) await db.exec(await readFile(new URL(file, directory), 'utf8'))
  async function asUser(i) {
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [users[i]])
    await db.exec('set role authenticated')
  }
  const denied = (sql, params = [], code = '42501') => assert.rejects(db.query(sql, params), error => error.code === code)
  const result = async (sql, params = []) => (await db.query(sql, params)).rows[0].result
  const snapshot = (id = null) => result('select public.flow_work_day_snapshot($1) as result', [id])
  const change = (day, previous, next, area = null, task = null) => result(
    'select public.flow_work_segment_switch($1,$2,$3,$4,$5) as result', [day, previous, next, area, task])
  const bounds = async (at, zone) => (await db.query('select * from public.flow_day_bounds($1,$2)', [at, zone])).rows[0]
  async function day(id, at, zone = 'UTC', ended = null) {
    // Deliberately forged metadata: trigger must derive the real bounds from timestamp/zone.
    return (await db.query(`insert into public.flow_work_days(id,logical_date,timezone,boundary_at,cutoff_at,started_at,ended_at)
      values($1,'2000-01-01',$3,'2000-01-01','2000-01-02',$2,$4) returning *`, [id, at, zone, ended])).rows[0]
  }
  async function segment(id, workDay, from, to = null, area = null, task = null) {
    return db.query(`insert into public.flow_work_segments(id,work_day_id,started_at,ended_at,area_id,task_id)
      values($1,$2,$3,$4,$5,$6)`, [id, workDay, from, to, area, task])
  }
  const legacyTables = async () => {
    const rows = {}
    for (const table of ['subjects', 'study_sessions', 'study_session_segments']) {
      rows[table] = (await db.query(`select * from public.${table} order by id`)).rows
    }
    return rows
  }
  const legacyDefinitions = async () => (await db.query(`select proname, pg_get_functiondef(oid) as definition
    from pg_proc where pronamespace='public'::regnamespace and proname like 'study_%' order by proname`)).rows

  for (let i = 0; i < 2; i++) {
    await asUser(i)
    await db.query(`insert into public.subjects(id,name,code,is_archived,created_at)
      values($1,$2,'CODE', $3,'2025-09-01T12:00:00Z')`, [areas[i], 'Existing ' + i, i === 1])
  }
  await asUser(0)
  await db.query(`insert into public.study_sessions(id,subject_id,description,started_at,ended_at)
    values($1,$2,'Existing work','2026-10-01T22:00:00Z','2026-10-02T02:00:00Z')`, [legacySession, areas[0]])
  await db.query(`insert into public.study_session_segments(id,session_id,started_at,ended_at)
    values($1,$2,'2026-10-01T22:00:00Z','2026-10-01T23:00:00Z')`, [legacySegment, legacySession])
  const running = randomUUID(), runningSegment = randomUUID()
  await db.query("select public.study_session_transition('start',$1,$2,'Running before migration',$3)", [running, areas[0], runningSegment])
  await db.exec('reset role')
  const before = await legacyTables(), definitions = await legacyDefinitions()
  await db.exec(await readFile(new URL(migration, directory), 'utf8'))

  await t.test('populated backfill preserves every subject field and leaves all old work/RPCs untouched', async () => {
    assert.deepEqual(await legacyTables(), before)
    assert.deepEqual(await legacyDefinitions(), definitions)
    assert.deepEqual((await db.query('select * from public.flow_areas order by id')).rows, before.subjects)
    for (const table of ['flow_tasks', 'flow_work_days', 'flow_work_segments']) {
      assert.equal((await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n, 0, 'No fabricated work/day/timezone')
    }
    await asUser(0)
    const history = await result('select public.study_session_history() as result')
    assert.equal(history[0].session.id, legacySession)
    assert.equal(history[0].segments[0].id, legacySegment)
    await db.query("select public.study_session_transition('pause',$1,null,'',$2)", [running, runningSegment])
    assert.equal((await result('select public.study_session_snapshot() as result')).session.id, running)
    const resumed = randomUUID()
    await db.query("select public.study_session_transition('resume',$1,null,'',$2)", [running, resumed])
    await db.query("select public.study_session_transition('stop',$1)", [running])
    assert.equal(await result('select public.study_session_snapshot() as result'), null)
  })

  await t.test('old frontend creates/edits/archives subjects through the one-way bridge; delete retains native area', async () => {
    await asUser(0)
    const id = randomUUID()
    await db.query("insert into public.subjects(id,name) values($1,'New subject')", [id])
    await db.query("update public.subjects set name='Renamed',code='X',is_archived=true where id=$1", [id])
    assert.deepEqual((await db.query('select * from public.flow_areas where id=$1', [id])).rows,
      (await db.query('select * from public.subjects where id=$1', [id])).rows)
    await db.query('delete from public.subjects where id=$1', [id])
    assert.equal((await db.query('select is_archived from public.flow_areas where id=$1', [id])).rows[0].is_archived, true)
    const native = randomUUID()
    await db.query("insert into public.flow_areas(id,name) values($1,'Jobbsøking')", [native])
    assert.equal((await db.query('select * from public.subjects where id=$1', [native])).rows.length, 0)
    await denied("insert into public.flow_areas(name) values(' ')", [], '23514')
  })

  await t.test('04:00 half-open boundaries in UTC, Oslo and New York, including 23/25-hour DST days', async () => {
    for (const [zone, date, start, end, hours] of [
      ['UTC', '2026-10-12', '2026-10-12T04:00:00Z', '2026-10-13T04:00:00Z', 24],
      ['Europe/Oslo', '2026-03-28', '2026-03-28T03:00:00Z', '2026-03-29T02:00:00Z', 23],
      ['Europe/Oslo', '2026-10-24', '2026-10-24T02:00:00Z', '2026-10-25T03:00:00Z', 25],
      ['America/New_York', '2026-03-07', '2026-03-07T09:00:00Z', '2026-03-08T08:00:00Z', 23],
      ['America/New_York', '2026-10-31', '2026-10-31T08:00:00Z', '2026-11-01T09:00:00Z', 25],
    ]) {
      const row = await bounds(start, zone)
      assert.equal(row.logical_date.toISOString().slice(0, 10), date)
      assert.equal(row.boundary_at.getTime(), Date.parse(start))
      assert.equal(row.cutoff_at.getTime(), Date.parse(end))
      assert.equal((row.cutoff_at - row.boundary_at) / 3600000, hours)
      assert.notEqual((await bounds(new Date(Date.parse(start) - 1).toISOString(), zone)).logical_date.getTime(), row.logical_date.getTime())
      assert.equal((await bounds(new Date(Date.parse(start) + 1).toISOString(), zone)).logical_date.getTime(), row.logical_date.getTime())
      assert.equal((await bounds(new Date(Date.parse(end) - 1).toISOString(), zone)).logical_date.getTime(), row.logical_date.getTime())
      assert.notEqual((await bounds(end, zone)).logical_date.getTime(), row.logical_date.getTime())
    }
    assert.equal((await bounds('2026-10-13T01:30:00+02:00', 'Europe/Oslo')).logical_date.toISOString().slice(0, 10), '2026-10-12')
    for (const [at, zone] of [[null, 'UTC'], ['infinity', 'UTC'], ['2026-10-12', 'No/Such_Zone'], ['2026-10-12', '+02:00']]) {
      await assert.rejects(bounds(at, zone), error => error.code === '22023')
    }
    await assert.rejects(bounds('2011-12-29T20:00:00Z', 'Pacific/Apia'), error => error.code === '22023', 'Skipped local date is explicit, never silently normalized')
  })

  await t.test('task foundations: optional area/deadline, status constraints and owner-linked days/segments', async () => {
    for (let i = 0; i < 2; i++) {
      await asUser(i)
      await db.query('update public.flow_areas set is_archived=false where id=$1', [areas[i]])
      await db.query("insert into public.flow_tasks(id,area_id,title,deadline_at) values($1,$2,'Work item','2026-12-01T12:00:00Z')", [tasks[i], areas[i]])
      const row = await day(days[i], '2026-10-10T08:00:00Z', 'UTC', '2026-10-10T12:00:00Z')
      assert.equal(row.logical_date.toISOString().slice(0, 10), '2026-10-10')
      assert.equal(row.cutoff_at.toISOString(), '2026-10-11T04:00:00.000Z')
      await segment(randomUUID(), days[i], '2026-10-10T08:00:00Z', '2026-10-10T09:00:00Z', areas[i], tasks[i])
      await segment(randomUUID(), days[i], '2026-10-10T09:30:00Z', '2026-10-10T10:00:00Z')
      const rowWithoutArea = (await db.query("insert into public.flow_tasks(title) values('Uncategorized task') returning *")).rows[0]
      assert.equal(rowWithoutArea.area_id, null)
      assert.equal(rowWithoutArea.deadline_at, null)
      await segment(randomUUID(), days[i], '2026-10-10T10:00:00Z', '2026-10-10T10:30:00Z', null, rowWithoutArea.id)
      assert.equal((await db.query("select sum(extract(epoch from ended_at-started_at))::int as seconds from public.flow_work_segments")).rows[0].seconds, 7200, 'Pause gap excluded; null-area work included')
      await denied("update public.flow_tasks set status='completed' where id=$1", [tasks[i]], '23514')
      await db.query("update public.flow_tasks set status='completed',completed_at=now() where id=$1", [tasks[i]])
      await denied("insert into public.flow_tasks(title,deadline_at) values('Bad','infinity')", [], '23514')
      await denied("insert into public.flow_tasks(title) values(' ')", [], '23514')
    }
  })

  await t.test('two-user RLS on ALL native tables and same-owner composite FKs', async () => {
    for (let i = 0; i < 2; i++) {
      await asUser(i)
      const other = 1 - i
      for (const table of ['flow_areas', 'flow_tasks', 'flow_work_days', 'flow_work_segments']) {
        assert.ok((await db.query(`select * from public.${table}`)).rows.every(row => row.user_id === users[i]))
        assert.equal((await db.query(`select * from public.${table} where user_id=$1`, [users[other]])).rows.length, 0)
        assert.equal((await db.query(`update public.${table} set created_at=now() where user_id=$1 returning id`, [users[other]])).rows.length, 0)
        await denied(`update public.${table} set user_id=$1 where user_id=$2`, [users[other], users[i]])
        await denied(`delete from public.${table} where user_id=$1`, [users[i]])
      }
      await denied("insert into public.flow_areas(user_id,name) values($1,'Attack')", [users[other]])
      await denied("insert into public.flow_tasks(user_id,title) values($1,'Attack')", [users[other]])
      await denied("insert into public.flow_tasks(area_id,title) values($1,'Attack')", [areas[other]], '23503')
      await denied('update public.flow_tasks set area_id=$1 where id=$2', [areas[other], tasks[i]], '23503')
      await denied(`insert into public.flow_work_days(user_id,logical_date,timezone,boundary_at,cutoff_at,started_at)
        values($1,'2026-10-11','UTC','2026-10-11T04:00Z','2026-10-12T04:00Z','2026-10-11T08:00Z')`, [users[other]])
      await assert.rejects(segment(randomUUID(), days[other], '2026-10-10T11:00Z', '2026-10-10T11:30Z'), error => error.code === '23503')
      await assert.rejects(segment(randomUUID(), days[i], '2026-10-10T11:00Z', '2026-10-10T11:30Z', areas[other]), error => error.code === '23503')
      await assert.rejects(segment(randomUUID(), days[i], '2026-10-10T11:00Z', '2026-10-10T11:30Z', null, tasks[other]), error => error.code === '23503')
      await denied(`insert into public.flow_work_segments(user_id,work_day_id,started_at,ended_at)
        values($1,$2,'2026-10-10T11:00Z','2026-10-10T11:30Z')`, [users[other], days[other]])
      assert.equal(await snapshot(days[other]), null)
      await assert.rejects(change(days[other], null, randomUUID()), error => error.code === '22023')
    }
  })

  await t.test('closed history keeps attribution after task move/completion and area rename/archive', async () => {
    await asUser(0)
    const moved = randomUUID()
    await db.query("insert into public.flow_areas(id,name) values($1,'Another area')", [moved])
    const beforeSegments = (await db.query('select * from public.flow_work_segments where task_id=$1', [tasks[0]])).rows
    await db.query('update public.flow_tasks set area_id=$1 where id=$2', [moved, tasks[0]])
    await db.query("update public.flow_areas set name='New name',is_archived=true where id=$1", [areas[0]])
    assert.deepEqual((await db.query('select * from public.flow_work_segments where task_id=$1', [tasks[0]])).rows, beforeSegments)
    await db.query('update public.flow_work_segments set ended_at=ended_at where task_id=$1', [tasks[0]])
    await db.exec('reset role')
    await denied('delete from public.flow_tasks where id=$1', [tasks[0]], '23503')
    await denied('delete from public.flow_areas where id=$1', [areas[0]], '23503')
    await asUser(0)
    await assert.rejects(segment(randomUUID(), days[0], '2026-10-10T11:00Z', '2026-10-10T11:30Z', areas[0], tasks[0]), error => error.code === '23514')
  })

  await t.test('database rejects overlap, wrong ranges, forged boundaries and repeated logical days', async () => {
    await asUser(0)
    await assert.rejects(segment(randomUUID(), days[0], '2026-10-10T08:30Z', '2026-10-10T09:30Z'), error => error.code === '23514')
    await assert.rejects(segment(randomUUID(), days[0], '2026-10-10T07:59Z', '2026-10-10T08:00Z'), error => error.code === '23514')
    await assert.rejects(segment(randomUUID(), days[0], '2026-10-10T11:00Z', '2026-10-10T12:01Z'), error => error.code === '23514')
    await assert.rejects(segment(randomUUID(), days[0], '2026-10-10T11:30Z', '2026-10-10T11:00Z'), error => error.code === '23514')
    await assert.rejects(segment(randomUUID(), days[0], '2026-10-11T04:00Z', '2026-10-11T04:00Z'), error => error.code === '23514')
    await assert.rejects(day(randomUUID(), '2026-10-10T13:00Z'), error => error.code === '23505')
    for (const update of ["cutoff_at=cutoff_at+interval '1 day'", "timezone='Europe/Oslo'", 'ended_at=null']) {
      await denied(`update public.flow_work_days set ${update} where id=$1`, [days[0]], '23514')
    }
  })

  await t.test('server recovery closes only at cutoff, preserving finished work, gaps and the next day', async () => {
    await asUser(0)
    const expired = randomUUID(), open = randomUUID()
    const row = await day(expired, '2026-01-01T08:00Z')
    await segment(randomUUID(), expired, '2026-01-01T08:00Z', '2026-01-01T09:00Z')
    await segment(open, expired, '2026-01-01T10:00Z')
    const recovered = await snapshot(expired)
    assert.equal(Date.parse(recovered.work_day.ended_at), row.cutoff_at.getTime())
    assert.equal(Date.parse(recovered.segments.at(-1).ended_at), row.cutoff_at.getTime())
    assert.equal(Date.parse(recovered.segments[0].ended_at), Date.parse('2026-01-01T09:00Z'))
    assert.equal(await snapshot(), null)
    const later = await change(expired, open, randomUUID())
    assert.deepEqual(later.segments, recovered.segments, 'Stale request cannot reopen expired day')
    const paused = randomUUID()
    await day(paused, '2026-01-02T08:00Z')
    await segment(randomUUID(), paused, '2026-01-02T08:00Z', '2026-01-02T09:00Z')
    const recoveredPaused = await snapshot(paused)
    assert.equal(Date.parse(recoveredPaused.segments[0].ended_at), Date.parse('2026-01-02T09:00Z'), 'Paused gap never becomes work')
    assert.equal(Date.parse(recoveredPaused.work_day.ended_at), Date.parse('2026-01-03T04:00Z'))
  })

  await t.test('atomic switch/pause/resume: one open segment, retry token, stale actions and rollback', async () => {
    await asUser(0)
    const current = randomUUID(), first = randomUUID(), second = randomUUID()
    const now = (await db.query('select clock_timestamp() as result')).rows[0].result.toISOString()
    await day(current, now)
    await assert.rejects(day(randomUUID(), new Date(Date.parse(now) + 86400000).toISOString()), error => error.code === '23505')
    await segment(first, current, now)
    await assert.rejects(segment(randomUUID(), current, now), error => ['23505', '23514'].includes(error.code))
    const original = (await snapshot(current)).segments
    await assert.rejects(change(current, first, randomUUID(), areas[1]), error => error.code === '23503')
    await assert.rejects(change(current, first, randomUUID(), areas[0]), error => error.code === '23503', 'Archived area cannot start new work')
    const completedTaskArea = (await db.query('select area_id from public.flow_tasks where id=$1', [tasks[0]])).rows[0].area_id
    await assert.rejects(change(current, first, randomUUID(), completedTaskArea, tasks[0]), error => error.code === '23514', 'Completed task cannot start new work')
    assert.deepEqual((await snapshot(current)).segments, original, 'Failed open rolls back earlier close')
    await db.query('update public.flow_areas set is_archived=false where id=$1', [areas[0]])
    const activeTask = randomUUID()
    await db.query("insert into public.flow_tasks(id,area_id,title) values($1,$2,'Active task')", [activeTask, areas[0]])
    const switched = await change(current, first, second, areas[0], activeTask)
    assert.equal(switched.segments.length, 2)
    assert.equal(switched.segments[0].ended_at, switched.segments[1].started_at)
    assert.equal(switched.segments[1].area_id, areas[0])
    assert.equal(switched.segments[1].task_id, activeTask)
    await db.query('update public.flow_areas set is_archived=true where id=$1', [areas[0]])
    await db.query("update public.flow_tasks set status='completed',completed_at=now() where id=$1", [activeTask])
    assert.deepEqual((await change(current, first, second)).segments, switched.segments, 'Retry creates nothing')
    assert.deepEqual((await change(current, first, null)).segments, switched.segments, 'Delayed pause does not close new work')
    await denied('update public.flow_work_days set ended_at=clock_timestamp() where id=$1', [current], '23514')
    const paused = await change(current, second, null)
    assert.ok(paused.segments.every(row => row.ended_at !== null))
    const third = randomUUID()
    const resumed = await change(current, null, third)
    assert.equal(resumed.work_day.id, current)
    assert.equal(resumed.segments.length, 3)
    assert.equal(resumed.segments[2].area_id, null, 'Annet requires no area record')
    assert.equal(resumed.segments[2].task_id, null)
    assert.deepEqual((await change(current, null, third)).segments, resumed.segments)
    assert.deepEqual((await change(current, null, randomUUID())).segments, resumed.segments)
    await change(current, third, null)
    await denied('update public.flow_work_segments set ended_at=null where id=$1', [third], '23514')
    const oldToken = (await db.query('select id from public.flow_work_segments where work_day_id=$1 limit 1', [days[0]])).rows[0].id
    await assert.rejects(change(current, null, oldToken), error => error.code === '22023')
    assert.deepEqual((await change(current, null, third)).segments, (await snapshot(current)).segments, 'Closed retry token cannot resume work again')
  })

  await t.test('native grants, invoker/search_path, anonymous denial and user deletion cascade', async () => {
    await db.exec('reset role')
    for (const table of ['flow_areas', 'flow_tasks', 'flow_work_days', 'flow_work_segments']) {
      assert.equal((await db.query('select relrowsecurity from pg_class where oid=$1::regclass', ['public.' + table])).rows[0].relrowsecurity, true)
    }
    const signatures = ['flow_day_bounds(timestamptz,text)', 'flow_work_day_snapshot(uuid)', 'flow_work_segment_switch(uuid,uuid,uuid,uuid,uuid)']
    for (const signature of signatures) {
      const proc = (await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', ['public.' + signature])).rows[0]
      assert.equal(proc.prosecdef, false)
      assert.ok(proc.proconfig.includes('search_path=""'))
      for (const role of ['anon', 'authenticated']) assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, 'public.' + signature])).rows[0].allowed, role === 'authenticated')
      assert.equal((await db.query(`select count(*)::int as n from pg_proc p,
        lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'`, ['public.' + signature])).rows[0].n, 0)
    }
    for (const name of ['flow_sync_subject', 'flow_guard_work_day', 'flow_guard_work_segment']) {
      assert.equal((await db.query("select has_function_privilege('authenticated',$1,'EXECUTE') as allowed", ['public.' + name + '()'])).rows[0].allowed, false)
    }
    await db.exec('set role anon')
    for (const table of ['flow_areas', 'flow_tasks', 'flow_work_days', 'flow_work_segments']) await denied(`select * from public.${table}`)
    await assert.rejects(snapshot(), error => error.code === '42501')
    await assert.rejects(change(days[0], null, randomUUID()), error => error.code === '42501')
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claim.sub', '', false)")
    await db.exec('set role authenticated')
    await assert.rejects(snapshot(), error => error.code === '42501')
    await assert.rejects(change(days[0], null, randomUUID()), error => error.code === '42501')
    await db.exec('reset role')
    for (const user of users) await db.query('delete from auth.users where id=$1', [user])
    for (const table of ['flow_areas', 'flow_tasks', 'flow_work_days', 'flow_work_segments']) assert.equal((await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n, 0)
  })
})

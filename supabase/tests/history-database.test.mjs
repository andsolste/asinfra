import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

// Apply canonical SQL to real PostgreSQL/WASM; only managed Auth is stubbed.
// No hosted writes, credentials, API keys or frontend code are involved.
test('finished history: interval overlap, atomic corrections/deletion and RLS', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const users = [randomUUID(), randomUUID(), randomUUID()]
  const subjects = [randomUUID(), randomUUID()]
  const archivedSubject = randomUUID()
  const active = [randomUUID(), randomUUID()]
  const activeSegments = [randomUUID(), randomUUID()]
  const start = '2026-10-05T00:00:00Z'
  const end = '2026-10-12T00:00:00Z'
  const segment = (started_at, ended_at) => ({ started_at, ended_at })
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
  for (const user of users) await db.query('insert into auth.users(id) values ($1)', [user])
  const migrations = new URL('../migrations/', import.meta.url)
  for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, migrations), 'utf8'))
  }
  async function asUser(i) {
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [users[i]])
    await db.exec('set role authenticated')
  }
  async function history(from = null, to = null, limit = 100, offset = 0) {
    return (await db.query('select public.study_session_history($1,$2,$3,$4) as result',
      [from, to, limit, offset])).rows[0].result
  }
  async function edit(session, correction) {
    return (await db.query('select public.study_session_history_edit($1,$2,$3,$4,$5,$6::jsonb) as result',
      [session, correction.subject, correction.description, correction.start, correction.end,
        JSON.stringify(correction.segments)])).rows[0].result
  }
  async function remove(session) {
    return (await db.query('select public.study_session_history_delete($1) as result', [session])).rows[0].result
  }
  async function state(session) {
    return {
      session: (await db.query('select * from public.study_sessions where id=$1', [session])).rows[0],
      segments: (await db.query('select * from public.study_session_segments where session_id=$1 order by started_at,id',
        [session])).rows,
    }
  }
  async function finished(subject, from, to, segments, description = 'Original work') {
    const id = randomUUID()
    await db.query('insert into public.study_sessions(id,subject_id,description,started_at,ended_at) values($1,$2,$3,$4,$5)',
      [id, subject, description, from, to])
    for (const item of segments) {
      await db.query('insert into public.study_session_segments(session_id,started_at,ended_at) values($1,$2,$3)',
        [id, item.started_at, item.ended_at])
    }
    return id
  }
  const crossingSegments = [
    segment('2026-10-04T23:50:00Z', '2026-10-05T00:20:00Z'),
    segment('2026-10-05T00:40:00Z', '2026-10-05T01:00:00Z'),
  ]
  const crossing = []
  for (let i = 0; i < 2; i++) {
    await asUser(i)
    await db.query('insert into public.subjects(id,name,code) values($1,$2,$3)',
      [subjects[i], 'Subject ' + i, 'CODE' + i])
    crossing[i] = await finished(subjects[i], crossingSegments[0].started_at,
      '2026-10-05T01:10:00Z', crossingSegments)
    await db.query("select public.study_session_transition('start',$1,$2,'Active',$3)",
      [active[i], subjects[i], activeSegments[i]])
  }
  await asUser(0)
  await db.query("insert into public.subjects(id,name,code,is_archived) values($1,'Archived','OLD',true)", [archivedSubject])
  const endsAtStart = await finished(subjects[0], '2026-10-04T23:30:00Z', start,
    [segment('2026-10-04T23:30:00Z', start)])
  const startsAtEnd = await finished(subjects[0], end, '2026-10-12T01:00:00Z',
    [segment(end, '2026-10-12T01:00:00Z')])
  const pausedOverBoundary = await finished(subjects[0], '2026-10-04T23:30:00Z', '2026-10-05T01:10:00Z', [
    segment('2026-10-04T23:30:00Z', '2026-10-04T23:50:00Z'),
    segment('2026-10-05T01:00:00Z', '2026-10-05T01:10:00Z'),
  ])
  const zero = await finished(subjects[0], '2026-10-05T12:00:00Z', '2026-10-05T12:00:00Z',
    [segment('2026-10-05T12:00:00Z', '2026-10-05T12:00:00Z')])
  const legacy = await finished(null, '2026-10-05T13:00:00Z', '2026-10-05T14:00:00Z', [])

  await t.test('own finished rows include the correct subject and all segments, not active/foreign rows', async () => {
    for (let i = 0; i < 2; i++) {
      await asUser(i)
      const rows = await history()
      assert.ok(rows.some(row => row.session.id === crossing[i]))
      assert.ok(rows.every(row => row.session.ended_at !== null))
      assert.ok(!rows.some(row => row.session.id === crossing[1 - i] || row.session.id === active[i]))
      const row = rows.find(row => row.session.id === crossing[i])
      assert.equal(row.session.subject_id, subjects[i])
      assert.equal(row.subject.id, subjects[i])
      assert.equal(row.subject.name, 'Subject ' + i)
      assert.equal(row.subject.code, 'CODE' + i)
      assert.equal(row.session.description, 'Original work')
      assert.equal(row.segments.length, 2)
      assert.ok(row.segments.every(item => item.session_id === crossing[i]))
      for (let j = 0; j < 2; j++) {
        assert.equal(Date.parse(row.segments[j].started_at), Date.parse(crossingSegments[j].started_at))
        assert.equal(Date.parse(row.segments[j].ended_at), Date.parse(crossingSegments[j].ended_at))
      }
    }
    await asUser(0)
    const row = (await history()).find(row => row.session.id === legacy)
    assert.equal(row.subject, null)
    assert.equal(row.session.subject_id, null)
    assert.deepEqual(row.segments, [])
    await asUser(2)
    assert.deepEqual(await history(), [])
    await asUser(0)
  })
  await t.test('half-open periods match actual work crossing the boundary, not pauses or session start', async () => {
    const rows = await history(start, '2026-10-05T00:30:00Z')
    assert.deepEqual(rows.map(row => row.session.id), [crossing[0]])
    assert.equal(rows[0].segments.length, 2, 'Include even segments outside the filter for client-side clipping')
    const week = await history(start, end)
    assert.deepEqual(new Set(week.map(row => row.session.id)), new Set([crossing[0], pausedOverBoundary]))
    for (const id of [endsAtStart, startsAtEnd, zero, legacy, active[0], crossing[1]]) {
      assert.ok(!week.some(row => row.session.id === id))
    }
    const offsetWeek = await history('2026-10-05T02:00:00+02:00', '2026-10-12T02:00:00+02:00')
    assert.deepEqual(offsetWeek, week, 'Offsets describe the same absolute interval')
    const clip = (segments, from, to) => segments.reduce((sum, item) =>
      sum + Math.max(0, Math.min(Date.parse(item.ended_at), Date.parse(to)) -
        Math.max(Date.parse(item.started_at), Date.parse(from))), 0) / 60000
    const row = week.find(row => row.session.id === crossing[0])
    assert.equal(clip(row.segments, start, end), 40)
    assert.equal(clip(row.segments, '2026-09-28T00:00:00Z', start), 10)
  })
  await t.test('bounded pagination has a stable tie-breaker and also applies to period results', async () => {
    const all = await history()
    const pages = []
    for (let offset = 0; offset < all.length; offset += 2) pages.push(...await history(null, null, 2, offset))
    assert.deepEqual(pages, all)
    assert.deepEqual(await history(null, null, 2, 1), all.slice(1, 3))
    assert.deepEqual(await history(null, null, 2, all.length), [])
    const week = await history(start, end)
    assert.deepEqual(await history(start, end, 1, 1), week.slice(1, 2))
    for (let i = 1; i < all.length; i++) {
      const previous = all[i - 1].session
      const current = all[i].session
      assert.ok(Date.parse(previous.started_at) >= Date.parse(current.started_at))
      if (Date.parse(previous.started_at) === Date.parse(current.started_at)) assert.ok(previous.id > current.id)
    }
  })
  await t.test('bad intervals and pagination fail instead of silently dropping the filter', async () => {
    for (const args of [
      [start, null], [null, end], [end, start], [start, start], ['-infinity', end], [start, 'infinity'],
      [null, null, 0], [null, null, 201], [null, null, null], [null, null, 1, -1], [null, null, 1, null],
    ]) await assert.rejects(history(...args), error => error.code === '22023')
  })

  const correction = {
    subject: archivedSubject,
    description: '  Corrected work  ',
    start: '2026-10-06T09:00:00Z',
    end: '2026-10-06T12:00:00Z',
    segments: [
      segment('2026-10-06T09:00:00Z', '2026-10-06T09:30:00Z'),
      segment('2026-10-06T09:45:00Z', '2026-10-06T10:45:00Z'),
    ],
  }
  await t.test('correction replaces segments atomically and accepts an archived own subject', async () => {
    const before = await state(crossing[0])
    const result = await edit(crossing[0], correction)
    assert.equal(result.session.id, crossing[0])
    assert.equal(result.session.description, 'Corrected work')
    assert.equal(result.session.subject_id, archivedSubject)
    assert.equal(result.subject.name, 'Archived')
    assert.equal(result.subject.code, 'OLD')
    assert.equal(result.subject.is_archived, true)
    assert.equal(Date.parse(result.session.started_at), Date.parse(correction.start))
    assert.equal(Date.parse(result.session.ended_at), Date.parse(correction.end))
    assert.equal(result.segments.length, 2)
    const after = await state(crossing[0])
    assert.equal(after.session.user_id, users[0])
    assert.equal(after.session.created_at.getTime(), before.session.created_at.getTime())
    for (let j = 0; j < 2; j++) {
      assert.equal(after.segments[j].user_id, users[0])
      assert.equal(after.segments[j].session_id, crossing[0])
      assert.equal(Date.parse(result.segments[j].started_at), Date.parse(correction.segments[j].started_at))
      assert.equal(Date.parse(result.segments[j].ended_at), Date.parse(correction.segments[j].ended_at))
      assert.ok(!before.segments.some(item => item.id === after.segments[j].id))
    }
    assert.equal((await history()).find(row => row.session.id === crossing[0]).subject.id, archivedSubject)
    await asUser(1)
    assert.equal((await state(crossing[1])).session.description, 'Original work')
    await asUser(0)
  })
  await t.test('invalid corrections leave session and original segments completely unchanged', async () => {
    const before = await state(crossing[0])
    const invalid = [
      { subject: subjects[1] }, { subject: randomUUID() },
      { description: 'x'.repeat(501) }, { description: null },
      { start: null }, { end: null }, { start: correction.end, end: correction.start },
      { start: '-infinity' }, { end: 'infinity' },
      { segments: null }, { segments: {} }, { segments: [null] }, { segments: ['invalid'] },
      { segments: [segment(correction.start, null)] },
      { segments: [{ ended_at: correction.end }] },
      { segments: [segment('not a timestamp', correction.end)] },
      { segments: [segment(correction.start, 'infinity')] },
      { segments: [segment('2026-10-06T08:59:00Z', '2026-10-06T09:30:00Z')] },
      { segments: [segment(correction.start, '2026-10-06T12:01:00Z')] },
      { segments: [segment('2026-10-06T10:00:00Z', '2026-10-06T09:00:00Z')] },
      { segments: [
        segment('2026-10-06T09:00:00Z', '2026-10-06T10:00:00Z'),
        segment('2026-10-06T09:30:00Z', '2026-10-06T10:30:00Z'),
      ] },
      { segments: [...correction.segments].reverse() },
      ...['id', 'session_id', 'user_id'].map(key => ({
        segments: [{ ...correction.segments[0], [key]: randomUUID() }],
      })),
    ]
    for (const change of invalid) {
      await assert.rejects(edit(crossing[0], { ...correction, ...change }), 'Reject ' + JSON.stringify(change))
      assert.deepEqual(await state(crossing[0]), before, 'Failed edit must not change persisted data')
    }
  })
  await t.test('a database error during replacement rolls back both session update and deleted segments', async () => {
    const before = await state(crossing[0])
    await db.exec(`
      reset role;
      create function public.reject_history_test_segment() returns trigger language plpgsql as $$
        begin
          if new.started_at = '2026-10-06T09:45:00Z'::timestamptz then
            raise exception 'Injected insert failure' using errcode = '23514';
          end if;
          return new;
        end;
      $$;
      create trigger reject_history_test_segment before insert on public.study_session_segments
        for each row execute function public.reject_history_test_segment();
    `)
    try {
      await asUser(0)
      await assert.rejects(edit(crossing[0], { ...correction, description: 'Should roll back' }),
        error => error.code === '23514')
      assert.deepEqual(await state(crossing[0]), before)
    } finally {
      await db.exec('reset role; drop trigger reject_history_test_segment on public.study_session_segments; drop function public.reject_history_test_segment()')
      await asUser(0)
    }
  })
  await t.test('foreign or nonexistent sessions cannot be edited/deleted and foreign data is unchanged', async () => {
    await asUser(1)
    const before = await state(crossing[1])
    await asUser(0)
    for (const id of [crossing[1], randomUUID(), null]) {
      await assert.rejects(edit(id, correction), error => error.code === '22023' && error.message === 'Session not found')
      await assert.rejects(remove(id), error => error.code === '22023' && error.message === 'Session not found')
    }
    await asUser(1)
    assert.deepEqual(await state(crossing[1]), before)
    await asUser(0)
  })
  await t.test('running AND paused sessions must be stopped before history edit/delete', async () => {
    const before = await state(active[0])
    await assert.rejects(edit(active[0], correction), error => error.code === '22023')
    await assert.rejects(remove(active[0]), error => error.code === '22023')
    assert.deepEqual(await state(active[0]), before)
    await db.query("select public.study_session_transition('pause',$1,null,'',$2)", [active[0], activeSegments[0]])
    const paused = await state(active[0])
    await assert.rejects(edit(active[0], correction), error => error.code === '22023')
    await assert.rejects(remove(active[0]), error => error.code === '22023')
    assert.deepEqual(await state(active[0]), paused)
    assert.ok(!(await history()).some(row => row.session.id === active[0]))
    await db.query("select public.study_session_transition('stop',$1)", [active[0]])
    assert.equal((await edit(active[0], correction)).session.description, 'Corrected work')
  })
  await t.test('touching segments and zero duration are allowed; an empty array never invents work', async () => {
    const result = await edit(legacy, {
      ...correction, subject: null, start: correction.start, end: correction.start,
      segments: [segment(correction.start, correction.start), segment(correction.start, correction.start)],
    })
    assert.equal(result.subject, null)
    assert.equal(result.segments.length, 2)
    await edit(legacy, { ...correction, subject: null, segments: [
      segment(correction.start, '2026-10-06T10:00:00Z'),
      segment('2026-10-06T10:00:00Z', correction.end),
    ] })
    assert.equal((await edit(legacy, { ...correction, segments: [] })).segments.length, 0)
    assert.ok((await history()).some(row => row.session.id === legacy))
    assert.ok(!(await history(start, end)).some(row => row.session.id === legacy))
  })
  await t.test('deleting an own finished session cascades all its segments, preserving other sessions', async () => {
    const before = await state(crossing[0])
    assert.equal(before.segments.length, 2)
    const another = await state(pausedOverBoundary)
    assert.equal(await remove(crossing[0]), crossing[0])
    assert.equal((await state(crossing[0])).session, undefined)
    assert.deepEqual((await state(crossing[0])).segments, [])
    assert.deepEqual(await state(pausedOverBoundary), another)
    assert.ok(!(await history()).some(row => row.session.id === crossing[0]))
  })
  await t.test('RPCs are invoker-only with empty search_path and no public/anon execution', async () => {
    const signatures = [
      'public.study_session_history(timestamp with time zone,timestamp with time zone,integer,integer)',
      'public.study_session_history_edit(uuid,uuid,text,timestamp with time zone,timestamp with time zone,jsonb)',
      'public.study_session_history_delete(uuid)',
    ]
    for (const signature of signatures) {
      const proc = (await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', [signature])).rows[0]
      assert.equal(proc.prosecdef, false)
      assert.ok(proc.proconfig.includes('search_path=""'))
      for (const role of ['anon', 'authenticated']) {
        assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).rows[0].allowed,
          role === 'authenticated')
      }
      assert.equal((await db.query(`
        select count(*)::int as grants from pg_proc p,
          lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
        where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'
      `, [signature])).rows[0].grants, 0)
    }
    for (const table of ['subjects', 'study_sessions', 'study_session_segments']) {
      assert.equal((await db.query('select relrowsecurity from pg_class where oid=$1::regclass', ['public.' + table])).rows[0].relrowsecurity, true)
    }
    await db.exec('reset role; set role anon')
    for (const call of [() => history(), () => edit(legacy, correction), () => remove(legacy)]) {
      await assert.rejects(call(), error => error.code === '42501')
    }
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claim.sub', '', false)")
    await db.exec('set role authenticated')
    for (const call of [() => history(), () => edit(legacy, correction), () => remove(legacy)]) {
      await assert.rejects(call(), error => error.code === '42501' && error.message === 'Authentication required')
    }
  })
})

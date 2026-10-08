import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('session migration: atomic RPCs, retry IDs, constraints, grants and two-user RLS', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const users = [randomUUID(), randomUUID()]
  const subjects = [randomUUID(), randomUUID()]
  const sessions = [randomUUID(), randomUUID()]
  const segments = [randomUUID(), randomUUID()]
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
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
  const denied = (sql, params = [], code = '42501') => assert.rejects(db.query(sql, params), error => error.code === code)
  async function rpc(action, session, subject = null, description = '', segment = null) {
    return (await db.query('select public.study_session_transition($1,$2,$3,$4,$5) as result',
      [action, session, subject, description, segment])).rows[0].result
  }
  async function snapshot(session = null) {
    return (await db.query('select public.study_session_snapshot($1) as result', [session])).rows[0].result
  }
  for (let i = 0; i < 2; i++) {
    await asUser(i)
    assert.equal(await snapshot(), null)
    await db.query('insert into public.subjects(id,name) values ($1,$2)', [subjects[i], 'Own subject'])
    const started = await rpc('start', sessions[i], subjects[i], 'Work', segments[i])
    assert.equal(started.session.id, sessions[i])
    assert.equal(started.segments.length, 1)
    assert.equal(started.segments[0].ended_at, null)
    assert.equal(started.session.started_at, started.segments[0].started_at)
  }
  await t.test('segments: own CRUD and isolation cannot bypass composite owner FK', async () => {
    for (let i = 0; i < 2; i++) {
      await asUser(i)
      const other = 1 - i
      assert.equal((await db.query('select * from public.study_session_segments')).rows.length, 1)
      assert.equal((await db.query('select * from public.study_session_segments where user_id=$1', [users[other]])).rows.length, 0)
      assert.equal((await db.query('update public.study_session_segments set created_at=now() where id=$1 returning id', [segments[other]])).rows.length, 0)
      assert.equal((await db.query('delete from public.study_session_segments where id=$1 returning id', [segments[other]])).rows.length, 0)
      assert.equal(await snapshot(sessions[other]), null)
      await denied('insert into public.study_session_segments(session_id,user_id,started_at) values ($1,$2,now())', [sessions[other], users[other]])
      await denied('insert into public.study_session_segments(session_id,started_at,ended_at) values ($1,now(),now())', [sessions[other]], '23503')
      await denied('update public.study_session_segments set user_id=$1 where id=$2', [users[other], segments[i]])
      await denied('update public.study_session_segments set session_id=$1, ended_at=started_at where id=$2', [sessions[other], segments[i]], '23503')
      await assert.rejects(rpc('stop', sessions[other]))
      await denied('insert into public.study_sessions(started_at) values(now())', [], '23505')
      await denied('insert into public.study_session_segments(session_id,started_at) values ($1,now())', [sessions[i]], '23505')
      await denied("update public.study_session_segments set ended_at=started_at-interval '1 second' where id=$1", [segments[i]], '23514')
      await denied("update public.study_sessions set ended_at=started_at-interval '1 second' where id=$1", [sessions[i]], '23514')
      const extra = (await db.query('insert into public.study_session_segments(session_id,started_at,ended_at) values($1,now(),now()) returning id', [sessions[i]])).rows[0].id
      assert.equal((await db.query('update public.study_session_segments set created_at=now() where id=$1 returning id', [extra])).rows.length, 1)
      assert.equal((await db.query('delete from public.study_session_segments where id=$1 returning id', [extra])).rows.length, 1)
    }
  })
  await t.test('pause/resume/stop, recovery and delayed duplicate actions', async () => {
    await asUser(0)
    assert.equal((await rpc('start', sessions[0], subjects[0], 'Ignored retry', segments[0])).session.description, 'Work')
    await assert.rejects(rpc('start', randomUUID(), subjects[0], '', randomUUID()))
    assert.equal((await snapshot()).segments.length, 1)
    const paused = await rpc('pause', sessions[0], null, '', segments[0])
    assert.equal(paused.session.ended_at, null)
    assert.ok(paused.segments[0].ended_at)
    assert.equal((await rpc('pause', sessions[0], null, '', segments[0])).segments[0].ended_at, paused.segments[0].ended_at)
    assert.deepEqual((await snapshot()).segments, paused.segments)
    const second = randomUUID()
    const resumed = await rpc('resume', sessions[0], null, '', second)
    assert.equal(resumed.session.id, sessions[0])
    assert.equal(resumed.session.description, 'Work')
    assert.equal(resumed.segments.length, 2)
    assert.equal((await rpc('resume', sessions[0], null, '', second)).segments.length, 2)
    assert.equal((await rpc('resume', sessions[0], null, '', randomUUID())).segments.length, 2)
    assert.equal((await rpc('pause', sessions[0], null, '', segments[0])).segments[1].ended_at, null, 'Stale pause cannot close newer work')
    await rpc('pause', sessions[0], null, '', second)
    assert.equal((await rpc('resume', sessions[0], null, '', second)).segments.length, 2, 'Delayed retry cannot start work again')
    const third = randomUUID()
    await rpc('resume', sessions[0], null, '', third)
    const stopped = await rpc('stop', sessions[0])
    assert.ok(stopped.session.ended_at)
    assert.equal(stopped.segments.at(-1).ended_at, stopped.session.ended_at)
    assert.equal(await snapshot(), null)
    assert.deepEqual((await rpc('stop', sessions[0])).segments, stopped.segments)
    assert.deepEqual((await rpc('resume', sessions[0], null, '', randomUUID())).segments, stopped.segments)
    assert.equal((await rpc('start', sessions[0], subjects[0], '', randomUUID())).session.ended_at, stopped.session.ended_at)
    await asUser(1)
    const pausedB = await rpc('pause', sessions[1], null, '', segments[1])
    assert.equal((await snapshot()).segments[0].ended_at, pausedB.segments[0].ended_at)
    const stoppedB = await rpc('stop', sessions[1])
    assert.ok(stoppedB.session.ended_at)
    assert.equal(stoppedB.segments[0].ended_at, pausedB.segments[0].ended_at, 'Stop paused does not extend work')
  })
  await t.test('archived/foreign subject, invalid description and failed segment insert roll back start', async () => {
    await asUser(0)
    await db.query('update public.subjects set is_archived=true where id=$1', [subjects[0]])
    await assert.rejects(rpc('start', randomUUID(), subjects[0], '', randomUUID()))
    await assert.rejects(rpc('start', randomUUID(), subjects[1], '', randomUUID()))
    await db.query('update public.subjects set is_archived=false where id=$1', [subjects[0]])
    const session = randomUUID()
    await assert.rejects(rpc('start', session, subjects[0], 'x'.repeat(501), randomUUID()))
    assert.equal(await snapshot(session), null)
    await assert.rejects(rpc('start', session, subjects[0], '', segments[0]), error => error.code === '23505')
    assert.equal(await snapshot(session), null, 'Session INSERT rolled back when segment INSERT failed')
    assert.equal(await snapshot(), null)
    const started = await rpc('start', session, subjects[0], '', randomUUID())
    assert.equal(started.session.description, '')
    await rpc('stop', session)
  })
  await t.test('anon denied tables and RPCs; deleting user cascades segments', async () => {
    await db.exec('reset role; set role anon')
    for (const query of ['select * from public.study_session_segments', 'update public.study_session_segments set created_at=now()', 'delete from public.study_session_segments']) await denied(query)
    await denied('insert into public.study_session_segments(session_id,started_at) values($1,now())', [sessions[0]])
    await assert.rejects(snapshot(), error => error.code === '42501')
    await assert.rejects(rpc('stop', sessions[0]), error => error.code === '42501')
    await db.exec('reset role')
    for (const user of users) await db.query('delete from auth.users where id=$1', [user])
    assert.equal((await db.query('select * from public.study_session_segments')).rows.length, 0)
  })
})

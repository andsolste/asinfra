import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('weekly task planning: additive canonical schema, compatibility, revisions and RLS', async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;
    alter default privileges in schema public grant all on tables to anon,authenticated;
    alter default privileges in schema public grant execute on functions to anon,authenticated;`)
  const dir = new URL('../migrations/', import.meta.url), migration = '20261103120000_add_flow_task_week_planning.sql'
  for (const file of (await readdir(dir)).filter(n => n.endsWith('.sql') && n !== migration).sort()) await db.exec(await readFile(new URL(file, dir), 'utf8'))
  await db.exec(`create or replace function pg_catalog.clock_timestamp() returns timestamptz language sql volatile as $$ select current_setting('flow.test_now')::timestamptz $$`)
  const clock = time => db.query("select set_config('flow.test_now',$1,false)", [time])
  async function user(id, role = 'authenticated') {
    await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); await db.exec('set role ' + role)
  }
  async function fixture() {
    await db.exec('reset role'); const id = randomUUID()
    await db.query('insert into auth.users values($1)', [id]); await user(id); await clock('2026-11-03T12:00Z'); return id
  }
  const result = async (sql, args = []) => (await db.query(sql, args)).rows[0].result
  const oldSave = (id, expected = null, title = 'Task') => result('select public.flow_task_save($1,$2,\'\',null,null,$3) as result', [id, title, expected])
  const save = (id, week = null, priority = 'normal', expected = null, title = 'Task') => result(
    'select public.flow_task_save($1,$2,\'\',null,null,$3,$4,$5) as result', [id, title, expected, week, priority])
  const get = id => result('select to_jsonb(t) as result from public.flow_tasks t where id=$1', [id])
  const status = (task, value) => result('select public.flow_task_status($1,$2,$3) as result', [task.id, value, task.updated_at])
  const denied = (promise, code) => assert.rejects(promise, error => error.code === code)

  const owner = await fixture(), existing = await oldSave(randomUUID()), completed = await status(await oldSave(randomUUID()), 'completed')
  await db.exec('reset role'); await db.exec(await readFile(new URL(migration, dir), 'utf8')); await user(owner)

  await t.test('migration preserves every existing field, revision and status; defaults are unplanned/normal', async () => {
    for (const before of [existing, completed]) {
      const after = await get(before.id)
      assert.deepEqual(after, { ...before, week_start: null, priority: 'normal' })
    }
  })
  await t.test('ISO Monday dates across year boundaries, priority, clearing week and no automatic carry-over', async () => {
    const row = await save(randomUUID(), '2025-12-29', 'high')
    assert.equal(row.week_start, '2025-12-29'); assert.equal(row.priority, 'high')
    const iso = (await db.query("select extract(isoyear from week_start)::int as year,extract(week from week_start)::int as week from public.flow_tasks where id=$1", [row.id])).rows[0]
    assert.deepEqual(iso, { year: 2026, week: 1 })
    await clock('2027-01-04T12:00Z'); assert.equal((await get(row.id)).week_start, row.week_start)
    const moved = await save(row.id, '2027-01-04', 'low', row.updated_at)
    assert.notEqual(moved.updated_at, row.updated_at); assert.equal(moved.status, 'active')
    assert.equal((await save(row.id, null, 'normal', moved.updated_at)).week_start, null)
    await clock('2026-11-03T12:00Z')
  })
  await t.test('invalid planning rolls back the entire save including title, create and version', async () => {
    const row = await save(randomUUID(), '2026-11-02')
    for (const [week, priority, code] of [['2026-11-03', 'normal', '23514'], ['infinity', 'normal', '23514'], ['2026-11-02', 'urgent', '23514'], ['2026-11-02', null, '23502']]) {
      await denied(save(row.id, week, priority, row.updated_at, 'Must roll back'), code)
      assert.deepEqual(await get(row.id), row)
    }
    const id = randomUUID(); await denied(save(id, '2026-11-03'), '23514')
    assert.equal((await db.query('select id from public.flow_tasks where id=$1', [id])).rows.length, 0)
  })
  await t.test('one revision protects planning, ordinary edits and status across stale tabs; direct writes also version', async () => {
    const row = await save(randomUUID(), '2026-11-02'), moved = await save(row.id, '2026-11-09', 'high', row.updated_at)
    await denied(save(row.id, row.week_start, 'low', row.updated_at), '40001')
    await denied(oldSave(row.id, row.updated_at, 'Stale old client'), '40001')
    await denied(status(row, 'completed'), '40001')
    assert.deepEqual(await get(row.id), moved)
    const direct = await result("with changed as (update public.flow_tasks set priority='low',updated_at='2000-01-01' where id=$1 returning *) select to_jsonb(changed) as result from changed", [row.id])
    assert.ok(direct.updated_at > moved.updated_at)
    await denied(save(row.id, '2026-11-16', 'normal', moved.updated_at), '40001')
    const noOp = await save(direct.id, direct.week_start, direct.priority, direct.updated_at)
    assert.equal(noOp.updated_at, direct.updated_at)
  })
  await t.test('old save preserves planning, repeat create never rewrites newer metadata, named overload is unambiguous', async () => {
    const row = await save(randomUUID(), '2026-11-02', 'high')
    assert.deepEqual(await save(row.id, '2026-11-09', 'low'), row)
    const old = await oldSave(row.id, row.updated_at, 'Old client edit')
    assert.equal(old.week_start, row.week_start); assert.equal(old.priority, 'high')
    const named = await result("select public.flow_task_save(p_task_id=>$1,p_title=>'Named',p_description=>'',p_area_id=>null,p_deadline_at=>null) as result", [randomUUID()])
    assert.equal(named.week_start, null); assert.equal(named.priority, 'normal')
    const planned = await result("select public.flow_task_save(p_task_id=>$1,p_title=>'Named plan',p_description=>'',p_area_id=>null,p_deadline_at=>null,p_expected_updated_at=>null,p_week_start=>'2026-11-02',p_priority=>'high') as result", [randomUUID()])
    assert.equal(planned.week_start, '2026-11-02')
  })
  await t.test('planning never changes running work; existing completion pauses and reopening does not resume', async () => {
    await fixture(); const row = await save(randomUUID(), '2026-11-02')
    const state = () => result("select public.flow_work_state('UTC') as result")
    const snapshot = await result("select public.flow_work_day_start($1,$2,'UTC',$3,null,$4) as result", [randomUUID(), randomUUID(), (await state()).next_boundary_at, row.id])
    await clock('2026-11-03T12:15Z')
    const planned = await save(row.id, '2026-11-09', 'high', row.updated_at)
    assert.deepEqual((await state()).current.segments, snapshot.segments)
    const done = await status(planned, 'completed'), paused = (await state()).current
    assert.equal(paused.segments[0].ended_at, done.completed_at)
    assert.equal(done.week_start, '2026-11-09'); assert.equal(done.priority, 'high')
    const reopened = await status(done, 'active')
    assert.deepEqual((await state()).current.segments, paused.segments)
    assert.equal(reopened.week_start, done.week_start)
  })
  await t.test('authenticated-only invoker RPC, empty search_path and unchanged two-owner RLS', async () => {
    const a = await fixture(), row = await save(randomUUID(), '2026-11-02', 'high')
    await fixture()
    assert.equal((await db.query('select * from public.flow_tasks')).rows.length, 0)
    await denied(save(row.id, '2026-11-09', 'low', row.updated_at), '22023')
    await denied(save(row.id, '2026-11-09', 'low'), '23505')
    assert.equal((await db.query("update public.flow_tasks set week_start='2026-11-09' where id=$1 returning id", [row.id])).rows.length, 0)
    await user(a); assert.deepEqual(await get(row.id), row)
    await db.exec('reset role')
    const signature = 'public.flow_task_save(uuid,text,text,uuid,timestamptz,timestamptz,date,text)'
    const fn = (await db.query('select prosecdef,proconfig,pronargdefaults from pg_proc where oid=$1::regprocedure', [signature])).rows[0]
    assert.equal(fn.prosecdef, false); assert.ok(fn.proconfig.includes('search_path=""')); assert.equal(fn.pronargdefaults, 0)
    assert.equal((await db.query("select has_function_privilege('anon',$1,'EXECUTE') as ok", [signature])).rows[0].ok, false)
    await user('', 'anon'); await denied(save(randomUUID()), '42501')
    await user(''); await denied(save(randomUUID()), '42501')
  })
})

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

// Real PostgreSQL policies/FKs; only the Supabase-managed auth schema is stubbed.
// No network, real accounts, passwords or privileged API keys are used.
test('migration enforces grants, two-user RLS and same-owner subject links', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const users = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']
  const subjects = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002']
  const sessions = ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002']
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `)
  for (const id of users) await db.query('insert into auth.users(id) values ($1)', [id])
  const migrations = new URL('../migrations/', import.meta.url)
  for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, migrations), 'utf8'))
  }

  async function asUser(id) {
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id])
    await db.exec('set role authenticated')
    assert.equal((await db.query('select current_user as role')).rows[0].role, 'authenticated')
  }
  const denied = (sql, params = [], code = '42501') => assert.rejects(db.query(sql, params), error => error.code === code)

  for (let i = 0; i < 2; i++) {
    await asUser(users[i])
    await db.query('insert into public.subjects(id, name) values ($1, $2)', [subjects[i], `Test ${i}`])
    await db.query("insert into public.study_sessions(id, subject_id, started_at) values ($1, $2, now())", [sessions[i], subjects[i]])
  }

  for (let i = 0; i < 2; i++) {
    const other = 1 - i
    await t.test(`user ${i + 1}: own CRUD, isolation and foreign-key integrity`, async () => {
      await asUser(users[i])
      for (const table of ['subjects', 'study_sessions']) {
        const own = (await db.query(`select * from public.${table}`)).rows
        assert.equal(own.length, 1)
        assert.equal(own[0].user_id, users[i])
        assert.equal((await db.query(`select * from public.${table} where user_id=$1`, [users[other]])).rows.length, 0)
        assert.equal((await db.query(`update public.${table} set created_at=now() where user_id=$1 returning id`, [users[other]])).rows.length, 0)
        assert.equal((await db.query(`delete from public.${table} where user_id=$1 returning id`, [users[other]])).rows.length, 0)
        await denied(`update public.${table} set user_id=$1 returning id`, [users[other]])
      }
      await denied('insert into public.subjects(user_id,name) values ($1, $2)', [users[other], 'Impersonation'])
      await denied('insert into public.study_sessions(user_id,started_at) values ($1,now())', [users[other]])
      await denied('insert into public.study_sessions(subject_id,started_at,ended_at) values ($1,now(),now())', [subjects[other]], '23503')
      await denied('update public.study_sessions set subject_id=$1 where id=$2', [subjects[other], sessions[i]], '23503')
      const extra = (await db.query("insert into public.subjects(name) values ('CRUD') returning id")).rows[0].id
      assert.equal((await db.query("update public.subjects set name='Changed', code='CODE' where id=$1 returning id", [extra])).rows.length, 1)
      const entry = (await db.query('insert into public.study_sessions(subject_id,started_at,ended_at) values ($1,now(),now()) returning id', [extra])).rows[0].id
      for (const archived of [true, false]) {
        const updated = (await db.query('update public.subjects set is_archived=$1 where id=$2 returning *', [archived, extra])).rows[0]
        assert.equal(updated.id, extra)
        assert.equal(updated.is_archived, archived)
        assert.equal((await db.query('select subject_id from public.study_sessions where id=$1', [entry])).rows[0].subject_id, extra)
        assert.equal((await db.query('update public.subjects set is_archived=$1 where id=$2 returning id', [archived, subjects[other]])).rows.length, 0)
      }
      await denied("insert into public.subjects(name) values ('   ')", [], '23514')
      await denied("insert into public.subjects(name) values (repeat('x',121))", [], '23514')
      await denied("update public.subjects set code=repeat('x',33) where id=$1", [extra], '23514')
      assert.equal((await db.query("update public.study_sessions set description='Changed', ended_at=now() where id=$1 returning id", [entry])).rows.length, 1)
      assert.equal((await db.query('delete from public.study_sessions where id=$1 returning id', [entry])).rows.length, 1)
      assert.equal((await db.query('delete from public.subjects where id=$1 returning id', [extra])).rows.length, 1)
      await denied("insert into public.study_sessions(started_at,ended_at) values ('2026-10-07','2026-10-06')", [], '23514')
    })
  }
  await t.test('anon has no CRUD grants even when default grants existed', async () => {
    await db.exec('reset role; set role anon')
    for (const table of ['subjects', 'study_sessions']) {
      for (const sql of [`select * from public.${table}`, `update public.${table} set created_at=now()`, `delete from public.${table}`]) await denied(sql)
    }
    await denied("insert into public.subjects(name) values ('Anon')")
    await denied('insert into public.study_sessions(started_at) values (now())')
  })
  await t.test('subject deletion preserves sessions; user deletion cascades', async () => {
    await asUser(users[0])
    await db.query('delete from public.subjects where id=$1', [subjects[0]])
    const row = (await db.query('select * from public.study_sessions')).rows[0]
    assert.equal(row.subject_id, null)
    assert.equal(row.user_id, users[0])
    await db.exec('reset role')
    for (const id of users) await db.query('delete from auth.users where id=$1', [id])
    assert.equal((await db.query('select * from public.subjects')).rows.length, 0)
    assert.equal((await db.query('select * from public.study_sessions')).rows.length, 0)
  })
})

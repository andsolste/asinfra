// Run only after review/migration deploy, using two confirmed test accounts.
// Creates/deletes only UUID-tagged test rows. Never uses an elevated API key.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { readSupabaseConfig } from '../src/lib/config.ts'

if (process.env.RUN_STUDY_RLS_TESTS !== 'yes') throw new Error('Set RUN_STUDY_RLS_TESTS=yes to approve temporary test-row writes.')
const config = readSupabaseConfig(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY)
if (!config) throw new Error('A valid project URL and publishable browser key are required.')
const credentials = ['A', 'B'].map(label => ({
  email: process.env[`TEST_USER_${label}_EMAIL`], password: process.env[`TEST_USER_${label}_PASSWORD`],
}))
if (credentials.some(user => !user.email || !user.password)) throw new Error('Provide TEST_USER_A/B_EMAIL and TEST_USER_A/B_PASSWORD in the process environment, not in Git.')
const clients = credentials.map(() => createClient(config.url, config.key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}))
const ids = [0, 1].map(() => ({ subject: randomUUID(), session: randomUUID() }))
const cleanupIds = {
  subjects: ids.map(row => row.subject),
  study_sessions: ids.map(row => row.session),
}
const users = []
function ok(result, label) { assert.equal(result.error, null, label); return result.data }
async function blockedInsert(client, table, row, label) {
  const id = randomUUID()
  cleanupIds[table].push(id)
  assert.ok((await client.from(table).insert({ id, ...row })).error, label)
}
try {
  for (let i = 0; i < 2; i++) {
    const result = await clients[i].auth.signInWithPassword(credentials[i])
    if (result.error || !result.data.user) throw new Error(`Test user ${i + 1} could not sign in. Confirm email/password and email verification.`)
    users.push(result.data.user.id)
  }
  assert.notEqual(users[0], users[1], 'Two different users are required')
  for (let i = 0; i < 2; i++) {
    ok(await clients[i].from('subjects').insert({ id: ids[i].subject, name: `RLS test ${ids[i].subject}` }), 'Create own subject')
    ok(await clients[i].from('study_sessions').insert({ id: ids[i].session, subject_id: ids[i].subject, started_at: new Date().toISOString() }), 'Create own session')
  }
  for (let i = 0; i < 2; i++) {
    const client = clients[i]
    const other = 1 - i
    for (const [table, field] of [['subjects', 'subject'], ['study_sessions', 'session']]) {
      assert.equal(ok(await client.from(table).select('id').eq('id', ids[i][field]), 'Read own row').length, 1)
      assert.equal(ok(await client.from(table).select('id').eq('id', ids[other][field]), 'Other rows stay hidden').length, 0)
      const change = table === 'subjects' ? { name: 'RLS updated' } : { description: 'RLS updated' }
      assert.equal(ok(await client.from(table).update(change).eq('id', ids[i][field]).select('id'), 'Update own row').length, 1)
      assert.equal(ok(await client.from(table).update(change).eq('id', ids[other][field]).select('id'), 'Cannot update other row').length, 0)
      assert.equal(ok(await client.from(table).delete().eq('id', ids[other][field]).select('id'), 'Cannot delete other row').length, 0)
      assert.ok((await client.from(table).update({ user_id: users[other] }).eq('id', ids[i][field])).error, 'Cannot transfer ownership')
    }
    await blockedInsert(client, 'subjects', { user_id: users[other], name: 'Blocked' }, 'Cannot insert for another user')
    await blockedInsert(client, 'study_sessions', { user_id: users[other], started_at: new Date().toISOString() }, 'Cannot insert session for another user')
    await blockedInsert(client, 'study_sessions', { subject_id: ids[other].subject, started_at: new Date().toISOString() }, 'Cannot link other subject')
    assert.ok((await client.from('study_sessions').update({ subject_id: ids[other].subject }).eq('id', ids[i].session)).error, 'Cannot change link to other subject')
  }
  const anonymous = createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false } })
  assert.ok((await anonymous.from('subjects').select('id')).error, 'Anon has no SELECT grant')
  assert.ok((await anonymous.from('study_sessions').select('id')).error, 'Anon has no SELECT grant')
  for (let i = 0; i < 2; i++) {
    assert.equal(ok(await clients[i].from('study_sessions').delete().eq('id', ids[i].session).select('id'), 'Delete own session').length, 1)
    assert.equal(ok(await clients[i].from('subjects').delete().eq('id', ids[i].subject).select('id'), 'Delete own subject').length, 1)
  }
  console.log('OK: real Auth/JWT/Data API, own CRUD, A/B isolation, anon and same-owner links.')
} finally {
  for (let i = 0; i < 2; i++) {
    if (!users[i]) continue
    // Try both owners for every known test ID, even if a security assertion failed.
    for (const table of ['study_sessions', 'subjects']) {
      const result = await clients[i].from(table).delete().in('id', cleanupIds[table])
      if (result.error) console.error(`Cleanup failed for test ${table} rows ${cleanupIds[table].join(', ')}; remove them through their test accounts.`)
    }
    await clients[i].auth.signOut({ scope: 'local' })
  }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createSubjectApi, mapSubject, splitSubjects, validateSubject } from '../src/lib/subjects.ts'

const row = {
  id: '10000000-0000-4000-8000-000000000001', name: 'Operativsystemer', code: 'IDATT2202',
  is_archived: false, created_at: '2026-10-07T00:00:00Z',
}

test('subject input trims text, supports optional codes and follows PostgreSQL character limits', () => {
  assert.deepEqual(validateSubject({ name: ' Planlegging ', code: '  ' }), { name: 'Planlegging', code: null })
  assert.deepEqual(validateSubject({ name: ' OS ', code: ' IDATT2202 ' }), { name: 'OS', code: 'IDATT2202' })
  assert.throws(() => validateSubject({ name: ' \n\t ', code: '' }), /påkrevd/)
  assert.throws(() => validateSubject({ name: 'a'.repeat(121), code: '' }), /120/)
  assert.throws(() => validateSubject({ name: 'A', code: 'x'.repeat(33) }), /32/)
  assert.ok(validateSubject({ name: '😀'.repeat(120), code: '😀'.repeat(32) }))
})

test('row mapping excludes ownership; active and archived lists preserve IDs and order', () => {
  assert.deepEqual(mapSubject({ ...row, user_id: 'never exposed as an editable field' }), row)
  for (const value of [null, {}, { ...row, is_archived: 'false' }, { ...row, code: 2 }, { ...row, created_at: 'bad' }]) {
    assert.throws(() => mapSubject(value), /Ugyldige/)
  }
  const archived = { ...row, id: '10000000-0000-4000-8000-000000000002', is_archived: true }
  assert.deepEqual(splitSubjects([row, archived]), { active: [row], archived: [archived] })
  assert.deepEqual(splitSubjects([]), { active: [], archived: [] })
})

function fixture(response, status = 200) {
  const calls = []
  const client = createClient('https://example.test', 'sb_publishable_TEST_ONLY', {
    accessToken: async () => 'TEST_SESSION_TOKEN',
    global: { fetch: async (input, init) => {
      calls.push({ url: new URL(input.toString()), method: init.method, body: init.body ? JSON.parse(init.body) : null,
        headers: new Headers(init.headers), signal: init.signal })
      return new Response(JSON.stringify(response), { status, headers: { 'Content-Type': 'application/json' } })
    } },
  })
  return { api: createSubjectApi(client), calls }
}

test('list/create/edit/archive/reactivate use SDK operations, session header, exact IDs and server rows', async () => {
  const controller = new AbortController()
  const listing = fixture([row])
  assert.deepEqual(await listing.api.list(controller.signal), [row])
  assert.equal(listing.calls[0].method, 'GET')
  assert.equal(listing.calls[0].url.searchParams.get('order'), 'created_at.asc,id.asc')
  const creating = fixture(row)
  assert.deepEqual(await creating.api.create({ name: ' OS ', code: ' IDATT2202 ' }, controller.signal), row)
  assert.equal(creating.calls[0].method, 'POST')
  assert.deepEqual(creating.calls[0].body, { name: 'OS', code: 'IDATT2202' })
  const editing = fixture({ ...row, name: 'Server-confirmed name', code: null })
  assert.equal((await editing.api.edit(row.id, { name: 'Updated', code: '' }, controller.signal)).name, 'Server-confirmed name')
  assert.deepEqual(editing.calls[0].body, { name: 'Updated', code: null })
  for (const archived of [true, false]) {
    const archiving = fixture({ ...row, is_archived: archived })
    const result = await archiving.api.setArchived(row.id, archived, controller.signal)
    assert.equal(result.id, row.id)
    assert.equal(result.is_archived, archived)
    assert.deepEqual(archiving.calls[0].body, { is_archived: archived })
    assert.equal(archiving.calls[0].method, 'PATCH')
    assert.equal(archiving.calls[0].url.searchParams.get('id'), `eq.${row.id}`)
  }
  for (const call of [...listing.calls, ...creating.calls, ...editing.calls]) {
    assert.equal(call.url.pathname, '/rest/v1/subjects')
    assert.equal(call.headers.get('Authorization'), 'Bearer TEST_SESSION_TOKEN')
    assert.equal(call.signal, controller.signal)
    assert.equal(call.url.searchParams.get('select'), 'id,name,code,is_archived,created_at')
    assert.ok(!call.body || !('user_id' in call.body))
  }
  assert.equal(editing.calls[0].method, 'PATCH')
  assert.equal(editing.calls[0].url.searchParams.get('id'), `eq.${row.id}`)
})

test('invalid inputs do not reach the network; server/network/empty-row failures stay understandable', async () => {
  const controller = new AbortController()
  const invalid = fixture(row)
  await assert.rejects(invalid.api.create({ name: ' ', code: '' }, controller.signal), /påkrevd/)
  assert.equal(invalid.calls.length, 0)
  const failing = fixture({ message: 'PRIVATE SQL DETAILS', code: '42501' }, 403)
  for (const operation of [
    () => failing.api.list(controller.signal),
    () => failing.api.create({ name: 'Valid', code: '' }, controller.signal),
    () => failing.api.edit(row.id, { name: 'Valid', code: '' }, controller.signal),
    () => failing.api.setArchived(row.id, true, controller.signal),
    () => failing.api.setArchived(row.id, false, controller.signal),
  ]) {
    await assert.rejects(operation(), error => /Kunne ikke/.test(error.message) && !/PRIVATE|42501/.test(error.message))
  }
  await assert.rejects(fixture(null).api.edit(row.id, { name: 'A', code: '' }, controller.signal), /Kunne ikke lagre/)
  const offline = createClient('https://example.test', 'sb_publishable_TEST_ONLY', {
    global: { fetch: async () => { throw new Error('NETWORK TECHNICAL DETAILS') } },
    auth: { persistSession: false },
  })
  await assert.rejects(createSubjectApi(offline).list(controller.signal), /Kunne ikke hente fagene dine/)
})

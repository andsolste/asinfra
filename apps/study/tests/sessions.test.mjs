import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createSessionApi, mapSessionSnapshot, sessionDurations, sessionStatus,
  formatDuration, validateSessionInput } from '../src/lib/study-sessions.ts'
import { createSessionStore } from '../src/lib/session-store.ts'

const sessionId = '10000000-0000-4000-8000-000000000001'
const subjectId = '20000000-0000-4000-8000-000000000001'
const segmentId = '30000000-0000-4000-8000-000000000001'
const subject = { id: subjectId, name: 'OS', code: 'IDATT2202', is_archived: false, created_at: '2026-10-07T00:00:00Z' }
const time = text => `2026-10-07T${text}:00Z`
const segment = (id, start, end) => ({ id, session_id: sessionId, started_at: time(start), ended_at: end ? time(end) : null })
function fixture(status = 'running') {
  return { session: { id: sessionId, subject_id: subjectId, description: 'M5-notater',
    started_at: time('10:15'), ended_at: status === 'finished' ? time('12:20') : null },
  subject, server_time: time('12:20'),
  segments: [segment(segmentId, '10:15', '10:47'),
    segment('30000000-0000-4000-8000-000000000002', '11:03', '11:42'),
    segment('30000000-0000-4000-8000-000000000003', '11:55', status === 'running' ? null : '12:20')] }
}
const command = { action: 'start', sessionId, subjectId, segmentId, description: 'M5-notater' }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('duration sums raw segments, pauses, running/paused/finished, sleep and timezones', () => {
  const finished = mapSessionSnapshot(fixture('finished'))
  assert.equal(sessionStatus(finished), 'finished')
  assert.deepEqual(sessionDurations(finished), { work: 96 * 60000, elapsed: 125 * 60000, pause: 29 * 60000 })
  assert.equal(formatDuration(sessionDurations(finished).work), '01:36:00')
  const running = mapSessionSnapshot(fixture())
  assert.equal(sessionStatus(running), 'running')
  assert.equal(sessionDurations(running, Date.parse(time('12:30'))).work, 106 * 60000)
  assert.equal(sessionDurations(running, Date.parse(time('15:30'))).work, 286 * 60000, 'Sleep needs no interval ticks')
  const paused = mapSessionSnapshot(fixture('paused'))
  assert.equal(sessionStatus(paused), 'paused')
  assert.equal(sessionDurations(paused, Date.parse(time('13:20'))).work, 96 * 60000)
  assert.equal(sessionDurations(paused, Date.parse(time('13:20'))).pause, 89 * 60000)
  const zoned = fixture('finished')
  zoned.session.started_at = '2026-10-07T12:15:00+02:00'
  assert.deepEqual(sessionDurations(mapSessionSnapshot(zoned)), sessionDurations(finished))
  assert.equal(formatDuration(100 * 3600000), '100:00:00')
  assert.equal(formatDuration(-10), '00:00:00')
})

test('mapping rejects corrupt timestamps, ownership links, overlap and multiple open segments', () => {
  assert.equal(mapSessionSnapshot(null), null)
  for (const change of [
    value => { value.session.started_at = '2026-10-07T10:15:00' },
    value => { value.segments[1].session_id = subjectId },
    value => { value.segments[0].ended_at = null },
    value => { value.segments[1].started_at = time('10:40') },
    value => { value.segments[1].ended_at = time('10:40') },
    value => { value.subject.id = segmentId },
    value => { value.session.ended_at = time('12:00') },
    value => { value.segments[1].id = segmentId },
    value => { value.session.description = 12 },
  ]) {
    const value = structuredClone(fixture())
    change(value)
    assert.throws(() => mapSessionSnapshot(value))
  }
  const legacy = fixture('paused')
  legacy.subject = null; legacy.session.subject_id = null; legacy.segments = []
  assert.equal(sessionStatus(mapSessionSnapshot(legacy)), 'paused', 'Do not invent work periods for older rows')
})

test('only active subjects, optional trimmed description and codepoint length', () => {
  assert.equal(validateSessionInput(subjectId, '  ', [subject]), '')
  assert.equal(validateSessionInput(subjectId, ' Notes ', [subject]), 'Notes')
  assert.throws(() => validateSessionInput(subjectId, '', [{ ...subject, is_archived: true }]))
  assert.throws(() => validateSessionInput(segmentId, '', [subject]))
  assert.throws(() => validateSessionInput(subjectId, 'x'.repeat(501), [subject]))
  assert.equal(Array.from(validateSessionInput(subjectId, '😀'.repeat(500), [subject])).length, 500)
})

test('SDK RPCs carry only action/input IDs, no owner or client time; failures do not leak raw errors', async () => {
  let fail = false
  const requests = []
  const client = createClient('http://localhost:9999', 'sb_publishable_TEST_ONLY', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) })
      return new Response(JSON.stringify(fail ? { message: 'private SQL detail', code: '23505' } : fixture()),
        { status: fail ? 400 : 200, headers: { 'Content-Type': 'application/json' } })
    } },
  })
  const api = createSessionApi(client), signal = new AbortController().signal
  assert.equal((await api.load(signal)).session.id, sessionId)
  assert.deepEqual(requests[0].body, { p_session_id: null })
  for (const action of ['start', 'pause', 'resume', 'stop']) {
    assert.equal((await api.transition({ ...command, action }, signal)).session.id, sessionId)
    assert.deepEqual(requests.at(-1).body, { p_action: action, p_session_id: sessionId,
      p_subject_id: subjectId, p_description: 'M5-notater', p_segment_id: segmentId })
    assert.ok(requests.at(-1).url.endsWith('/rpc/study_session_transition'))
  }
  fail = true
  await assert.rejects(api.load(signal), { message: 'Kunne ikke hente økten.' })
  await assert.rejects(api.transition(command, signal), { message: 'Kunne ikke lagre økten.' })
})

test('store recovers running/paused sessions and guards double actions until server confirms', async () => {
  let server = null, resolveTransition, calls = 0
  const api = { load: async () => server,
    transition: async () => { calls++; return new Promise(resolve => { resolveTransition = resolve }) } }
  const store = createSessionStore(api)
  store.connect(); await tick()
  assert.equal(store.getSnapshot().loaded, true)
  const starting = store.dispatch(command)
  await store.dispatch({ ...command, sessionId: subjectId })
  assert.equal(calls, 1)
  assert.equal(store.getSnapshot().current, null, 'No optimistic timer')
  server = fixture(); resolveTransition(server); await starting
  assert.equal(sessionStatus(store.getSnapshot().current), 'running')
  store.disconnect()
  const recovered = createSessionStore(api)
  recovered.connect(); await tick()
  assert.equal(recovered.getSnapshot().current.session.id, sessionId)
  server = fixture('paused'); await recovered.refresh()
  assert.equal(sessionStatus(recovered.getSnapshot().current), 'paused')
  recovered.disconnect()
})

test('store keeps previous confirmed state on failed pause/resume/stop and retries exact UUIDs', async () => {
  for (const action of ['start', 'pause', 'resume', 'stop']) {
    let server = action === 'start' ? null : fixture(action === 'resume' ? 'paused' : 'running')
    let fails = true
    const calls = []
    const store = createSessionStore({
      load: async () => server,
      transition: async value => {
        calls.push(value)
        if (fails) throw new Error('Offline')
        server = fixture(action === 'stop' ? 'finished' : action === 'pause' ? 'paused' : 'running')
        return server
      },
    })
    store.connect(); await tick()
    const previous = store.getSnapshot().current
    await store.dispatch({ ...command, action })
    assert.equal(store.getSnapshot().current, previous)
    assert.ok(store.getSnapshot().error.includes('Prøv igjen'))
    await store.dispatch(command)
    assert.equal(calls.length, 1, 'Cannot overwrite uncertain action')
    fails = false; await store.retry()
    assert.deepEqual(calls[0], calls[1])
    assert.equal(store.getSnapshot().pending, null)
    assert.equal(store.getSnapshot().error, null)
    if (action === 'stop') {
      assert.equal(store.getSnapshot().current, null)
      assert.equal(sessionStatus(store.getSnapshot().saved), 'finished')
    }
    store.disconnect()
  }
})

test('uncertain committed Stop is reconciled; disconnected or stale requests never replace new user data', async () => {
  let server = fixture(), reads = 0
  const store = createSessionStore({
    load: async (_signal, id) => { reads++; return id ? fixture('finished') : server },
    transition: async () => { server = null; throw new Error('Lost reply after commit') },
  })
  store.connect(); await tick()
  await store.dispatch({ action: 'stop', sessionId })
  assert.ok(store.getSnapshot().current)
  await store.refresh()
  assert.equal(store.getSnapshot().current, null)
  assert.equal(sessionStatus(store.getSnapshot().saved), 'finished')
  assert.equal(store.getSnapshot().pending, null)
  assert.equal(reads, 3)
  store.disconnect()
  let reply
  const old = createSessionStore({ load: () => new Promise(resolve => { reply = resolve }), transition: async () => fixture() })
  old.connect(); old.disconnect(); reply(fixture()); await tick()
  assert.equal(old.getSnapshot().current, null)
  await old.dispatch(command)
  assert.equal(old.getSnapshot().pending, null)
})

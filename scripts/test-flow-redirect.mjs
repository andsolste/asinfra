import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const html = await readFile(new URL('../study/index.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]

test('the actual /study/ script redirects once, directly to Flow, retaining query/hash', () => {
  assert.ok(script, 'Missing legacy redirect script')
  for (const input of [
    'https://asinfra.no/study/',
    'https://asinfra.no/study/?foo=bar#section',
    'https://asinfra.no/study/index.html?code=TEST_ONLY#access_token=TEST_ONLY&type=signup',
    'http://localhost:8000/study/?next=https%3A%2F%2Fevil.example%2F#test',
  ]) {
    const location = new URL(input)
    const calls = []
    const expected = new URL('https://flow.asinfra.no/')
    expected.search = location.search
    expected.hash = location.hash
    runInNewContext(script, { URL, window: { location: {
      search: location.search, hash: location.hash, replace: url => calls.push(url),
    } } })
    assert.deepEqual(calls, [expected.href])
    assert.notEqual(calls[0], input, 'Must not redirect to itself')
  }
  assert.match(html, /rel="canonical" href="https:\/\/flow\.asinfra\.no\/"/)
  assert.match(html, /http-equiv="refresh" content="0; url=https:\/\/flow\.asinfra\.no\/"/)
  assert.match(html, /Åpne Flow/)
  assert.doesNotMatch(html, /https:\/\/study\.asinfra\.no\//)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { readSupabaseConfig } from '../src/lib/config.ts'
import { authErrorMessage } from '../src/lib/auth-errors.ts'

test('configuration requires an HTTP(S) project URL and only a publishable browser key', () => {
  assert.equal(readSupabaseConfig(), null)
  for (const url of ['not a URL', 'ftp://example.test', 'http://example.test', 'https://user:pass@example.test', 'https://example.test/#token']) {
    assert.equal(readSupabaseConfig(url, 'sb_publishable_test'), null)
  }
  assert.equal(readSupabaseConfig('https://example.test', 'sb_secret_TEST_NOT_A_KEY'), null)
  assert.equal(readSupabaseConfig('https://example.test', 'not-a-browser-key'), null)
  assert.deepEqual(readSupabaseConfig('https://example.test', 'sb_publishable_test'), { url: 'https://example.test', key: 'sb_publishable_test' })
  assert.ok(readSupabaseConfig('http://localhost:54321', 'sb_publishable_test'))
})

test('auth errors are curated, not untrusted technical server messages', () => {
  assert.match(authErrorMessage('invalid_credentials'), /E-post eller passord/)
  assert.match(authErrorMessage('email_not_confirmed'), /Bekreft/)
  assert.match(authErrorMessage('over_request_rate_limit'), /Vent/)
  assert.match(authErrorMessage('untrusted raw message', true), /Registreringen/)
  assert.doesNotMatch(authErrorMessage('untrusted raw message'), /untrusted/)
})

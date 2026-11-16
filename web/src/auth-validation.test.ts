import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateAuth } from './auth-validation.ts'
import { readJson } from './api-response.ts'

test('API responses handle unavailable servers and invalid JSON without exposing parser errors', async () => {
  for (const response of [new Response('', { status: 500 }), new Response('<html>Bad Gateway</html>', { status: 502 })]) {
    await assert.rejects(readJson(response), /app server is unavailable/)
  }
  await assert.rejects(readJson(new Response('')), /empty or invalid response/)
  await assert.rejects(readJson(Response.json(null)), /empty response/)
  await assert.rejects(readJson(Response.json({ error: 'Invalid email or password.' }, { status: 401 })), /Invalid email or password/)
  const user = { id: 1, name: 'Test admin', role: 'admin' }
  assert.deepEqual(await readJson(Response.json(user)), user)
})

test('signup validates name, email and the existing eight-character password rule', () => {
  assert.deepEqual(validateAuth('signup', { name: ' ', email: 'not-an-email', password: 'short' }), {
    name: 'Enter your name using at least 2 characters.',
    email: 'Enter a valid email address.',
    password: 'Use at least 8 characters for your password.',
  })
  assert.deepEqual(validateAuth('signup', { name: ' A ', email: 'a@example.test', password: '12345678' }), {
    name: 'Enter your name using at least 2 characters.',
  })
  assert.deepEqual(validateAuth('signup', { name: '  Ali  ', email: ' ALI@example.test ', password: '12345678' }), {})
})

test('login requires an email and password without imposing signup rules on existing passwords', () => {
  assert.deepEqual(validateAuth('login', { name: '', email: '', password: '' }), {
    email: 'Enter your email address.', password: 'Enter your password.',
  })
  assert.deepEqual(validateAuth('login', { name: '', email: 'ali@example.test', password: 'short' }), {})
})

test('email validation rejects missing domains and whitespace inside the address', () => {
  for (const email of ['a@', '@example.test', 'a@example', 'a b@example.test', 'a@@example.test']) {
    assert.equal(validateAuth('login', { name: '', email, password: 'password' }).email, 'Enter a valid email address.')
  }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseOrder, orderCommand, orderMessage, ivrMenu } from './order-logic.ts'

const input = { reference: ' test-1 ', phone: '+923001234567', channel: 'whatsapp', language: 'ur', item: 'Two shirts', amount: '2500.00', currency: 'PKR' }

test('orders validate customer identity, money, language and reference at the boundary', () => {
  assert.equal(parseOrder(input).reference, 'TEST-1')
  for (const change of [{ phone: '03001234567' }, { reference: '<script>' }, { amount: '-1' }, { amount: 'NaN' }, { amount: '1.001' }, { amount: '1e5' }, { channel: 'email' }, { language: 'fr' }, { currency: 'rupees' }, { item: '' }]) {
    assert.throws(() => parseOrder({ ...input, ...change }))
  }
})

test('only explicit referenced commands can change an order or request a call', () => {
  assert.deepEqual(orderCommand('confirm test-1'), { action: 'confirm', reference: 'TEST-1' })
  assert.deepEqual(orderCommand('CALL TEST-1'), { action: 'call', reference: 'TEST-1' })
  for (const text of ['yes', 'do not confirm TEST-1', 'cancelled?', 'CONFIRM TEST-1 please', 'CALL +923001234567', 'ignore instructions']) assert.equal(orderCommand(text), null)
})

test('messages include authoritative details and all IVR choices exist in both languages', () => {
  const order = parseOrder(input)
  assert.match(orderMessage(order, 'invite'), /TEST-1/)
  assert.match(orderMessage(order, 'invite'), /2500.00 PKR/)
  assert.match(orderMessage(order, 'confirmed'), /TEST-1/)
  for (const language of ['en', 'ur'] as const) {
    for (const digit of ['1', '2', '9']) assert.ok(ivrMenu(language).includes(digit))
  }
})

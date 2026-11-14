import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { validateAgentPlan, approvalReply, textAgent } from './text-agent.ts'

const orders = [{ reference: 'ORD-1', item: 'Shirt', amount: '500.00', currency: 'PKR', status: 'pending' }]
const plan = { action: 'details', reference: 'ORD-1', language: 'roman-ur', details: { name: 'Ali', address: null, notes: null } }

test('model output can only select authorized orders and quote customer supplied details', () => {
  assert.equal(validateAgentPlan(plan, 'Mera naam Ali hai', orders).details?.name, 'Ali')
  assert.throws(() => validateAgentPlan({ ...plan, reference: 'PRIVATE-2' }, 'Ali', orders))
  assert.throws(() => validateAgentPlan({ ...plan, details: { name: 'Invented', address: null, notes: null } }, 'Ali', orders))
  assert.throws(() => validateAgentPlan({ ...plan, phone: '+12025550199' }, 'Ali', orders))
  assert.throws(() => validateAgentPlan(plan, 'Ali', [...orders, { ...orders[0], reference: 'ORD-2' }]))
  assert.equal(validateAgentPlan(plan, 'ORD-1 naam Ali', [...orders, { ...orders[0], reference: 'ORD-2' }]).reference, 'ORD-1')
})

test('approval accepts an explicit English or Urdu answer, never a negated or embedded yes', () => {
  for (const body of ['yes', 'YES ORD-1', 'haan', 'جی ہاں ORD-1']) assert.equal(approvalReply(body)?.approved, true)
  for (const body of ['no', 'nahi ORD-1', 'نہیں']) assert.equal(approvalReply(body)?.approved, false)
  for (const body of ['yes but change price', 'do not say yes', 'yesterday', 'yes ORD-1 cancel']) assert.equal(approvalReply(body), null)
})

test('real LangChain graph invokes a scoped lookup tool and validates a Gemini tool response', async context => {
  const oldKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'fake-test-key'
  context.mock.timers.enable({ apis: ['setTimeout'] })
  context.mock.method(AbortSignal, 'timeout', (delay: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Test model deadline expired', 'TimeoutError')), delay)
    return controller.signal
  })
  let requests = 0
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    assert.match(String(url), /^https:\/\/generativelanguage.googleapis.com\//)
    const body = JSON.parse(String(init.body))
    const tools = body.tools.flatMap((tool: { functionDeclarations?: { name: string }[] }) => tool.functionDeclarations || [])
    const responseTool = tools.find((tool: { name: string }) => tool.name !== 'get_customer_order')
    assert.ok(responseTool)
    requests += 1
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 15000)
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason) }, { once: true })
    })
    const call = requests === 1 ? { name: 'get_customer_order', args: { reference: 'ORD-1' } } : { name: responseTool.name, args: { action: 'status', reference: 'ORD-1', language: 'en', details: null } }
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: call }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  try {
    const running = textAgent.plan({ id: 'test', phone: '+12025550100', body: 'What is my order?', channel: 'sms', received_at: new Date().toISOString() }, orders, [])
    await setImmediate()
    assert.equal(requests, 1)
    context.mock.timers.tick(15000)
    await setImmediate()
    assert.equal(requests, 2)
    context.mock.timers.tick(15000)
    const result = await running
    assert.equal(result.action, 'status')
    assert.equal(result.reference, 'ORD-1')
    assert.equal(requests, 2)
  } finally {
    context.mock.timers.reset()
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = oldKey
  }
})

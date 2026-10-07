import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup } from './helpers/paypal-fixture.mjs'

test('Redis toggle pauses payment operations without network requests or record changes', async () => {
  let redisCalls = 0
  const s = setup({ redisTransport: async () => { redisCalls++; throw new Error('must not connect') } })
  for (const disabled of [false, 'false', '', 'invalid']) {
    s.config.paypalRedisEnabled = disabled
    await assert.rejects(s.newOrder(), error => error.statusCode === 503 && /storage is disabled/.test(error.message))
    s.event.body = { proof: 'a'.repeat(64) }
    await assert.rejects(s.capture(s.event), { statusCode: 503 })
    await assert.rejects(s.verify(s.event), { statusCode: 503 })
  }
  assert.equal(redisCalls, 0)
  assert.equal(s.calls.length, 0)
  assert.equal(s.records.size, 0)
  s.config.paypalRedisEnabled = 'true'
  await assert.rejects(s.newOrder(), { statusCode: 503 })
  assert.equal(redisCalls, 1)
})

const completed = id => ({ id, status: 'COMPLETED', purchase_units: [{ reference_id: 'checkout-test-product', payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } }] } }] })

test('independent instances share attempt records, locks, and capture results in both environments', async () => {
  for (const environment of ['sandbox', 'live']) {
    const shared = { records: new Map(), locks: new Map(), calls: [], responses: [] }
    const a = setup(shared), b = setup(shared)
    a.config.paypalLiveTestEnabled = b.config.paypalLiveTestEnabled = true
    const order = await a.newOrder(environment)
    b.event.cookies = { ...a.event.cookies }
    b.event.body = { requestId: '12345678-1234-1234-1234-123456789012', environment, liveConfirmed: true }
    assert.equal((await b.create(b.event)).proof, order.proof)
    b.event.body = { proof: order.proof }
    shared.responses.push(completed(order.id), completed(order.id))
    await Promise.all([a.capture(a.event), b.capture(b.event)])
    assert.equal(shared.calls.filter(c => c.url.endsWith('/capture')).length, 1)
    assert.equal(shared.calls.filter(c => c.url.endsWith('/v2/checkout/orders')).length, 1)
    shared.responses.push(completed(order.id))
    assert.equal((await b.capture(b.event)).environment, environment)
  }
})

test('expired lock owner cannot write records or delete a replacement lock', async () => {
  const s = setup()
  await assert.rejects(s.globals.withPayPalLock(s.event, 'lease-test', async storage => {
    s.locks.set('{test}:locks:lease-test', { value: 'new-owner', expires: Date.now() + 60000 })
    await storage.setItem('attempts:stale', { stale: true })
  }), { statusCode: 409 })
  assert.equal(s.records.has('attempts:stale'), false)
  assert.equal(s.locks.get('{test}:locks:lease-test').value, 'new-owner')
})

test('storage configuration/outage errors are sanitized and prevent PayPal operations', async () => {
  const s = setup({ redisTransport: async () => { throw new Error('secret redis token upstream endpoint') } })
  await assert.rejects(s.newOrder(), error => error.statusCode === 503 && !error.message.includes('secret'))
  assert.equal(s.calls.length, 0)
  s.config.paypalRedisRestToken = ''
  await assert.rejects(s.newOrder(), { statusCode: 503 })
  assert.equal(s.calls.length, 0)
})

test('capture timeout on one instance reconciles on another without another POST', async () => {
  const shared = { records: new Map(), locks: new Map(), calls: [], responses: [] }
  const a = setup(shared), b = setup(shared)
  const order = await a.newOrder()
  shared.responses.push(new Error('lost response'))
  await assert.rejects(a.capture(a.event), { statusCode: 502 })
  b.event.cookies = { ...a.event.cookies }
  b.event.body = { proof: order.proof }
  shared.responses.push(completed(order.id))
  assert.equal((await b.capture(b.event)).status, 'COMPLETED')
  assert.equal(shared.calls.filter(c => c.url.endsWith('/capture')).length, 1)
  assert.equal(shared.calls.at(-1).options.method, 'GET')
})

test('failed capture-marker persistence prevents dispatching a capture', async () => {
  const s = setup()
  await s.newOrder()
  const raw = s.globals.$fetch.raw
  s.globals.$fetch.raw = async (url, options) => {
    if (url === 'https://redis.test/' && options.body[0] === 'EVAL' && options.body[1].includes("'SET'")
      && options.body.at(-1).includes('captureAttemptedAt')) throw new Error('private storage details')
    return raw(url, options)
  }
  await assert.rejects(s.capture(s.event), error => error.statusCode === 503 && !error.message.includes('private'))
  assert.equal(s.calls.filter(c => c.url.endsWith('/capture')).length, 0)
})

test('failed result persistence after capture reconciles without charging again', async () => {
  const shared = { records: new Map(), locks: new Map(), calls: [], responses: [] }
  const a = setup(shared), b = setup(shared)
  const order = await a.newOrder()
  const raw = a.globals.$fetch.raw
  a.globals.$fetch.raw = async (url, options) => {
    if (url === 'https://redis.test/' && options.body[0] === 'EVAL' && options.body[1].includes("'SET'")
      && options.body.at(-1).includes('"result"')) throw new Error('private storage details')
    return raw(url, options)
  }
  shared.responses.push(completed(order.id))
  await assert.rejects(a.capture(a.event), { statusCode: 503 })
  b.event.cookies = { ...a.event.cookies }
  b.event.body = { proof: order.proof }
  shared.responses.push(completed(order.id))
  assert.equal((await b.capture(b.event)).status, 'COMPLETED')
  assert.equal(shared.calls.filter(c => c.url.endsWith('/capture')).length, 1)
  assert.equal(shared.calls.at(-1).options.method, 'GET')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { setup } from './helpers/paypal-fixture.mjs'
function completed(id) {
  return { id, status: 'COMPLETED', purchase_units: [{ reference_id: 'checkout-test-product', payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } }] } }] }
}
const operations = s => s.calls.filter(call => !call.url.endsWith('/token'))

test('capture rejection shows a documented issue without leaking upstream details or retrying capture', async () => {
  const s = setup()
  await s.newOrder()
  s.responses.push(Object.assign(new Error('private'), { statusCode: 422, data: {
    details: [{ issue: 'INSTRUMENT_DECLINED', description: 'private card details' }], debug_id: 'f20578465a4a1'
  } }))
  await assert.rejects(s.capture(s.event), error => {
    assert.match(error.message, /INSTRUMENT_DECLINED/)
    assert.match(error.message, /f20578465a4a1/)
    assert.doesNotMatch(error.message, /private/)
    return true
  })
  s.responses.push(completed(s.event.id))
  await s.capture(s.event)
  assert.equal(operations(s).filter(call => call.url.endsWith('/capture')).length, 1)
})

test('another instance retains the sanitized rejection when status checks find no capture', async () => {
  const shared = { records: new Map(), locks: new Map(), calls: [], responses: [] }
  const a = setup(shared), b = setup(shared)
  const order = await a.newOrder()
  shared.responses.push(Object.assign(new Error('private error'), { statusCode: 422, data: {
    details: [{ issue: 'ORDER_NOT_APPROVED', description: 'private buyer details' }], debug_id: 'safe-reference'
  } }))
  await assert.rejects(a.capture(a.event), { statusCode: 502 })
  const record = shared.records.get(`captures:sandbox:${order.id}`)
  assert.deepEqual(JSON.parse(JSON.stringify(record.captureFailure)), { stage: 'capture', issue: 'ORDER_NOT_APPROVED', debugId: 'safe-reference' })
  assert.doesNotMatch(JSON.stringify(record), /private/)
  b.event.cookies = { ...a.event.cookies }
  b.event.body = { proof: order.proof }
  shared.responses.push({ id: order.id, status: 'APPROVED' })
  await assert.rejects(b.capture(b.event), error => {
    assert.match(error.message, /Order status: APPROVED; capture status: NONE_REPORTED/)
    assert.match(error.message, /ORDER_NOT_APPROVED/)
    assert.match(error.message, /safe-reference/)
    return true
  })
  assert.equal(shared.calls.filter(call => call.url.endsWith('/capture')).length, 1)
  assert.equal(shared.calls.at(-1).options.method, 'GET')
})

test('PayPal failures identify the stage and expose only a safe support reference', async () => {
  const s = setup()
  s.responses.push(Object.assign(new Error('private upstream data'), {
    statusCode: 422, data: { debug_id: 'abc123', message: 'buyer-private-data', details: [{ description: 'secret' }] }
  }))
  await assert.rejects(s.globals.paypalRequest(s.event, 'sandbox', '/v2/checkout/orders', {}), error => {
    assert.match(error.message, /sandbox order creation failed/)
    assert.match(error.message, /does not capture or charge/)
    assert.match(error.message, /abc123/)
    assert.doesNotMatch(error.message, /buyer-private|secret|private upstream/)
    return true
  })
  const auth = setup({ tokenError: Object.assign(new Error('private'), { statusCode: 401, data: { error: 'invalid_client' } }) })
  await assert.rejects(auth.globals.paypalRequest(auth.event, 'sandbox', '/v2/checkout/orders', {}), error => {
    assert.match(error.message, /authentication failed/)
    assert.match(error.message, /same PayPal app/)
    assert.match(error.message, /No payment request was sent/)
    return true
  })
})

test('default Sandbox config and public config expose no secrets', () => {
  const s = setup()
  const config = s.getConfig(s.event)
  assert.equal(config.environment, 'sandbox')
  assert.equal(config.clientId, 'sandbox-test-id')
  assert.deepEqual(Object.keys(config).sort(), ['clientId', 'environment'])
  assert.equal(s.calls.length, 0)
})

test('create fixes price, persists environment, and deduplicates concurrent/repeated attempts', async () => {
  const s = setup()
  const order = await s.newOrder()
  s.event.body = { requestId: '12345678-1234-1234-1234-123456789012' }
  const results = await Promise.all([s.create(s.event), s.create(s.event)])
  assert.ok(results.every(result => result.id === order.id && result.proof === order.proof))
  const posts = operations(s)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].options.body.purchase_units[0].amount.value, '1.00')
  assert.equal(posts[0].options.body.purchase_units[0].amount.currency_code, 'USD')
  assert.ok(posts[0].options.headers['PayPal-Request-Id'])
  assert.equal(s.records.get(`orders:${order.proof}`).environment, 'sandbox')
  assert.ok(s.calls.every(call => call.url.startsWith('https://api-m.sandbox.paypal.com/')))
})

test('Live requires server enablement and explicit confirmation; invalid environments fail closed', async () => {
  const s = setup()
  s.event.body = { environment: 'live', requestId: '12345678-1234-1234-1234-123456789012' }
  await assert.rejects(s.create(s.event), { statusCode: 403 })
  s.config.paypalLiveTestEnabled = true
  await assert.rejects(s.create(s.event), { statusCode: 400 })
  for (const environment of ['LIVE', '', 'production', null, ['sandbox']]) {
    s.event.body.environment = environment
    await assert.rejects(s.create(s.event), { statusCode: 400 })
  }
  assert.equal(s.calls.length, 0)
  await s.newOrder('live')
  assert.ok(s.calls.every(call => call.url.startsWith('https://api-m.paypal.com/')))
  assert.equal(s.calls[0].options.headers.Authorization, `Basic ${Buffer.from('live-test-id:live-test-secret').toString('base64')}`)
})

test('capture uses recorded environment, ignores browser environment, and deduplicates concurrent/repeated captures', async () => {
  const s = setup()
  s.config.paypalLiveTestEnabled = true
  await s.newOrder('live')
  s.event.body.environment = 'sandbox'
  s.responses.push(completed(s.event.id), completed(s.event.id))
  const results = await Promise.all([s.capture(s.event), s.capture(s.event)])
  assert.ok(results.every(result => result.environment === 'live' && result.status === 'COMPLETED'))
  s.responses.push(completed(s.event.id))
  await s.capture(s.event)
  const captures = operations(s).filter(call => call.url.endsWith('/capture'))
  assert.equal(captures.length, 1)
  assert.equal(captures[0].options.headers['PayPal-Request-Id'], `capture-live-${s.event.id}`)
  assert.ok(s.calls.every(call => call.url.startsWith('https://api-m.paypal.com/')))
})

test('uncertain capture is reconciled using GET, never another capture POST', async () => {
  const s = setup()
  await s.newOrder()
  s.responses.push(new Error('sensitive upstream request'))
  await assert.rejects(s.capture(s.event), error => error.statusCode === 502 && !error.message.includes('sensitive'))
  s.responses.push(completed(s.event.id))
  assert.equal((await s.capture(s.event)).status, 'COMPLETED')
  const calls = operations(s)
  assert.equal(calls.filter(call => call.url.endsWith('/capture')).length, 1)
  assert.equal(calls.at(-1).options.method, 'GET')
})

test('rejects pending, wrong amount/currency/order/reference, and extra captures', async () => {
  for (const mutate of [
    o => { o.status = 'APPROVED' },
    o => { o.purchase_units[0].payments.captures[0].status = 'PENDING' },
    o => { o.purchase_units[0].payments.captures[0].amount.value = '2.00' },
    o => { o.purchase_units[0].payments.captures[0].amount.currency_code = 'EUR' },
    o => { o.id = 'OTHERORDER' },
    o => { o.purchase_units[0].reference_id = 'wrong' },
    o => { o.purchase_units[0].payments.captures.push(o.purchase_units[0].payments.captures[0]) }
  ]) {
    const s = setup()
    await s.newOrder()
    const order = completed(s.event.id)
    mutate(order)
    s.responses.push(order)
    await assert.rejects(s.capture(s.event), { statusCode: 422 })
  }
})

test('capture respects Live disablement and session ownership before network', async () => {
  const s = setup()
  s.config.paypalLiveTestEnabled = true
  await s.newOrder('live')
  const before = s.calls.length
  s.config.paypalLiveTestEnabled = false
  await assert.rejects(s.capture(s.event), { statusCode: 403 })
  s.config.paypalLiveTestEnabled = true
  delete s.event.cookies['paypal-test-session']
  await assert.rejects(s.capture(s.event), { statusCode: 403 })
  assert.equal(s.calls.length, before)
})

test('tester gate protects payment APIs; endpoints also authorize directly', async () => {
  const s = setup()
  delete s.event.cookies['paypal-tester-auth']
  for (const path of ['/api/paypal/config', '/api/paypal/orders/TESTORDER123456789/capture']) {
    s.event.url = `http://localhost:3000${path}`
    assert.throws(() => s.middleware(s.event), { statusCode: 401 })
  }
  await assert.rejects(s.create(s.event), { statusCode: 401 })
  await assert.rejects(s.capture(s.event), { statusCode: 401 })
  s.event.cookies['paypal-tester-auth'] = 'forged.session'
  assert.throws(() => s.middleware(s.event), { statusCode: 401 })
  s.config.paypalTesterPassword = ''
  assert.throws(() => s.middleware(s.event), { statusCode: 503 })
  assert.equal(s.calls.length, 0)
})

test('cross-origin, forged proof, and missing credentials fail without network', async () => {
  const s = setup()
  s.event.origin = 'https://other.example'
  await assert.rejects(s.create(s.event), { statusCode: 403 })
  s.event.origin = 'http://localhost:3000'
  s.event.body = { proof: 'f'.repeat(64) }
  await assert.rejects(s.capture(s.event), { statusCode: 403 })
  s.config.paypalSandboxClientSecret = ''
  await assert.rejects(s.create(s.event), { statusCode: 503 })
  assert.equal(s.calls.length, 0)
})

test('configured tester passwords are accepted without an arbitrary minimum length', () => {
  const s = setup()
  s.config.paypalTesterPassword = 'test1234'
  s.globals.signInPayPalTester(s.event, 'tester', 'test1234')
  assert.doesNotThrow(() => s.globals.requirePayPalTester(s.event))
  assert.throws(() => s.globals.signInPayPalTester(s.event, 'tester', 'incorrect'), { statusCode: 401 })
})

test('tester cookies reject tampering and credential rotation; sign-in throttles repeated failures', () => {
  const s = setup()
  const cookie = s.event.cookies['paypal-tester-auth']
  s.event.cookies['paypal-tester-auth'] = `${cookie}tampered`
  assert.throws(() => s.globals.requirePayPalTester(s.event), { statusCode: 401 })
  s.event.cookies['paypal-tester-auth'] = cookie
  s.config.paypalTesterPassword = 'rotated-password'
  assert.throws(() => s.globals.requirePayPalTester(s.event), { statusCode: 401 })
  for (let i = 0; i < 10; i++) assert.throws(() => s.globals.signInPayPalTester(s.event, 'tester', 'wrong'), { statusCode: 401 })
  assert.throws(() => s.globals.signInPayPalTester(s.event, 'tester', 'rotated-password'), { statusCode: 429 })
})

test('expired tester sessions are rejected', () => {
  const s = setup()
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() - 1000, nonce: 'test-nonce' })).toString('base64url')
  const signature = createHmac('sha256', s.config.paypalTesterPassword).update(`${s.config.paypalTesterUsername}:${payload}`).digest('hex')
  s.event.cookies['paypal-tester-auth'] = `${payload}.${signature}`
  assert.throws(() => s.globals.requirePayPalTester(s.event), { statusCode: 401 })
})

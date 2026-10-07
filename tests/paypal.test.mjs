import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { createHmac } from 'node:crypto'

function setup() {
  const config = {
    paypalSandboxClientSecret: 'sandbox-test-secret', paypalLiveClientSecret: 'live-test-secret', paypalLiveTestEnabled: false,
    paypalTesterUsername: 'tester', paypalTesterPassword: 'test-only-password-at-least-24-chars',
    public: { paypalSandboxClientId: 'sandbox-test-id', paypalLiveClientId: 'live-test-id' }
  }
  const calls = [], responses = [], records = new Map()
  const event = { cookies: {}, body: {}, origin: 'http://localhost:3000', url: 'http://localhost:3000/api/paypal/orders', id: 'TESTORDER123456789', query: {}, auth: `Basic ${Buffer.from(`${config.paypalTesterUsername}:${config.paypalTesterPassword}`).toString('base64')}` }
  const storage = {
    getItem: async key => records.has(key) ? structuredClone(records.get(key)) : null,
    setItem: async (key, value) => { records.set(key, structuredClone(value)) }
  }
  const globals = {
    Buffer, console, require: createRequire(import.meta.url),
    useRuntimeConfig: () => config,
    createError: data => Object.assign(new Error(data.statusMessage), data),
    defineEventHandler: handler => handler,
    getHeader: e => e.origin,
    getRequestURL: e => new URL(e.url), getQuery: e => e.query,
    getRequestIP: () => '127.0.0.1',
    setHeader: () => {},
    getCookie: (e, key) => e.cookies[key],
    setCookie: (e, key, value) => { e.cookies[key] = value },
    readBody: async e => e.body, getRouterParam: e => e.id,
    useStorage: () => storage,
    $fetch: async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/token')) return { access_token: 'mock-token' }
      const response = responses.shift()
      if (response instanceof Error) throw response
      return typeof response === 'function' ? response() : response
    }
  }
  globals.$fetch.raw = async (url, options) => ({ _data: await globals.$fetch(url, options) })
  function load(path) {
    const context = vm.createContext({ ...globals, exports: {} })
    vm.runInContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, context)
    return context.exports
  }
  Object.assign(globals, load('../server/utils/paypal-auth.ts'), load('../server/utils/paypal.ts'))
  globals.signInPayPalTester(event, config.paypalTesterUsername, config.paypalTesterPassword)
  const create = load('../server/api/paypal/orders.post.ts').default
  return { config, calls, responses, records, event, globals, create,
    capture: load('../server/api/paypal/orders/[id]/capture.post.ts').default,
    getConfig: load('../server/api/paypal/config.get.ts').default,
    middleware: load('../server/middleware/paypal-tester.ts').default,
    async newOrder(environment = 'sandbox') {
      event.body = { environment, liveConfirmed: true, requestId: '12345678-1234-1234-1234-123456789012', amount: '999', currency: 'EUR' }
      responses.push({ id: event.id, status: 'CREATED' })
      const order = await create(event)
      event.body = { proof: order.proof }
      return order
    }
  }
}

function completed(id) {
  return { id, status: 'COMPLETED', purchase_units: [{ reference_id: 'checkout-test-product', payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } }] } }] }
}
const operations = s => s.calls.filter(call => !call.url.endsWith('/token'))

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
  s.responses.push(completed(s.event.id))
  const results = await Promise.all([s.capture(s.event), s.capture(s.event)])
  assert.ok(results.every(result => result.environment === 'live' && result.status === 'COMPLETED'))
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

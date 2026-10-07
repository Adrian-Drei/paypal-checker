import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

// Run the actual handlers with Nuxt/H3 globals and PayPal transport mocked.
// No credentials or network access are used.
function setup() {
  const config = { paypalEnv: 'sandbox', paypalClientSecret: 'test-only-secret', public: { paypalClientId: 'test-only-id' } }
  const calls = []
  const responses = []
  const event = { cookies: {}, body: {}, origin: 'http://localhost:3000', id: 'TESTORDER123456789' }
  const globals = {
    Buffer, console, require: createRequire(import.meta.url),
    useRuntimeConfig: () => config,
    createError: data => Object.assign(new Error(data.statusMessage), data),
    defineEventHandler: handler => handler,
    getHeader: e => e.origin,
    getRequestURL: () => new URL('http://localhost:3000/api/paypal/orders'),
    setHeader: () => {},
    getCookie: (e, key) => e.cookies[key],
    setCookie: (e, key, value) => { e.cookies[key] = value },
    readBody: async e => e.body,
    getRouterParam: e => e.id,
    $fetch: async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/token')) return { access_token: 'mock-token' }
      const response = responses.shift()
      if (response instanceof Error) throw response
      return response
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
  Object.assign(globals, load('../server/utils/paypal.ts'))
  return { config, calls, responses, event, globals,
    create: load('../server/api/paypal/orders.post.ts').default,
    capture: load('../server/api/paypal/orders/[id]/capture.post.ts').default }
}

function completed(id) {
  return { id, status: 'COMPLETED', purchase_units: [{ reference_id: 'sandbox-test-product', payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } }] } }] }
}

test('create fixes price, uses Sandbox and reuses the request ID', async () => {
  const s = setup()
  s.event.body = { requestId: '12345678-1234-1234-1234-123456789012', amount: '999', currency: 'EUR' }
  s.responses.push({ id: s.event.id, status: 'CREATED' }, { id: s.event.id, status: 'CREATED' })
  const order = await s.create(s.event)
  await s.create(s.event)
  const posts = s.calls.filter(call => !call.url.endsWith('/token'))
  assert.equal(posts[0].options.body.purchase_units[0].amount.value, '1.00')
  assert.equal(posts[0].options.body.purchase_units[0].amount.currency_code, 'USD')
  assert.equal(posts[0].options.headers['PayPal-Request-Id'], posts[1].options.headers['PayPal-Request-Id'])
  assert.ok(s.calls.every(call => call.url.startsWith('https://api-m.sandbox.paypal.com/')))
  assert.equal(order.proof.length, 64)
})

test('capture validates success and uses a stable capture request ID', async () => {
  const s = setup()
  s.event.body = { proof: s.globals.signature(s.event, s.event.id) }
  s.responses.push(completed(s.event.id), completed(s.event.id))
  assert.equal((await s.capture(s.event)).status, 'COMPLETED')
  await s.capture(s.event)
  const posts = s.calls.filter(call => !call.url.endsWith('/token'))
  assert.equal(posts[0].options.headers['PayPal-Request-Id'], posts[1].options.headers['PayPal-Request-Id'])
})

test('rejects pending, wrong amount, wrong currency, wrong order and extra captures', async () => {
  for (const mutate of [
    o => { o.status = 'APPROVED' },
    o => { o.purchase_units[0].payments.captures[0].status = 'PENDING' },
    o => { o.purchase_units[0].payments.captures[0].amount.value = '2.00' },
    o => { o.purchase_units[0].payments.captures[0].amount.currency_code = 'EUR' },
    o => { o.id = 'OTHERORDER' },
    o => { o.purchase_units[0].payments.captures.push(o.purchase_units[0].payments.captures[0]) }
  ]) {
    const s = setup()
    s.event.body = { proof: s.globals.signature(s.event, s.event.id) }
    const order = completed(s.event.id)
    mutate(order)
    s.responses.push(order)
    await assert.rejects(s.capture(s.event), { statusCode: 422 })
  }
})

test('rejects Live, cross-origin, invalid input and forged/session-mismatched proof before network', async () => {
  const s = setup()
  s.config.paypalEnv = 'live'
  await assert.rejects(s.create(s.event), { statusCode: 503 })
  s.config.paypalEnv = 'sandbox'
  s.event.origin = 'https://other.example'
  await assert.rejects(s.create(s.event), { statusCode: 403 })
  s.event.origin = 'http://localhost:3000'
  await assert.rejects(s.create(s.event), { statusCode: 400 })
  s.event.body = { proof: 'f'.repeat(64) }
  await assert.rejects(s.capture(s.event), { statusCode: 403 })
  s.event.body = { proof: s.globals.signature(s.event, s.event.id) }
  s.event.cookies = {}
  await assert.rejects(s.capture(s.event), { statusCode: 403 })
  assert.equal(s.calls.length, 0)
})

test('upstream failures return sanitized errors', async () => {
  const s = setup()
  s.event.body = { proof: s.globals.signature(s.event, s.event.id) }
  s.responses.push(new Error('sensitive upstream request'))
  await assert.rejects(s.capture(s.event), error => error.statusCode === 502 && !error.message.includes('sensitive'))
})

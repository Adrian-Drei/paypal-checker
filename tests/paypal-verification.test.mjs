import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup } from './helpers/paypal-fixture.mjs'

const completed = id => ({ id, status: 'COMPLETED', purchase_units: [{
  reference_id: 'checkout-test-product', payee: { merchant_id: 'SELLER123', email_address: 'private@example.com' },
  payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } }] }
}] })
const details = id => ({ id: 'CAPTURE123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' },
  payee: { merchant_id: 'SELLER123' }, supplementary_data: { related_ids: { order_id: id } } })

test('diagnostics use fresh order and capture GETs, retain privacy, and never write payment records', async () => {
  const s = setup()
  await s.newOrder()
  const before = JSON.stringify([...s.records])
  const start = s.calls.length
  s.responses.push(completed(s.event.id), details(s.event.id))
  const result = await s.verify(s.event)
  assert.equal(result.recipientMerchantId, 'SELLER123')
  assert.equal(result.verificationSource, 'fresh-paypal-lookup')
  assert.equal(result.orderId, s.event.id)
  assert.equal(result.captureId, 'CAPTURE123')
  assert.doesNotMatch(JSON.stringify(result), /private|email_address|owner|proof|token/)
  assert.equal(JSON.stringify([...s.records]), before)
  const operations = s.calls.slice(start).filter(c => !c.url.endsWith('/token'))
  assert.equal(operations.length, 2)
  assert.ok(operations.every(c => c.options.method === 'GET'))
})

test('diagnostics reject a capture linked to another order, wrong amount, status, ID or recipient', async () => {
  for (const mutate of [
    c => { c.supplementary_data.related_ids.order_id = 'OTHERORDER' },
    c => { c.amount.value = '2.00' }, c => { c.amount.currency_code = 'EUR' },
    c => { c.status = 'PENDING' }, c => { c.id = 'OTHER' }, c => { c.payee.merchant_id = 'OTHERSELLER' }
  ]) {
    const s = setup()
    await s.newOrder()
    const capture = details(s.event.id)
    mutate(capture)
    s.responses.push(completed(s.event.id), capture)
    await assert.rejects(s.verify(s.event), { statusCode: 422 })
  }
})

test('cached success requires fresh PayPal verification and cannot hide an outage', async () => {
  const s = setup()
  await s.newOrder()
  s.responses.push(completed(s.event.id))
  assert.equal((await s.capture(s.event)).verificationSource, 'paypal-response')
  s.responses.push(new Error('private network error'))
  await assert.rejects(s.capture(s.event), { statusCode: 502 })
  s.responses.push(completed(s.event.id))
  assert.equal((await s.capture(s.event)).verificationSource, 'fresh-paypal-lookup')
  assert.equal(s.calls.filter(c => c.url.endsWith('/capture')).length, 1)
})

test('cached results cannot cross order/environment/owner boundaries or change capture identity', async () => {
  for (const mutate of [
    r => { r.id = 'OTHERORDER' }, r => { r.environment = 'live' }, r => { r.owner = 'another-owner' },
    r => { r.result.orderId = 'OTHERORDER' }, r => { r.result.environment = 'live' }, r => { r.result.captureId = 'OTHER' }
  ]) {
    const s = setup()
    await s.newOrder()
    s.responses.push(completed(s.event.id))
    await s.capture(s.event)
    mutate(s.records.get(`captures:sandbox:${s.event.id}`))
    s.responses.push(completed(s.event.id))
    await assert.rejects(s.capture(s.event), error => [409, 422].includes(error.statusCode))
    assert.equal(s.calls.filter(c => c.url.endsWith('/capture')).length, 1)
  }
})

test('diagnostics reject unauthorized testers and wrong session proofs before PayPal calls', async () => {
  const s = setup()
  await s.newOrder()
  const count = s.calls.length
  const cookie = s.event.cookies['paypal-tester-auth']
  delete s.event.cookies['paypal-tester-auth']
  await assert.rejects(s.verify(s.event), { statusCode: 401 })
  s.event.cookies['paypal-tester-auth'] = cookie
  delete s.event.cookies['paypal-test-session']
  await assert.rejects(s.verify(s.event), { statusCode: 403 })
  assert.equal(s.calls.length, count)
})

test('status inspection of an uncaptured order never initiates capture', async () => {
  const s = setup()
  await s.newOrder()
  const before = JSON.stringify([...s.records])
  s.responses.push({ id: s.event.id, status: 'APPROVED' })
  await assert.rejects(s.verify(s.event), { statusCode: 422 })
  assert.equal(JSON.stringify([...s.records]), before)
  assert.equal(s.calls.filter(c => c.url.endsWith('/capture')).length, 0)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/paypal-fixture.mjs'
import { startRedis } from './helpers/redis-server.mjs'

const executable = process.env.PAYPAL_TEST_REDIS_SERVER ?? 'C:/laragon/bin/redis/redis-x64-5.0.14.1/redis-server.exe'
const completed = id => ({ id, status: 'COMPLETED', purchase_units: [{ reference_id: 'checkout-test-product', payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } }] } }] })

test('real Redis: durable records, independent-instance concurrency, both payment environments and stale-lock fencing', { skip: !existsSync(executable) && 'Set PAYPAL_TEST_REDIS_SERVER to a Redis executable', timeout: 30000 }, async () => {
  const redis = await startRedis(executable)
  try {
    for (const environment of ['sandbox', 'live']) {
      const shared = { calls: [], responses: [], redisTransport: redis.command }
      const a = setup(shared), b = setup(shared)
      const prefix = `integration-${randomUUID()}`
      a.config.paypalRedisPrefix = b.config.paypalRedisPrefix = prefix
      a.config.paypalLiveTestEnabled = b.config.paypalLiveTestEnabled = true
      const order = await a.newOrder(environment)
      await redis.restart()
      b.event.cookies = { ...a.event.cookies }
      b.event.body = { environment, liveConfirmed: true, requestId: '12345678-1234-1234-1234-123456789012' }
      assert.equal((await b.create(b.event)).proof, order.proof, 'Create retry survives Redis restart')
      b.event.body = { proof: order.proof }
      shared.responses.push(completed(order.id))
      await Promise.all([a.capture(a.event), b.capture(b.event)])
      assert.equal(shared.calls.filter(c => c.url.endsWith('/capture')).length, 1)
      await redis.restart()
      assert.equal((await b.capture(b.event)).status, 'COMPLETED', 'Verified capture survives Redis restart')
      assert.equal(shared.calls.filter(c => c.url.endsWith('/capture')).length, 1)
      const apiBase = environment === 'live' ? 'https://api-m.paypal.com/' : 'https://api-m.sandbox.paypal.com/'
      assert.ok(shared.calls.every(c => c.url.startsWith(apiBase)))
      await assert.rejects(a.globals.withPayPalLock(a.event, 'fencing', async storage => {
        await redis.command(['SET', `{${prefix}}:locks:fencing`, 'replacement-owner', 'PX', 60000])
        await storage.setItem('stale-record', { shouldNotPersist: true })
      }), { statusCode: 409 })
      assert.equal(await redis.command(['GET', `{${prefix}}:stale-record`]), null)
      assert.equal(await redis.command(['GET', `{${prefix}}:locks:fencing`]), 'replacement-owner')
    }
  } finally { await redis.stop() }
})

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { H3Event } from 'h3'

// All related keys share a Redis Cluster hash tag. Records have no TTL; only locks expire.
const readScript = `return redis.call('GET', KEYS[1])`
const ownedReadScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {0} end
return {1, redis.call('GET', KEYS[2]) or false}`
const writeScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2])
return 1`
const releaseScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`

function storageError() {
  return createError({ statusCode: 503, statusMessage: 'Payment storage is unavailable. Check the existing order before starting another payment.' })
}
function lockError() {
  return createError({ statusCode: 409, statusMessage: 'This payment operation is busy or its lock expired. Retry the same operation; do not start another payment.' })
}

export function paypalStorage(event: H3Event) {
  const config = useRuntimeConfig(event)
  let url: URL
  try {
    url = new URL(config.paypalRedisRestUrl)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password
      || !config.paypalRedisRestToken || !/^[a-zA-Z0-9_-]{1,80}$/.test(config.paypalRedisPrefix)) throw new Error('Invalid storage config')
  } catch {
    throw createError({ statusCode: 503, statusMessage: 'Configure server-only PayPal Redis storage before creating or capturing orders.' })
  }
  const prefix = `{${config.paypalRedisPrefix}}:`
  let syncToken: string | undefined
  async function command<T>(args: Array<string | number>): Promise<T> {
    try {
      const response = await $fetch.raw<{ result?: T; error?: string }>(url.toString(), {
        method: 'POST', timeout: 5000, retry: 0,
        headers: { Authorization: `Bearer ${config.paypalRedisRestToken}`, ...(syncToken ? { 'Upstash-Sync-Token': syncToken } : {}) },
        body: args
      })
      syncToken = response.headers.get('upstash-sync-token') ?? syncToken
      const data = response._data
      if (!data || data.error || !Object.hasOwn(data, 'result')) throw new Error('Redis command failed')
      return data.result as T
    } catch { throw storageError() } // Never leak REST tokens, URLs, records, or upstream errors.
  }
  function decode<T>(value: string | null): T | null {
    try { return value === null ? null : JSON.parse(value) as T }
    catch { throw storageError() }
  }
  return {
    command,
    key: (key: string) => `${prefix}${key}`,
    async getItem<T>(key: string): Promise<T | null> {
      return decode<T>(await command<string | null>(['EVAL', readScript, 1, `${prefix}${key}`]))
    },
    owned(lockKey: string, token: string) {
      return {
        async getItem<T>(key: string): Promise<T | null> {
          const result = await command<[number, string | null]>(['EVAL', ownedReadScript, 2, lockKey, `${prefix}${key}`, token])
          if (result[0] !== 1) throw lockError()
          return decode<T>(result[1])
        },
        async setItem(key: string, value: unknown): Promise<void> {
          const result = await command<number>(['EVAL', writeScript, 2, lockKey, `${prefix}${key}`, token, JSON.stringify(value)])
          if (result !== 1) throw lockError()
        }
      }
    }
  }
}

type LockedStorage = ReturnType<ReturnType<typeof paypalStorage>['owned']>

export async function withPayPalLock<T>(event: H3Event, key: string, operation: (storage: LockedStorage) => Promise<T>): Promise<T> {
  const storage = paypalStorage(event)
  const lockKey = storage.key(`locks:${key}`)
  const token = randomUUID()
  const deadline = Date.now() + 2000
  while (await storage.command<string | null>(['SET', lockKey, token, 'NX', 'PX', 60000]) !== 'OK') {
    if (Date.now() >= deadline) throw lockError()
    await delay(100)
  }
  try { return await operation(storage.owned(lockKey, token)) }
  finally {
    // Expired/replaced locks cannot be deleted by their previous owner. A failed
    // release can safely expire; never mask a persisted result or original error.
    await storage.command(['EVAL', releaseScript, 1, lockKey, token]).catch(() => {})
  }
}

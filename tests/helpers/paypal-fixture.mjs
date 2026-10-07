import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
export function setup(shared = {}) {
  const config = {
    paypalSandboxClientSecret: 'sandbox-test-secret', paypalLiveClientSecret: 'live-test-secret', paypalLiveTestEnabled: false,
    paypalTesterUsername: 'tester', paypalTesterPassword: 'test-only-password-at-least-24-chars',
    paypalRedisRestUrl: 'https://redis.test', paypalRedisRestToken: 'test-only-redis-token', paypalRedisPrefix: 'test',
    public: { paypalSandboxClientId: 'sandbox-test-id', paypalLiveClientId: 'live-test-id' }
  }
  const calls = shared.calls ?? [], responses = shared.responses ?? [], records = shared.records ?? new Map(), locks = shared.locks ?? new Map()
  const event = { cookies: {}, body: {}, origin: 'http://localhost:3000', url: 'http://localhost:3000/api/paypal/orders', id: 'TESTORDER123456789', query: {}, auth: `Basic ${Buffer.from(`${config.paypalTesterUsername}:${config.paypalTesterPassword}`).toString('base64')}` }
  function redis(args) {
    const [command, script, count, ...rest] = args
    const logical = key => key.replace(/^\{test\}:/, '')
    const get = key => {
      if (key.includes(':locks:')) {
        const lock = locks.get(key)
        if (lock && lock.expires > Date.now()) return lock.value
        locks.delete(key); return null
      }
      return records.has(logical(key)) ? JSON.stringify(records.get(logical(key))) : null
    }
    if (command === 'SET') {
      if (get(script) !== null) return null
      locks.set(script, { value: count, expires: Date.now() + Number(args.at(-1)) })
      return 'OK'
    }
    const keys = rest.slice(0, count), argv = rest.slice(count)
    if (script.includes("'DEL'")) {
      if (get(keys[0]) !== argv[0]) return 0
      locks.delete(keys[0]); return 1
    }
    if (script.includes("'SET'")) {
      if (get(keys[0]) !== argv[0]) return 0
      records.set(logical(keys[1]), JSON.parse(argv[1])); return 1
    }
    if (script.includes('return {1,')) return get(keys[0]) === argv[0] ? [1, get(keys[1])] : [0]
    return get(keys[0])
  }
  const globals = {
    Buffer, console, URL, require: createRequire(import.meta.url),
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
    $fetch: async (url, options) => {
      if (url === 'https://redis.test/') return { result: shared.redisTransport ? await shared.redisTransport(options.body) : redis(options.body) }
      calls.push({ url, options })
      if (url.endsWith('/token')) return { access_token: 'mock-token' }
      const response = responses.shift()
      if (response instanceof Error) throw response
      return typeof response === 'function' ? response() : response
    }
  }
  globals.$fetch.raw = async (url, options) => ({ _data: await globals.$fetch(url, options), headers: { get: () => null } })
  function load(path) {
    const context = vm.createContext({ ...globals, exports: {} })
    vm.runInContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, context)
    return context.exports
  }
  Object.assign(globals, load('../../server/utils/paypal-auth.ts'), load('../../server/utils/paypal.ts'), load('../../server/utils/paypal-storage.ts'))
  globals.signInPayPalTester(event, config.paypalTesterUsername, config.paypalTesterPassword)
  const create = load('../../server/api/paypal/orders.post.ts').default
  return { config, calls, responses, records, locks, event, globals, create,
    capture: load('../../server/api/paypal/orders/[id]/capture.post.ts').default,
    getConfig: load('../../server/api/paypal/config.get.ts').default,
    middleware: load('../../server/middleware/paypal-tester.ts').default,
    async newOrder(environment = 'sandbox') {
      event.body = { environment, liveConfirmed: true, requestId: '12345678-1234-1234-1234-123456789012', amount: '999', currency: 'EUR' }
      responses.push({ id: event.id, status: 'CREATED' })
      const order = await create(event)
      event.body = { proof: order.proof }
      return order
    }
  }
}



import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise the page's actual TypeScript callbacks with a mocked DOM/PayPal SDK.
// No SDK download, network call, credentials, or payment occurs.
function setup() {
  const calls = [], scripts = [], options = [], closes = [], mounts = [], unmounts = []
  let createResponse
  const context = vm.createContext({
    ref: value => ({ value }),
    computed: getter => ({ get value() { return getter() } }),
    definePageMeta: () => {}, useHead: () => {},
    onMounted: callback => mounts.push(callback), onBeforeUnmount: callback => unmounts.push(callback),
    setTimeout, clearTimeout, URLSearchParams, crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789012' },
    window: {},
    document: {
      createElement: () => ({ attributes: {}, setAttribute(key, value) { this.attributes[key] = value }, remove() { this.removed = true } }),
      head: { appendChild(script) {
        scripts.push(script)
        const namespace = script.attributes['data-namespace']
        context.window[namespace] = {
          FUNDING: { CARD: 'card' }, isFundingEligible: () => true,
          Buttons: callbacks => {
            options.push(callbacks)
            return { isEligible: () => true, render: async () => {}, close: async () => closes.push(namespace) }
          }
        }
        queueMicrotask(() => script.onload?.())
      } }
    },
    $fetch: async (url, init) => {
      calls.push({ url, init })
      if (url === '/api/paypal/config') return { environment: init.query.environment, clientId: `${init.query.environment}-client-id` }
      if (url === '/api/paypal/orders') return createResponse ? createResponse() : { id: 'ORDER1234567890', proof: 'proof', environment: init.body.environment }
      return { environment: 'live', orderId: 'ORDER1234567890', captureId: 'CAPTURE1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } }
    }
  })
  const source = readFileSync(new URL('../app/pages/index.vue', import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
  vm.runInContext('container.value = { replaceChildren() {} }', context)
  const run = expression => vm.runInContext(expression, context)
  return { calls, scripts, options, closes, mounts, unmounts, run,
    setCreate: value => { createResponse = value } }
}
function actions() {
  return { resolved: false, rejected: false, async resolve() { this.resolved = true }, async reject() { this.rejected = true } }
}

test('initially Sandbox; switching clears state, closes old buttons, removes old SDK and loads matching ID', async () => {
  const s = setup()
  await s.mounts[0]()
  assert.equal(s.run('environment.value'), 'sandbox')
  assert.ok(s.scripts[0].src.includes('client-id=sandbox-client-id'))
  s.run("result.value = { status: 'COMPLETED' }; order = { id: 'OLD' }; liveConfirmed = true")
  const oldNamespace = s.scripts[0].attributes['data-namespace']
  await s.run("switchEnvironment('live')")
  assert.equal(s.run('result.value'), undefined)
  assert.equal(s.run('order'), undefined)
  assert.equal(s.run('liveConfirmed'), false)
  assert.equal(s.scripts[0].removed, true)
  assert.ok(s.closes.includes(oldNamespace))
  assert.equal(s.run(`window['${oldNamespace}']`), undefined)
  assert.ok(s.scripts[1].src.includes('client-id=live-client-id'))
  assert.ok(s.calls.every(call => call.url === '/api/paypal/config'))
  await s.unmounts[0]()
})

test('declining Live confirmation creates no order; accepting passes explicit consent', async () => {
  const s = setup()
  await s.mounts[0]()
  await s.run("switchEnvironment('live')")
  const callbacks = s.options.at(-1)
  const rejected = actions()
  const pendingCancel = callbacks.onClick({}, rejected)
  assert.equal(s.run('confirmation.value'), 'live')
  assert.equal(s.run('switchLocked.value'), true)
  s.run('finishConfirmation(false)')
  await pendingCancel
  assert.equal(rejected.rejected, true)
  assert.equal(s.calls.filter(call => call.url === '/api/paypal/orders').length, 0)
  await assert.rejects(callbacks.createOrder())
  const accepted = actions()
  const pendingAccept = callbacks.onClick({}, accepted)
  s.run('finishConfirmation(true)')
  await pendingAccept
  assert.equal(accepted.resolved, true)
  await callbacks.createOrder()
  const request = s.calls.find(call => call.url === '/api/paypal/orders')
  assert.equal(request.init.body.environment, 'live')
  assert.equal(request.init.body.liveConfirmed, true)
  callbacks.onCancel()
  await s.unmounts[0]()
})

test('cancelling the reset modal preserves the uncertain order; unmount cancels pending Live consent', async () => {
  const s = setup()
  await s.mounts[0]()
  s.run("approvedOrder.value = 'ORDER1234567890'")
  const reset = s.run('resetAfterVerification()')
  assert.equal(s.run('confirmation.value'), 'reset')
  s.run('finishConfirmation(false)')
  await reset
  assert.equal(s.run('approvedOrder.value'), 'ORDER1234567890')
  s.run('approvedOrder.value = undefined')
  await s.run("switchEnvironment('live')")
  const rejected = actions()
  const pending = s.options.at(-1).onClick({}, rejected)
  await s.unmounts[0]()
  await pending
  assert.equal(rejected.rejected, true)
  assert.equal(s.calls.filter(call => call.url === '/api/paypal/orders').length, 0)
})

test('switching is locked during order creation/approval and capture reconciliation, then unlocks after cancellation', async () => {
  const s = setup()
  await s.mounts[0]()
  let release
  s.setCreate(() => new Promise(resolve => { release = resolve }))
  const callbacks = s.options.at(-1)
  await callbacks.onClick({}, actions())
  const pending = callbacks.createOrder()
  await s.run("switchEnvironment('live')")
  assert.equal(s.run('environment.value'), 'sandbox')
  release({ id: 'ORDER1234567890', proof: 'proof', environment: 'sandbox' })
  await pending
  await s.run("switchEnvironment('live')")
  assert.equal(s.run('environment.value'), 'sandbox')
  callbacks.onCancel()
  assert.equal(s.run('switchLocked.value'), false)
  s.run("approvedOrder.value = 'ORDER1234567890'; state.value = 'error'")
  await s.run("switchEnvironment('live')")
  assert.equal(s.run('environment.value'), 'sandbox')
  s.run('approvedOrder.value = undefined')
  await s.run("switchEnvironment('live')")
  assert.equal(s.run('environment.value'), 'live')
  await s.unmounts[0]()
})

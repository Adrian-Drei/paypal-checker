<script setup lang="ts">
type Environment = 'sandbox' | 'live'
type Result = { orderId: string; captureId: string; environment: Environment; status: string; amount: { currency_code: string; value: string } }
type Order = { id: string; proof: string; environment: Environment }
type Buttons = { render: (element: HTMLElement) => Promise<void>; close: () => Promise<void>; isEligible: () => boolean }
type PayPal = { Buttons: (options: {
  style: { layout: 'vertical'; shape: 'rect'; label: 'pay' }
  onClick: (data: unknown, actions: { resolve: () => Promise<void>; reject: () => Promise<void> }) => Promise<void>
  createOrder: () => Promise<string>
  onApprove: (data: { orderID: string }) => Promise<void>
  onCancel: () => void
  onError: () => void
}) => Buttons; isFundingEligible: (source: string) => boolean; FUNDING: { CARD: string } }

definePageMeta({ middleware: 'paypal-tester' })
useHead({ title: 'PayPal checkout test', meta: [{ name: 'robots', content: 'noindex, nofollow' }] })
const environment = ref<Environment>('sandbox')
const container = ref<HTMLElement>()
const state = ref('loading')
const message = ref('Checking Sandbox configuration…')
const cardEligibility = ref('Not checked yet')
const result = ref<Result>()
const approvedOrder = ref<string>()
const loading = ref(true)
const operationBusy = ref(false)
const confirmation = ref<'live' | 'reset'>()
const switchLocked = computed(() => loading.value || operationBusy.value || !!approvedOrder.value || !!confirmation.value)
const live = computed(() => environment.value === 'live')
let requestId = ''
let order: Order | undefined
let buttons: Buttons | undefined
let script: HTMLScriptElement | undefined
let namespace = ''
let generation = 0
let disposed = false
let captureInFlight = false
let liveConfirmed = false
let cancelLoad: (() => void) | undefined
const sdkWindow = () => window as unknown as Record<string, PayPal | undefined>
let resolveConfirmation: ((accepted: boolean) => void) | undefined

function askConfirmation(kind: 'live' | 'reset'): Promise<boolean> {
  if (disposed || confirmation.value) return Promise.resolve(false)
  confirmation.value = kind
  return new Promise(resolve => { resolveConfirmation = resolve })
}

function finishConfirmation(accepted: boolean) {
  const resolve = resolveConfirmation
  resolveConfirmation = undefined
  confirmation.value = undefined
  resolve?.(accepted)
}

function fail(error: unknown) {
  state.value = 'error'
  const data = (error as { data?: { statusMessage?: string } })?.data
  message.value = data?.statusMessage ?? 'Checkout could not complete. Check your network or local configuration. If capture was attempted, verify the seller account before another payment.'
}

async function cleanupSDK() {
  cancelLoad?.()
  cancelLoad = undefined
  if (buttons) await buttons.close().catch(() => {})
  buttons = undefined
  container.value?.replaceChildren()
  script?.remove()
  script = undefined
  if (namespace) delete sdkWindow()[namespace]
  namespace = ''
}

async function capture(id: string) {
  if (captureInFlight) return
  captureInFlight = true
  operationBusy.value = true
  state.value = 'capturing'
  message.value = 'Capturing or checking the existing capture, and verifying USD 1.00 on the server…'
  try {
    if (!order || order.id !== id || order.environment !== environment.value) throw new Error('Order mismatch')
    result.value = await $fetch<Result>(`/api/paypal/orders/${id}/capture`, { method: 'POST', body: { proof: order.proof }, retry: 0 })
    state.value = 'success'
    message.value = result.value.environment === 'live' ? 'Live capture verified — USD 1.00 was actually charged. Verify it in the Live seller account.' : 'Sandbox capture verified — USD 1.00. No real money moved.'
    approvedOrder.value = undefined
    liveConfirmed = false
  } catch (error) { fail(error) }
  finally { captureInFlight = false; operationBusy.value = false }
}

async function loadEnvironment(selected: Environment) {
  if (disposed) return
  loading.value = true
  state.value = 'loading'
  environment.value = selected
  result.value = undefined
  approvedOrder.value = undefined
  order = undefined
  requestId = ''
  liveConfirmed = false
  cardEligibility.value = 'Not checked yet'
  message.value = `Checking ${selected} configuration…`
  try {
    await cleanupSDK()
    const config = await $fetch<{ environment: Environment; clientId: string }>('/api/paypal/config', { query: { environment: selected }, retry: 0 })
    if (disposed) return
    if (config.environment !== selected) throw new Error('Environment mismatch')
    message.value = `Loading PayPal ${selected} buttons…`
    const params = new URLSearchParams({ 'client-id': config.clientId, currency: 'USD', intent: 'capture', components: 'buttons,funding-eligibility', 'enable-funding': 'card', 'integration-date': '2026-10-07' })
    const currentNamespace = `paypalCheckoutTest${++generation}`
    namespace = currentNamespace
    script = document.createElement('script')
    // The official SDK URL uses the selected environment's client ID.
    script.src = `https://www.paypal.com/sdk/js?${params}`
    script.setAttribute('data-namespace', currentNamespace)
    const currentScript = script
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        currentScript.onload = null
        currentScript.onerror = null
        cancelLoad = undefined
        if (error) { currentScript.remove(); reject(error) } else resolve()
      }
      const timer = setTimeout(() => finish(new Error('SDK timeout')), 20000)
      cancelLoad = () => finish(new Error('SDK load cancelled'))
      currentScript.onload = () => finish()
      currentScript.onerror = () => finish(new Error('SDK failed'))
      document.head.appendChild(currentScript)
    })
    if (disposed) return
    const paypal = sdkWindow()[currentNamespace]
    if (!paypal || !container.value) throw new Error('SDK unavailable')
    cardEligibility.value = paypal.isFundingEligible(paypal.FUNDING.CARD) ? `Card funding eligible in this ${selected} session` : `Card funding not eligible in this ${selected} session`
    buttons = paypal.Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'pay' },
      async onClick(_data, actions) {
        if (loading.value || operationBusy.value || approvedOrder.value || result.value || confirmation.value || disposed || selected !== environment.value) return actions.reject()
        liveConfirmed = selected !== 'live' || await askConfirmation('live')
        if (disposed || selected !== environment.value) return actions.reject()
        if (!liveConfirmed) {
          state.value = 'cancelled'
          message.value = 'Live checkout was not opened. No order or charge was initiated.'
          return actions.reject()
        }
        operationBusy.value = true
        return actions.resolve()
      },
      async createOrder() {
        try {
          if (disposed || selected !== environment.value || (selected === 'live' && !liveConfirmed)) throw new Error('Live confirmation or current checkout required')
          operationBusy.value = true
          state.value = 'creating'
          message.value = `Creating a USD 1.00 ${selected} order…`
          requestId ||= crypto.randomUUID()
          order ??= await $fetch<Order>('/api/paypal/orders', { method: 'POST', body: { requestId, environment: selected, liveConfirmed: selected === 'live' && liveConfirmed }, retry: 0 })
          if (!order || order.environment !== selected) throw new Error('Order unavailable')
          state.value = 'approving'
          message.value = selected === 'live' ? 'Live checkout open. Approval will charge USD 1.00. Cancel before approving to inspect without paying.' : 'Complete Sandbox approval in PayPal, or cancel to return here.'
          return order.id
        } catch (error) { operationBusy.value = false; fail(error); throw error }
      },
      async onApprove(data) { approvedOrder.value = data.orderID; await capture(data.orderID) },
      onCancel() {
        if (captureInFlight || approvedOrder.value) return
        operationBusy.value = false
        state.value = 'cancelled'
        message.value = 'Checkout cancelled before approval. No capture was requested. You can switch environments or try again.'
        order = undefined; requestId = ''; liveConfirmed = false
      },
      onError() { if (!captureInFlight) operationBusy.value = false; if (state.value !== 'error') fail(undefined) }
    })
    if (!buttons.isEligible()) throw new Error('No eligible funding')
    await buttons.render(container.value)
    if (disposed) { await cleanupSDK(); return }
    state.value = 'ready'
    message.value = selected === 'live' ? 'Live buttons ready for inspection. Selecting Live has not created an order or charged money. Opening checkout requires confirmation.' : 'Ready to test. PayPal displays eligible Sandbox funding options below.'
  } catch (error) { if (!disposed) { await cleanupSDK(); fail(error) } }
  finally { loading.value = false }
}

async function switchEnvironment(selected: Environment) {
  if (switchLocked.value || selected === environment.value) return
  await loadEnvironment(selected)
}

async function resetAfterVerification() {
  if (operationBusy.value || confirmation.value || !await askConfirmation('reset') || disposed) return
  approvedOrder.value = undefined
  void loadEnvironment(environment.value)
}

onMounted(() => loadEnvironment('sandbox'))
onBeforeUnmount(() => { disposed = true; finishConfirmation(false); void cleanupSDK() })
</script>

<template>
  <main class="mx-auto max-w-4xl px-4 py-10 sm:px-8 sm:py-16">
    <TesterSignOut :disabled="switchLocked" />
    <ConfirmationModal
      :open="!!confirmation"
      :title="confirmation === 'live' ? 'Open Live checkout?' : 'Reset this checkout?'"
      :description="confirmation === 'live' ? 'If you approve payment in PayPal, USD 1.00 will actually be charged. To inspect guest checkout without paying, cancel in PayPal before approving.' : 'An uncertain capture may already have charged money. Only reset after checking this order in the correct seller account and verifying that it is safe to start another test. Resetting does not refund or cancel a payment.'"
      :confirm-label="confirmation === 'live' ? 'Continue to Live checkout' : 'I verified the seller account'"
      :danger="confirmation === 'live'"
      @confirm="finishConfirmation(true)"
      @cancel="finishConfirmation(false)"
    />
    <span class="inline-flex rounded-full px-3 py-1 text-sm font-bold" :class="live ? 'bg-red-100 text-red-900' : 'bg-amber-100 text-amber-900'">{{ live ? 'Live mode — real payments' : 'Sandbox — no real money' }}</span>
    <h1 class="mt-5 text-3xl font-bold tracking-tight sm:text-4xl">PayPal checkout test</h1>
    <p class="mt-3 max-w-2xl text-slate-600">Inspect payment options, approval, and capture as an authorized tester. Selected environment: <strong class="capitalize">{{ environment }}</strong>.</p>
    <div class="mt-6 flex gap-3" role="group" aria-label="Payment environment">
      <button v-for="option in (['sandbox', 'live'] as const)" :key="option" class="rounded-lg border px-5 py-2 font-bold capitalize disabled:cursor-not-allowed disabled:opacity-50" :class="environment === option ? 'border-blue-700 bg-blue-700 text-white' : 'border-slate-300 bg-white text-slate-800'" :aria-pressed="environment === option" :disabled="switchLocked" @click="switchEnvironment(option)">{{ option }}</button>
    </div>
    <p v-if="operationBusy || approvedOrder" class="mt-2 text-sm text-slate-600">Environment switching is locked while checkout is open or a capture needs verification.</p>
    <aside v-if="live" class="mt-6 rounded-xl border-2 border-red-300 bg-red-50 p-5 text-sm leading-6 text-red-950">
      <h2 class="text-lg font-bold">Live mode — real payments</h2>
      <p>Approving payment will actually charge USD 1.00. You may inspect eligible buttons and open PayPal-hosted checkout after confirmation, then cancel before approval to avoid payment. Card entry is hosted by PayPal.</p>
    </aside>
    <div class="mt-8 grid gap-6 md:grid-cols-2">
      <section class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="text-lg font-bold">Test product</h2>
        <p class="mt-2 text-sm text-slate-600">One fixed-price test item. No shipping.</p>
        <p class="my-6 text-4xl font-bold">$1.00 <span class="text-base font-normal text-slate-500">USD</span></p>
        <p class="border-t border-slate-100 pt-4 text-sm text-slate-600">The server fixes the amount and currency and verifies the capture before showing success.</p>
      </section>
      <section class="rounded-2xl border border-slate-200 bg-white p-6" aria-label="Test payment">
        <h2 class="mb-4 text-lg font-bold">Choose a payment method</h2>
        <div role="status" aria-live="polite" class="mb-4 rounded-lg p-3 text-sm" :class="state === 'error' ? 'bg-red-50 text-red-800' : state === 'success' ? 'bg-green-50 text-green-800' : 'bg-slate-100 text-slate-700'" :aria-busy="loading || operationBusy">
          <strong class="mb-1 block capitalize">{{ state }}</strong>{{ message }}
        </div>
        <div v-show="!result && !approvedOrder" ref="container" />
        <template v-if="state === 'error' && approvedOrder">
          <button class="rounded-lg bg-blue-700 px-4 py-2 text-white disabled:opacity-50" :disabled="operationBusy" @click="capture(approvedOrder)">Check capture status</button>
          <button class="mt-3 block text-sm text-blue-700 underline disabled:opacity-50" :disabled="operationBusy" @click="resetAfterVerification">Reset after verifying seller account</button>
        </template>
        <button v-else-if="state === 'error' || state === 'success'" class="mt-3 text-sm text-blue-700 underline disabled:opacity-50" :disabled="switchLocked" @click="loadEnvironment(environment)">Reset selected checkout</button>
        <p class="mt-4 text-xs text-slate-500">{{ cardEligibility }}. This does not guarantee guest checkout.</p>
      </section>
    </div>
    <section v-if="result" class="mt-6 rounded-2xl border border-green-200 bg-white p-6">
      <h2 class="font-bold">Verified <span class="capitalize">{{ result.environment }}</span> capture</h2>
      <dl class="mt-3 grid gap-2 break-all text-sm"><div><dt class="font-bold">Order ID</dt><dd>{{ result.orderId }}</dd></div><div><dt class="font-bold">Capture ID</dt><dd>{{ result.captureId }}</dd></div><div><dt class="font-bold">Status / amount</dt><dd>{{ result.status }} / {{ result.amount.currency_code }} {{ result.amount.value }}</dd></div></dl>
    </section>
  </main>
</template>

<script setup lang="ts">
type Result = { orderId: string; captureId: string; status: string; amount: { currency_code: string; value: string } }
type Buttons = { render: (element: HTMLElement) => Promise<void>; close: () => Promise<void>; isEligible: () => boolean }
type PayPal = { Buttons: (options: {
  style: { layout: 'vertical'; shape: 'rect'; label: 'pay' }
  createOrder: () => Promise<string>
  onApprove: (data: { orderID: string }) => Promise<void>
  onCancel: () => void
  onError: () => void
}) => Buttons; isFundingEligible: (source: string) => boolean; FUNDING: { CARD: string } }

useHead({ title: 'PayPal Sandbox checkout test' })
const config = useRuntimeConfig()
const container = ref<HTMLElement>()
const state = ref('loading')
const message = ref('Checking Sandbox configuration…')
const cardEligibility = ref('Not checked yet')
const result = ref<Result>()
const approvedOrder = ref<string>()
let requestId = ''
let order: { id: string; proof: string } | undefined
let buttons: Buttons | undefined
let script: HTMLScriptElement | undefined
let disposed = false
let captureInFlight = false

function fail(error: unknown) {
  state.value = 'error'
  const data = (error as { data?: { statusMessage?: string } })?.data
  message.value = data?.statusMessage ?? 'Checkout could not complete. Check your network or Sandbox setup and try again.'
}

async function capture(id: string) {
  if (captureInFlight) return
  captureInFlight = true
  state.value = 'capturing'
  message.value = 'Capturing and verifying USD 1.00 on the server…'
  try {
    if (!order || order.id !== id) throw new Error('Order mismatch')
    result.value = await $fetch<Result>(`/api/paypal/orders/${id}/capture`, { method: 'POST', body: { proof: order.proof }, retry: 0 })
    state.value = 'success'
    message.value = 'Sandbox capture verified — USD 1.00. No real money moved.'
    approvedOrder.value = undefined
  } catch (error) { fail(error) }
  finally { captureInFlight = false }
}

onMounted(async () => {
  try {
    await $fetch('/api/paypal/config')
    if (disposed) return
    message.value = 'Loading PayPal Sandbox buttons…'
    const params = new URLSearchParams({ 'client-id': config.public.paypalClientId, currency: 'USD', intent: 'capture', components: 'buttons,funding-eligibility', 'enable-funding': 'card' })
    script = document.createElement('script')
    script.src = `https://www.paypal.com/sdk/js?${params}`
    script.setAttribute('data-namespace', 'paypalSandboxTest')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SDK timeout')), 20000)
      script!.onload = () => { clearTimeout(timer); resolve() }
      script!.onerror = () => { clearTimeout(timer); reject(new Error('SDK failed')) }
      document.head.appendChild(script!)
    })
    if (disposed) return
    const paypal = (window as unknown as { paypalSandboxTest?: PayPal }).paypalSandboxTest
    if (!paypal || !container.value) throw new Error('SDK unavailable')
    cardEligibility.value = paypal.isFundingEligible(paypal.FUNDING.CARD) ? 'Card funding eligible in this Sandbox session' : 'Card funding not eligible in this Sandbox session'
    buttons = paypal.Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'pay' },
      async createOrder() {
        state.value = 'creating'
        message.value = 'Creating a USD 1.00 Sandbox order…'
        requestId ||= crypto.randomUUID()
        try {
          order ??= await $fetch<{ id: string; proof: string }>('/api/paypal/orders', { method: 'POST', body: { requestId }, retry: 0 })
          if (!order) throw new Error('Order unavailable')
          state.value = 'approving'
          message.value = 'Complete approval in PayPal, or cancel to return here.'
          return order.id
        } catch (error) { fail(error); throw error }
      },
      async onApprove(data) { approvedOrder.value = data.orderID; await capture(data.orderID) },
      onCancel() {
        state.value = 'cancelled'
        message.value = 'Checkout cancelled. No capture was requested. You can try again.'
        order = undefined; requestId = ''; approvedOrder.value = undefined
      },
      onError() { if (state.value !== 'error') fail(undefined) }
    })
    if (!buttons.isEligible()) throw new Error('No eligible funding')
    await buttons.render(container.value)
    if (disposed) { await buttons.close(); return }
    state.value = 'ready'
    message.value = 'Ready to test. PayPal displays the eligible funding options below.'
  } catch (error) { if (!disposed) fail(error) }
})

onBeforeUnmount(() => { disposed = true; void buttons?.close().catch(() => {}); script?.remove() })
</script>

<template>
  <main class="mx-auto max-w-4xl px-4 py-10 sm:px-8 sm:py-16">
    <span class="inline-flex rounded-full bg-amber-100 px-3 py-1 text-sm font-bold text-amber-900">Sandbox — no real money</span>
    <h1 class="mt-5 text-3xl font-bold tracking-tight sm:text-4xl">PayPal checkout test</h1>
    <p class="mt-3 max-w-2xl text-slate-600">Test order approval and capture, and inspect the payment options PayPal offers in this Sandbox session.</p>
    <div class="mt-8 grid gap-6 md:grid-cols-2">
      <section class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="text-lg font-bold">Test product</h2>
        <p class="mt-2 text-sm text-slate-600">One fixed-price Sandbox item. No shipping.</p>
        <p class="my-6 text-4xl font-bold">$1.00 <span class="text-base font-normal text-slate-500">USD</span></p>
        <p class="border-t border-slate-100 pt-4 text-sm text-slate-600">The server fixes the amount and currency and verifies the capture before showing success.</p>
      </section>
      <section class="rounded-2xl border border-slate-200 bg-white p-6" aria-label="Sandbox payment">
        <h2 class="mb-4 text-lg font-bold">Choose a payment method</h2>
        <div role="status" aria-live="polite" class="mb-4 rounded-lg p-3 text-sm" :class="state === 'error' ? 'bg-red-50 text-red-800' : state === 'success' ? 'bg-green-50 text-green-800' : 'bg-slate-100 text-slate-700'" :aria-busy="['loading', 'creating', 'capturing'].includes(state)">
          <strong class="mb-1 block capitalize">{{ state }}</strong>{{ message }}
        </div>
        <div v-show="!result && !approvedOrder" ref="container" />
        <button v-if="state === 'error' && approvedOrder" class="rounded-lg bg-blue-700 px-4 py-2 text-white" @click="capture(approvedOrder)">Retry capture of the same order</button>
        <button v-else-if="state === 'error' || state === 'success'" class="mt-3 text-sm text-blue-700 underline" @click="reloadNuxtApp({ force: true })">Reload checkout</button>
        <p class="mt-4 text-xs text-slate-500">{{ cardEligibility }}. This is not a guest checkout eligibility result.</p>
      </section>
    </div>
    <section v-if="result" class="mt-6 rounded-2xl border border-green-200 bg-white p-6">
      <h2 class="font-bold">Verified Sandbox capture</h2>
      <dl class="mt-3 grid gap-2 break-all text-sm"><div><dt class="font-bold">Order ID</dt><dd>{{ result.orderId }}</dd></div><div><dt class="font-bold">Capture ID</dt><dd>{{ result.captureId }}</dd></div><div><dt class="font-bold">Status / amount</dt><dd>{{ result.status }} / {{ result.amount.currency_code }} {{ result.amount.value }}</dd></div></dl>
    </section>
    <aside class="mt-6 rounded-xl border border-slate-200 p-5 text-sm leading-6 text-slate-600">
      <h2 class="font-bold text-slate-900">What this test can tell you</h2>
      <p>PayPal decides whether to display card funding or guest credit/debit card checkout. Availability can vary by buyer, region, merchant configuration, and other eligibility checks. Card funding eligibility does not guarantee a guest checkout experience.</p>
      <p class="mt-2">Sandbox results are not proof of live-account eligibility. Actual availability requires Live credentials and separate, explicitly authorized Live testing. This project only supports Sandbox.</p>
    </aside>
  </main>
</template>

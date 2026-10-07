import type { PayPalFailure, PayPalOrderResponse, StoredPayPalOrder } from '../../../../utils/paypal'

export default defineEventHandler(async (event) => {
  requirePayPalTester(event)
  requireSameOrigin(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody(event)
  if (!/^[A-Z0-9]{10,32}$/.test(id) || typeof body?.proof !== 'string' || !/^[a-f0-9]{64}$/.test(body.proof)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid order or checkout proof.' })
  }
  const owner = paypalOwner(event)
  const storage = paypalStorage(event)
  const created = await storage.getItem<StoredPayPalOrder>(`orders:${body.proof}`)
  if (!created || created.id !== id || created.owner !== owner) {
    throw createError({ statusCode: 403, statusMessage: 'Order does not belong to this checkout session.' })
  }
  // Never select capture credentials from browser-supplied environment values.
  const environment = parsePayPalEnvironment(created.environment)
  paypalConfig(event, environment)
  return withPayPalLock(event, `capture-${environment}-${id}`, async (storage) => {
    // Canonical capture state is keyed by PayPal order, even if create retries yielded another proof.
    const key = `captures:${environment}:${id}`
    const stored = await storage.getItem<StoredPayPalOrder>(key) ?? created
    if (stored.id !== id || stored.environment !== environment || stored.owner !== owner) {
      throw createError({ statusCode: 409, statusMessage: 'Stored payment does not match this checkout.' })
    }
    let order: PayPalOrderResponse
    const lookupOnly = !!(stored.captureAttemptedAt || stored.result)
    if (lookupOnly) {
      // A lost response may hide a completed charge. Reconcile; never send a second capture.
      order = await paypalRequest<PayPalOrderResponse>(event, environment, `/v2/checkout/orders/${id}`)
    } else {
      // Persist BEFORE dispatch. A crash or timeout must not turn a retry into another charge.
      stored.captureAttemptedAt = Date.now()
      await storage.setItem(key, stored)
      try {
        order = await paypalRequest<PayPalOrderResponse>(event, environment, `/v2/checkout/orders/${id}/capture`, {}, `capture-${environment}-${id}`)
      } catch (error: unknown) {
        // paypalRequest constructs this minimal metadata; never store raw upstream errors.
        const failure = (error as { data?: { paypalFailure?: PayPalFailure } })?.data?.paypalFailure
        if (failure) {
          stored.captureFailure = failure
          // The pre-dispatch marker is already durable. Preserve the original error
          // even if storage/lease loss prevents saving optional diagnostic metadata.
          await storage.setItem(key, stored).catch(() => {})
        }
        throw error
      }
    }
    stored.result = validatePayPalCapture(order, stored, lookupOnly ? 'fresh-paypal-lookup' : 'paypal-response')
    await storage.setItem(key, stored)
    return stored.result
  })
})

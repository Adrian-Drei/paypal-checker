import type { PayPalCaptureResponse, PayPalOrderResponse, StoredPayPalOrder } from '../../../../utils/paypal'

// This route performs only PayPal GETs and Redis reads, even for an uncaptured order.
export default defineEventHandler(async (event) => {
  requirePayPalTester(event)
  requireSameOrigin(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody(event)
  if (!/^[A-Z0-9]{10,32}$/.test(id) || typeof body?.proof !== 'string' || !/^[a-f0-9]{64}$/.test(body.proof)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid order or checkout proof.' })
  }
  const storage = paypalStorage(event)
  const created = await storage.getItem<StoredPayPalOrder>(`orders:${body.proof}`)
  const owner = paypalOwner(event)
  if (!created || created.id !== id || created.owner !== owner) {
    throw createError({ statusCode: 403, statusMessage: 'Order does not belong to this checkout session.' })
  }
  const environment = parsePayPalEnvironment(created.environment)
  const stored = await storage.getItem<StoredPayPalOrder>(`captures:${environment}:${id}`) ?? created
  if (stored.id !== id || stored.environment !== environment || stored.owner !== owner) {
    throw createError({ statusCode: 409, statusMessage: 'Stored payment does not match this checkout.' })
  }
  const order = await paypalRequest<PayPalOrderResponse>(event, environment, `/v2/checkout/orders/${id}`)
  const result = validatePayPalCapture(order, stored, 'fresh-paypal-lookup')
  const capture = await paypalRequest<PayPalCaptureResponse>(event, environment, `/v2/payments/captures/${result.captureId}`)
  return validatePayPalCaptureDetails(capture, result)
})

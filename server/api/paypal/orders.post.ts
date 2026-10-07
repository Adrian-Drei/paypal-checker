import { createHash } from 'node:crypto'

export default defineEventHandler(async (event) => {
  requireSameOrigin(event)
  paypalConfig(event)
  const body = await readBody(event)
  if (typeof body?.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.requestId)) {
    throw createError({ statusCode: 400, statusMessage: 'A checkout request ID is required.' })
  }
  const requestId = createHash('sha256').update(`${sessionId(event)}:${body.requestId}`).digest('hex').slice(0, 32)
  const order = await paypalRequest<{ id?: string; status?: string }>(event, '/v2/checkout/orders', {
    intent: 'CAPTURE', purchase_units: [{ reference_id: 'sandbox-test-product', description: 'Sandbox test product', amount: product }],
    payment_source: { paypal: { experience_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' } } }
  }, `new-${requestId}`)
  if (!order.id || !/^[A-Z0-9]{10,32}$/.test(order.id) || !['CREATED', 'APPROVED', 'PAYER_ACTION_REQUIRED'].includes(order.status ?? '')) {
    throw createError({ statusCode: 502, statusMessage: 'Invalid Sandbox order response.' })
  }
  return { id: order.id, proof: signature(event, order.id) }
})

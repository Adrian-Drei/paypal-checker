import { createHash, randomBytes } from 'node:crypto'
import type { StoredPayPalOrder } from '../../utils/paypal'

interface CreateAttempt { startedAt: number; order?: { id: string; proof: string; environment: 'sandbox' | 'live' } }

export default defineEventHandler(async (event) => {
  requirePayPalTester(event)
  requireSameOrigin(event)
  const body = await readBody(event)
  const environment = parsePayPalEnvironment(body?.environment)
  paypalConfig(event, environment)
  if (environment === 'live' && body?.liveConfirmed !== true) {
    throw createError({ statusCode: 400, statusMessage: 'Explicit confirmation is required before opening Live checkout. Approval will charge USD 1.00.' })
  }
  if (typeof body?.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.requestId)) {
    throw createError({ statusCode: 400, statusMessage: 'A checkout request ID is required.' })
  }
  const owner = paypalOwner(event)
  const requestId = createHash('sha256').update(`${environment}:${owner}:${body.requestId}`).digest('hex').slice(0, 32)
  return withPayPalLock(`new-${requestId}`, async () => {
    const storage = useStorage('paypal')
    const key = `attempts:${requestId}`
    const attempt = await storage.getItem<CreateAttempt>(key) ?? { startedAt: Date.now() }
    if (attempt.order) return attempt.order
    // Bound retries conservatively; upstream idempotency keys are not permanent storage.
    if (Date.now() - attempt.startedAt > 60 * 60 * 1000) {
      throw createError({ statusCode: 409, statusMessage: 'Checkout attempt expired. Reload before creating a new order.' })
    }
    await storage.setItem(key, attempt)
    const order = await paypalRequest<{ id?: string; status?: string }>(event, environment, '/v2/checkout/orders', {
      intent: 'CAPTURE', purchase_units: [{ reference_id: productReference, description: 'USD 1.00 checkout test', amount: product }],
      payment_source: { paypal: { experience_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' } } }
    }, `new-${requestId}`)
    if (!order.id || !/^[A-Z0-9]{10,32}$/.test(order.id) || !['CREATED', 'APPROVED', 'PAYER_ACTION_REQUIRED'].includes(order.status ?? '')) {
      throw createError({ statusCode: 502, statusMessage: 'Invalid PayPal order response.' })
    }
    const proof = randomBytes(32).toString('hex')
    await storage.setItem(`orders:${proof}`, { id: order.id, environment, owner, createdAt: Date.now() } satisfies StoredPayPalOrder)
    attempt.order = { id: order.id, proof, environment }
    await storage.setItem(key, attempt)
    return attempt.order
  })
})

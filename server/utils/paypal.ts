import { createHash, randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'

export type PayPalEnvironment = 'sandbox' | 'live'
export const product = { currency_code: 'USD', value: '1.00' } as const
export const productReference = 'checkout-test-product'
export type CaptureResult = { orderId: string; captureId: string; environment: PayPalEnvironment; status: 'COMPLETED'; amount: typeof product }
export interface StoredPayPalOrder {
  id: string
  environment: PayPalEnvironment
  owner: string
  createdAt: number
  captureAttemptedAt?: number
  result?: CaptureResult
}
export interface PayPalOrderResponse {
  id?: string
  status?: string
  purchase_units?: Array<{
    reference_id?: string
    payments?: { captures?: Array<{ id?: string; status?: string; amount?: { currency_code?: string; value?: string } }> }
  }>
}

export function parsePayPalEnvironment(value: unknown): PayPalEnvironment {
  if (value === undefined) return 'sandbox'
  if (value !== 'sandbox' && value !== 'live') {
    throw createError({ statusCode: 400, statusMessage: 'Environment must be sandbox or live.' })
  }
  return value
}

export function paypalConfig(event: H3Event, environment: PayPalEnvironment) {
  const config = useRuntimeConfig(event)
  // Fail closed: accept only the explicit boolean true (Nuxt may deserialize env values).
  if (environment === 'live' && String(config.paypalLiveTestEnabled) !== 'true') {
    throw createError({ statusCode: 403, statusMessage: 'Live testing is disabled on this server.' })
  }
  const clientId = environment === 'live' ? config.public.paypalLiveClientId : config.public.paypalSandboxClientId
  const secret = environment === 'live' ? config.paypalLiveClientSecret : config.paypalSandboxClientSecret
  if (!clientId || !secret) {
    throw createError({ statusCode: 503, statusMessage: `Configure ${environment} credentials locally and restart Nuxt.` })
  }
  return { clientId, secret, base: environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com' }
}

export function requireSameOrigin(event: H3Event) {
  const origin = getHeader(event, 'origin')
  if (!origin || origin !== getRequestURL(event).origin) {
    throw createError({ statusCode: 403, statusMessage: 'Same-origin requests required.' })
  }
  setHeader(event, 'Cache-Control', 'no-store')
}

export function sessionId(event: H3Event) {
  const current = getCookie(event, 'paypal-test-session')
  if (current && /^[a-f0-9-]{36}$/.test(current)) return current
  const id = randomUUID()
  setCookie(event, 'paypal-test-session', id, {
    httpOnly: true, sameSite: 'strict', secure: getRequestURL(event).protocol === 'https:', path: '/api/paypal', maxAge: 21600
  })
  return id
}

export function paypalOwner(event: H3Event) {
  return createHash('sha256').update(sessionId(event)).digest('hex')
}

export function validatePayPalCapture(order: PayPalOrderResponse, stored: StoredPayPalOrder): CaptureResult {
  const units = order.purchase_units
  const captures = units?.[0]?.payments?.captures
  const capture = captures?.[0]
  if (order.id !== stored.id || order.status !== 'COMPLETED' || units?.length !== 1
    || units[0]?.reference_id !== productReference || captures?.length !== 1
    || !capture?.id || capture.status !== 'COMPLETED'
    || capture.amount?.currency_code !== product.currency_code || capture.amount.value !== product.value) {
    throw createError({ statusCode: 422, statusMessage: 'Capture is not verified as COMPLETED for USD 1.00. Check the seller account; do not assume success or start another payment.' })
  }
  return { orderId: stored.id, captureId: capture.id, environment: stored.environment, status: 'COMPLETED', amount: product }
}

export async function paypalRequest<T>(event: H3Event, environment: PayPalEnvironment, path: string, body?: Record<string, unknown>, requestId?: string): Promise<T> {
  const config = paypalConfig(event, environment)
  try {
    const token = await $fetch<{ access_token: string }>(`${config.base}/v1/oauth2/token`, {
      method: 'POST', timeout: 15000, retry: 0,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }, body: 'grant_type=client_credentials'
    })
    if (!token.access_token) throw new Error('Missing token')
    const response = await $fetch.raw<T>(`${config.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST', timeout: 20000, retry: 0,
      headers: { Authorization: `Bearer ${token.access_token}`, ...(requestId ? { 'PayPal-Request-Id': requestId } : {}), Prefer: 'return=representation' },
      body
    })
    if (!response._data) throw new Error('Missing PayPal response')
    // External API data is validated by the handlers, not Nitro route inference.
    return response._data as T
  } catch {
    // Never expose/log upstream request objects, credentials, tokens or buyer/card data.
    throw createError({ statusCode: 502, statusMessage: `PayPal ${environment} request failed. If capture was attempted, check its status and the seller account before another payment.` })
  }
}

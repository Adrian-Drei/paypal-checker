import { createHash, randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'

export type PayPalEnvironment = 'sandbox' | 'live'
export const product = { currency_code: 'USD', value: '1.00' } as const
export const productReference = 'checkout-test-product'
export type CaptureResult = { orderId: string; captureId: string; environment: PayPalEnvironment; status: 'COMPLETED'; amount: typeof product; recipientMerchantId: string | null; verificationSource: 'paypal-response' | 'fresh-paypal-lookup'; verifiedAt: string }
export interface PayPalFailure { issue?: string; debugId?: string; stage: string }
const failureExplanations: Record<string, string> = {
  INSTRUMENT_DECLINED: 'PayPal declined the buyer funding source.',
  ORDER_NOT_APPROVED: 'The buyer has not approved this order.',
  PAYER_CANNOT_PAY: 'This buyer account cannot pay for this order.',
  PAYEE_ACCOUNT_RESTRICTED: 'The seller account is restricted.',
  PAYEE_ACCOUNT_NOT_VERIFIED: 'The seller account needs verification.',
  TRANSACTION_REFUSED: 'PayPal refused this transaction.',
  COMPLIANCE_VIOLATION: 'PayPal blocked the transaction for compliance review.',
  ORDER_ALREADY_CAPTURED: 'PayPal reports this order was already captured. Reconcile its status.',
  PAYMENT_DENIED: 'PayPal denied this payment.',
  CANNOT_PAY_SELF: 'The buyer and seller must be different accounts.',
  ORDER_EXPIRED: 'The PayPal order has expired.'
}
function failureDescription(failure?: PayPalFailure) {
  const issue = failure?.issue
  const reason = issue && Object.hasOwn(failureExplanations, issue) ? ` PayPal code: ${issue}. ${failureExplanations[issue]}` : ''
  const debugId = failure?.debugId
  return reason + (debugId && /^[a-zA-Z0-9-]{1,64}$/.test(debugId) ? ` PayPal support reference: ${debugId}.` : '')
}
export interface StoredPayPalOrder {
  id: string
  environment: PayPalEnvironment
  owner: string
  createdAt: number
  captureAttemptedAt?: number
  captureFailure?: PayPalFailure
  result?: CaptureResult
}
export interface PayPalOrderResponse {
  id?: string
  status?: string
  purchase_units?: Array<{
    reference_id?: string
    payee?: { merchant_id?: string }
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

export function validatePayPalCapture(order: PayPalOrderResponse, stored: StoredPayPalOrder, source: CaptureResult['verificationSource'] = 'paypal-response'): CaptureResult {
  const units = order.purchase_units
  const captures = units?.[0]?.payments?.captures
  const capture = captures?.[0]
  if (order.id !== stored.id || order.status !== 'COMPLETED' || units?.length !== 1
    || units[0]?.reference_id !== productReference || captures?.length !== 1
    || !capture?.id || !/^[A-Z0-9]{1,36}$/.test(capture.id) || capture.status !== 'COMPLETED'
    || (stored.result && (stored.result.orderId !== stored.id || stored.result.environment !== stored.environment || stored.result.captureId !== capture.id))
    || capture.amount?.currency_code !== product.currency_code || capture.amount.value !== product.value) {
    const orderStatus = ['CREATED', 'SAVED', 'APPROVED', 'VOIDED', 'COMPLETED', 'PAYER_ACTION_REQUIRED'].includes(order.status ?? '') ? order.status : 'UNKNOWN'
    const captureStatus = ['COMPLETED', 'DECLINED', 'PENDING', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(capture?.status ?? '') ? capture?.status : capture ? 'UNKNOWN' : 'NONE_REPORTED'
    throw createError({ statusCode: 422, statusMessage: `Capture is not verified as COMPLETED for USD 1.00. Order status: ${orderStatus}; capture status: ${captureStatus}.${failureDescription(stored.captureFailure)} Check the seller account; do not assume success or start another payment.` })
  }
  const merchantId = units[0]?.payee?.merchant_id
  return { orderId: stored.id, captureId: capture.id, environment: stored.environment, status: 'COMPLETED', amount: product,
    recipientMerchantId: typeof merchantId === 'string' && /^[A-Z0-9]{1,36}$/.test(merchantId) ? merchantId : null,
    verificationSource: source, verifiedAt: new Date().toISOString() }
}

export interface PayPalCaptureResponse {
  id?: string
  status?: string
  amount?: { currency_code?: string; value?: string }
  payee?: { merchant_id?: string }
  supplementary_data?: { related_ids?: { order_id?: string } }
}

export function validatePayPalCaptureDetails(capture: PayPalCaptureResponse, result: CaptureResult): CaptureResult {
  const merchantId = capture.payee?.merchant_id
  if (capture.id !== result.captureId || capture.status !== 'COMPLETED'
    || capture.amount?.currency_code !== product.currency_code || capture.amount.value !== product.value
    || capture.supplementary_data?.related_ids?.order_id !== result.orderId
    || (merchantId && result.recipientMerchantId && merchantId !== result.recipientMerchantId)) {
    throw createError({ statusCode: 422, statusMessage: 'PayPal capture lookup does not match this completed USD 1.00 order. Check the seller account before another payment.' })
  }
  return result
}

export async function paypalRequest<T>(event: H3Event, environment: PayPalEnvironment, path: string, body?: Record<string, unknown>, requestId?: string): Promise<T> {
  const config = paypalConfig(event, environment)
  let stage = 'authentication'
  try {
    const token = await $fetch<{ access_token: string }>(`${config.base}/v1/oauth2/token`, {
      method: 'POST', timeout: 15000, retry: 0,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }, body: 'grant_type=client_credentials'
    })
    if (!token.access_token) throw new Error('Missing token')
    stage = path.endsWith('/capture') ? 'capture' : body === undefined ? 'order status check' : 'order creation'
    const response = await $fetch.raw<T>(`${config.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST', timeout: 20000, retry: 0,
      headers: { Authorization: `Bearer ${token.access_token}`, ...(requestId ? { 'PayPal-Request-Id': requestId } : {}), Prefer: 'return=representation' },
      body
    })
    if (!response._data) throw new Error('Missing PayPal response')
    // External API data is validated by the handlers, not Nitro route inference.
    return response._data as T
  } catch (error: unknown) {
    // Never expose/log upstream request objects, credentials, tokens or buyer/card data.
    const upstream = error as { status?: number; statusCode?: number; data?: { error?: unknown; name?: unknown; debug_id?: unknown; details?: Array<{ issue?: unknown }> } }
    // Only documented codes and our own explanations may reach the browser.
    const explanations = failureExplanations
    const details = upstream?.data?.details
    const issue = Array.isArray(details) ? details.map(detail => detail?.issue).find(value => typeof value === 'string' && Object.hasOwn(explanations, value)) : undefined
    const explanation = typeof issue === 'string' ? `PayPal code: ${issue}. ${explanations[issue]}` : undefined
    const status = upstream?.statusCode ?? upstream?.status
    const authenticationFailed = stage === 'authentication' && (status === 401 || upstream?.data?.error === 'invalid_client')
    const reason = authenticationFailed
      ? `Check that the ${environment} Client ID and Secret belong to the same PayPal app and are configured in this deployment.`
      : explanation ?? (status === 422 ? 'PayPal rejected the request. Check the seller account configuration and payment approval.'
        : status === 403 ? 'PayPal denied this operation. Check the app and seller permissions.'
          : 'PayPal could not complete the request. Check connectivity and PayPal service availability.')
    const debugId = upstream?.data?.debug_id
    const reference = typeof debugId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(debugId) ? ` PayPal support reference: ${debugId}.` : ''
    const guidance = stage === 'authentication' ? ' No payment request was sent by this call.'
      : stage === 'order creation' ? ' This call does not capture or charge a payment.'
        : ' Use Check capture status for this order before starting another payment.'
    const failure: PayPalFailure = { stage, ...(typeof issue === 'string' ? { issue } : {}), ...(reference ? { debugId: debugId as string } : {}) }
    throw createError({ statusCode: 502, statusMessage: `PayPal ${environment} ${stage} failed. ${reason}${guidance}${reference}`, data: { paypalFailure: failure } })
  }
}

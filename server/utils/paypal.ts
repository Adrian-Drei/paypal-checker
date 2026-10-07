import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'

export const product = { currency_code: 'USD', value: '1.00' } as const

export function paypalConfig(event: H3Event) {
  const config = useRuntimeConfig(event)
  if (config.paypalEnv !== 'sandbox') {
    throw createError({ statusCode: 503, statusMessage: 'This test supports Sandbox only.' })
  }
  if (!config.public.paypalClientId || !config.paypalClientSecret) {
    throw createError({ statusCode: 503, statusMessage: 'Configure Sandbox credentials locally and restart Nuxt.' })
  }
  return config
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

export function signature(event: H3Event, value: string) {
  return createHmac('sha256', paypalConfig(event).paypalClientSecret).update(`${sessionId(event)}:${value}`).digest('hex')
}

export function verifyOrder(event: H3Event, id: string, proof: string) {
  const expected = signature(event, id)
  if (!/^[a-f0-9]{64}$/.test(proof) || !timingSafeEqual(Buffer.from(expected), Buffer.from(proof))) {
    throw createError({ statusCode: 403, statusMessage: 'Order does not belong to this checkout session.' })
  }
}

export async function paypalRequest<T>(event: H3Event, path: string, body: unknown, requestId: string): Promise<T> {
  const config = paypalConfig(event)
  const base = 'https://api-m.sandbox.paypal.com'
  try {
    const token = await $fetch<{ access_token: string }>(`${base}/v1/oauth2/token`, {
      method: 'POST', timeout: 15000, retry: 0,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.public.paypalClientId}:${config.paypalClientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }, body: 'grant_type=client_credentials'
    })
    if (!token.access_token) throw new Error('Missing token')
    const response = await $fetch.raw<T>(`${base}${path}`, {
      method: 'POST', timeout: 20000, retry: 0,
      headers: { Authorization: `Bearer ${token.access_token}`, 'PayPal-Request-Id': requestId, Prefer: 'return=representation' },
      body: body as Record<string, unknown>
    })
    if (!response._data) throw new Error('Missing PayPal response')
    // This external API is not a Nitro route. Handlers validate its response at runtime.
    return response._data as T
  } catch {
    // Never expose or log the upstream request, credentials, tokens, or buyer data.
    throw createError({ statusCode: 502, statusMessage: 'PayPal Sandbox request failed. Check local credentials or retry the same operation.' })
  }
}

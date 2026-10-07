import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'

const testerCookie = 'paypal-tester-auth'
const sessionSeconds = 6 * 60 * 60
function equal(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

export function testerConfig(event: H3Event) {
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow')
  const config = useRuntimeConfig(event)
  if (!config.paypalTesterUsername || !config.paypalTesterPassword) {
    throw createError({ statusCode: 503, statusMessage: 'Set NUXT_PAYPAL_TESTER_USERNAME and NUXT_PAYPAL_TESTER_PASSWORD locally, then restart the server.' })
  }
  const url = getRequestURL(event)
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw createError({ statusCode: 403, statusMessage: 'Tester access requires HTTPS outside localhost.' })
  }
  return config
}

function sign(config: ReturnType<typeof testerConfig>, payload: string) {
  return createHmac('sha256', config.paypalTesterPassword).update(`${config.paypalTesterUsername}:${payload}`).digest('hex')
}

export function requirePayPalTester(event: H3Event) {
  const config = testerConfig(event)
  const cookie = getCookie(event, testerCookie) ?? ''
  const parts = cookie.split('.')
  const [payload, signature] = parts
  if (parts.length === 2 && payload && signature && cookie.length < 1024 && equal(signature, sign(config, payload))) {
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      if (typeof data.exp === 'number' && data.exp > Date.now() && data.exp <= Date.now() + sessionSeconds * 1000 && typeof data.nonce === 'string') return
    } catch { /* Invalid sessions are rejected without logging their contents. */ }
  }
  // No WWW-Authenticate header: authentication is handled by the in-app modal.
  throw createError({ statusCode: 401, statusMessage: 'Authorized tester sign-in required.' })
}

const failures = new Map<string, { count: number; reset: number }>()
export function signInPayPalTester(event: H3Event, username: unknown, password: unknown) {
  const config = testerConfig(event)
  const ip = getRequestIP(event) ?? 'local'
  const now = Date.now()
  for (const [key, entry] of failures) if (entry.reset <= now) failures.delete(key)
  const entry = failures.get(ip)
  if (entry && entry.count >= 10) {
    setHeader(event, 'Retry-After', Math.ceil((entry.reset - now) / 1000))
    throw createError({ statusCode: 429, statusMessage: 'Too many sign-in attempts. Please try again later.' })
  }
  const validUsername = typeof username === 'string' && username.length <= 256 && equal(username, config.paypalTesterUsername)
  const validPassword = typeof password === 'string' && password.length <= 4096 && equal(password, config.paypalTesterPassword)
  if (!validUsername || !validPassword) {
    failures.set(ip, { count: (entry?.count ?? 0) + 1, reset: entry?.reset ?? now + 15 * 60 * 1000 })
    throw createError({ statusCode: 401, statusMessage: 'Incorrect tester username or password.' })
  }
  failures.delete(ip)
  const payload = Buffer.from(JSON.stringify({ exp: now + sessionSeconds * 1000, nonce: randomBytes(24).toString('hex') })).toString('base64url')
  setCookie(event, testerCookie, `${payload}.${sign(config, payload)}`, {
    httpOnly: true, sameSite: 'strict', secure: getRequestURL(event).protocol === 'https:', path: '/', maxAge: sessionSeconds
  })
}

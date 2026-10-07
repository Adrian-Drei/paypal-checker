import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

// Local built-server checks with throwaway credentials; no PayPal API/SDK requests.
const password = randomBytes(32).toString('hex')
const sandboxSecret = randomBytes(32).toString('hex')
const liveSecret = randomBytes(32).toString('hex')
const port = randomInt(20000, 40000)
const base = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, ['.output/server/index.mjs'], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
    NUXT_PAYPAL_TESTER_USERNAME: 'smoke-tester', NUXT_PAYPAL_TESTER_PASSWORD: password,
    NUXT_PUBLIC_PAYPAL_SANDBOX_CLIENT_ID: 'smoke-sandbox-id', NUXT_PAYPAL_SANDBOX_CLIENT_SECRET: sandboxSecret,
    NUXT_PUBLIC_PAYPAL_LIVE_CLIENT_ID: 'smoke-live-id', NUXT_PAYPAL_LIVE_CLIENT_SECRET: liveSecret,
    NUXT_PAYPAL_LIVE_TEST_ENABLED: 'false'
  }
})
let serverErrors = ''
child.stderr.on('data', chunk => { serverErrors += chunk.toString() })
const request = (path, init = {}) => fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5000) })
const formHeaders = { Origin: base, 'Content-Type': 'application/json' }
try {
  let ready = false
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await request('/sign-in'); ready = true; break } catch { await delay(100) }
  }
  assert.ok(ready, 'Built server started')
  const lockedPage = await request('/', { redirect: 'manual' })
  assert.equal(lockedPage.status, 302)
  assert.equal(lockedPage.headers.get('location'), '/sign-in')
  assert.equal(lockedPage.headers.get('www-authenticate'), null)
  const signIn = await request('/sign-in')
  assert.equal(signIn.status, 200)
  assert.ok((await signIn.text()).includes('Welcome back'))
  for (const path of ['/api/paypal/access', '/api/paypal/config']) {
    const response = await request(path)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('www-authenticate'), null)
  }
  const bad = await request('/api/paypal/login', { method: 'POST', headers: formHeaders, body: JSON.stringify({ username: 'smoke-tester', password: 'wrong' }) })
  assert.equal(bad.status, 401)
  assert.equal(bad.headers.get('www-authenticate'), null)
  const crossOrigin = await request('/api/paypal/login', { method: 'POST', headers: { ...formHeaders, Origin: 'https://other.example' }, body: '{}' })
  assert.equal(crossOrigin.status, 403)
  const login = await request('/api/paypal/login', { method: 'POST', headers: formHeaders, body: JSON.stringify({ username: 'smoke-tester', password }) })
  assert.equal(login.status, 200)
  const authCookie = login.headers.getSetCookie().find(cookie => cookie.startsWith('paypal-tester-auth='))
  assert.ok(authCookie.includes('HttpOnly') && authCookie.includes('SameSite=Strict'))
  const headers = { Cookie: authCookie.split(';')[0] }
  const redirect = await request('/paypal-test', { headers, redirect: 'manual' })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), '/')
  const page = await request('/', { headers })
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.ok(html.includes('Sandbox — no real money'))
  assert.ok(html.includes('>Live</button>') || html.includes('>live</button>'))
  assert.ok(html.includes('Sign out'))
  assert.ok([password, sandboxSecret, liveSecret].every(secret => !html.includes(secret)))
  assert.equal(page.headers.get('cache-control'), 'no-store')
  const config = await request('/api/paypal/config', { headers })
  assert.equal(config.status, 200)
  assert.deepEqual(await config.json(), { environment: 'sandbox', clientId: 'smoke-sandbox-id' })
  assert.equal((await request('/api/paypal/config?environment=live', { headers })).status, 403)
  assert.equal((await request('/api/paypal/config?environment=other', { headers })).status, 400)
  const deniedLive = await request('/api/paypal/orders', { method: 'POST', headers: { ...headers, ...formHeaders }, body: JSON.stringify({ environment: 'live', liveConfirmed: true, requestId: '12345678-1234-1234-1234-123456789012' }) })
  assert.equal(deniedLive.status, 403)
  const logout = await request('/api/paypal/logout', { method: 'POST', headers: { ...headers, Origin: base } })
  assert.equal(logout.status, 200)
  assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'))
  assert.equal((await request('/api/paypal/access')).status, 401)
  assert.equal(serverErrors.includes('[unhandled]'), false)
  console.log('HTTP smoke passed: sign-in redirect/modal, no browser auth challenge, login, cookie-protected checkout/APIs, logout, default Sandbox and disabled Live.')
} finally { child.kill() }

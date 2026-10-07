export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname
  if (path === '/' || path === '/sign-in' || /^\/paypal-test(?:\/|$)/.test(path)) {
    setHeader(event, 'Cache-Control', 'no-store')
    setHeader(event, 'X-Robots-Tag', 'noindex, nofollow')
  }
  // The page middleware redirects unauthenticated visitors to the sign-in modal.
  // Login is the only public payment API; all payment/configuration APIs stay protected.
  if (/^\/api\/paypal(?:\/|$)/.test(path) && path !== '/api/paypal/login') requirePayPalTester(event)
})

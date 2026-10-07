export default defineEventHandler((event) => {
  requirePayPalTester(event)
  requireSameOrigin(event)
  deleteCookie(event, 'paypal-tester-auth', { path: '/' })
  return { authorized: false }
})

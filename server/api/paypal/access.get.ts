export default defineEventHandler((event) => {
  requirePayPalTester(event)
  return { authorized: true }
})

export default defineEventHandler(async (event) => {
  requireSameOrigin(event)
  const body = await readBody(event)
  signInPayPalTester(event, body?.username, body?.password)
  return { authorized: true }
})

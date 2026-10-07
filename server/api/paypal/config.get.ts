export default defineEventHandler((event) => {
  paypalConfig(event)
  // Establish the session before the first create request, including lost-response retries.
  sessionId(event)
  setHeader(event, 'Cache-Control', 'no-store')
  return { sandbox: true }
})

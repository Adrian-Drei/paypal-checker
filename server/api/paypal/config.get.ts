export default defineEventHandler((event) => {
  requirePayPalTester(event)
  const environment = parsePayPalEnvironment(getQuery(event).environment)
  const config = paypalConfig(event, environment)
  sessionId(event)
  setHeader(event, 'Cache-Control', 'no-store')
  return { environment, clientId: config.clientId }
})

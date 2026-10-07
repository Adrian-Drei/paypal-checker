export default defineNuxtRouteMiddleware(async () => {
  try {
    await useRequestFetch()('/api/paypal/access')
  } catch (error) {
    const status = (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status
    if (status === 401 || status === 503) return navigateTo('/sign-in', { replace: true })
    throw error
  }
})

interface CaptureOrder {
  id?: string
  status?: string
  purchase_units?: Array<{
    reference_id?: string
    payments?: { captures?: Array<{ id?: string; status?: string; amount?: { currency_code?: string; value?: string } }> }
  }>
}

export default defineEventHandler(async (event) => {
  requireSameOrigin(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody(event)
  if (!/^[A-Z0-9]{10,32}$/.test(id) || typeof body?.proof !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'Invalid order or checkout proof.' })
  }
  verifyOrder(event, id, body.proof)
  const order = await paypalRequest<CaptureOrder>(event, `/v2/checkout/orders/${id}/capture`, {}, `capture-${id}`)
  const units = order.purchase_units
  const captures = units?.[0]?.payments?.captures
  const capture = captures?.[0]
  if (order.id !== id || order.status !== 'COMPLETED' || units?.length !== 1
    || units[0]?.reference_id !== 'sandbox-test-product' || captures?.length !== 1
    || !capture?.id || capture.status !== 'COMPLETED'
    || capture.amount?.currency_code !== product.currency_code || capture.amount.value !== product.value) {
    throw createError({ statusCode: 422, statusMessage: 'Capture was not verified as COMPLETED for USD 1.00. Do not assume payment success.' })
  }
  return { orderId: id, captureId: capture.id, status: 'COMPLETED', amount: product }
})

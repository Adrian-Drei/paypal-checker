# Sandbox capture investigation — 2026-10-07

Only OAuth authentication, PayPal GETs, and Redis reads were performed against configured services. No orders were created, captured, refunded, or deleted. Live settings and payment records were not changed. Responses below are actual HTTP response projections; authorization headers, tokens, buyer/payment-source details, seller email characters, and unrelated fields are redacted or omitted.

## PayPal evidence

Configured Sandbox Client ID/Secret authenticated successfully (OAuth HTTP 200). The server chooses `https://api-m.sandbox.paypal.com`. The SDK configuration endpoint and server authentication read the same `public.paypalSandboxClientId` runtime value. This verifies the configured pair and source-code wiring; the credentials and browser SDK of an independently deployed build were not inspected.

`GET https://api-m.sandbox.paypal.com/v2/checkout/orders/5KB98440M2294512U`

HTTP **200**, PayPal debug reference `f820242e88cdf`:

```json
{
  "id": "5KB98440M2294512U",
  "status": "COMPLETED",
  "intent": "CAPTURE",
  "create_time": "2026-10-07T18:43:31Z",
  "update_time": "2026-10-07T18:43:31Z",
  "purchase_units": [{
    "reference_id": "checkout-test-product",
    "amount": { "currency_code": "USD", "value": "1.00" },
    "payee": {
      "merchant_id": "R6N93DKXCFHH2",
      "email_address": "sb-***@business.example.com"
    },
    "payments": { "captures": [{
      "id": "034532093U329550E",
      "status": "COMPLETED",
      "amount": { "currency_code": "USD", "value": "1.00" },
      "create_time": "2026-10-07T18:43:31Z",
      "update_time": "2026-10-07T18:43:31Z"
    }] }
  }]
}
```

The response's `payment_source` object was named `paypal`; its contents are omitted. A card form was reported by the tester, but this lookup alone does not establish the exact funding source used within PayPal-hosted checkout.

`GET https://api-m.sandbox.paypal.com/v2/payments/captures/034532093U329550E`

HTTP **200**, PayPal debug reference `f442458d6b588`:

```json
{
  "id": "034532093U329550E",
  "status": "COMPLETED",
  "amount": { "currency_code": "USD", "value": "1.00" },
  "create_time": "2026-10-07T18:43:31Z",
  "update_time": "2026-10-07T18:43:31Z",
  "supplementary_data": {
    "related_ids": { "order_id": "5KB98440M2294512U" }
  },
  "payee": {
    "merchant_id": "R6N93DKXCFHH2",
    "email_address": "sb-***@business.example.com"
  }
}
```

Both responses associate the same completed USD 1.00 capture with the same order and recipient. The Business Sandbox account to inspect is merchant **R6N93DKXCFHH2**, not the Personal buyer account or an unrelated Sandbox seller. Locate that Business account in PayPal Developer's Sandbox accounts and sign in at `https://www.sandbox.paypal.com`. Match its account merchant ID and inspect Activity around **2026-10-07 18:43:31 UTC**. No explicit `payee`, merchant-ID override, or `PayPal-Auth-Assertion` is set by the create-order code; the recipient is selected through the configured Sandbox app credentials.

## Storage and code evidence

- Redis `captures:sandbox:5KB98440M2294512U` contains the exact reported order/capture IDs, environment Sandbox, COMPLETED status and USD 1.00. `captures:live:5KB98440M2294512U` is absent.
- A read-only scan found exactly one matching order-proof record and one matching create-attempt record. Proofs, owner hashes, namespace and authorization data were not exposed.
- Capture keys include environment and order ID. Create attempts hash environment, session owner and browser request UUID; order proofs are random. The reported result is not a cross-environment/key collision.
- Production app/server code contains no mocked PayPal responses, `PayPal-Mock-Response` headers, test fixture imports, or fallback success data. Mocks exist only under `tests/`, which is not imported by checkout routes.
- Confirmed hardening gap: the previous capture handler returned stored success without rechecking PayPal or validating the stored record/result against the current order. Fresh GET validation and canonical record/result identity checks now prevent that path. This gap did **not** cause this reported payment: independent fresh lookups confirm its recorded success.
- Diagnostics now display the recipient merchant ID and verification provenance. A dedicated authorized, session-bound verification route performs order/capture GETs only, checks the capture's related order, and never modifies Redis records.

## Conclusion and uncertainty

The payment is genuine in PayPal Sandbox and belongs to recipient **R6N93DKXCFHH2**. Redis and application mock data do not explain its absence from the Activity screen. Whether the tester is viewing that exact Business account remains unconfirmed. If the account merchant ID differs, that identifies the account mismatch; if it matches, the remaining issue is the Sandbox Activity display/account context and requires inspection there or PayPal support with the order/capture IDs and debug references above. An API success cannot prove which account is open in the tester's browser. No unsupported claim of Sandbox UI delay or guaranteed Live eligibility is made.

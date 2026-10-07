# PayPal Sandbox checkout test

Nuxt 4, TypeScript, Tailwind CSS 4, official PayPal JavaScript SDK v5 Buttons, and Orders v2 REST API. Visit `/paypal-test` for a fixed USD 1.00 test product.

## Local setup

Use Node 24.15 or newer compatible LTS. The installed Nuxt packages require a newer runtime than Node 20.12.

1. Sign in to [PayPal Developer](https://developer.paypal.com/dashboard/). Under **Apps & Credentials**, choose **Sandbox**, then create or select a REST application associated with your Sandbox business account.
2. Copy `.env.example` to `.env` locally. Fill `NUXT_PUBLIC_PAYPAL_CLIENT_ID` and `NUXT_PAYPAL_CLIENT_SECRET` from the **same Sandbox app**. Keep `NUXT_PAYPAL_ENV=sandbox`. Never commit `.env` or share the secret in chat. Rotate any previously exposed secret before using it.
3. Run `npm install`, then `npm run dev`. Open `http://localhost:3000/paypal-test`. Restart Nuxt after changing `.env`.
4. Run `npm run typecheck`, `npm test` (mocked server checks; no network/payments), and `npm run build` to validate changes.

Nuxt loads `.env` for local development/build. For a locally started built server, supply environment variables explicitly; `.output/server/index.mjs` does not automatically load `.env`. This is a server-backed app, not a static-only deployment.

## Buyer and checkout testing

In PayPal Developer, open **Testing Tools > Sandbox Accounts** (or **Sandbox > Test Accounts**). Select or create a **Personal** buyer account separate from the Business merchant account. View/edit the buyer account to find its Sandbox email and password. Use these in the PayPal Sandbox popup; do not use real payment details. See [Sandbox accounts](https://developer.paypal.com/sandbox-testing/accounts).

- **Approval and capture:** Click a payment button, sign in with the Sandbox personal buyer, and approve. Approval triggers the server capture endpoint. Success appears only after the server verifies the order ID, COMPLETED order/capture statuses, a single expected purchase unit/capture, and exactly USD 1.00. The page shows order and capture IDs. Inspect matching transactions in the Sandbox accounts.
- **Cancellation:** Close/cancel checkout before approval. Expect the cancellation message with no capture request. Try again using the buttons.
- **Configuration errors:** Leave credentials blank, or temporarily use an invalid Sandbox secret locally and restart. Expect configuration or PayPal request errors and no success message. Restore credentials afterward.
- **SDK/network errors:** Block `www.paypal.com/sdk/js` in browser developer tools and reload; expect an error (a hung script times out after 20 seconds). To test capture errors, block the local `/api/paypal/orders/*/capture` request before approving a Sandbox order. Unblock it and use **Retry capture of the same order**. Do not start another order when the outcome of a capture is uncertain; inspect the Sandbox transaction first.
- **Invalid requests:** Send a same-origin capture request with a malformed order ID or missing/invalid proof; expect 400/403 and no PayPal capture call. Browser-provided amount/currency fields are ignored when creating orders.
- **Card/guest inspection:** Observe the displayed card funding eligibility and available buttons. If PayPal offers a debit/credit-card path, inspect whether guest checkout is offered. Use only PayPal Sandbox test data. Do not force eligibility with buyer-country overrides or assume card eligibility guarantees guest checkout.

## Boundaries and implementation

**Sandbox — no real money. Sandbox results are not proof of live-account guest card checkout eligibility.** PayPal decides available funding methods and guest checkout based on merchant configuration, buyer context, region, risk checks, and other eligibility criteria. Live credentials and separate, explicitly authorized Live testing are required to check actual availability. This project rejects every environment other than `sandbox`; setting `live` does not enable real payments. Choose both credentials from the Sandbox tab; credential environment cannot be inferred reliably from a client ID.

`runtimeConfig.paypalClientSecret` and `paypalEnv` stay server-only; only the client ID is public. The server uses `https://api-m.sandbox.paypal.com`, obtains an OAuth token server-side, fixes the product amount, and sanitizes upstream errors without logging credentials, tokens, or buyer data. The SDK uses the matching public Sandbox client ID after the server confirms Sandbox configuration. `enable-funding=card` requests consideration of card funding; SDK eligibility still controls rendering.

Nuxt is explicitly inlined into the Nitro server bundle so the installed Nuxt version resolves its generated renderer data in production. A local HTTP smoke check verifies that the built `/paypal-test` page returns 200, missing credentials return 503, and cross-origin creation returns 403. No PayPal payment was initiated during implementation; approval, funding display, and capture still require manual Sandbox testing with your local credentials.

Create requests use a per-attempt browser UUID combined with an HttpOnly session cookie to derive `PayPal-Request-Id`. Retries within that attempt reuse it. Capture requests use a deterministic ID per order. PayPal retains idempotency keys for a limited period; this is not permanent transaction storage. A server HMAC binds created order IDs to the browser session, and capture requires this proof. Requests require a same-origin header. Reloading loses the in-memory order/proof: reconcile uncertain captures in Sandbox before creating another order. This minimal local test has no persistent order database, webhooks, production authentication, or rate limiting.

## Official references checked

- [JavaScript SDK v5 Buttons and callbacks](https://developer.paypal.com/sdk/js/v5/reference)
- [SDK v5 configuration and funding parameters](https://developer.paypal.com/sdk/js/v5/configuration)
- [Create order](https://developer.paypal.com/api/orders/v2/orders-create) and [capture order](https://developer.paypal.com/api/orders/v2/orders-capture)
- [REST idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)
- [Nuxt runtime config](https://nuxt.com/docs/4.x/guide/going-further/runtime-config) and [environment files](https://nuxt.com/docs/4.x/directory-structure/env)

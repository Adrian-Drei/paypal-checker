# PayPal Sandbox and Live checkout test

Nuxt 4, TypeScript, Tailwind CSS 4, official PayPal JavaScript SDK v5 Buttons, and Orders v2 REST API. `/` tests a server-fixed USD 1.00 product. Sandbox is always the initial selection. No credential values are committed.

## Local setup and authorized testers

Use Node 24.15+ compatible LTS (or Node 22.22.3+). Copy `.env.example` to `.env` locally; `.env` and `.data` are gitignored.

Fill these values locally, never in chat:

```dotenv
NUXT_PUBLIC_PAYPAL_SANDBOX_CLIENT_ID=
NUXT_PAYPAL_SANDBOX_CLIENT_SECRET=
NUXT_PUBLIC_PAYPAL_LIVE_CLIENT_ID=
NUXT_PAYPAL_LIVE_CLIENT_SECRET=
NUXT_PAYPAL_LIVE_TEST_ENABLED=false
NUXT_PAYPAL_TESTER_USERNAME=
NUXT_PAYPAL_TESTER_PASSWORD=
NUXT_PAYPAL_REDIS_REST_URL=
NUXT_PAYPAL_REDIS_REST_TOKEN=
NUXT_PAYPAL_REDIS_PREFIX=paypal-checker
```

In [PayPal Developer > Apps & Credentials](https://developer.paypal.com/dashboard/applications), select **Sandbox** and copy the Client ID and Secret from the same Sandbox REST app into the Sandbox variables. Select **Live** and copy the matching Live app credentials into the Live variables only if you intend to enable Live testing. Credential environment is not reliably inferred from the ID; use the correct Dashboard tab. Rotate any previously exposed secret. All secrets and the Live enable flag remain in server-only Nuxt runtime config; only Client IDs are public.

Set a tester username and a nonempty tester password; a unique random password of at least 24 characters is recommended. Share tester access only through your normal secure channel. Visiting `/` without a valid session redirects to `/sign-in`, which opens a styled sign-in modal. Use the configured tester credentials, separate from your PayPal account. Login issues a signed, HttpOnly, SameSite=Strict cookie lasting six hours (Secure over HTTPS). Sign out using the checkout page button. Changing tester credentials invalidates existing sessions. The public sign-in form never loads the PayPal SDK; payment and configuration endpoints remain protected. Incorrect login attempts are limited to ten per IP per fifteen minutes in the single server process.

Run `npm install`, then `npm run dev`, and open `http://localhost:3000/`. Outside localhost, HTTPS is required for the tester gate. If using a TLS-terminating reverse proxy, make sure the application sees HTTPS through your trusted deployment configuration; do not disable the check or trust arbitrary forwarded headers. Protect the tester endpoint additionally with your organization's access proxy if available.

## Enabling Live testing

Set both Live credential values and explicitly set `NUXT_PAYPAL_LIVE_TEST_ENABLED=true`. Restart the Nuxt process after changing local `.env`. In an existing hosted installation, update its server environment and restart/redeploy through your normal approved process; changing browser code or a query parameter cannot enable Live. This task does not deploy anything. Set the flag back to `false` and restart when done; new Live orders and captures/status requests are then rejected server-side.

Nuxt loads `.env` in development/build. A built server does not automatically load `.env`; supply the environment explicitly when running `node .output/server/index.mjs`. Do not statically generate this server-backed app. Payment records and operation locks use persistent Redis over HTTPS and are shared across Node processes and Vercel function instances. There is no filesystem, `/tmp`, or process-memory fallback for payment storage.

## Persistent Redis configuration for Vercel

1. Create/connect a persistent Upstash Redis database through the Vercel Marketplace or Upstash Console. Use a single-region primary database and keep **eviction disabled**. This is payment state, not disposable cache; do not use a read replica, temporary trial database, or automatically expiring dataset. Keep backups and monitor capacity/write failures.
2. In Vercel **Project Settings > Environment Variables**, set `NUXT_PAYPAL_REDIS_REST_URL` to its HTTPS REST URL and `NUXT_PAYPAL_REDIS_REST_TOKEN` to its read/write REST token. These are server-only. If the integration provides `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, copy their values into the matching `NUXT_PAYPAL_...` variables. Do not put tokens in public variables, URLs, source control, or chat.
3. Set `NUXT_PAYPAL_REDIS_PREFIX` to a stable project namespace, e.g. `paypal-checker-production`. All production instances and redeploys must use the same namespace/database; isolate Preview/development with a different database or prefix. Sandbox/Live attempt IDs and capture keys are separated within that namespace.
4. Add the same variables to local `.env` for development. Restart locally; redeploy Vercel through your approved process after setting server environment variables. No deployment is performed by this change. Missing Redis configuration returns a sanitized 503 before creating/capturing a payment.
5. The application uses Upstash REST JSON commands, atomic Lua operations, and per-request synchronization tokens. Related keys share a Redis Cluster hash tag. There are no local record caches. As with any distributed datastore, durability depends on the provider: preserve the primary database, eviction settings and backups; a cache reset or lost database cannot preserve duplicate-prevention records.

Old `.data/paypal` records are not automatically imported. Reconcile any uncertain existing transactions in the correct PayPal seller account before starting new tests; do not change request IDs or clear records to retry an uncertain capture.

## Environment switching and Live inspection

The visible **Sandbox** and **Live** buttons select the environment. Switching closes old PayPal buttons, removes the SDK script/namespace, clears the previous order/results and confirmation, and reloads the SDK with the matching Client ID. The SDK URL stays the official `https://www.paypal.com/sdk/js`; the selected Client ID determines its merchant context. The server independently chooses `https://api-m.sandbox.paypal.com` or `https://api-m.paypal.com`. Selecting Live only loads configuration and eligible buttons; it does not create an order or initiate a charge.

**Live mode — real payments:** each Live checkout click requires a confirmation explaining that approval will actually charge USD 1.00. You can confirm to open PayPal-hosted checkout and inspect the guest card path, then **cancel before approving payment**. No local card form or card data collection is implemented. If you approve, capture follows automatically; this is a real payment, not an authorization-only test. There is no automatic refund.

For guest checkout inspection:

1. Open a fresh incognito/private window, visit `/` directly, and authenticate as a tester. This reduces existing PayPal login/cookie effects; it does not guarantee guest eligibility.
2. Select Live after the server flag and credentials are configured. Inspect the buttons and the card-funding eligibility indicator.
3. Click a payment button and confirm the Live warning to open PayPal checkout. Look for the debit/credit-card or guest path offered by PayPal. Do not use Sandbox accounts/test card numbers in Live.
4. **Cancel before approval** to inspect without paying. If you deliberately approve, USD 1.00 is charged. Enter any card details only into PayPal-hosted UI.

PayPal decides eligibility. Guest checkout availability varies by buyer, location, device, merchant configuration, and PayPal risk checks. `enable-funding=card` asks PayPal to consider card funding only if eligible; no buyer-country override, forced eligibility, or guest-checkout promise is used. A card-funding indicator is not a guarantee of guest checkout. **Sandbox success does not prove Live-account guest card eligibility.**

## Approval, capture, cancellation, and errors

For Sandbox buyers, open [PayPal Developer > Sandbox accounts](https://developer.paypal.com/sandbox-testing/accounts), create/select a **Personal** account distinct from the merchant **Business** account, and view its Sandbox email/password. Use only Sandbox buyer accounts and PayPal's Sandbox test data in Sandbox.

- **Approval/capture:** approve using the correct environment's buyer. The server verifies the returned order ID, COMPLETED order and capture statuses, exactly one expected purchase unit/capture, and exactly USD 1.00 before showing success. The result displays its environment, order ID, and capture ID.
- **Verify in the seller account:** for Sandbox, sign in to the matching Sandbox Business seller at `https://www.sandbox.paypal.com` and inspect Activity. For Live, sign in to the actual seller account associated with the Live REST app at `https://www.paypal.com`, open Activity, and match the capture/transaction ID, amount, currency, and completed status. Live receipts, fees, and any manual refund must be reviewed in that actual seller account.
- **Cancellation:** close/cancel PayPal checkout before approval. The page reports cancellation and no capture request is sent. Switching is unlocked after cancellation.
- **Disabled/misconfigured Live:** leave the flag false or credentials blank. Live loading/order/capture requests must be rejected; an error is displayed. No API call to PayPal is made for a disabled environment.
- **Network/SDK errors:** block the SDK URL in browser developer tools and reload; expect an error (20-second SDK load timeout). Test payment API failures in Sandbox only. Temporarily block the local capture request, approve a Sandbox order, unblock it, then select **Check capture status**. If the first request never reached the server this may perform the first capture; after a recorded capture attempt, it only reconciles the existing order through PayPal GET.
- **Uncertain capture:** a timeout/error can hide a completed charge. Switching remains locked while a capture needs verification. Use **Check capture status** and verify the correct seller account. Never repeat payment just because a response was lost. **Reset after verifying seller account** explicitly acknowledges that you checked the outcome; it clears local state but does not refund/cancel a transaction. Browser reload also loses local state, so reconcile first.
- **Access controls:** unauthenticated checkout navigation redirects to `/sign-in`; payment/configuration APIs return 401 without a browser authentication challenge. Missing tester configuration is displayed as an inline sign-in error. Invalid environment values return 400. Login and payment writes require same-origin headers. Never log login bodies, cookies, or authorization headers in application/proxy logs.

## Server safety and checks

The server stores order ID, environment, session-owner hash, capture-attempt timestamp, and the minimal validated result. No access tokens, credentials, card details, or full buyer responses are stored/logged. Browser-supplied prices are ignored. Capture takes an opaque checkout proof and order ID; environment is read from the server record, never the browser. Proofs are random, bound to an HttpOnly session cookie, and returned only to authorized testers. Preserve the session cookie when checking a capture.

Create request IDs include the environment and session, and are persisted with the proof before calling PayPal. Retries retain the same proof and `PayPal-Request-Id`, with a conservative one-hour retry limit for incomplete creates. A distributed Redis `SET NX PX` lease coordinates each create/capture across serverless instances. Lua scripts check the unique lease token atomically with every locked read/write, and only the owner may release the lock. Expired owners cannot overwrite results or delete replacement locks. Busy operations return a sanitized 409 after a short wait; retry the same operation. Capture permanently records its attempt before dispatch, caches verified results, and never sends a second capture POST for that record. A retry reconciles via PayPal GET. If a process dies after marking an attempt but before sending capture, verify the seller account before resetting. Records/attempt markers have no TTL; only leases expire. Redis outages return sanitized 503 errors and never fall back to local storage. Preserve storage and the namespace across redeploys.

Run sequentially with the supported Node runtime:

```sh
npm run typecheck
npm test
npm run build
npm run test:smoke
```

Tests mock PayPal and use no real payment credentials or PayPal network calls. When a Redis executable is available, the Redis integration test runs real Lua operations against an isolated local Redis with AOF persistence and verifies records survive restarts, concurrent independent instances capture once, both environment routes use matching credentials/endpoints, and stale lock writes/releases are rejected. Set `PAYPAL_TEST_REDIS_SERVER` to a Redis executable outside Laragon; without one, that integration test is explicitly skipped. This test dataset is separate from production Redis. Actual SDK eligibility/guest UI and end-to-end approval still need manual testing with configured accounts. Nuxt is explicitly inlined into the Nitro server bundle to resolve generated renderer data with the installed Nuxt version.

## Official references checked

- [PayPal SDK v5 Buttons, callbacks, and eligibility](https://developer.paypal.com/sdk/js/v5/reference)
- [SDK configuration, funding, Client IDs, and integration date](https://developer.paypal.com/sdk/js/v5/configuration)
- [PayPal REST environments and authentication](https://developer.paypal.com/api/rest/)
- [Orders v2 create](https://developer.paypal.com/api/orders/v2/orders-create), [capture](https://developer.paypal.com/api/orders/v2/orders-capture), and [order details](https://developer.paypal.com/api/orders/v2/orders-get)
- [REST idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)
- [Nuxt runtime config](https://nuxt.com/docs/4.x/guide/going-further/runtime-config)



- [Upstash REST API](https://upstash.com/docs/redis/features/restapi), [durability](https://upstash.com/docs/redis/features/durability), and [eviction settings](https://upstash.com/docs/redis/features/eviction)
- [Redis distributed locks](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/) and [Redis on Vercel](https://vercel.com/docs/redis)

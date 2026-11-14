# FU-GLIDE FOUNDER'S DIARY 2026 registration

The existing HTML/CSS/JavaScript registration site is served with Node.js and
Express. Registration data is stored in Firebase Cloud Firestore after payment
verification. Razorpay Checkout is used for the fixed ₹250 INR fee.

## Local development

1. Install Node.js 22 or newer and run `npm install`.
2. Copy `.env.example` to `.env` and set the variables described below. Keep
   `.env` out of source control.
3. For Firebase Admin credentials, set `FIREBASE_SERVICE_ACCOUNT` to the
   service-account JSON string, or use Application Default Credentials locally.
   The JSON file itself must not be committed.
4. Run `npm start` and open `http://localhost:3000`. Do not use a static-only
   development server because it cannot handle the payment API.
5. Run `npm test` for the automated tests. They mock Razorpay requests and do
   not make payments.

## Deploy to Vercel

1. Push this repository to GitHub.
2. In Vercel, choose **Add New → Project**, import the GitHub repository, and
   authorize access to it.
3. Keep the project root at the repository root and use the Express framework
   preset. Leave the Build Command and Output Directory empty; use the default
   install command (`npm install`). Vercel detects the Express app exported
   from `server.js` and serves `public/**` from the site root as CDN assets.
   `server.js` exports the Express app as the default function and also starts
   it for local `npm start`; `index.js` re-exports the same app.
   `vercel.json` configures the `server.js` function for a 30-second maximum
   duration and includes `index.html`. The same function handles `/api/*`
   routes and the Razorpay webhook, so no rewrite or separate `api/index.js`
   is needed.
4. Add the environment variables below in **Project Settings → Environment
   Variables**. Configure Test Mode values for Preview and Production until
   the complete test flow has been manually verified.
5. Deploy, then use the Vercel deployment URL for the Razorpay webhook URL.
   Vercel deployments receive updates when the connected Git branch is updated.
   See [VERCEL_ENV_SETUP.md](./VERCEL_ENV_SETUP.md) for variable requirements,
   sources, secret classification, and environment-specific setup.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `FIREBASE_PROJECT_ID` | Firebase project ID for Firestore. |
| `FIREBASE_SERVICE_ACCOUNT` | Full Firebase service-account JSON string for Vercel, or local Application Default Credentials. Do not use a file path as the value. |
| `REGISTRATION_LOCK_SECRET` | Long random secret used to derive duplicate-registration locks. Keep it stable across deployments and environments. |
| `RAZORPAY_MODE` | Defaults to `test`; set explicitly to `test` in every Vercel environment. |
| `RAZORPAY_KEY_ID` | Razorpay key ID matching the configured mode (`rzp_test_...` or, after deliberate activation, `rzp_live_...`). |
| `RAZORPAY_KEY_SECRET` | Matching Razorpay key secret. Server-side only. |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook secret configured for the corresponding Razorpay webhook endpoint. |
| `TRUST_PROXY` | Optional trusted-proxy hop count. Defaults to `0`; change only for a verified proxy topology. |
| `PORT` | Local development only; defaults to `3000`. Do not set it to route Vercel requests. |

Replace the applicable placeholders in `.env.example` before starting local
development. Leave `FIREBASE_SERVICE_ACCOUNT` empty only when local Application
Default Credentials are configured. Generate a lock secret locally with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### Firebase credentials and Firestore

In Firebase Console, enable Cloud Firestore and create a dedicated service
account with the read/write permissions needed for the registration
collections. Store the entire downloaded service-account JSON in Vercel as
`FIREBASE_SERVICE_ACCOUNT`; do not commit or publish the JSON file. The Admin
SDK normalizes escaped newlines in the private key. Locally, you may instead
use Application Default Credentials.

The browser never accesses Firestore. Keep the existing deny-all
`firestore.rules` deployed; Firebase Admin writes are authorized by the server
identity and bypass those client security rules. The service-account key must
never be placed in a `NEXT_PUBLIC_*`, `VITE_*`, or other browser-exposed
variable.

During checkout, a validated registration is kept in the server-only
`payment_attempts` collection so a verified Razorpay webhook can recover a
registration if the browser closes before confirmation. The details are
removed from the payment attempt after the registration is completed.
`payment_orders` maps Razorpay orders to their protected attempts, and
`webhook_events` makes webhook retries idempotent. These collections
are inaccessible to browser clients under the existing Firestore rules.

### Razorpay Test Mode and webhooks

1. In Razorpay Dashboard, use **Test Mode** and create a test API key pair.
   Set `RAZORPAY_MODE=test`, `RAZORPAY_KEY_ID` to the test key ID, and
   `RAZORPAY_KEY_SECRET` to the matching secret in Vercel.
2. Enable automatic payment capture in the Razorpay test account.
3. Add a webhook with URL
   `https://<your-vercel-domain>/api/webhooks/razorpay`. Subscribe to
   `payment.captured` and `payment.failed`. Generate a webhook secret and set
   the same value as `RAZORPAY_WEBHOOK_SECRET` in Vercel.
4. Redeploy after changing environment variables. Use Razorpay's test payment
   methods to confirm order creation, captured payment, registration
   confirmation, webhook recovery, and duplicate delivery handling.

The server creates orders at exactly 25000 paise / INR, verifies the checkout
HMAC, and independently checks the captured payment, order ID, amount, and
currency with Razorpay before creating a registration. The webhook signature
is checked against the exact raw request body.

The existing Express rate limiter uses its in-memory store, so its counts are
per serverless instance rather than globally shared. For high-volume or
production abuse protection, configure a Vercel Firewall rate limit or another
shared rate-limiting service. Set `TRUST_PROXY` only to a proxy hop count
verified for the deployment; do not blindly trust arbitrary forwarded headers.

### Custom domain

Add a domain under **Project Settings → Domains** and complete the DNS records
Vercel provides. Wait for the domain to become valid, then update the Razorpay
webhook URL to `https://<your-custom-domain>/api/webhooks/razorpay`. Keep the
Vercel deployment URL configured as well only if it is intentionally used for
testing.

### Enabling Live Mode

Live payments are not enabled automatically. First finish Test Mode verification
and review the Razorpay account's live activation requirements. To activate
live payments, deliberately set `RAZORPAY_MODE=live`, replace both Razorpay API
credentials with the matching Live Mode pair, configure a Live Mode webhook
and its separate webhook secret, and redeploy. The server rejects a key ID
whose prefix does not match the explicitly selected mode. Never mix test and
live credentials.

### Troubleshooting

- **Homepage loads but an API returns 503:** Firebase initialization is lazy;
  the homepage does not depend on Firebase. Check Vercel Function Logs for the
  initialization error, confirm `FIREBASE_PROJECT_ID` and
  `REGISTRATION_LOCK_SECRET`, and ensure `FIREBASE_SERVICE_ACCOUNT` contains
  valid JSON for the same project. Redeploy after changing variables.
- **An API returns 500 after initialization:** Verify the service account has
  Firestore access and inspect Vercel Function Logs for the failed database
  operation.
- **Order creation fails:** Confirm the Razorpay key pair matches
  `RAZORPAY_MODE` and the account is in Test Mode while testing.
- **Webhook returns 400:** Confirm the configured webhook secret matches
  `RAZORPAY_WEBHOOK_SECRET` and Razorpay is sending the raw request to the
  exact `/api/webhooks/razorpay` URL.
- **Payment succeeds but confirmation is delayed:** The browser retries
  server-side verification, and `payment.captured` webhook processing can
  recover the registration. Check Vercel Function Logs and Razorpay webhook
  delivery history before retrying payment.
- **Assets fail to load:** Keep `index.html` and `public/` at the repository
  root. Vercel maps files in `public/` to root URLs such as `/app.js`.

If any credential was previously committed or shared, rotate it in the
corresponding provider. Removing it from `.env.example` does not remove it from
Git history. Do not treat deployment as production-ready until the Firebase,
payment, webhook, and recovery flows have been verified in the target
environment.

See [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md) for the ordered
credential-rotation, deployment, Test Mode, and Live Mode checklist.

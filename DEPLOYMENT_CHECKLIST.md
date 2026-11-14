# Vercel deployment checklist

## Before deploying

- [ ] Use Node.js 22 or newer locally and in the deployment runtime.
- [ ] Inspect `.env.example` and confirm it contains no real values.
- [ ] Rotate the Razorpay Key ID and Key Secret previously present in Git history.
      Revoke the old key pair and use the replacement pair in Test Mode.
- [ ] If a Firebase service-account file or private key was included in any
      shared archive, revoke its old key in Google Cloud IAM and create a
      replacement service account key.
- [ ] If `REGISTRATION_LOCK_SECRET` was exposed, generate a replacement before
      launch. Do not rotate it after deployment without a controlled migration:
      it determines email locks used for duplicate registration protection.
- [ ] If `RAZORPAY_WEBHOOK_SECRET` was exposed, replace it in Razorpay and in
      Vercel.
- [ ] Generate a new lock secret with
      `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
      Store it securely and keep the same value in every deployment environment
      that shares the same Firestore data.
- [ ] Enable Cloud Firestore and create a dedicated server identity with
      read/write access to the registration collections.
- [ ] Add the service-account JSON to Vercel as `FIREBASE_SERVICE_ACCOUNT`.
      Do not upload the JSON file to GitHub or put the key in frontend code.
- [ ] Deploy the existing deny-all `firestore.rules`. Browser clients must not
      read or write registration, payment-attempt, order, or webhook documents.

## Vercel setup

- [ ] Push the project to GitHub and import that repository in Vercel.
- [ ] Set the project root to the repository root and select the Express
      framework preset.
- [ ] Leave the Build Command and Output Directory empty; use the default
      `npm install` install command.
- [ ] Add `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`,
      `REGISTRATION_LOCK_SECRET`, `RAZORPAY_MODE=test`,
      `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and
      `RAZORPAY_WEBHOOK_SECRET` to the required Vercel environments.
- [ ] Set `TRUST_PROXY` only to a value verified for the deployed proxy chain.
- [ ] Keep live Razorpay keys out of Preview and Production until the manual
      Test Mode flow below passes.
- [ ] Deploy and inspect Vercel Function Logs for configuration or runtime
      errors.

## Razorpay Test Mode verification

- [ ] Enable automatic payment capture in the Razorpay Test Mode account.
- [ ] Configure a webhook at
      `https://<deployment-domain>/api/webhooks/razorpay`.
- [ ] Subscribe to `payment.captured` and `payment.failed`, then set the
      webhook's secret as `RAZORPAY_WEBHOOK_SECRET`.
- [ ] Test an order and confirm it is fixed at 25000 paise / INR.
- [ ] Test payment failure and checkout cancellation; neither must create a
      paid registration.
- [ ] Complete a Test Mode payment and confirm registration appears only after
      server verification of signature, order, amount, currency, and captured
      status.
- [ ] Confirm the captured webhook can recover a registration if the browser
      does not complete verification.
- [ ] Retry the same webhook and payment verification; confirm no duplicate
      registration is created.
- [ ] Confirm invalid webhook signatures, wrong order IDs, wrong amounts,
      wrong currencies, and uncaptured payments are rejected.
- [ ] Check that submitted registration data is not present in browser URLs or
      browser storage.

## Domain and Live Mode

- [ ] If using a custom domain, add it in Vercel, complete the provided DNS
      records, and wait for domain validation.
- [ ] Update the Razorpay webhook URL to the final HTTPS domain and confirm
      successful delivery there.
- [ ] Review provider account permissions, key access, and Vercel environment
      scopes before launch.
- [ ] Only after all Test Mode checks pass, intentionally set
      `RAZORPAY_MODE=live`, replace both API credentials with the matching Live
      Mode pair, configure the separate Live Mode webhook secret and endpoint,
      then redeploy.
- [ ] Make a deliberate live activation decision in Razorpay. The application
      never switches itself to Live Mode.
- [ ] Monitor Vercel logs, Razorpay webhook delivery, and Firestore writes
      during the launch.

## Operational follow-up

- [ ] Consider a Firestore TTL/retention policy for abandoned unpaid attempts.
      Registration details are retained in `payment_attempts` while payment is
      pending so a delayed captured webhook can recover them; they are removed
      from that document after registration completes.
- [ ] Configure Vercel Firewall or a shared rate-limit store if global
      serverless rate limiting is required. Express's current in-memory limit
      is per function instance.
- [ ] Record the deployed Vercel URL, environment ownership, key-rotation
      procedure, and webhook endpoint in your operational records.

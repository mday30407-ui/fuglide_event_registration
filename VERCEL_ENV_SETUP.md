# Vercel environment setup

This guide documents the environment variables read by the application and how
to configure them safely. It contains placeholders and instructions only; no
Firebase or Razorpay credentials are included here.

## Variables used by the application

| Variable | Requirement | Secret? | Purpose and source |
| --- | --- | --- | --- |
| `FIREBASE_PROJECT_ID` | Required for Firestore-backed API operations | No | The Firebase project ID from [Firebase Console](https://console.firebase.google.com/) → Project settings. It must match the service account's `project_id` when present. |
| `FIREBASE_SERVICE_ACCOUNT` | Required on Vercel unless valid Application Default Credentials are configured | **Yes** | The complete service-account JSON value from a dedicated account created in [Google Cloud IAM](https://console.cloud.google.com/iam-admin/serviceaccounts). The application parses this value as JSON; it does not treat it as a file path. Grant only the Firestore permissions the server needs. |
| `REGISTRATION_LOCK_SECRET` | Required for Firestore-backed API operations | **Yes** | A stable, high-entropy secret used to derive duplicate-registration locks. Generate it yourself with a password manager or a cryptographically secure local tool, then store it securely. Do not rotate it after registrations exist without a migration plan. Use the same value wherever deployments share the same Firestore data. |
| `RAZORPAY_MODE` | Optional in code; set explicitly in every Vercel environment | No | Payment mode. The code defaults to `test`; use `test` initially. `live` must only be selected after manual approval and testing. |
| `RAZORPAY_KEY_ID` | Required for online order creation and verification | No (public identifier) | The API key ID from the [Razorpay Dashboard](https://dashboard.razorpay.com/) in the selected mode. Test IDs use the `rzp_test_` prefix. The ID is returned to the browser for Razorpay Checkout. |
| `RAZORPAY_KEY_SECRET` | Required for online order creation and verification | **Yes** | The secret paired with the key ID from the same Razorpay mode. It is used only by the server. |
| `RAZORPAY_WEBHOOK_SECRET` | Required to verify Razorpay webhooks | **Yes** | The signing secret configured for the corresponding webhook in the Razorpay Dashboard. It is separate from the API key secret. |
| `TRUST_PROXY` | Optional; defaults to `0` | No | Express trusted-proxy hop count. Leave at `0` unless the actual deployment proxy topology has been verified. |
| `PORT` | Local development only; defaults to `3000` | No | Port used by `npm start`. Vercel supplies the function runtime; do not set this to route Vercel requests. |

### Firebase Application Default Credentials fallback

When `FIREBASE_SERVICE_ACCOUNT` is empty, Firebase Admin uses Google
Application Default Credentials. During local development, the Google
authentication library may read `GOOGLE_APPLICATION_CREDENTIALS`, which is a
path to a local credentials file. The application does not read that variable
directly. Keep the referenced file out of Git. For Vercel, use the complete
`FIREBASE_SERVICE_ACCOUNT` JSON value unless you have deliberately configured
and verified an alternative runtime identity.

## Values to obtain or create manually

- **Firebase:** Obtain the project ID from Firebase Console. Create a dedicated
  service account with the necessary Firestore permissions and obtain its JSON
  key through Google Cloud IAM. The value for `FIREBASE_SERVICE_ACCOUNT` is the
  full JSON content, not `firebase-service-account.json` or another path.
- **Registration lock:** Create a random secret locally or with a password
  manager. Keep it private and stable for every deployment that shares the
  same Firestore collections. Do not put the generated value in this document
  or `.env.example`.
- **Razorpay:** Create an API key pair while Test Mode is selected. Configure
  the webhook in Test Mode and set its webhook secret independently. Do not
  copy Live Mode credentials into any environment during initial setup.

The `.env.example` file is only a template. Copy it to an ignored local `.env`
and replace the placeholders locally. Leave `FIREBASE_SERVICE_ACCOUNT` empty
only when local Application Default Credentials are configured. Never commit
`.env`, service-account JSON, private-key files, or secret values.

## Vercel environment scopes

Use Test Mode in **Production, Preview (including branch deployments), and
Development** until manual Test Mode verification is complete.

| Scope | Firebase configuration | Razorpay configuration |
| --- | --- | --- |
| Production | Production project ID, service-account JSON, and stable lock secret | `RAZORPAY_MODE=test`, matching Test Mode key ID/secret, and the secret for the Test Mode webhook targeting Production |
| Preview, including branches | Prefer a separate non-production Firebase project and service account. If it shares Firestore with Production, use the same lock secret. | `RAZORPAY_MODE=test`, Test Mode key ID/secret, and the secret for the Preview Test Mode webhook. Configure a webhook for a stable Preview URL if webhook recovery is being tested; use a different secret when the endpoint has a different webhook secret. |
| Development | Local project/service account or local Application Default Credentials; use an ignored `.env` | `RAZORPAY_MODE=test`, Test Mode key ID/secret, and the secret for a local Test Mode webhook when testing webhooks |

Set `TRUST_PROXY` only if required and verified. `PORT` is for local
development and is not needed in Vercel.

## Configure the Vercel project

1. Open the Vercel project and go to **Settings → Environment Variables**.
2. Add each variable by its exact name from the table above. Select the intended
   scope: **Production**, **Preview**, **Development**, or the scopes where it
   is needed.
3. Paste the entire Firebase service-account JSON into
   `FIREBASE_SERVICE_ACCOUNT`; do not enter a filename or upload the JSON into
   the repository. Confirm that its project matches `FIREBASE_PROJECT_ID`.
4. Add the Razorpay Test Mode key ID and its matching key secret. Set
   `RAZORPAY_MODE` to `test` in every configured Vercel scope.
5. Add the webhook secret configured for the matching Test Mode webhook.
   Never use the API key secret in place of the webhook secret.
6. Save the variables and redeploy. Vercel environment changes do not update
   deployments that have already been built.
7. Check Function Logs and manually test order creation, captured payment,
   webhook delivery, duplicate delivery, and recovery before considering any
   Live Mode change.

Keep all secret values in Vercel's environment-variable settings or a secure
secret manager. Do not put them in source files, browser variables, build
logs, screenshots, support requests, or this guide.

## Secret exposure and project status

The app's frontend uses only the Razorpay Key ID returned by the server. It
does not receive `FIREBASE_SERVICE_ACCOUNT`, `REGISTRATION_LOCK_SECRET`,
`RAZORPAY_KEY_SECRET`, or `RAZORPAY_WEBHOOK_SECRET`. Do not add these secrets
to `index.html`, `public/app.js`, or any `NEXT_PUBLIC_*`/`VITE_*` variable.

The repository's `.env.example` is sanitized, and `.gitignore` excludes local
environment files and common service-account/private-key file types. A local
ignored credential file is not deleted by these instructions. However,
sanitizing a tracked file does not erase its Git history. Revoke and replace
any credential that was real and committed or shared.

This workspace cannot inspect the Vercel project's saved values. Therefore,
which variables are currently absent from that Vercel project is unknown; use
the Environment Variables page to verify each name and scope. No Vercel
environment values have been added or changed by this task.

# FOUNDER'S DIARY 2026 — Manual Registration

Isolated manual UPI registration system for FU-GLIDE. It does not modify or connect to the existing Razorpay routes.

## Structure

- `public/` — registration page and isolated verification admin UI
- `src/firebase.js` — existing Firebase project/Admin SDK initialization
- `src/registration-routes.js` — participant submission API
- `src/admin-routes.js` — cookie-authenticated admin verification API
- `src/storage.js` — private Firebase Storage adapter
- `src/validation.js` — server-side field and image validation

## Requirements

- Node.js 22 or newer
- Access to the existing Firebase project
- A private Firebase Storage bucket
- Existing Firebase service account or Application Default Credentials
- Existing admin email and password configuration

## Environment variables

Copy `.env.example` to `.env` and fill in values:

- `PORT=3001`
- `FIREBASE_PROJECT_ID` — existing Firebase project ID
- `FIREBASE_SERVICE_ACCOUNT` — existing full service-account JSON, or omit to use Application Default Credentials
- `FIREBASE_STORAGE_BUCKET` — existing/private Firebase Storage bucket
- `MANUAL_PAYMENT_STORAGE` — `firebase` for a configured private bucket, or `local` for the private local disk adapter (default in `.env.example`)
- `MANUAL_PAYMENT_UPLOAD_DIR` — optional private disk directory; a relative path is resolved from `manual-registration/`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD_HASH` — SHA-256, `sha256$...`, or existing `scrypt$...` format
- `ADMIN_SESSION_SECRET` or `SESSION_SECRET`
- `ADMIN_SESSION_TTL_MS`

Do not put credentials in source code or commit `.env`.

## Installation

From `manual-registration/`:

```powershell
npm install
npm start
```

Open `http://localhost:3001/`. Admin verification is at `http://localhost:3001/admin/login`.

## Firebase

The system uses Firebase Admin SDK exclusively on the server. It writes only to:

- `manual_payment_registrations`
- `manual_payment_duplicate_locks`

It does not change `event_registrations`, Razorpay orders, or existing registration documents.

The configured project currently has no Firebase Storage bucket. The `.env.example` therefore uses the private local disk adapter. It saves files outside `public/` under `private-uploads/manual-payment-screenshots/{registrationId}/` with restrictive file permissions, and the original admin server streams those files only after existing admin authentication. Configure a persistent private directory for deployment; do not use ephemeral server storage.

To use Firebase Storage instead, create/enable a private bucket in the existing Firebase project, configure `FIREBASE_STORAGE_BUCKET`, and set `MANUAL_PAYMENT_STORAGE=firebase`. Screenshots are saved under `manual-payment-screenshots/{registrationId}/`; only the storage path is stored in Firestore. Screenshot bytes are never stored in Firestore or public URLs.

## QR image

No UPI ID or QR is supplied in this system. Replace the placeholder at:

`public/assets/payment-qr.png`

Do not invent account information. If the file is missing or unreadable, the page displays a configuration placeholder.

## Admin workflow

1. Open `/admin/login`.
2. Sign in with `ADMIN_EMAIL` and the configured password.
3. Search/filter submitted registrations.
4. Open a participant to view details and the protected screenshot.
5. Approve or reject the payment.
6. Rejections require a reason.

Approved records become `VERIFIED` and `READY_TO_SEND`. The system does not send invitations automatically.

Admin mutations require the existing-style `admin_session` and `admin_csrf` cookies plus matching CSRF header. No participant can approve or reject records.

## Test registrations

Submit a valid registration with a JPG, PNG, or WebP screenshot no larger than 5 MB. A successful submission creates `PENDING_VERIFICATION`.

The confirmation page provides a private status link. Keep it safe: its unguessable access token lets the participant check the registration status after admin review. The status page shows payment status, verification date, and any rejection reason. It does not expose contact details or payment screenshots. The token is stored as a SHA-256 hash in Firestore and is returned only once at submission. There is no email notification.

Run focused tests:

```powershell
npm test
```

## Deployment

Deploy this folder as an independent Node.js service. Configure the environment variables through the hosting provider. Do not deploy it by changing the existing Vercel configuration or server.

Use HTTPS and persistent/private Storage. Ensure the service account can read/write Firestore and upload/download from the configured private bucket.

## Existing admin integration

The existing dashboard uses signed cookie sessions and requires `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` or `ADMIN_PASSWORD`, and `ADMIN_SESSION_SECRET`/`SESSION_SECRET`. This isolated system reuses those environment conventions but runs a separate server and interface.

To integrate into the existing Express server, the dashboard owner must explicitly approve route mounting, shared session secrets, and Firestore/Storage permissions; no existing file has been changed here.

## Security and limitations

- File MIME and actual signatures are checked; executable and arbitrary file types are rejected.
- Uploads are limited to 5 MB.
- Submissions are rate-limited.
- Email and UTR combinations are duplicate-locked.
- Admin APIs require authentication and CSRF protection.
- Uploaded screenshots are private and served only through an authenticated endpoint.
- The system cannot confirm payment authenticity by inspection; all payments remain pending until manual review.

# FU-GLIDE FOUNDER'S DIARY 2026 registration

This project serves only the public registration form. It uses a Node.js/Express
backend and Firebase Cloud Firestore. Online payment is currently disabled;
registrations are recorded with `paymentStatus: UNPAID`.

## Setup

1. Use Node.js 20 or newer and run `npm install`.
2. Enable Cloud Firestore in the `prepai-5f3bc` Firebase project and create a server
   identity with permission to read and write Firestore. Locally, authenticate
   with Application Default Credentials or set `GOOGLE_APPLICATION_CREDENTIALS`
   to the service-account JSON file path. Do not commit the service-account file.
3. Copy `.env.example` to `.env` and set `FIREBASE_PROJECT_ID` and a separate
   long random `REGISTRATION_LOCK_SECRET`. Keep the lock secret stable across
   deployments so duplicate-registration locks remain addressable. Keep `.env`
   and all secrets out of source control.
4. Run `npm start` and open `http://localhost:3000`. Run `npm test` for the
   validation, registration, and route tests.

After valid form submission, the page opens a WhatsApp message prefilled with
the registration details for `+91 9150792336`; the participant must review and
press Send. The server saves the registration in `event_registrations` with an
`UNPAID` status; no payment is collected. The form header links to
`fuglide@gmail.com`.

## Deployment

Deploy the Node.js service to a server-side runtime such as Cloud Run; do not
deploy it as a static-only site. Configure the Firebase project ID as a runtime
environment variable and give the service identity Firestore access. Keep
`REGISTRATION_LOCK_SECRET` stable. Set `TRUST_PROXY` to the exact number of
trusted proxy hops for the deployment (leave it at `0` for direct/local
connections). Deploy `firestore.rules` to prevent public client access to the
database.

The browser never writes to Firestore. The server validates form details,
creates each registration only once per email, and stores the payment fields as
`UNPAID` with null Razorpay IDs and `paidAt`. Server-only
`registration_submissions` documents contain an HMAC-derived email lock and
request digest (no form details) to prevent duplicate submissions. The
`/api/orders` and `/api/verify` payment endpoints return HTTP 410 while payment
is disabled. Firestore Admin SDK writes bypass Firestore security rules, so
protect the service identity and deployment secrets.
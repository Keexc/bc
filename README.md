# Kenyan Excellence Awards — Voting Platform

A public voting site: KSh 20/vote via M-Pesa STK Push (through FXS Pay),
unlimited votes per person, live public results, and an admin dashboard
for managing categories, nominees, and payments.

## Structure

```
backend/    Express API + Supabase (deploy to Render)
frontend/   Public site + admin dashboard (static HTML/JS — deploy to GitHub Pages
            or any static host)
```

## 1. Set up Supabase

1. Create a Supabase project.
2. Open the SQL editor and run `backend/schema.sql`.
3. Copy your project URL and **service role key** (Settings → API) — you'll
   need these for the backend `.env`. The service role key is server-only;
   never put it in the frontend.

## 2. Configure the backend

```
cd backend
cp .env.example .env
npm install
```

Fill in `.env`:
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — from step 1
- `JWT_SECRET` — any long random string
- `FXS_*` values — **see the note below**

Create your first admin login:
```
node create-admin.js you@example.com "a-strong-password" "Your Name"
```

Run locally:
```
npm run dev
```

Deploy to Render the same way you deploy your other Node/Express APIs —
either connect the `keexc/bc` repo directly (Render auto-detects
`npm start`), or use the included `backend/render.yaml` Blueprint (New →
Blueprint in Render, point it at the repo). Either way, the `sync: false`
variables in `render.yaml` (JWT_SECRET, SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY, FXS_API_KEY, FXS_WEBHOOK_SECRET) still need to
be filled in manually from the dashboard — Blueprints don't auto-fill
secrets.

## 3. FXS Pay setup

`routes/payments.js` is built against FXS Pay's real API (base URL
`https://fxspay.onrender.com`). Steps, in order:

1. **Register a merchant account and get an API key** — either via FXS
   Pay's own dashboard, or:
   ```
   curl -X POST https://fxspay.onrender.com/api/merchant/register \
     -H "Content-Type: application/json" \
     -d '{"businessName":"Kenyan Excellence Awards","email":"you@example.com","password":"a-strong-password"}'
   ```
   Then generate a key (a `test` key works immediately; a `live` key needs
   FXS Pay to approve the account first):
   ```
   curl -X POST https://fxspay.onrender.com/api/merchant/api-key \
     -H "Authorization: Bearer <jwt-from-register>" \
     -H "Content-Type: application/json" \
     -d '{"env":"live","label":"KEA backend"}'
   ```
   The full key is only shown once — put it straight into `.env` as
   `FXS_API_KEY`.

2. **Deploy the backend first** (Render), so you have a real URL, then
   register the webhook:
   ```
   node register-webhook.js https://your-backend.onrender.com/api/payments/webhook
   ```
   This prints a `secret` shown only once — put it in `.env` as
   `FXS_WEBHOOK_SECRET` and redeploy.

3. Voting is now fully wired: `/api/payments/initiate` calls FXS Pay's
   `/api/mpesa/stk-push`, and `/api/payments/webhook` verifies FXS Pay's
   HMAC signature before crediting votes on `payment.success`. The status
   endpoint also falls back to asking FXS Pay directly if a webhook hasn't
   arrived yet, so polling from the frontend still works even if a webhook
   delivery is delayed.

Note: FXS Pay's docs describe card/bank payments as a separate flow
(`/api/mpesa/checkout`, redirect-based) — not used here since the spec is
M-Pesa STK Push only, but it's there if you ever want to add card/bank
later.

## 4. Configure and deploy the frontend

In `frontend/js/app.js` and `frontend/js/admin.js`, either set
`window.KEA_API_BASE` before the script loads, or edit the `API_BASE`
fallback directly to point at your deployed Render URL, e.g.:

```html
<script>window.KEA_API_BASE = 'https://your-api.onrender.com/api';</script>
<script src="js/app.js"></script>
```

Then push `frontend/` to GitHub Pages as usual.

## 5. Notes on the categories that include real public figures

The politics category (and any entertainment nominees who are real named
individuals) means real people's names, photos, and bios will appear
attached to a paid competition. Worth confirming you have the standing to
do that — sponsor backing, nominee awareness, or at minimum a clear public
disclaimer — before opening voting on those categories specifically. The
admin dashboard lets you open/close voting per category, so you can launch
entertainment categories immediately and hold back politics until that's
settled.

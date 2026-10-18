# DalabaPay backend

Node.js + Express + MongoDB API for the DalabaPay Flutter app (`dalabapay-newproject`).

## Run it

```bash
cp .env.example .env      # set MONGO_URI and JWT_SECRET
npm install
npm run dev               # http://localhost:4000
npm run make-super-admin -- you@example.com   # promote an existing account
npm test                  # needs MONGO_URL pointing at a MongoDB server
```

Outside production the bill and payment providers default to **simulator**, so every screen works end to end without real money. In production they default to `none` until a real provider (VTpass etc.) is configured.

Simulator test values:

| Input | Result |
|---|---|
| phone / recipient ending `0000` | purchase fails, wallet refunded automatically |
| phone / recipient ending `9999` | purchase stays pending |
| meter / smartcard / profile ending `000` | "not found" on verify |
| `POST /api/dev/simulate-transfer {amount}` | pretend a bank transfer arrived (dev only) |

## Conventions

- Every response: `{ "success": true, "data": … }` or `{ "success": false, "code": "…", "message": "…", "errors"?: […] }`.
- Auth: `Authorization: Bearer <token>`. Tokens are invalidated when the password changes or an admin deactivates the account.
- Money is sent and returned in **naira** (decimals allowed); it is stored in kobo.
- Purchases and transfers need the 6-digit payment `pin`. 5 wrong PINs lock it for 30 minutes.
- Lists accept `page` and `limit` and return `{ items, total, page, pages }`.

## Endpoints

### Auth `/api/auth`
| Method | Path | Body |
|---|---|---|
| POST | `/register` | fullName, email, phone, password, referralCode? → emails a code |
| POST | `/register/verify` | email, code → `{ token, user }` |
| POST | `/register/resend` | email |
| POST | `/login` | identifier (email or phone), password |
| POST | `/password/forgot` → `/password/verify-code` → `/password/reset` | email · email, code → resetToken · resetToken, password |
| POST | `/password/change` | currentPassword, newPassword → new token |
| POST | `/pin/set`, `/pin/change`, `/pin/verify` | pin · currentPin, newPin · pin |
| POST | `/pin/forgot` → `/pin/reset` | — · code, newPin |

### Account
- `GET /api/me`, `GET /api/me/home` (balance, recent transactions, unread count, services), `PATCH /api/me/preferences`
- `GET /api/kyc`, `POST /api/kyc` (type bvn/nin, number, dateOfBirth)
- `GET /api/notifications`, `POST /api/notifications/read-all`, `PATCH /api/notifications/:id/read`, `DELETE /api/notifications/:id`
- `GET /api/referrals`
- `GET /api/commission`, `POST /api/commission/withdraw`

### Wallet `/api/wallet`
`GET /` · `POST /fund/one-time {amount, pin}` · `POST /fund/assisted {amount, pin}` · `POST /transfer/lookup {phone}` · `POST /transfer {phone, amount, note?, pin}` · `POST /verify-payment {reference}` · `GET /fundings`

### Transactions
`GET /api/transactions?status&type=airtime,data&wallet&q&from&to` · `GET /api/transactions/:id`

### Services `/api/services`
| Service | Catalogue | Verify | Buy (POST) |
|---|---|---|---|
| Airtime | `GET /networks` | — | `/airtime` network, phone, amount, pin |
| Data | `GET /data/plans?network` | — | `/data` network, phone, planCode, pin |
| Electricity | `GET /electricity/providers` | `POST /electricity/verify` | `/electricity` provider, meterNumber, meterType, amount, phone, pin |
| Cable TV | `GET /cable/providers`, `/cable/plans?provider` | `POST /cable/verify` | `/cable` provider, smartcardNumber, action renew\|change, planCode?, months, phone, pin |
| Education | `GET /education/products` | `POST /education/verify` | `/education` service, variationCode, quantity, profileId?, phone, pin |
| Insurance | `GET /insurance/options`, `/insurance/models?make`, `/insurance/lgas?state` | — | `/insurance` typeCode, plateNumber, insuredName, … |
| International | `GET /international/countries`, `/product-types`, `/operators`, `/variations` | — | `/international` country, productType, operator, variationCode, phone, amount, pin |

Also `GET /status` (which services are on, maintenance), `GET /rates`, `GET /limits`.

### Disputes `/api/disputes`
`GET /` · `GET /eligible` · `POST / {transactionId, type, reason}` · `GET /:id`

### Webhooks
`POST /api/webhooks/payment` — header `x-webhook-secret`. Idempotent per reference.

### Admin `/api/admin` (roles: support < finance < admin < super)
- `GET /me` (role + permissions), `GET /dashboard?period=today|week|month|year|all`
- Users: `GET /users?q&filter`, `GET|PATCH /users/:id`, `POST /users/:id/approve`, `POST /users/:id/wallet {action credit|debit, amount, reason}`, `POST /users/:id/pin/unlock`, `POST /users/:id/pin/reset`, `GET /users/:id/history`
- Transactions: `GET /transactions`, `GET /transactions/export.csv`, `GET /transactions/refund-queue`, `PATCH /transactions/:id/status`, `POST /transactions/:id/refund`, `POST /transactions/:id/requery`
- Disputes: `GET /disputes`, `PATCH /disputes/:id`, `POST /disputes/:id/resolve {action approve|reject, resolution}`
- Payments: `GET|POST /payments/self-fund` (super + PIN), `POST /payments/verify`, `POST /payments/manual`
- Messages: `GET|POST /broadcasts`, `GET /alerts`, `POST /alerts/read-all`, `PATCH /alerts/:id/read`
- Roles (super): `GET /roles`, `POST /roles {userId|email, role}`
- Settings: `GET|PATCH /settings`, `GET /provider`, `POST /provider/health`, `POST /provider/test`, `GET /commission`, `PATCH /commission/rates/:service`, `GET /limits`, `PUT /limits/defaults`, `GET|PUT /limits/users/:id`

## Adding a real provider

Bill providers live in `src/providers/bill/`, payment providers in `src/providers/payment/`. Copy `simulator.js`, implement the same methods against the provider's API, register it in `index.js`, and set `BILL_PROVIDER` / `PAYMENT_PROVIDER`.

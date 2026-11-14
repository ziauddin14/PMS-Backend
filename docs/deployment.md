# Deployment and Handover — Render (API) + Vercel (web) + MongoDB Atlas

No secret values belong in this file or in either repository. Enter them only in the Render / Vercel dashboards.

## 1. MongoDB Atlas

1. Use an Atlas cluster (the free M0 tier is a replica set, so transactions work). Create a database user with read/write on **one** database (e.g. `pms_prod`) only.
2. Network access: allow Render's outbound addresses (Render dashboard → service → _Outbound_), or `0.0.0.0/0` only if you accept that risk; access is still protected by the user/password.
3. Turn on Atlas backups (or schedule `mongodump` exports) **before** the first real data is entered.
4. Start-up only creates missing collections, validators and indexes. It never drops or rewrites data.

## 2. Render — backend (`PMS-Backend` repository)

`render.yaml` describes the service (`mab-pms-api`, free plan, health check `/api/health`). In the dashboard: **New → Blueprint** (or Web Service) from the repository, branch `main`, root = repository root.

| Variable                  | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `MONGODB_URI`             | Atlas connection string (secret)                                                   |
| `MONGODB_DB_NAME`         | e.g. `pms_prod`                                                                    |
| `CORS_ALLOWED_ORIGINS`    | the Vercel production URL, e.g. `https://<project>.vercel.app` (no trailing slash) |
| `SESSION_COOKIE_SAMESITE` | `lax` with the Vercel `/api` rewrite (recommended, §3); `none` only without it     |
| `TRUST_PROXY`             | `1` direct; with the Vercel rewrite use `2` and confirm client IPs in the logs     |

The others (`NODE_ENV=production`, `HOST`, `MONGODB_REQUIRE_TRANSACTIONS=true`, `MONGODB_ALLOW_REMOTE=true`, `MONGOMS_DISABLE_POSTINSTALL=1`) come from `render.yaml`. Build: `npm ci --include=dev && npm run build`; start: `npm start`.

Verify: `GET https://<api>.onrender.com/api/health` → `{"status":"ok"}` and `/api/health/ready` → `"database":"up"`. The free plan sleeps after inactivity; the first request after a pause takes up to a minute.

## 3. Vercel — frontend (`Production-Managment-System` repository)

Import the repository (framework Vite; `vercel.json` already sets install/build/output and SPA routing).

**Recommended (same-site cookies):** add an API rewrite **before** the SPA rewrite in `vercel.json`, using the real Render URL:

```json
"rewrites": [
  { "source": "/api/:path*", "destination": "https://<api>.onrender.com/api/:path*" },
  { "source": "/(.*)", "destination": "/index.html" }
]
```

and set `VITE_API_BASE_URL=/` in Vercel project settings. The browser then talks only to the Vercel domain, so the session cookie is first-party (Safari and Chrome third-party-cookie blocking cannot break sign-in).

Without the rewrite: `VITE_API_BASE_URL=https://<api>.onrender.com` and `SESSION_COOKIE_SAMESITE=none` on Render — works in Chrome/Edge today but may fail in Safari or private windows.

## 4. First accounts

There are no default accounts. From a trusted machine with the production variables in a local `.env` (never committed):

```bash
npm run user-admin -- create --username <name> --display-name "<Full name>" --role OPERATOR
```

`--role VIEWER` for HOD/managers (read-only). Other commands: `list`, `disable`, `unlock`, `reset-password`.

## 5. Smoke test after each deploy

Sign in and out; dashboard loads; master data list; create a demand and a PO (synthetic test names, then cancel them with reason "smoke test"); receiving page; stock page; dispatch list; payments; reports (JSON + CSV); sync status; sign in as a VIEWER and confirm no write buttons appear and writes return 403.

## 6. Routine troubleshooting

| Symptom                                  | Check                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Sign-in succeeds but next page logs out  | Cookie not sent: use the Vercel rewrite (§3) or `SameSite=none`; `CORS_ALLOWED_ORIGINS` exact |
| `FORBIDDEN_ORIGIN`                       | Add the exact web origin to `CORS_ALLOWED_ORIGINS`                                            |
| `/api/health/ready` says database down   | Atlas network access list, user/password, cluster paused                                      |
| Startup exits immediately                | Render logs show which configuration variable is missing/invalid (values are never printed)   |
| `409` "would be over-received/over-paid" | Someone recorded the same thing concurrently — reload the page; nothing was double-counted    |
| Account locked                           | `npm run user-admin -- unlock --username <name>`                                              |

# MAB PMS — Backend API

Node.js + Express + TypeScript + MongoDB API for the MAB Production Management System.
Separate repository from the frontend (`../frontend`). Deployment target: Render (this folder is the project root).

**Status:** M4 — Master Data. Sign-in, sessions, roles, dashboard summary and master-data APIs (provinces, divisions, departments, items, vendors, warehouses). Technical notes: [`docs/m2-foundation.md`](docs/m2-foundation.md), [`docs/m3-auth-dashboard.md`](docs/m3-auth-dashboard.md), [`docs/m4-master-data.md`](docs/m4-master-data.md).

> **Data safety.** Never place workbooks, exports, backups or real business data in this repository. Tests use synthetic data only. Do not connect to MongoDB Atlas until it is separately authorised.

## Prerequisites

- Node.js 22 or later and npm 10+.
- To run the API locally: a **local** MongoDB **replica set** (transactions need one). A standalone server works only with `MONGODB_REQUIRE_TRANSACTIONS=false` (non-atomic fallback, development only).
- Tests need no MongoDB installation: integration tests start an in-memory MongoDB 8.2.6 (the first install downloads a ~820 MB binary into `node_modules/.cache/mongodb-memory-server`; set `MONGOMS_DISABLE_POSTINSTALL=1` to skip it when tests are not needed).

## Setup and run

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run dev
```

- `GET http://127.0.0.1:4000/api/health` — liveness
- `GET http://127.0.0.1:4000/api/health/ready` — database readiness

There are no default accounts. Create one with the user-admin tool (the password is asked at a hidden prompt):

```bash
npm run user-admin -- create --username usman --display-name "Usman Bhai" --role OPERATOR
```

**Without a local MongoDB:** `npm run dev:memory` runs the API on a throw-away in-memory database and prints two synthetic demo accounts with one-time passwords (development only; data is lost on exit).

## Checks

| Command                    | What it does                                   |
| -------------------------- | ---------------------------------------------- |
| `npm run lint`             | ESLint                                         |
| `npm run typecheck`        | TypeScript check (source and tests)            |
| `npm test`                 | All tests (unit + integration)                 |
| `npm run test:unit`        | Unit tests only — no database needed           |
| `npm run test:integration` | Integration tests against an in-memory MongoDB |
| `npm run build`            | Compile to `dist/`                             |
| `npm start`                | Run the compiled API                           |
| `npm run user-admin -- …`  | Create, list, disable, unlock; reset password  |
| `npm run dev:memory`       | Dev API on an in-memory DB with demo accounts  |
| `npm run format:check`     | Prettier check                                 |
| `npm run check`            | Lint, typecheck, tests and build               |

## Configuration

Environment variables are documented in [`docs/m2-foundation.md`](docs/m2-foundation.md#5-environment-variables). The API refuses to start with missing or invalid configuration and never prints the supplied values.

## API contract shared with the frontend

`src/contracts/` defines the response shapes and error codes. The frontend keeps a minimal mirror of the schemas it consumes (`frontend/src/contracts/`); update both when the contract changes.

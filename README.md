# MAB PMS — Backend API

Node.js + Express + TypeScript + MongoDB API for the MAB Production Management System.
Separate repository from the frontend (`../frontend`). Deployment target: Render (this folder is the project root).

**Status:** M2 — Project Foundation & Database. Health endpoints and the database/record foundation only; no business endpoints yet. Technical notes: [`docs/m2-foundation.md`](docs/m2-foundation.md).

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
| `npm run format:check`     | Prettier check                                 |
| `npm run check`            | Lint, typecheck, tests and build               |

## Configuration

Environment variables are documented in [`docs/m2-foundation.md`](docs/m2-foundation.md#5-environment-variables). The API refuses to start with missing or invalid configuration and never prints the supplied values.

## API contract shared with the frontend

`src/contracts/` defines the response shapes and error codes. The frontend keeps a minimal mirror of the schemas it consumes (`frontend/src/contracts/`); update both when the contract changes.

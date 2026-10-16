# M2 — Project Foundation & Database: Implementation Notes

**Scope:** technical foundation only (approved M2). No business modules, no authentication, no Excel integration, no historical import, no PoC, no deployment. Based on the frozen M1 documents kept in the parent folder at `../docs/requirements/` (CD-01…CD-14); those documents are not part of this repository.

## 1. Architecture

Two independent repositories in one parent folder:

```
<parent>/
├─ frontend/  (own Git repo) React SPA ──HTTP (VITE_API_BASE_URL)──▶ backend API
└─ backend/   (own Git repo) Express API ──▶ MongoDB
    src/
    ├─ contracts/ API response schemas (health, readiness, error envelope), record-code helpers
    ├─ config/    env validation (zod), MongoDB URI helpers
    ├─ http/      app factory, security middleware, CORS, health routes, errors
    ├─ db/        connection, transaction detection, collections/validators/indexes, record codes
    ├─ domain/    actor, provenance, mutation context schemas
    └─ records/   RecordStore: the single write path for operational records
```

**Shared code decision.** The former `packages/shared` workspace was removed to avoid cross-repository imports. Its contents moved into `backend/src/contracts/` (the API owns its contract). The frontend keeps a minimal mirror of the one schema it consumes (`frontend/src/contracts/health.ts`). Any contract change must update both; frontend tests validate the mirrored shape.

- **One write path.** Later modules (M4+) define a `RecordDefinition` (collection, code prefix, create/update schemas, sync targets) and write only through `RecordStore`. That guarantees validation, IDs, versioning, archival, audit and sync-job creation for every module.
- **No HTTP mutation endpoints exist in M2.** The API exposes only health endpoints. Authentication (M3) must be in place before any write endpoint is added.
- Validation library: **zod** for environment variables, API inputs (`validateBody`) and record payloads; MongoDB `$jsonSchema` validators as a second safety net.

## 2. Record foundation (implemented)

Every operational record carries:

| Field                    | Purpose                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `_id` (ObjectId)         | Permanent primary identity                                                                                          |
| `code`                   | Immutable human/workbook code `PREFIX-000001`, unique index, from an atomic counter; never reused (gaps possible)   |
| `rev`                    | Integer revision starting at 1; every change requires the expected `rev` (optimistic concurrency) and increments it |
| `createdAt`, `updatedAt` | Timestamps (UTC)                                                                                                    |
| `createdBy`, `updatedBy` | Actor (`USER`, `EXCEL_SYNC`, `IMPORT`, `SYSTEM`)                                                                    |
| `lifecycle`              | `ACTIVE` / `ARCHIVED` with time, actor and reason — **no hard delete** method exists                                |
| `provenance` (optional)  | Source type, import batch, raw source row ids, workbook, sheet, row, legacy references                              |

`RecordStore` operations: `create`, `update(id, expectedRev, changes)`, `archive(id, expectedRev, reason)`, `findById`, `findIncompleteAuditEvents`.

- Input is validated before persistence; system-managed fields in input are rejected.
- Updates audit only fields that actually changed; a no-op update does not bump `rev`.
- Stale `rev` → `409 CONFLICT`; archived record → `409`; unknown id → `404`.

### Atomicity

| Deployment                                                                | Behaviour                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replica set / sharded (MongoDB Atlas, local replica set)                  | Record write + audit event (`state: COMMITTED`, `atomic: true`) + sync jobs in **one multi-document transaction**                                                                                                                                                                                                                                     |
| Standalone (local development only, `MONGODB_REQUIRE_TRANSACTIONS=false`) | **Not atomic.** Audit event written first as `PENDING`, then the record, then sync jobs, then the event is marked `COMMITTED`. If the record write fails the event becomes `FAILED`; if a later step fails it stays `PENDING` with a reason. `findIncompleteAuditEvents()` lists them for reconciliation. Production configuration rejects this mode. |

Transaction support is detected at start-up (`hello` command). If transactions are required but unavailable, the API refuses to start.

## 3. Collections and indexes (implemented)

| Collection                     | Purpose                                                                                                        | Indexes                                                                                                   | Validator                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `counters`                     | Atomic sequence per code prefix (`_id` = prefix)                                                               | `_id`                                                                                                     | `seq` ≥ 0                                                                       |
| `auditEvents`                  | Append-only change history                                                                                     | `entity_history` (collection, id, occurredAt); `occurredAt`; `state_occurredAt`; `correlationId` (sparse) | actor, action ∈ CREATE/UPDATE/ARCHIVE, entity ref, revs, changes, state, atomic |
| `syncJobs`                     | Outbox for future workbook sync (written, **not consumed** in M2)                                              | `idempotencyKey_unique` (unique); `status_nextAttempt`; `workbook_queue`; `entity`                        | direction, target, entity, rev, operation, status, attempts, lease              |
| `importBatches`                | Future historical import batches (structure only)                                                              | `code_unique`; `createdAt`                                                                                | source files with SHA-256                                                       |
| `rawSourceRows`                | Future lossless staging of source rows, **separate from operational records** (structure only; no import code) | `source_row_unique` (file SHA-256, sheet, row; unique); `importBatch`                                     | cell refs, personal-data flag                                                   |
| Operational record collections | Created per module via `recordCollectionSpec(name)`                                                            | `code_unique`; `lifecycle_updatedAt`; `provenance_importBatch` (partial)                                  | base record fields                                                              |

No business collections (demands, POs, stock, payments, …) are created in M2. Sync job idempotency key: `collection:id:rev:workbook:sheet`.

`ensureInfrastructureCollections()` runs at API start-up; it creates missing collections, re-applies validators and creates indexes, and is safe to run repeatedly.

## 4. Security and configuration (implemented)

- Environment validated at start-up; errors list variable names and rules only, never values.
- `MONGODB_ALLOW_REMOTE=false` by default: the API refuses non-local database hosts until a remote database is explicitly authorised and configured.
- Production requires explicit `CORS_ALLOWED_ORIGINS` and transactions.
- CORS: explicit allow-list; requests with any other `Origin` (including preflight) get `403`; no wildcard; credentials only for listed origins.
- Helmet security headers; `x-powered-by` disabled; JSON body limit (`REQUEST_BODY_LIMIT`, default 100 kb); rate limiting; trust-proxy hops configurable.
- Error responses use a fixed envelope `{ error: { code, message, requestId, details? } }`; unexpected errors return a generic message and log only the error class.
- Logger (pino) redacts authorization/cookie headers and secret-like fields; database errors never include the connection string or host.
- `.gitignore` excludes spreadsheets, CSV/TSV, PDFs outside `docs/`, `.env*` (except `.env.example`), keys, credential JSON, backups, exports, import/PoC working folders, build output and caches. The original workbooks (`../refrence-files/`) live outside both repositories.

This is a foundation, not a completed security review.

## 5. Environment variables

**Backend (`backend/.env`, Render dashboard in future):**

| Variable                              | Required   | Default                                            | Notes                                     |
| ------------------------------------- | ---------- | -------------------------------------------------- | ----------------------------------------- |
| `NODE_ENV`                            | no         | `development`                                      | `development` / `test` / `production`     |
| `HOST`                                | no         | `127.0.0.1`                                        | `0.0.0.0` on Render                       |
| `PORT`                                | no         | `4000`                                             | 1–65535                                   |
| `LOG_LEVEL`                           | no         | `info`                                             | pino levels or `silent`                   |
| `MONGODB_URI`                         | **yes**    | —                                                  | `mongodb://` or `mongodb+srv://`; secret  |
| `MONGODB_DB_NAME`                     | **yes**    | —                                                  | 1–38 letters, digits, `_`, `-`            |
| `MONGODB_ALLOW_REMOTE`                | no         | `false`                                            | Must be `true` for any non-local host     |
| `MONGODB_REQUIRE_TRANSACTIONS`        | no         | `true`                                             | Must be `true` in production              |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | no         | `5000`                                             | 100–60000                                 |
| `CORS_ALLOWED_ORIGINS`                | production | dev: `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated origins, no `*`, no paths |
| `REQUEST_BODY_LIMIT`                  | no         | `100kb`                                            | e.g. `100kb`, `1mb`                       |
| `TRUST_PROXY`                         | no         | `0`                                                | Proxy hops (Render: `1`)                  |
| `RATE_LIMIT_WINDOW_MS`                | no         | `60000`                                            | —                                         |
| `RATE_LIMIT_MAX`                      | no         | `300`                                              | Requests per window per client            |

**Frontend (`frontend/.env.local`, Vercel project settings in future):** `VITE_API_BASE_URL` (public; default `http://127.0.0.1:4000`). Every `VITE_` value is visible in the browser — never secrets. The frontend's backend origin must be listed in the backend's `CORS_ALLOWED_ORIGINS`.

`MONGOMS_DISABLE_POSTINSTALL=1` (backend, optional): skips the in-memory MongoDB test-binary download during `npm install`/`npm ci` (set in `render.yaml` for deployment builds).

## 6. Tests

`npm test` runs everything. API tests are split into **unit** tests (no database server) and **integration** tests (a real MongoDB started in memory):

| Command                    | Suite                                           | Covers                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run test:unit`        | `test/unit/codes.test.ts`                       | Record code formatting and validation (formerly `packages/shared`)                                                                                                                         |
|                            | `test/unit/config.test.ts`                      | Env validation, defaults, missing variables, no values in errors, remote-DB guard, CORS rules, production rules                                                                            |
|                            | `test/unit/app.test.ts`                         | Health/readiness (probe faked), validation errors, malformed JSON, body limit, 404, hidden internal errors, request ids, security headers, CORS allow/deny/preflight, rate limit           |
|                            | `test/unit/databaseConnection.test.ts`          | Real driver against a closed local port: safe connection-failure error, no secrets in message or logs                                                                                      |
|                            | `test/unit/recordStore.validation.test.ts`      | Fake database that fails on any access: invalid input, unknown/system fields, actor, revision and archive-reason checks happen **before** persistence; no delete operation                 |
| `npm run test:integration` | `test/integration/database.test.ts`             | Transactions required vs standalone, transaction detection, ping after close, schema creation, idempotency, validators, unique indexes                                                     |
|                            | `test/integration/recordStore.test.ts`          | Codes, rev, timestamps, audit and sync jobs, concurrent code generation, optimistic concurrency, concurrent updates, archive, transaction rollback, provenance — in-memory **replica set** |
|                            | `test/integration/recordStore.fallback.test.ts` | Non-atomic fallback: COMMITTED/FAILED/PENDING audit events — in-memory **standalone** server                                                                                               |
| (frontend repo) `npm test` | `frontend/src/App.test.tsx`                     | Shell renders; API status online/unavailable/malformed (fetch mocked)                                                                                                                      |

Integration tests use `mongodb-memory-server`, which downloads a MongoDB binary (~820 MB zip for 8.2.6 on Windows) into `node_modules/.cache/mongodb-memory-server` on first use. All tests use synthetic data only and never connect to Atlas.

## 7. Deployment readiness (prepared, not deployed)

- `backend/render.yaml`: Render web service blueprint with the backend repository as root (`plan: free`, `autoDeploy: false`, secrets as `sync: false`, health check `/api/health`, test-binary download disabled).
- `frontend/vercel.json`: Vite SPA build with the frontend repository as root, SPA rewrites, basic security headers, `noindex`.
- **To verify before any production use** (see M1 `04` §10, Q-19): Vercel Hobby terms (personal/non-commercial use); Render free service sleeping after inactivity, monthly hour limits, ephemeral disk and no background workers; Atlas free tier storage limits and absence of automated backups; Node.js version supported by each host. A free-tier deployment is not assumed suitable for organisational production.

## 8. Known limitations and deferred decisions

| Item                                                                                     | Status                                                                                                               |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Authentication, users, roles                                                             | M3 (actor context and audit fields are ready)                                                                        |
| Business collections and schemas                                                         | M4–M9                                                                                                                |
| Sync job consumer, `syncRecordMap`, `syncIssues`, workbook connectors                    | M10 / PoC; outbox only in M2                                                                                         |
| Historical import tooling (assessment, staging writer, matching, review, reconciliation) | Not implemented; only `importBatches` / `rawSourceRows` structure exists. Running any import needs gates AG-03/AG-04 |
| Backup/restore scripts and drill                                                         | Not implemented in this M2 increment; backup targets pending Q-35                                                    |
| Personal-data projection by role                                                         | Pending Q-30 / M3                                                                                                    |
| Atlas connection                                                                         | Not configured or tested; requires separate authorisation and your connection string                                 |
| Rate limiter storage                                                                     | In-memory per instance (fine for one instance; revisit if scaled)                                                    |
| Money/decimal and date-only helpers                                                      | Deferred to the first module that needs them (M5/M6)                                                                 |

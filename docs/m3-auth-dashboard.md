# M3 — Authentication & Dashboard: Implementation Notes

**Scope:** sign-in, sessions, sign-out, server-side route protection, roles, and the first dashboard. Based on the frozen M1 requirements: BRD §4 and Rules 9–10, CD-07 and the M2 actor model.

## 1. Requirements applied

| Source          | Requirement                                              | Implementation                                                                                                       |
| --------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| BRD §4, Rule 10 | Production Operator (Usman Bhai) is the operational user | Role `OPERATOR`                                                                                                      |
| BRD §4, Rule 9  | HOD and managers have read-only access                   | Role `VIEWER`; read-only notice in the UI; `requireRole` guard for future write routes                               |
| BRD §9          | User login                                               | Username + password, server-side sessions                                                                            |
| BRD §5 Step 8   | Management dashboard                                     | `/api/dashboard/summary` + dashboard page; every indicator stays "Not available yet" until its module exists (M5–M9) |
| M1              | No identity provider specified                           | Local accounts only; no Google or other provider                                                                     |

Not decided in M1 and left open: Q-30 (who may see receiver personal data) applies when personal data arrives in M5. No admin role and no admin screens: accounts are managed from the command line.

## 2. Authentication design

| Topic                       | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials                 | Username (3–50 characters: lowercase letters, digits, `.`, `_`, `-`; case-insensitive at sign-in) + password                                                                                                                                                                                                                                                                                                                            |
| Password policy             | 12–128 characters, no leading/trailing spaces, must not contain the username, not a single repeated character                                                                                                                                                                                                                                                                                                                           |
| Hashing                     | Node's built-in `scrypt` (N=2^15, r=8, p=1, 16-byte salt), compared in constant time. No extra dependency.                                                                                                                                                                                                                                                                                                                              |
| Unknown users               | Checked against a dummy hash, so response time doesn't reveal whether an account exists. Same generic error for every failure.                                                                                                                                                                                                                                                                                                          |
| Sessions                    | Server-side, in the MongoDB `sessions` collection. 256-bit random token in an **HttpOnly** cookie; only its SHA-256 is stored. Absolute lifetime `SESSION_TTL_HOURS` (default 12 h) and idle timeout `SESSION_IDLE_MINUTES` (default 120 min). A TTL index removes expired sessions.                                                                                                                                                    |
| Cookie                      | `pms_session` in development; `__Host-pms_session` with `Secure` when secure cookies are on (forced in production). `SameSite=Lax` by default; `Path=/`.                                                                                                                                                                                                                                                                                |
| CSRF                        | State-changing requests must send the session's CSRF token in `X-CSRF-Token`. The token is returned in the session response body and kept only in memory by the frontend. The custom header also forces a CORS preflight, which only allow-listed origins pass.                                                                                                                                                                         |
| Brute force                 | `LOGIN_RATE_LIMIT_MAX` sign-in requests per client per window (default 20 per 15 min), plus a per-username lockout after `LOGIN_MAX_FAILURES` (default 5) for `LOGIN_LOCKOUT_MINUTES` (default 15). Unknown usernames lock the same way. Counters are keyed by a SHA-256 of the attempted username (§2a).                                                                                                                               |
| Disabling / password change | `user-admin disable`, `set-password` and `set-role` end every session of that user immediately. A disabled account can't sign in (generic error).                                                                                                                                                                                                                                                                                       |
| Audit                       | Users are M2 records (`USR-000001`, rev, lifecycle, audit). `passwordHash` is replaced by `[REDACTED]` in audit events. Sign-in events go to the append-only `authEvents` collection (`LOGIN_SUCCEEDED`, `LOGIN_FAILED` with reason, `ACCOUNT_LOCKED`, `LOGOUT`, `SESSION_EXPIRED`, `LOCKOUT_CLEARED`), never with passwords. The attempted username is recorded only if it is an existing account's name; otherwise `(unknown)` (§2a). |
| No bypasses                 | No default accounts, no hard-coded credentials, no "skip auth" setting.                                                                                                                                                                                                                                                                                                                                                                 |

### API

| Method & path                | Auth                        | Purpose                                                                                                                              |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/auth/login`       | public, rate-limited        | Body `{ username, password }` (validated, strict). Sets the session cookie; returns `{ user, csrfToken, expiresAt, idleExpiresAt }`. |
| `GET /api/auth/session`      | session                     | Current user and CSRF token; `401 UNAUTHENTICATED` or `401 SESSION_EXPIRED` otherwise                                                |
| `POST /api/auth/logout`      | session + CSRF              | Deletes the session and clears the cookie (`204`)                                                                                    |
| `GET /api/dashboard/summary` | session, OPERATOR or VIEWER | Indicators (all `not_available`, `value: null`, with the planned milestone) and database status                                      |

Authenticated responses send `Cache-Control: no-store`. Error codes added: `UNAUTHENTICATED`, `SESSION_EXPIRED`, `FORBIDDEN`, `CSRF_FAILED`, `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`.

### New collections

| Collection                  | Indexes                                 |
| --------------------------- | --------------------------------------- |
| `users` (record collection) | base record indexes + `username_unique` |
| `sessions`                  | `expiresAt_ttl` (TTL), `userId`         |
| `loginThrottle`             | `expiresAt_ttl` (TTL)                   |
| `authEvents`                | `occurredAt`, `username_occurredAt`     |

## 3. Account administration (command line)

Run from `backend/` against the database configured in `.env`. Passwords are typed at a hidden prompt (or piped on stdin), never passed as arguments.

```bash
npm run user-admin -- create --username usman --display-name "Usman Bhai" --role OPERATOR
npm run user-admin -- set-password --username usman
npm run user-admin -- set-role --username hod --role VIEWER
npm run user-admin -- disable --username someone --reason "No longer in the department"
npm run user-admin -- unlock --username usman
npm run user-admin -- list
```

## 4. Local development without installing MongoDB

`npm run dev:memory` starts the API against a throw-away in-memory replica set and creates two synthetic demo accounts (`demo.operator`, `demo.viewer`) with random passwords printed once in that terminal. It refuses to run unless `NODE_ENV` is `development`, and all data is lost when it stops. It is not a production authentication setup.

## 5. Deployment notes (not deployed)

The session cookie must reach the API. Pick one of these before deploying:

1. **Same site (recommended):** serve the frontend and API under one site, e.g. `pms.example.org` and `api.pms.example.org`, or proxy `/api` through a Vercel rewrite to the Render URL. Keep `SESSION_COOKIE_SAMESITE=lax`.
2. **Different sites** (`*.vercel.app` + `*.onrender.com`): requires `SESSION_COOKIE_SAMESITE=none` with Secure cookies. Browsers that block third-party cookies (Safari, and Chrome in some modes) may then fail to keep users signed in, so this is not recommended.

`CORS_ALLOWED_ORIGINS` must list the exact frontend origin in either case.

## 2a. Credential leakage and lockout review

**Typed usernames are not stored.** Users sometimes type their password into the username field. The sign-in log (`authEvents`) therefore stores the attempted name only when it matches an existing account; otherwise it stores `(unknown)`. Lockout counters (`loginThrottle`) are keyed by `u:` + SHA-256 of the attempted name, not the text itself, and expire after the lockout window. Request logs record only method, path, status and request id — never request bodies. A regression test covers this exact case.

Residual risk: someone with read access to the database could test guesses against a lockout key's hash during its ≤15-minute life. This needs database access and is far smaller than storing the text.

**Lockout denial of service (documented, not removed).** Lockout is per username, so anyone who knows a username (e.g. the operator's) can keep that account locked by sending 5 wrong passwords every 15 minutes. That is the price of per-username protection against password guessing from many addresses. Alternatives considered and rejected for now:

| Alternative                                          | Why not                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Lock per username + client IP                        | Weakens brute-force protection: each additional address gets fresh attempts |
| Successful sign-in bypasses an active lock           | Turns the lock into no protection at all                                    |
| Different responses for existing vs unknown accounts | Account enumeration                                                         |

Change made: **administrator recovery** — `user-admin unlock --username <name>` clears an active lockout immediately (recorded as `LOCKOUT_CLEARED`). It does not change the lockout rules. The per-client sign-in rate limit (20 per 15 min) also slows a single source attempting the lockout. If this DoS becomes a real problem, the next step would be an allow-listed network path or MFA, not a weaker lock.

## 6. Known limitations

- No self-service password reset or e-mail flow (no e-mail service is configured); the administrator resets passwords from the command line.
- No multi-factor authentication.
- The rate limiter's memory is per process (fine for one instance).
- Roles are coarse (OPERATOR / VIEWER). Finer permissions and personal-data visibility (Q-30) arrive with the business modules.
- No recent-activity feed: there is no business activity data yet, so none is shown.
- This is not a security audit; a review before production use is still needed.

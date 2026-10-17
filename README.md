# Tijorat Markazi backend

The production backend is one Node.js 24 process, backed by PostgreSQL 18.
There is no Python/Django runtime. Packages are locked in `package-lock.json`;
use `npm ci`, `npm test`, and `npm start` with the environment below.

## Production deployment

The Dockerfile installs production dependencies in a separate stage. The runtime
contains the API and `unzip` for bounded Office text extraction, runs as
UID/GID `10001:10001`, and supports a read-only root filesystem. Mount writable
`/app/data` and `/app/uploads` and provide `/tmp` as tmpfs. Runtime files and
uploads are excluded from image builds. PostgreSQL must persist independently.

`entrypoint.sh` uses `exec node server.js`. Before listening, the server validates
configuration and directory permissions, waits for PostgreSQL within
`STARTUP_TIMEOUT`, creates its document/session tables, and initializes account
credentials. `WEB_CONCURRENCY` must be `1`; do not use clustering, PM2 workers,
replicas, or a second process that writes through the same memory mirror.

| Setting | Purpose |
| --- | --- |
| `NODE_ENV` | `production` in deployed containers. |
| `DATABASE_URL` | Required PostgreSQL connection URL; no file fallback. |
| `APP_ORIGIN` | Exact public HTTPS origin, e.g. `https://domain-name.uz`. |
| `ADMIN_PASSWORD` | Required secret, at least 16 characters. |
| `RAIS_PASSWORD` | Required initial oversight password, at least 16 characters. |
| `RAIS_LOGIN` | Optional initial oversight login; default `rais`. |
| `WEB_CONCURRENCY` | `1`, enforced. |
| `PORT`, `STARTUP_TIMEOUT` | `4321`, `120` seconds. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional AI integration; configure a supported model explicitly when setting the key. |
| `NEWS_FETCH` | `off` by default. |
| `DOC_TTL_DAYS` | Generated document lifetime; default 14 days. |
| `TELEGRAM_BOT_TOKEN`, `RAIS_TG_CHAT` | Optional monthly report notification. |
| `TZ` | Set to `Asia/Tashkent` for monthly report timing. |

Keep runtime secrets in the **infra** repository's `prod` environment. Application
CI receives only GHCR and infra-update credentials. Only infra connects to the
VPS. The production runbook and manual bootstrap are maintained in
[Tijorat-Markazi/infra setup guide](https://github.com/Tijorat-Markazi/infra/blob/main/SETUP.md).
Infra validates and deploys in one workflow run; failed validation blocks server
access and cleanup. `VPS_HOST` belongs in infra/prod's environment **secrets**.

TLS, IPv6, and HTTP/3 terminate at the host's Caddy service. Proxy `/api`, `/ws`,
and `/uploads` to this backend, preserving their prefixes. Caddy must overwrite
`X-Real-IP` with the actual client address. Do not expose the internal backend
port publicly or allow untrusted proxies to reach it. Frontend pages are served
by the separate frontend container; backend source directories are never served.
Meeting scheduling accepts manually supplied `https://meet.google.com/...`
links. Legacy desktop-browser automation and standalone bot/report CLI programs
are outside this website deployment and are excluded from its image.

`/api/health/live` reports process liveness. `/api/health/ready` actually probes
PostgreSQL. Failed database writes return no successful response, reject later
operations, and restart the process. The application drains HTTP/WebSockets and
flushes PostgreSQL with a 25-second shutdown deadline; allow 30 seconds in Compose.

## Authentication and private data

`GET /api/auth/session` supplies session metadata and a CSRF token. It creates a
guest session when needed. `POST /api/auth/login` accepts `{login,password}` and
rotates the session; `POST /api/auth/logout` revokes it and creates a fresh guest.
Every POST requires `Origin: APP_ORIGIN`, JSON content type, and
`X-CSRF-Token`. Cookies are HttpOnly, Secure in production, SameSite=Lax, and
scoped to `/`; authenticated sessions expire after 12 hours and guest sessions
after 30 days. Only hashes of opaque random session tokens are stored in the DB.

Roles are `admin`, `rais`, `assoc`, `company`, `analyst`, and `buyer`. Account
password changes, suspension, or deletion invalidate existing normal sessions.
Suspended company/association/buyer accounts can sign in with
`purpose: "rights"` for their own legal export, erasure request, and request
status only. Rights sessions cannot access cabinets, markets, AI, or private
group files. Existing role-specific `/api/<role>/login` routes now return the
cookie-authenticated profile; they do not authenticate request credentials.

Guest email/name can be saved with `POST /api/auth/guest`. They are contact data,
never identity. Guest assistant history, candidate profiles, financial passports,
inquiries, registration status and other private visitor records use a
server-issued cookie owner ID. Clearing/expiring the cookie loses guest access;
there is no email-only recovery or cross-browser lookup. Login/logout rotates
identity and never silently merges guest records into another account.

WebSocket upgrades require a valid account session and the exact public Origin.
`{op:"auth"}` requests the safe welcome; never send passwords over the socket.
Account/session validity and room membership are rechecked for messages and
recipients. Private `/uploads` files require their owner or current room access;
public showroom/news images use explicit public metadata.

## Existing installation migration

Do not copy runtime data into Docker images or commit it to Git. Stop legacy
writers, place existing uploads/data in their mounted production directories,
then explicitly run the same backend image with:

```sh
CONFIRM_LEGACY_IMPORT=yes node scripts/import-legacy.js
```

Supply production environment values. The importer copies only missing JSON
collections and does not overwrite existing PostgreSQL rows. Known group and
company-admin attachment references receive their matching room ACLs; referenced
public showroom/news images remain public. Unknown private files and legacy
email-owned histories remain retained but inaccessible. They need a separate
operator-verified ownership migration; entering an email never claims old data.
The first hardened startup provisions/rotates the oversight credential from
`RAIS_PASSWORD` and marks it initialized. Later password changes use authorized
account management; changing that initialization secret does not rotate an
already initialized oversight account. The admin secret is read at startup.

PostgreSQL role passwords and major version upgrades are operator migrations.
Changing an initialization secret cannot change an existing PostgreSQL password.

## Verification

```sh
npm ci
npm test
npm audit --omit=dev
```

Set `TEST_DATABASE_URL` to an expendable PostgreSQL database to include HTTP,
role/ownership, private-file, and WebSocket integration checks. Tests create an
isolated random schema and remove only that schema. Without it, those checks
are explicitly skipped; CI supplies PostgreSQL 18.

Spreadsheet exports use ExcelJS. Its UUID dependency is overridden to the
CommonJS-compatible patched `11.1.1`; an XLSX write/read roundtrip covers the
integration. No high/critical vulnerability exceptions are introduced.

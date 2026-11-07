# OCI Dash implementation scope

Private project. Next.js App Router, TypeScript, SQLite/Drizzle, official OCI TypeScript SDK, and a durable background worker. The default Docker deployment runs Web and Worker in one application container under a Node process supervisor. Navigation includes overview, instances, traffic, costs, accounts, tasks and settings. Network, security rules and storage are inside instance details.

Excluded by the user: AI chat, Telegram interactive management, automatic rescue, maps. VNC has subsequently been authorized as an integrated OCI console feature. Telegram notifications and other integrations are not part of this release. Do not copy production credentials, data, or logs into this repository.

First usable release must include authenticated account import/verification, multi-region inventory including accessible compartments, real instance list/details, instance creation and lifecycle actions, explicit public IP binding protection/rotation, boot-volume configuration, security rules, native OCI metrics where available, durable jobs and history, and local Docker deployment. Demo data is explicitly labeled and cannot execute cloud operations. Existing services are not modified by development verification.

## Default runtime contract

- Compose project: `oci-dash`; sole service: `app`; local image: `oci-dash:local`. Preserve the `app-data` volume and `/data/oci-dash.db` database path.
- The container starts `node dist/runtime.mjs`. It supervises the standalone Web server (`node server.js`) and background worker (`node dist/worker.mjs`) as separate business processes with the same database and environment. Consolidating deployment does not remove the worker or imply a substantial memory reduction.
- Any child exit outside coordinated shutdown, including exit code 0, stops the other child and causes a nonzero supervisor exit. Docker uses `restart: unless-stopped` to restart the container. An explicitly stopped container remains stopped until restarted by the operator.
- `SIGTERM` and `SIGINT` are forwarded and child exit is awaited. The worker has a 25-second hard-stop limit, the supervisor a 30-second limit, and Compose a 35-second stop grace period. Shutdown must not leave an unmanaged Web or Worker process behind; interrupted cloud operations still require checkpoint reconciliation.
- Container health runs `node dist/health.mjs`, checking Web/SQLite availability and a recent worker heartbeat. HTTP `GET /api/health` retains its Web/SQLite-only meaning. `dist/worker-health.mjs` may remain for standalone development diagnostics. An unhealthy status alone does not activate Docker's restart policy.
- Development may continue to use `npm run dev` and `npm run worker` in separate terminals. Default deployment, logs, recreation and backup commands target `app`.
- Migration from the old two-service layout stops the old services after active jobs finish, retains the project/data volume, `.env` and original `MASTER_KEY`, starts and checks `app`, then removes the old containers. No account re-import or manual data conversion is required for this runtime change.
- Restore backups in isolation and reconcile nonterminal jobs against OCI before enabling the default runtime. Starting `app` normally starts the worker too. A temporary Web-only inspection must explicitly override the command, for example `docker compose run --service-ports --rm --no-deps app node server.js`; it is not a read-only API mode.

Operational commands and migration/restore sequencing are documented in [OPERATIONS.md](OPERATIONS.md). Verification evidence belongs in [VERIFICATION.md](VERIFICATION.md); this runtime contract does not claim acceptance results.

## VNC console contract

- The runtime also serves the public HTTP/WebSocket gateway; Next standalone binds only a private loopback port. The gateway handles `/api/console/**` and forwards other HTTP traffic. No custom `next()` server is mixed with standalone output. Compose mounts `/tmp` as tmpfs for ephemeral console SSH material.
- Frontend: noVNC loaded only in the client at `/instances/[id]/console`; creating a console requires a user click. The SSH command dialog is labelled “SSH 连接信息”.
- Transport: the official OCI SDK creates a session-tagged console connection using a temporary RSA key. OpenSSH runs with structured arguments and private loopback forwards. The OCI command string is parsed as data, never executed through a shell. The public service key must match the OCI API fingerprint. Only the inner loopback connection uses `accept-new` to record its key through that authenticated channel; it does not open a separate keyscan connection that would compete with OCI's single-channel limit.
- `GET /api/console/session` returns `{session,demo}`; `POST /api/console/sessions` accepts `{instanceId}` and returns `{session}` with status 202. `GET /api/console/sessions/:id`, `DELETE` on the same path, and `POST .../:id/close` return `{session}`. `POST .../:id/touch` records user interaction.
- `POST .../:id/ticket` returns `{ticket,expiresAt,path}`. The WebSocket uses protocols `oci-console` and `ticket.<value>`, with a single-use 30-second ticket. The handshake checks login, exact Origin, owner/session binding, path and standard WebSocket headers. Authentication is rechecked for live sockets; tickets and private keys are never placed in URLs or persisted in the session table.
- SQLite `console_sessions` retains ownership and cleanup metadata, not private credentials. A unique active slot enforces one application-wide session, including unfinished cleanup. Account scope changes/removal remain blocked while that slot references the account.
- Disconnect, logout, timeout and shutdown close SSH streams and request deletion only of matching session-tagged OCI connections. Startup reconciles unfinished cleanup. Demonstration mode preserves existing records without performing cloud operations. Real OCI acceptance is limited to the explicitly authorized temporary console connection; instance lifecycle, networking and guest configuration are outside these tests.

## API contract

Analytics uses `GET /api/analytics/traffic` and `GET /api/analytics/costs` with explicit date and scope filters; `POST` on the same URL refreshes the query. Both require login, with same-origin checks for POST. Demonstration responses never access real credentials. `src/lib/analytics-contracts.ts` defines public reports; server readers, date validation and bounded caches are in `src/server/analytics/`. This release queries current-inventory VNIC history and reported Usage API costs on demand; it does not implement long-term archives, forecasts or credit accounting. Statistical semantics and accepted limitations are documented in [ANALYTICS.md](ANALYTICS.md).

All responses are JSON. Errors: `{error, code?}` with an appropriate HTTP status. Routes except login/health require a session. Mutations enforce same-origin requests. Public DTOs are in `src/lib/contracts.ts`.

- `GET /api/auth/me` → `{user, demo}`; `POST /api/auth/login` with `{username,password,code?}`; `POST /api/auth/logout`.
- `GET /api/dashboard` → `DashboardData`.
- `GET /api/accounts` → `{accounts,syncJobs,demo}`; `syncJobs` contains each account's active sync task, or latest finished one. `POST /api/accounts` with `{name,tenancyId,userId,fingerprint,homeRegion,regions,privateKey}` atomically saves the account and queues its initial connection task, returning `{account,job}`. The form parses pasted OCI configuration and reads the selected PEM file. Never fetch the key back.
- `PATCH /api/accounts/:id` accepts name/regions and optional replacement credentials. Credential or actual region changes atomically queue a connection task; a rename does not. `DELETE /api/accounts/:id` removes only this application's account configuration, not cloud resources.
- `POST /api/accounts/:id/sync` queues a durable connection/resource refresh task, reusing an active task for that account. The worker verifies credentials before reading inventory and reports failures on the account. `POST /api/accounts/:id/verify` remains available for API diagnostics; normal onboarding needs no separate verification request.
- `GET /api/instances` → `{instances,demo}`; `GET /api/instances/:id` → `{instance,demo}` (IDs URL encoded).
- `POST /api/inventory/refresh` accepts `{mode:"auto"|"manual",accountIds?:string[]}` and returns `InventoryRefreshResult` with queued/reused jobs and per-account freshness/backoff status. GETs remain side-effect free. Visible resource pages request automatic checks every 60 seconds; manual refresh waits for the durable job before reloading the snapshot. Automatic jobs are deduplicated across tabs, excluded from ordinary history, and retain only the latest terminal record per account. Explicit user jobs retain their history.
- `GET /api/instances/:id/metrics?range=1h|24h|7d` → `MetricsResult`.
- `GET /api/instances/:id/security` → `{groups,demo}`.
- `GET /api/accounts/:id/create-options?region=...&compartmentId=...` → `CreateOptions`.
- `POST /api/operations` with `OperationRequest` → `{job}` (HTTP 202). User confirmation is part of a concrete action dialog. Terminate requires typing the resource name. Rotation must identify the instance, VNIC, private IP and expected old public IP; reserved/protected addresses are refused.
- `GET /api/jobs` → `{jobs,demo}`; `GET /api/jobs/:id` → `{job,events}`; `POST /api/jobs/:id/cancel`; `POST /api/jobs/:id/retry`.
- `GET /api/settings` → `{username,mfaEnabled,demo,version,worker}`; password/MFA controls are supplied by the main implementation.

OCI adapter contract is `src/server/oci/types.ts`; implementation belongs in `src/server/oci/adapter.ts`, exporting `ociAdapter`. Credentials are decrypted only server-side. Common exception text must never include credentials or request Authorization headers.

## Parallel ownership

- Frontend: `src/components/**`, `src/app/(dashboard)/**`, `src/app/login/**`, `src/app/globals.css`, UI utility hooks. Main agent owns root layout/page and API routes.
- OCI adapter: `src/server/oci/**` except initially shared `types.ts`; adapter tests in `tests/oci-*.test.ts`.
- Jobs: `src/server/jobs/**`, `src/worker.ts`, jobs tests. Main agent provides DB/auth/accounts/inventory services.
- Main: package/config, DB/schema/migrations, auth/credentials, API routes, Docker/CI, integration tests, GitHub and final verification.

Automated tests use simulated OCI clients and never perform real cloud writes. Explicitly authorized manual VNC acceptance may create and delete a temporary instance console connection; it must confirm cleanup afterward and must not modify instance lifecycle, networking or guest configuration. Read-only integration may use an existing authorized account, with secrets kept outside Git. Unit/contract tests must cover lifecycle, concurrency, partial failures and protection boundaries with a replaceable OCI client.

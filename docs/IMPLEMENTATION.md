# OCI Dash implementation scope

Private project. Next.js App Router, TypeScript, SQLite/Drizzle, official OCI TypeScript SDK, and a separate durable worker. UI follows the editable OCI Dash Figma desktop designs with a simpler navigation: overview, instances, accounts, tasks, settings. Network, security rules and storage are inside instance details.

Excluded by the user: AI chat, VNC/noVNC, Telegram interactive management, automatic rescue, maps. Telegram notifications and other integrations are not part of this release. Do not copy production credentials, data, or logs into this repository.

First usable release must include authenticated account import/verification, multi-region inventory including accessible compartments, real instance list/details, instance creation and lifecycle actions, explicit public IP binding protection/rotation, boot-volume configuration, security rules, native OCI metrics where available, durable jobs and history, and local Docker deployment. Demo data is explicitly labeled and cannot execute cloud operations. Existing services are not modified by development verification.

## API contract

All responses are JSON. Errors: `{error, code?}` with an appropriate HTTP status. Routes except login/health require a session. Mutations enforce same-origin requests. Public DTOs are in `src/lib/contracts.ts`.

- `GET /api/auth/me` → `{user, demo}`; `POST /api/auth/login` with `{username,password,code?}`; `POST /api/auth/logout`.
- `GET /api/dashboard` → `DashboardData`.
- `GET /api/accounts` → `{accounts,syncJobs,demo}`; `syncJobs` contains each account's active sync task, or latest finished one. `POST /api/accounts` with `{name,tenancyId,userId,fingerprint,homeRegion,regions,privateKey}` atomically saves the account and queues its initial connection task, returning `{account,job}`. The form parses pasted OCI configuration and reads the selected PEM file. Never fetch the key back.
- `PATCH /api/accounts/:id` accepts name/regions and optional replacement credentials. Credential or actual region changes atomically queue a connection task; a rename does not. `DELETE /api/accounts/:id` removes only this application's account configuration, not cloud resources.
- `POST /api/accounts/:id/sync` queues a durable connection/resource refresh task, reusing an active task for that account. The worker verifies credentials before reading inventory and reports failures on the account. `POST /api/accounts/:id/verify` remains available for API diagnostics; normal onboarding needs no separate verification request.
- `GET /api/instances` → `{instances,demo}`; `GET /api/instances/:id` → `{instance,demo}` (IDs URL encoded).
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

No real OCI writes during automated or manual development checks. Read-only integration may use an existing authorized account, with secrets kept outside Git. Unit/contract tests must cover lifecycle, concurrency, partial failures and protection boundaries with a replaceable OCI client.

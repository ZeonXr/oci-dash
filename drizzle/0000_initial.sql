CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tenancy_id` text NOT NULL,
	`user_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`home_region` text NOT NULL,
	`regions` text NOT NULL,
	`credential` text NOT NULL,
	`status` text DEFAULT 'unchecked' NOT NULL,
	`last_sync_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`name_source` text DEFAULT 'custom' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analytics_snapshots` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`report_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`touched_at` integer NOT NULL,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`resource` text NOT NULL,
	`result` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `console_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`instance_name` text NOT NULL,
	`account_id` text NOT NULL,
	`region` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`owner_username` text NOT NULL,
	`owner_session_hash` text NOT NULL,
	`state` text NOT NULL,
	`connection_id` text,
	`compartment_id` text,
	`creation_state` text DEFAULT 'not_attempted' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`ready_at` text,
	`last_error` text,
	`cleanup_pending` integer DEFAULT 0 NOT NULL,
	`credential_recovery_ready` integer DEFAULT 0 NOT NULL,
	`slot` integer,
	CONSTRAINT "console_sessions_state" CHECK("console_sessions"."state" IN ('preparing','ready','connected','closing','closed','failed')),
	CONSTRAINT "console_sessions_creation_state" CHECK("console_sessions"."creation_state" IN ('not_attempted','uncertain','created','rejected')),
	CONSTRAINT "console_sessions_cleanup_pending" CHECK("console_sessions"."cleanup_pending" IN (0,1)),
	CONSTRAINT "console_sessions_credential_recovery_ready" CHECK("console_sessions"."credential_recovery_ready" IN (0,1)),
	CONSTRAINT "console_sessions_slot" CHECK("console_sessions"."slot" IS NULL OR "console_sessions"."slot"=1),
	CONSTRAINT "console_sessions_cleanup_slot" CHECK("console_sessions"."slot" IS NOT NULL OR ("console_sessions"."state" IN ('closed','failed') AND "console_sessions"."cleanup_pending"=0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `console_sessions_slot_unique` ON `console_sessions` (`slot`);--> statement-breakpoint
CREATE INDEX `console_sessions_account` ON `console_sessions` (`account_id`,`slot`);--> statement-breakpoint
CREATE TABLE `inventory_refresh_state` (
	`account_id` text PRIMARY KEY NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_failure_at` text,
	`retry_after` text,
	`manual_requested_at` text,
	`manual_job_id` text
);
--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`detail_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_events_job` ON `job_events` (`job_id`,`id`);--> statement-breakpoint
CREATE TABLE `job_resources` (
	`job_id` text NOT NULL,
	`resource_key` text NOT NULL,
	PRIMARY KEY(`job_id`, `resource_key`),
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_resources_resource` ON `job_resources` (`resource_key`,`job_id`);--> statement-breakpoint
CREATE TABLE `job_workers` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`last_heartbeat_at` text NOT NULL,
	`lease_seconds` integer NOT NULL,
	`stopped_at` text
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`account_id` text NOT NULL,
	`account_name` text NOT NULL,
	`region` text NOT NULL,
	`resource_id` text,
	`resource_lock` text NOT NULL,
	`state` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 4 NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`next_run_at` text,
	`last_error` text,
	`result_json` text,
	`operation_json` text NOT NULL,
	`requested_by` text NOT NULL,
	`idempotency_key` text,
	`payload_hash` text NOT NULL,
	`checkpoints_json` text DEFAULT '{}' NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`cancel_requested` integer DEFAULT 0 NOT NULL,
	`needs_reconcile` integer DEFAULT 0 NOT NULL,
	`background` integer DEFAULT 0 NOT NULL,
	`waiting_for_completion` integer DEFAULT 0 NOT NULL,
	`completion_deadline_at` text,
	CONSTRAINT "jobs_state" CHECK("jobs"."state" IN ('queued','running','retrying','succeeded','failed','cancel_requested','cancelled','interrupted')),
	CONSTRAINT "jobs_background" CHECK("jobs"."background" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency` ON `jobs` (`account_id`,`idempotency_key`) WHERE "jobs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `jobs_due` ON `jobs` (`state`,`next_run_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_account_sync` ON `jobs` (`account_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_active_resource` ON `jobs` (`resource_lock`) WHERE "jobs"."state" IN ('running','cancel_requested');--> statement-breakpoint
CREATE INDEX `jobs_active_kind_account` ON `jobs` (`kind`,`account_id`) WHERE "jobs"."state" IN ('running','cancel_requested');--> statement-breakpoint
CREATE INDEX `jobs_background_history` ON `jobs` (`account_id`,`background`,`finished_at`);--> statement-breakpoint
CREATE INDEX `jobs_manual_history` ON `jobs` ("created_at" DESC,"id" DESC) WHERE "jobs"."background"=0;--> statement-breakpoint
CREATE INDEX `jobs_manual_resource_history` ON `jobs` (`account_id`,`resource_id`,"created_at" DESC,"id" DESC) WHERE "jobs"."background"=0;--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`subject` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`region` text NOT NULL,
	`data` text NOT NULL,
	`synced_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `resources_account` ON `resources` (`account_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_expiry` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`mfa_secret` text,
	`mfa_pending` text,
	`mfa_pending_expires` text,
	`recovery_codes` text DEFAULT '[]' NOT NULL,
	`last_otp_step` integer DEFAULT -1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
CREATE TABLE `audit_events` (
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`authenticator_id` text,
	`id` text PRIMARY KEY,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`request_id` text,
	`target_id` text NOT NULL,
	`target_type` text NOT NULL,
	CONSTRAINT "audit_events_action_check" CHECK(length("action") BETWEEN 1 AND 128 AND instr("action", char(0)) = 0 AND substr("action", 1, 1) GLOB '[a-z0-9]' AND "action" = lower("action") AND "action" NOT GLOB '*[^a-z0-9._-]*'),
	CONSTRAINT "audit_events_actor_check" CHECK("actor_kind" IN ('anonymous', 'automation', 'system', 'user') AND length("actor_id") BETWEEN 1 AND 128 AND instr("actor_id", char(0)) = 0 AND length(trim("actor_id", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND (("actor_kind" IN ('automation', 'user') AND "authenticator_id" IS NOT NULL) OR ("actor_kind" IN ('anonymous', 'system') AND "authenticator_id" IS NULL))),
	CONSTRAINT "audit_events_authenticator_id_check" CHECK("authenticator_id" IS NULL OR (length("authenticator_id") BETWEEN 1 AND 128 AND instr("authenticator_id", char(0)) = 0 AND length(trim("authenticator_id", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0)),
	CONSTRAINT "audit_events_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "audit_events_metadata_json_check" CHECK(length(CAST("metadata_json" AS BLOB)) <= 4096 AND CASE WHEN json_valid("metadata_json") THEN json_type("metadata_json") = 'object' ELSE 0 END),
	CONSTRAINT "audit_events_occurred_at_check" CHECK("occurred_at" BETWEEN 0 AND 8640000000000000),
	CONSTRAINT "audit_events_outcome_check" CHECK("outcome" IN ('accepted', 'attempted', 'cancelled', 'denied', 'failed', 'succeeded')),
	CONSTRAINT "audit_events_request_id_check" CHECK("request_id" IS NULL OR (length("request_id") BETWEEN 1 AND 128 AND instr("request_id", char(0)) = 0 AND length(trim("request_id", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0)),
	CONSTRAINT "audit_events_target_check" CHECK(length("target_type") BETWEEN 1 AND 64 AND instr("target_type", char(0)) = 0 AND substr("target_type", 1, 1) GLOB '[a-z0-9]' AND "target_type" = lower("target_type") AND "target_type" NOT GLOB '*[^a-z0-9._-]*' AND length("target_id") BETWEEN 1 AND 256 AND instr("target_id", char(0)) = 0 AND length(trim("target_id", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`authentication_version` integer NOT NULL,
	`challenge` text NOT NULL,
	`config_fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY,
	`pending_login_id` text,
	`purpose` text NOT NULL,
	`session_id` text,
	CONSTRAINT `fk_auth_challenges_pending_login_id_auth_pending_logins_id_fk` FOREIGN KEY (`pending_login_id`) REFERENCES `auth_pending_logins`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_auth_challenges_session_id_auth_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "auth_challenges_authentication_version_check" CHECK("authentication_version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "auth_challenges_challenge_check" CHECK(length("challenge") BETWEEN 32 AND 256 AND instr("challenge", char(0)) = 0 AND "challenge" NOT GLOB '*[^A-Za-z0-9_-]*' AND (length("challenge") % 4 = 0 OR (length("challenge") % 4 = 2 AND substr("challenge", -1, 1) GLOB '[AQgw]') OR (length("challenge") % 4 = 3 AND substr("challenge", -1, 1) GLOB '[AEIMQUYcgkosw048]'))),
	CONSTRAINT "auth_challenges_config_fingerprint_check" CHECK(length("config_fingerprint") = 64 AND instr("config_fingerprint", char(0)) = 0 AND "config_fingerprint" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "auth_challenges_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "auth_challenges_binding_check" CHECK(("purpose" = 'login' AND "pending_login_id" IS NOT NULL AND "session_id" IS NULL) OR ("purpose" IN ('registration', 'step-up') AND "session_id" IS NOT NULL AND "pending_login_id" IS NULL)),
	CONSTRAINT "auth_challenges_time_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" > "created_at" AND "expires_at" <= "created_at" + 300000)
) STRICT;
--> statement-breakpoint
CREATE TABLE `auth_pending_logins` (
	`allows_recovery` integer NOT NULL,
	`allows_totp` integer NOT NULL,
	`allows_webauthn` integer NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`authentication_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY,
	`password_verified_at` integer NOT NULL,
	`replaced_session_id` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`validator_hash` text NOT NULL,
	`validator_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_auth_pending_logins_replaced_session_id_auth_sessions_id_fk` FOREIGN KEY (`replaced_session_id`) REFERENCES `auth_sessions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_auth_pending_logins_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "auth_pending_logins_methods_check" CHECK("allows_recovery" IN (0, 1) AND "allows_totp" IN (0, 1) AND "allows_webauthn" IN (0, 1) AND ("allows_recovery" + "allows_totp" + "allows_webauthn") >= 1),
	CONSTRAINT "auth_pending_logins_attempt_count_check" CHECK("attempt_count" BETWEEN 0 AND 8),
	CONSTRAINT "auth_pending_logins_authentication_version_check" CHECK("authentication_version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "auth_pending_logins_id_check" CHECK(length("id") = 32 AND instr("id", char(0)) = 0 AND "id" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "auth_pending_logins_time_check" CHECK("password_verified_at" BETWEEN 0 AND 8640000000000000 AND "created_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" BETWEEN 0 AND 8640000000000000 AND "password_verified_at" <= "created_at" AND "expires_at" > "created_at" AND "expires_at" <= "password_verified_at" + 300000),
	CONSTRAINT "auth_pending_logins_user_agent_check" CHECK("user_agent" IS NULL OR (length("user_agent") BETWEEN 1 AND 512 AND instr("user_agent", char(0)) = 0 AND length(trim("user_agent", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0)),
	CONSTRAINT "auth_pending_logins_validator_hash_check" CHECK(length("validator_hash") = 64 AND instr("validator_hash", char(0)) = 0 AND "validator_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "auth_pending_logins_validator_version_check" CHECK("validator_version" = 1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `auth_rate_limit_buckets` (
	`blocked_until` integer,
	`bucket_key` text PRIMARY KEY,
	`failure_count` integer NOT NULL,
	`first_failed_at` integer NOT NULL,
	`kind` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "auth_rate_limit_buckets_blocked_until_check" CHECK("blocked_until" IS NULL OR ("blocked_until" BETWEEN 0 AND 8640000000000000 AND "blocked_until" > "updated_at")),
	CONSTRAINT "auth_rate_limit_buckets_bucket_key_check" CHECK(length("bucket_key") = 64 AND instr("bucket_key", char(0)) = 0 AND "bucket_key" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "auth_rate_limit_buckets_failure_count_check" CHECK("failure_count" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "auth_rate_limit_buckets_kind_check" CHECK("kind" IN ('account-mfa', 'account-password', 'bootstrap-gateway-global', 'bootstrap-gateway-source', 'login-mfa-global', 'login-mfa-source', 'login-password-global', 'login-password-source')),
	CONSTRAINT "auth_rate_limit_buckets_timestamps_check" CHECK("first_failed_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" >= "first_failed_at")
) STRICT;
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`authenticated_at` integer NOT NULL,
	`authentication_version` integer NOT NULL,
	`auth_method` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY,
	`last_seen_at` integer NOT NULL,
	`mfa_verified_at` integer,
	`password_verified_at` integer NOT NULL,
	`user_agent` text,
	`user_id` text NOT NULL,
	`validator_hash` text NOT NULL,
	`validator_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_auth_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "auth_sessions_authentication_version_check" CHECK("authentication_version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "auth_sessions_auth_method_check" CHECK("auth_method" IN ('password', 'recovery', 'totp', 'webauthn')),
	CONSTRAINT "auth_sessions_expiry_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" > "created_at"),
	CONSTRAINT "auth_sessions_authentication_time_check" CHECK("authenticated_at" BETWEEN 0 AND 8640000000000000 AND "authenticated_at" <= "created_at"),
	CONSTRAINT "auth_sessions_last_seen_check" CHECK("last_seen_at" BETWEEN 0 AND 8640000000000000 AND "last_seen_at" >= "created_at" AND "last_seen_at" < "expires_at"),
	CONSTRAINT "auth_sessions_mfa_time_check" CHECK("mfa_verified_at" IS NULL OR ("mfa_verified_at" BETWEEN 0 AND 8640000000000000 AND "mfa_verified_at" >= "authenticated_at" AND "mfa_verified_at" <= "created_at")),
	CONSTRAINT "auth_sessions_password_time_check" CHECK("password_verified_at" BETWEEN 0 AND 8640000000000000 AND "password_verified_at" >= "authenticated_at" AND "password_verified_at" <= "created_at"),
	CONSTRAINT "auth_sessions_mfa_method_check" CHECK("auth_method" = 'password' OR "mfa_verified_at" IS NOT NULL),
	CONSTRAINT "auth_sessions_id_check" CHECK(length("id") = 32 AND instr("id", char(0)) = 0 AND "id" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "auth_sessions_user_agent_check" CHECK("user_agent" IS NULL OR (length("user_agent") BETWEEN 1 AND 512 AND instr("user_agent", char(0)) = 0 AND length(trim("user_agent", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0)),
	CONSTRAINT "auth_sessions_validator_hash_check" CHECK(length("validator_hash") = 64 AND instr("validator_hash", char(0)) = 0 AND "validator_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "auth_sessions_validator_version_check" CHECK("validator_version" = 1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `automation_credentials` (
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`id` text PRIMARY KEY,
	`label` text NOT NULL,
	`prefix` text NOT NULL,
	`principal_id` text NOT NULL,
	`replaces_credential_id` text,
	`revoked_at` integer,
	`validator_hash` text NOT NULL,
	`validator_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_automation_credentials_principal_id_automation_principals_id_fk` FOREIGN KEY (`principal_id`) REFERENCES `automation_principals`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_automation_credentials_replaces_credential_id_automation_credentials_id_fk` FOREIGN KEY (`replaces_credential_id`) REFERENCES `automation_credentials`(`id`) ON DELETE SET NULL,
	CONSTRAINT "automation_credentials_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "automation_credentials_label_check" CHECK(length("label") BETWEEN 1 AND 128 AND instr("label", char(0)) = 0 AND length(trim("label", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "label" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "automation_credentials_prefix_check" CHECK(length("prefix") = 32 AND instr("prefix", char(0)) = 0 AND "prefix" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "automation_credentials_validator_hash_check" CHECK(length("validator_hash") = 64 AND instr("validator_hash", char(0)) = 0 AND "validator_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "automation_credentials_validator_version_check" CHECK("validator_version" = 1),
	CONSTRAINT "automation_credentials_replacement_check" CHECK("replaces_credential_id" IS NULL OR (length("replaces_credential_id") = 36 AND instr("replaces_credential_id", char(0)) = 0 AND length(replace("replaces_credential_id", '-', '')) = 32 AND replace("replaces_credential_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("replaces_credential_id", 9, 1) = '-' AND substr("replaces_credential_id", 14, 1) = '-' AND substr("replaces_credential_id", 15, 1) = '7' AND substr("replaces_credential_id", 19, 1) = '-' AND substr("replaces_credential_id", 20, 1) GLOB '[89ab]' AND substr("replaces_credential_id", 24, 1) = '-' AND "replaces_credential_id" <> "id")),
	CONSTRAINT "automation_credentials_time_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND ("expires_at" IS NULL OR ("expires_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" > "created_at")) AND ("revoked_at" IS NULL OR ("revoked_at" BETWEEN 0 AND 8640000000000000 AND "revoked_at" >= "created_at")))
) STRICT;
--> statement-breakpoint
CREATE TABLE `automation_principal_capabilities` (
	`capability` text NOT NULL,
	`granted_at` integer NOT NULL,
	`principal_id` text NOT NULL,
	CONSTRAINT `automation_principal_capabilities_pk` PRIMARY KEY(`principal_id`, `capability`),
	CONSTRAINT `fk_automation_principal_capabilities_principal_id_automation_principals_id_fk` FOREIGN KEY (`principal_id`) REFERENCES `automation_principals`(`id`) ON DELETE CASCADE,
	CONSTRAINT "automation_principal_capabilities_capability_check" CHECK("capability" IN ('agents:read', 'agents:write', 'backups:read', 'backups:write', 'cache:read', 'cache:write', 'chat:read', 'chat:write', 'database:read', 'delivery:read', 'delivery:write', 'docker:read', 'docker:write', 'files:read', 'files:write', 'gateway-sessions:read', 'gateway-sessions:write', 'jobs:read', 'jobs:write', 'logs:read', 'logs:write', 'monitoring:write', 'notifications:read', 'notifications:write', 'openclaw-settings:read', 'openclaw-settings:write', 'openclaw-tasks:read', 'openclaw-tasks:write', 'reports:read', 'reports:write', 'service-actions:read', 'service-actions:write', 'tasks:read', 'tasks:write', 'terminal:read', 'terminal:write')),
	CONSTRAINT "automation_principal_capabilities_granted_at_check" CHECK("granted_at" BETWEEN 0 AND 8640000000000000)
) STRICT;
--> statement-breakpoint
CREATE TABLE `automation_principals` (
	`authorization_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer,
	`id` text PRIMARY KEY,
	`label` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "automation_principals_authorization_version_check" CHECK("authorization_version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "automation_principals_id_check" CHECK(length("id") BETWEEN 1 AND 64 AND instr("id", char(0)) = 0 AND "id" = lower("id") AND substr("id", 1, 1) GLOB '[a-z0-9]' AND "id" NOT GLOB '*[^a-z0-9._-]*'),
	CONSTRAINT "automation_principals_label_check" CHECK(length("label") BETWEEN 1 AND 128 AND instr("label", char(0)) = 0 AND length(trim("label", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "label" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "automation_principals_time_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" >= "created_at" AND ("disabled_at" IS NULL OR ("disabled_at" BETWEEN 0 AND 8640000000000000 AND "disabled_at" >= "created_at" AND "disabled_at" <= "updated_at")))
) STRICT;
--> statement-breakpoint
CREATE TABLE `chat_run_events` (
	`chat_run_id` text NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`kind` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`payload_bytes` integer NOT NULL,
	`payload_json` text NOT NULL,
	`provider_sequence_end` integer,
	`provider_sequence_start` integer,
	`sequence` integer NOT NULL,
	CONSTRAINT `fk_chat_run_events_chat_run_id_chat_runs_id_fk` FOREIGN KEY (`chat_run_id`) REFERENCES `chat_runs`(`id`) ON UPDATE RESTRICT ON DELETE CASCADE,
	CONSTRAINT "chat_run_events_kind_check" CHECK("kind" IN ('assistant', 'cancel', 'interrupted', 'item', 'plan', 'provider-noop', 'reconciled', 'status', 'terminal', 'thinking', 'tool', 'user')),
	CONSTRAINT "chat_run_events_sequence_check" CHECK("sequence" BETWEEN 1 AND 4096),
	CONSTRAINT "chat_run_events_payload_check" CHECK(length(CAST("payload_json" AS BLOB)) <= 262144 AND CASE WHEN json_valid("payload_json") THEN json_type("payload_json") = 'object' ELSE 0 END AND "payload_bytes" = length(CAST("payload_json" AS BLOB)) AND "payload_bytes" BETWEEN 2 AND 262144),
	CONSTRAINT "chat_run_events_provider_sequence_check" CHECK(("provider_sequence_start" IS NULL AND "provider_sequence_end" IS NULL) OR ("provider_sequence_start" BETWEEN 1 AND 9007199254740991 AND "provider_sequence_end" BETWEEN "provider_sequence_start" AND 9007199254740991)),
	CONSTRAINT "chat_run_events_occurred_at_check" CHECK("occurred_at" BETWEEN 0 AND 8640000000000000)
) STRICT;
--> statement-breakpoint
CREATE TABLE `chat_runs` (
	`actor_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`admitted_at` integer NOT NULL,
	`cancel_requested_at` integer,
	`dispatch_attempted_at` integer,
	`event_bytes` integer DEFAULT 0 NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`failure_code` text,
	`failure_message` text,
	`gateway_scope` text NOT NULL,
	`history_message_id` text,
	`id` text PRIMARY KEY,
	`idempotency_key` text NOT NULL,
	`last_event_sequence` integer DEFAULT 0 NOT NULL,
	`provider_acknowledged_at` integer,
	`provider_run_id` text,
	`reconciled_at` integer,
	`reconciliation_state` text DEFAULT 'pending' NOT NULL,
	`request_json` text NOT NULL,
	`request_sha256` text NOT NULL,
	`retention_expires_at` integer,
	`session_key` text NOT NULL,
	`state` text DEFAULT 'admitted' NOT NULL,
	`state_version` integer DEFAULT 1 NOT NULL,
	`terminal_at` integer,
	`transcript_generation` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chat_runs_actor_check" CHECK((("actor_kind" = 'user' AND length("actor_id") = 36 AND instr("actor_id", char(0)) = 0 AND length(replace("actor_id", '-', '')) = 32 AND replace("actor_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("actor_id", 9, 1) = '-' AND substr("actor_id", 14, 1) = '-' AND substr("actor_id", 15, 1) = '7' AND substr("actor_id", 19, 1) = '-' AND substr("actor_id", 20, 1) GLOB '[89ab]' AND substr("actor_id", 24, 1) = '-') OR ("actor_kind" = 'automation' AND length("actor_id") BETWEEN 1 AND 64 AND instr("actor_id", char(0)) = 0 AND "actor_id" = lower("actor_id") AND substr("actor_id", 1, 1) GLOB '[a-z0-9]' AND "actor_id" NOT GLOB '*[^a-z0-9._-]*'))),
	CONSTRAINT "chat_runs_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "chat_runs_idempotency_key_check" CHECK(length("idempotency_key") BETWEEN 32 AND 128 AND instr("idempotency_key", char(0)) = 0 AND "idempotency_key" NOT GLOB '*[^A-Za-z0-9_-]*' AND (length("idempotency_key") % 4 = 0 OR (length("idempotency_key") % 4 = 2 AND substr("idempotency_key", -1, 1) GLOB '[AQgw]') OR (length("idempotency_key") % 4 = 3 AND substr("idempotency_key", -1, 1) GLOB '[AEIMQUYcgkosw048]'))),
	CONSTRAINT "chat_runs_gateway_scope_check" CHECK(length("gateway_scope") BETWEEN 1 AND 64 AND instr("gateway_scope", char(0)) = 0 AND length(trim("gateway_scope", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "gateway_scope" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "chat_runs_session_key_check" CHECK(length("session_key") BETWEEN 1 AND 512 AND instr("session_key", char(0)) = 0 AND length(trim("session_key", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "session_key" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "chat_runs_provider_run_id_check" CHECK("provider_run_id" IS NULL OR length("provider_run_id") BETWEEN 1 AND 256 AND instr("provider_run_id", char(0)) = 0 AND length(trim("provider_run_id", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "provider_run_id" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "chat_runs_history_message_id_check" CHECK("history_message_id" IS NULL OR length("history_message_id") BETWEEN 1 AND 256 AND instr("history_message_id", char(0)) = 0 AND length(trim("history_message_id", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "history_message_id" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "chat_runs_request_json_check" CHECK(length(CAST("request_json" AS BLOB)) <= 262144 AND CASE WHEN json_valid("request_json") THEN json_type("request_json") = 'object' ELSE 0 END),
	CONSTRAINT "chat_runs_request_sha256_check" CHECK(length("request_sha256") = 64 AND instr("request_sha256", char(0)) = 0 AND "request_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "chat_runs_event_budget_check" CHECK("event_count" BETWEEN 0 AND 4096 AND "last_event_sequence" = "event_count" AND "event_bytes" BETWEEN 0 AND 1048576),
	CONSTRAINT "chat_runs_state_check" CHECK("state" IN ('active', 'admitted', 'cancel-requested', 'cancelled', 'completed', 'failed', 'interrupted', 'outcome-unknown', 'unresolved')),
	CONSTRAINT "chat_runs_reconciliation_state_check" CHECK("reconciliation_state" IN ('failed', 'history-authoritative', 'pending', 'runtime-authoritative')),
	CONSTRAINT "chat_runs_state_version_check" CHECK("state_version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "chat_runs_failure_check" CHECK(("state" = 'failed' AND "failure_code" IS NOT NULL AND length("failure_code") BETWEEN 1 AND 128 AND instr("failure_code", char(0)) = 0 AND length(trim("failure_code", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "failure_code" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*') AND "failure_message" IS NOT NULL AND length("failure_message") BETWEEN 1 AND 2000 AND instr("failure_message", char(0)) = 0 AND length(trim("failure_message", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0) OR ("state" <> 'failed' AND "failure_code" IS NULL AND "failure_message" IS NULL)),
	CONSTRAINT "chat_runs_lifecycle_check" CHECK(("state" IN ('cancelled', 'completed', 'failed', 'unresolved') AND "terminal_at" IS NOT NULL AND "retention_expires_at" IS NOT NULL AND "retention_expires_at" > "terminal_at") OR ("state" NOT IN ('cancelled', 'completed', 'failed', 'unresolved') AND "terminal_at" IS NULL AND "retention_expires_at" IS NULL)),
	CONSTRAINT "chat_runs_cancellation_check" CHECK(("state" IN ('cancel-requested', 'cancelled') AND "cancel_requested_at" IS NOT NULL) OR ("state" IN ('admitted', 'active', 'interrupted') AND "cancel_requested_at" IS NULL) OR ("state" IN ('completed', 'failed', 'outcome-unknown', 'unresolved'))),
	CONSTRAINT "chat_runs_reconciliation_check" CHECK(("reconciliation_state" = 'history-authoritative' AND "reconciled_at" IS NOT NULL) OR ("reconciliation_state" <> 'history-authoritative' AND "reconciled_at" IS NULL)),
	CONSTRAINT "chat_runs_transcript_generation_check" CHECK("transcript_generation" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "chat_runs_time_check" CHECK("admitted_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" >= "admitted_at" AND ("dispatch_attempted_at" IS NULL OR ("dispatch_attempted_at" BETWEEN 0 AND 8640000000000000 AND "dispatch_attempted_at" BETWEEN "admitted_at" AND "updated_at")) AND ("provider_acknowledged_at" IS NULL OR ("dispatch_attempted_at" IS NOT NULL AND "provider_acknowledged_at" BETWEEN 0 AND 8640000000000000 AND "provider_acknowledged_at" BETWEEN "dispatch_attempted_at" AND "updated_at")) AND ("cancel_requested_at" IS NULL OR ("cancel_requested_at" BETWEEN 0 AND 8640000000000000 AND "cancel_requested_at" BETWEEN "admitted_at" AND "updated_at")) AND ("terminal_at" IS NULL OR ("terminal_at" BETWEEN 0 AND 8640000000000000 AND "terminal_at" BETWEEN "admitted_at" AND "updated_at")) AND ("reconciled_at" IS NULL OR ("reconciled_at" BETWEEN 0 AND 8640000000000000 AND "reconciled_at" BETWEEN "admitted_at" AND "updated_at")) AND ("retention_expires_at" IS NULL OR "retention_expires_at" BETWEEN 0 AND 8640000000000000))
) STRICT;
--> statement-breakpoint
CREATE TABLE `chat_transcript_generations` (
	`current_generation` integer DEFAULT 1 NOT NULL,
	`gateway_scope` text NOT NULL,
	`last_boundary_action` text,
	`last_boundary_provider_updated_at` integer,
	`observed_at` integer,
	`pending_action` text,
	`pending_control_id` text,
	`pending_previous_status` text,
	`provider_session_id` text,
	`provider_updated_at` integer,
	`session_key` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `chat_transcript_generations_pk` PRIMARY KEY(`gateway_scope`, `session_key`),
	CONSTRAINT "chat_transcript_generations_gateway_scope_check" CHECK(length("gateway_scope") BETWEEN 1 AND 64 AND instr("gateway_scope", char(0)) = 0 AND length(trim("gateway_scope", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "gateway_scope" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "chat_transcript_generations_session_key_check" CHECK(length("session_key") BETWEEN 1 AND 512 AND instr("session_key", char(0)) = 0 AND length(trim("session_key", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "session_key" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "chat_transcript_generations_current_generation_check" CHECK("current_generation" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "chat_transcript_generations_version_check" CHECK("version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "chat_transcript_generations_status_check" CHECK("status" IN ('absent', 'control-pending', 'ready', 'reconciling')),
	CONSTRAINT "chat_transcript_generations_pending_check" CHECK(("status" = 'control-pending' AND "pending_action" IN ('compact', 'delete', 'reset') AND "pending_control_id" IS NOT NULL AND length("pending_control_id") BETWEEN 1 AND 128 AND instr("pending_control_id", char(0)) = 0 AND length(trim("pending_control_id", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "pending_control_id" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*') AND "pending_previous_status" IN ('absent', 'ready')) OR ("status" <> 'control-pending' AND "pending_action" IS NULL AND "pending_control_id" IS NULL AND "pending_previous_status" IS NULL)),
	CONSTRAINT "chat_transcript_generations_provider_session_check" CHECK("provider_session_id" IS NULL OR length("provider_session_id") BETWEEN 1 AND 256 AND instr("provider_session_id", char(0)) = 0 AND length(trim("provider_session_id", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "provider_session_id" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "chat_transcript_generations_boundary_action_check" CHECK("last_boundary_action" IS NULL OR "last_boundary_action" IN ('compact', 'delete', 'new', 'reset', 'transport')),
	CONSTRAINT "chat_transcript_generations_time_check" CHECK("updated_at" BETWEEN 0 AND 8640000000000000 AND ("observed_at" IS NULL OR ("observed_at" BETWEEN 0 AND 8640000000000000 AND "observed_at" <= "updated_at")) AND ("provider_updated_at" IS NULL OR "provider_updated_at" BETWEEN 0 AND 8640000000000000) AND ("last_boundary_provider_updated_at" IS NULL OR "last_boundary_provider_updated_at" BETWEEN 0 AND 8640000000000000)),
	CONSTRAINT "chat_transcript_generations_absent_check" CHECK("status" <> 'absent' OR "provider_session_id" IS NULL)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `chat_external_runtime_snapshots` (
	`gateway_scope` text NOT NULL,
	`observation_epoch` integer NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`session_key` text NOT NULL,
	`snapshot_bytes` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`transcript_generation` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `chat_external_runtime_snapshots_pk` PRIMARY KEY(`gateway_scope`, `session_key`),
	CONSTRAINT `chat_external_runtime_snapshots_transcript_fk` FOREIGN KEY (`gateway_scope`,`session_key`) REFERENCES `chat_transcript_generations`(`gateway_scope`,`session_key`) ON UPDATE RESTRICT ON DELETE CASCADE,
	CONSTRAINT "chat_external_runtime_snapshots_gateway_scope_check" CHECK(length("gateway_scope") BETWEEN 1 AND 64 AND instr("gateway_scope", char(0)) = 0 AND length(trim("gateway_scope", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "gateway_scope" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "chat_external_runtime_snapshots_session_key_check" CHECK(length("session_key") BETWEEN 1 AND 512 AND instr("session_key", char(0)) = 0 AND length(trim("session_key", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "session_key" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "chat_external_runtime_snapshots_transcript_generation_check" CHECK("transcript_generation" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "chat_external_runtime_snapshots_observation_epoch_check" CHECK("observation_epoch" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "chat_external_runtime_snapshots_schema_version_check" CHECK("schema_version" = 1),
	CONSTRAINT "chat_external_runtime_snapshots_payload_check" CHECK(length(CAST("snapshot_json" AS BLOB)) <= 5242880 AND CASE WHEN json_valid("snapshot_json") THEN json_type("snapshot_json") = 'object' ELSE 0 END AND "snapshot_bytes" = length(CAST("snapshot_json" AS BLOB))),
	CONSTRAINT "chat_external_runtime_snapshots_updated_at_check" CHECK("updated_at" BETWEEN 0 AND 8640000000000000)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `chat_runtime_snapshots` (
	`chat_run_id` text PRIMARY KEY,
	`first_sequence` integer NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`snapshot_bytes` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`through_sequence` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_chat_runtime_snapshots_chat_run_id_chat_runs_id_fk` FOREIGN KEY (`chat_run_id`) REFERENCES `chat_runs`(`id`) ON UPDATE RESTRICT ON DELETE CASCADE,
	CONSTRAINT "chat_runtime_snapshots_schema_version_check" CHECK("schema_version" = 1),
	CONSTRAINT "chat_runtime_snapshots_sequence_check" CHECK("first_sequence" BETWEEN 1 AND 4096 AND "through_sequence" BETWEEN "first_sequence" AND 4096),
	CONSTRAINT "chat_runtime_snapshots_payload_check" CHECK(length(CAST("snapshot_json" AS BLOB)) <= 524288 AND CASE WHEN json_valid("snapshot_json") THEN json_type("snapshot_json") = 'object' ELSE 0 END AND "snapshot_bytes" = length(CAST("snapshot_json" AS BLOB))),
	CONSTRAINT "chat_runtime_snapshots_updated_at_check" CHECK("updated_at" BETWEEN 0 AND 8640000000000000)
) STRICT;
--> statement-breakpoint
CREATE TABLE `cache_entries` (
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`failure_code` text,
	`failure_message` text,
	`key` text PRIMARY KEY NOT NULL,
	`last_attempt_at` integer NOT NULL,
	`last_attempt_duration_ms` integer NOT NULL,
	`last_attempt_number` integer NOT NULL,
	`last_attempt_run_id` text NOT NULL,
	`last_attempt_status` text NOT NULL,
	`last_success_at` integer,
	`metadata_json` text,
	`payload_json` text,
	`schema_id` text,
	`source` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_cache_entries_last_attempt_run_id_job_runs_id_fk` FOREIGN KEY (`last_attempt_run_id`) REFERENCES `job_runs`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "cache_entries_attempt_number_check" CHECK("last_attempt_number" BETWEEN 1 AND 10),
	CONSTRAINT "cache_entries_attempt_run_id_check" CHECK(length("last_attempt_run_id") = 36 AND instr("last_attempt_run_id", char(0)) = 0 AND length(replace("last_attempt_run_id", '-', '')) = 32 AND replace("last_attempt_run_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("last_attempt_run_id", 9, 1) = '-' AND substr("last_attempt_run_id", 14, 1) = '-' AND substr("last_attempt_run_id", 15, 1) = '7' AND substr("last_attempt_run_id", 19, 1) = '-' AND substr("last_attempt_run_id", 20, 1) GLOB '[89ab]' AND substr("last_attempt_run_id", 24, 1) = '-'),
	CONSTRAINT "cache_entries_attempt_status_check" CHECK("last_attempt_status" IN ('failed', 'succeeded')),
	CONSTRAINT "cache_entries_duration_check" CHECK("last_attempt_duration_ms" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "cache_entries_failure_code_check" CHECK(("failure_code" IS NULL OR (length("failure_code") BETWEEN 1 AND 128 AND instr("failure_code", char(0)) = 0 AND "failure_code" = lower("failure_code") AND substr("failure_code", 1, 1) GLOB '[a-z0-9]' AND "failure_code" NOT GLOB '*[^a-z0-9._/-]*'))),
	CONSTRAINT "cache_entries_failure_message_check" CHECK(("failure_message" IS NULL OR (length("failure_message") BETWEEN 1 AND 2000 AND instr("failure_message", char(0)) = 0 AND length(trim("failure_message", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "failure_message" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*') AND length(CAST("failure_message" AS BLOB)) <= 8000))),
	CONSTRAINT "cache_entries_failure_state_check" CHECK(("last_attempt_status" = 'succeeded' AND "consecutive_failures" = 0 AND "failure_code" IS NULL AND "failure_message" IS NULL) OR ("last_attempt_status" = 'failed' AND "consecutive_failures" BETWEEN 1 AND 9007199254740991 AND "failure_code" IS NOT NULL AND "failure_message" IS NOT NULL)),
	CONSTRAINT "cache_entries_key_check" CHECK(length("key") BETWEEN 1 AND 128 AND instr("key", char(0)) = 0 AND "key" = lower("key") AND substr("key", 1, 1) GLOB '[a-z0-9]' AND "key" NOT GLOB '*[^a-z0-9._-]*'),
	CONSTRAINT "cache_entries_metadata_json_check" CHECK("metadata_json" IS NULL OR (length(CAST("metadata_json" AS BLOB)) <= 16384 AND CASE WHEN json_valid("metadata_json") THEN json_type("metadata_json") = 'object' ELSE 0 END)),
	CONSTRAINT "cache_entries_payload_json_check" CHECK("payload_json" IS NULL OR (length(CAST("payload_json" AS BLOB)) <= 262144 AND CASE WHEN json_valid("payload_json") THEN json_type("payload_json") = 'object' ELSE 0 END) OR ("key" = 'delivery.overview.pull-requests' AND length(CAST("payload_json" AS BLOB)) <= 2359296 AND CASE WHEN json_valid("payload_json") THEN json_type("payload_json") = 'object' ELSE 0 END)),
	CONSTRAINT "cache_entries_projection_check" CHECK(("payload_json" IS NULL AND "metadata_json" IS NULL AND "source" IS NULL AND "schema_id" IS NULL AND "last_success_at" IS NULL AND "expires_at" IS NULL) OR ("payload_json" IS NOT NULL AND "metadata_json" IS NOT NULL AND "source" IS NOT NULL AND "schema_id" IS NOT NULL AND "last_success_at" IS NOT NULL AND "expires_at" IS NOT NULL)),
	CONSTRAINT "cache_entries_schema_id_check" CHECK("schema_id" IS NULL OR (length("schema_id") BETWEEN 1 AND 128 AND instr("schema_id", char(0)) = 0 AND "schema_id" = lower("schema_id") AND substr("schema_id", 1, 1) GLOB '[a-z0-9]' AND "schema_id" NOT GLOB '*[^a-z0-9._-]*')),
	CONSTRAINT "cache_entries_source_check" CHECK("source" IS NULL OR (length("source") BETWEEN 1 AND 128 AND instr("source", char(0)) = 0 AND length(trim("source", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "source" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*') AND length(CAST("source" AS BLOB)) <= 512)),
	CONSTRAINT "cache_entries_success_state_check" CHECK("last_attempt_status" <> 'succeeded' OR ("payload_json" IS NOT NULL AND "last_success_at" = "last_attempt_at")),
	CONSTRAINT "cache_entries_time_check" CHECK("last_attempt_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" >= "last_attempt_at" AND ("last_success_at" IS NULL OR ("last_success_at" BETWEEN 0 AND 8640000000000000 AND "last_success_at" <= "last_attempt_at")) AND ("expires_at" IS NULL OR ("expires_at" BETWEEN 0 AND 8640000000000000 AND "last_success_at" IS NOT NULL AND "expires_at" > "last_success_at")))
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `incident_observations` (
	`details_json` text DEFAULT '{}' NOT NULL,
	`generation` integer NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`incident_id` text NOT NULL,
	`kind` text NOT NULL,
	`monitor_run_id` text NOT NULL,
	`observed_at` integer NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	CONSTRAINT `fk_incident_observations_incident_id_incidents_id_fk` FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_incident_observations_monitor_run_id_monitor_runs_id_fk` FOREIGN KEY (`monitor_run_id`) REFERENCES `monitor_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "incident_observations_details_json_check" CHECK(CASE WHEN json_valid("details_json") THEN json_type("details_json") = 'object' ELSE 0 END),
	CONSTRAINT "incident_observations_generation_check" CHECK("generation" >= 1),
	CONSTRAINT "incident_observations_severity_check" CHECK("severity" IN ('critical', 'error', 'info', 'warning'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `incidents` (
	`details_json` text DEFAULT '{}' NOT NULL,
	`fingerprint` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	`monitor_key` text NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`resolved_at` integer,
	`severity` text NOT NULL,
	`state` text NOT NULL,
	`title` text NOT NULL,
	CONSTRAINT "incidents_details_json_check" CHECK(CASE WHEN json_valid("details_json") THEN json_type("details_json") = 'object' ELSE 0 END),
	CONSTRAINT "incidents_fingerprint_check" CHECK(length("fingerprint") = 64 AND instr("fingerprint", char(0)) = 0 AND "fingerprint" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "incidents_generation_check" CHECK("generation" >= 1),
	CONSTRAINT "incidents_occurrence_count_check" CHECK("occurrence_count" >= 1),
	CONSTRAINT "incidents_severity_check" CHECK("severity" IN ('critical', 'error', 'info', 'warning')),
	CONSTRAINT "incidents_state_check" CHECK("state" IN ('active', 'resolved')),
	CONSTRAINT "incidents_resolution_check" CHECK(("state" = 'active' AND "resolved_at" IS NULL) OR ("state" = 'resolved' AND "resolved_at" IS NOT NULL)),
	CONSTRAINT "incidents_seen_order_check" CHECK("last_seen_at" >= "first_seen_at"),
	CONSTRAINT "incidents_resolution_order_check" CHECK("resolved_at" IS NULL OR "resolved_at" >= "last_seen_at")
) STRICT;
--> statement-breakpoint
CREATE TABLE `monitor_runs` (
	`completed_at` integer,
	`complete_snapshot` integer NOT NULL,
	`id` text PRIMARY KEY,
	`monitor_key` text NOT NULL,
	`report_id` text,
	`started_at` integer NOT NULL,
	`state` text NOT NULL,
	`submission_sha256` text NOT NULL,
	CONSTRAINT `fk_monitor_runs_report_id_reports_id_fk` FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON DELETE SET NULL,
	CONSTRAINT "monitor_runs_complete_snapshot_check" CHECK("complete_snapshot" IN (0, 1)),
	CONSTRAINT "monitor_runs_state_check" CHECK("state" IN ('failed', 'running', 'succeeded')),
	CONSTRAINT "monitor_runs_completion_check" CHECK(("state" = 'running' AND "completed_at" IS NULL) OR ("state" IN ('failed', 'succeeded') AND "completed_at" IS NOT NULL)),
	CONSTRAINT "monitor_runs_completion_order_check" CHECK("completed_at" IS NULL OR "completed_at" >= "started_at"),
	CONSTRAINT "monitor_runs_submission_sha256_check" CHECK(length("submission_sha256") = 64 AND instr("submission_sha256", char(0)) = 0 AND "submission_sha256" NOT GLOB '*[^0-9a-f]*')
) STRICT;
--> statement-breakpoint
CREATE TABLE `notifications` (
	`channel` text NOT NULL,
	`id` text PRIMARY KEY,
	`incident_generation` integer,
	`incident_id` text,
	`kind` text NOT NULL,
	`link_url` text,
	`message` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`read_at` integer,
	`report_id` text,
	`severity` text NOT NULL,
	`source` text,
	`title` text NOT NULL,
	CONSTRAINT `fk_notifications_incident_id_incidents_id_fk` FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_notifications_report_id_reports_id_fk` FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON DELETE CASCADE,
	CONSTRAINT "notifications_channel_check" CHECK("channel" = 'dashboard'),
	CONSTRAINT "notifications_incident_pair_check" CHECK(("incident_id" IS NULL AND "incident_generation" IS NULL) OR ("incident_id" IS NOT NULL AND "incident_generation" IS NOT NULL)),
	CONSTRAINT "notifications_incident_generation_check" CHECK("incident_generation" IS NULL OR "incident_generation" >= 1),
	CONSTRAINT "notifications_read_order_check" CHECK("read_at" IS NULL OR "read_at" >= "occurred_at"),
	CONSTRAINT "notifications_severity_check" CHECK("severity" IN ('critical', 'error', 'info', 'warning'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `realtime_events` (
	`entity_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`expires_at` integer NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`occurred_at` integer NOT NULL,
	`operation` text NOT NULL,
	`payload_json` text NOT NULL,
	`topic` text NOT NULL,
	CONSTRAINT "realtime_events_payload_json_check" CHECK(json_valid("payload_json")),
	CONSTRAINT "realtime_events_operation_check" CHECK("operation" IN ('created', 'deleted', 'snapshot-required', 'updated')),
	CONSTRAINT "realtime_events_expiry_order_check" CHECK("expires_at" > "occurred_at")
) STRICT;
--> statement-breakpoint
CREATE TABLE `reports` (
	`body_markdown` text NOT NULL,
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` integer NOT NULL,
	`source` text NOT NULL,
	`source_job_id` text,
	`status` text DEFAULT 'ok' NOT NULL,
	`summary` text,
	`title` text NOT NULL,
	CONSTRAINT "reports_metadata_json_check" CHECK(CASE WHEN json_valid("metadata_json") THEN json_type("metadata_json") = 'object' ELSE 0 END),
	CONSTRAINT "reports_status_check" CHECK("status" IN ('error', 'ok', 'warning'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `schema_migrations` (
	`applied_at` integer NOT NULL,
	`checksum` text NOT NULL,
	`id` text PRIMARY KEY,
	`release_id` text NOT NULL,
	CONSTRAINT "schema_migrations_applied_at_check" CHECK("applied_at" BETWEEN 0 AND 8640000000000000),
	CONSTRAINT "schema_migrations_checksum_check" CHECK(length("checksum") = 64 AND instr("checksum", char(0)) = 0 AND "checksum" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "schema_migrations_id_check" CHECK(length("id") BETWEEN 16 AND 128 AND instr("id", char(0)) = 0 AND substr("id", 1, 14) NOT GLOB '*[^0-9]*' AND substr("id", 15, 1) = '_' AND substr("id", 16, 1) GLOB '[a-z0-9]' AND substr("id", 16) NOT GLOB '*[^a-z0-9_-]*'),
	CONSTRAINT "schema_migrations_release_id_check" CHECK(length("release_id") = 40 AND instr("release_id", char(0)) = 0 AND "release_id" NOT GLOB '*[^0-9a-f]*')
) STRICT;
--> statement-breakpoint
CREATE TABLE `user_recovery_codes` (
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY,
	`selector` text NOT NULL,
	`used_at` integer,
	`user_id` text NOT NULL,
	`validator_hash` text NOT NULL,
	CONSTRAINT `fk_user_recovery_codes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "user_recovery_codes_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "user_recovery_codes_selector_check" CHECK(length("selector") = 32 AND instr("selector", char(0)) = 0 AND "selector" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "user_recovery_codes_time_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND ("used_at" IS NULL OR ("used_at" BETWEEN 0 AND 8640000000000000 AND "used_at" >= "created_at"))),
	CONSTRAINT "user_recovery_codes_validator_hash_check" CHECK(length("validator_hash") = 118 AND instr("validator_hash", char(0)) = 0 AND substr("validator_hash", 1, 31) = '$argon2id$v=19$m=65536,t=3,p=1$' AND substr("validator_hash", 75, 1) = '$' AND substr("validator_hash", 32, 43) NOT GLOB '*[^A-Za-z0-9+/]*' AND substr("validator_hash", 76, 43) NOT GLOB '*[^A-Za-z0-9+/]*' AND substr("validator_hash", 74, 1) GLOB '[AEIMQUYcgkosw048]' AND substr("validator_hash", 118, 1) GLOB '[AEIMQUYcgkosw048]')
) STRICT;
--> statement-breakpoint
CREATE TABLE `user_totp_factors` (
	`confirmed_at` integer,
	`created_at` integer NOT NULL,
	`encrypted_secret` text NOT NULL,
	`enrollment_expires_at` integer NOT NULL,
	`id` text PRIMARY KEY,
	`label` text NOT NULL,
	`last_used_step` integer,
	`secret_key_id` text NOT NULL,
	`user_id` text NOT NULL,
	CONSTRAINT `fk_user_totp_factors_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "user_totp_factors_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "user_totp_factors_label_check" CHECK(length("label") BETWEEN 1 AND 128 AND instr("label", char(0)) = 0 AND length(trim("label", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "label" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "user_totp_factors_secret_key_id_check" CHECK(length("secret_key_id") BETWEEN 1 AND 32 AND instr("secret_key_id", char(0)) = 0 AND "secret_key_id" = lower("secret_key_id") AND substr("secret_key_id", 1, 1) GLOB '[a-z0-9]' AND "secret_key_id" NOT GLOB '*[^a-z0-9_-]*'),
	CONSTRAINT "user_totp_factors_encrypted_secret_check" CHECK(length("encrypted_secret") = 84 AND instr("encrypted_secret", char(0)) = 0 AND substr("encrypted_secret", 1, 3) = 'v1.' AND substr("encrypted_secret", 4, 16) NOT GLOB '*[^A-Za-z0-9_-]*' AND substr("encrypted_secret", 20, 1) = '.' AND substr("encrypted_secret", 21, 64) NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "user_totp_factors_enrollment_time_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND "enrollment_expires_at" BETWEEN 0 AND 8640000000000000 AND "enrollment_expires_at" > "created_at" AND "enrollment_expires_at" <= "created_at" + 300000),
	CONSTRAINT "user_totp_factors_confirmation_check" CHECK(("confirmed_at" IS NULL AND "last_used_step" IS NULL) OR ("confirmed_at" IS NOT NULL AND "last_used_step" IS NOT NULL AND "confirmed_at" BETWEEN 0 AND 8640000000000000 AND "confirmed_at" >= "created_at" AND "confirmed_at" < "enrollment_expires_at" AND "last_used_step" BETWEEN 0 AND 9007199254740991))
) STRICT;
--> statement-breakpoint
CREATE TABLE `user_webauthn_credentials` (
	`algorithm` integer NOT NULL,
	`backed_up` integer NOT NULL,
	`counter` integer NOT NULL,
	`created_at` integer NOT NULL,
	`credential_id` text NOT NULL,
	`device_type` text NOT NULL,
	`id` text PRIMARY KEY,
	`label` text NOT NULL,
	`last_used_at` integer,
	`public_key` blob NOT NULL,
	`rp_id` text NOT NULL,
	`transport_mask` integer NOT NULL,
	`user_id` text NOT NULL,
	CONSTRAINT `fk_user_webauthn_credentials_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "user_webauthn_credentials_algorithm_check" CHECK("algorithm" = -7),
	CONSTRAINT "user_webauthn_credentials_counter_check" CHECK("counter" BETWEEN 0 AND 4294967295),
	CONSTRAINT "user_webauthn_credentials_credential_id_check" CHECK(length("credential_id") BETWEEN 8 AND 1024 AND instr("credential_id", char(0)) = 0 AND "credential_id" NOT GLOB '*[^A-Za-z0-9_-]*' AND (length("credential_id") % 4 = 0 OR (length("credential_id") % 4 = 2 AND substr("credential_id", -1, 1) GLOB '[AQgw]') OR (length("credential_id") % 4 = 3 AND substr("credential_id", -1, 1) GLOB '[AEIMQUYcgkosw048]'))),
	CONSTRAINT "user_webauthn_credentials_device_state_check" CHECK("backed_up" IN (0, 1) AND "device_type" IN ('singleDevice', 'multiDevice') AND NOT ("device_type" = 'singleDevice' AND "backed_up" = 1)),
	CONSTRAINT "user_webauthn_credentials_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "user_webauthn_credentials_label_check" CHECK(length("label") BETWEEN 1 AND 128 AND instr("label", char(0)) = 0 AND length(trim("label", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "label" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "user_webauthn_credentials_public_key_check" CHECK(length("public_key") BETWEEN 1 AND 2048),
	CONSTRAINT "user_webauthn_credentials_rp_id_check" CHECK(length("rp_id") BETWEEN 1 AND 253 AND instr("rp_id", char(0)) = 0 AND length(trim("rp_id", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0),
	CONSTRAINT "user_webauthn_credentials_time_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND ("last_used_at" IS NULL OR ("last_used_at" BETWEEN 0 AND 8640000000000000 AND "last_used_at" >= "created_at"))),
	CONSTRAINT "user_webauthn_credentials_transport_mask_check" CHECK("transport_mask" BETWEEN 0 AND 127)
) STRICT;
--> statement-breakpoint
CREATE TABLE `users` (
	`authentication_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer,
	`id` text PRIMARY KEY,
	`mfa_enabled_at` integer,
	`password_hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	`username` text NOT NULL,
	CONSTRAINT "users_authentication_version_check" CHECK("authentication_version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "users_created_at_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" >= "created_at"),
	CONSTRAINT "users_disabled_at_check" CHECK("disabled_at" IS NULL OR ("disabled_at" BETWEEN 0 AND 8640000000000000 AND "disabled_at" >= "created_at" AND "disabled_at" <= "updated_at")),
	CONSTRAINT "users_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "users_mfa_enabled_at_check" CHECK("mfa_enabled_at" IS NULL OR ("mfa_enabled_at" BETWEEN 0 AND 8640000000000000 AND "mfa_enabled_at" >= "created_at" AND "mfa_enabled_at" <= "updated_at")),
	CONSTRAINT "users_password_hash_check" CHECK(length("password_hash") = 118 AND instr("password_hash", char(0)) = 0 AND substr("password_hash", 1, 31) = '$argon2id$v=19$m=65536,t=3,p=1$' AND substr("password_hash", 75, 1) = '$' AND substr("password_hash", 32, 43) NOT GLOB '*[^A-Za-z0-9+/]*' AND substr("password_hash", 76, 43) NOT GLOB '*[^A-Za-z0-9+/]*' AND substr("password_hash", 74, 1) GLOB '[AEIMQUYcgkosw048]' AND substr("password_hash", 118, 1) GLOB '[AEIMQUYcgkosw048]'),
	CONSTRAINT "users_username_check" CHECK(length("username") BETWEEN 3 AND 32 AND instr("username", char(0)) = 0 AND "username" = lower("username") AND substr("username", 1, 1) GLOB '[a-z0-9]' AND "username" NOT GLOB '*[^a-z0-9._-]*')
) STRICT;
--> statement-breakpoint
CREATE INDEX `audit_events_occurred_id_idx` ON `audit_events` (`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_request_occurred_idx` ON `audit_events` (`request_id`,`occurred_at`,`id`) WHERE "audit_events"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `audit_events_target_occurred_idx` ON `audit_events` (`target_type`,`target_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `auth_challenges_expires_at_idx` ON `auth_challenges` (`expires_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_challenges_pending_login_purpose_unique` ON `auth_challenges` (`pending_login_id`,`purpose`) WHERE ("auth_challenges"."pending_login_id" is not null);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_challenges_session_purpose_unique` ON `auth_challenges` (`session_id`,`purpose`) WHERE ("auth_challenges"."session_id" is not null);--> statement-breakpoint
CREATE INDEX `auth_pending_logins_expires_at_idx` ON `auth_pending_logins` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `auth_pending_logins_replaced_session_id_idx` ON `auth_pending_logins` (`replaced_session_id`);--> statement-breakpoint
CREATE INDEX `auth_pending_logins_user_expires_at_idx` ON `auth_pending_logins` (`user_id`,`expires_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_pending_logins_validator_hash_unique` ON `auth_pending_logins` (`validator_hash`);--> statement-breakpoint
CREATE INDEX `auth_rate_limit_buckets_kind_updated_at_idx` ON `auth_rate_limit_buckets` (`kind`,`updated_at`,`bucket_key`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expires_at_idx` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_last_seen_idx` ON `auth_sessions` (`user_id`,`last_seen_at`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_validator_hash_unique` ON `auth_sessions` (`validator_hash`);--> statement-breakpoint
CREATE INDEX `automation_credentials_principal_created_idx` ON `automation_credentials` (`principal_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `automation_credentials_active_principal_created_idx` ON `automation_credentials` (`principal_id`,`created_at`,`id`) WHERE "automation_credentials"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `automation_credentials_replacement_idx` ON `automation_credentials` (`replaces_credential_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_credentials_active_replacement_unique` ON `automation_credentials` (`replaces_credential_id`) WHERE "automation_credentials"."replaces_credential_id" IS NOT NULL AND "automation_credentials"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `automation_credentials_prefix_unique` ON `automation_credentials` (`prefix`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_credentials_validator_unique` ON `automation_credentials` (`validator_version`,`validator_hash`);--> statement-breakpoint
CREATE INDEX `automation_principals_created_id_idx` ON `automation_principals` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `automation_principals_active_created_id_idx` ON `automation_principals` (`created_at`,`id`) WHERE "automation_principals"."disabled_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_run_events_run_sequence_unique` ON `chat_run_events` (`chat_run_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `chat_run_events_run_cursor_idx` ON `chat_run_events` (`chat_run_id`,`id`);--> statement-breakpoint
CREATE INDEX `chat_run_events_occurred_cursor_idx` ON `chat_run_events` (`occurred_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_runs_actor_idempotency_unique` ON `chat_runs` (`actor_kind`,`actor_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_runs_provider_intent_unique` ON `chat_runs` (`gateway_scope`,`session_key`,`transcript_generation`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_runs_provider_identity_unique` ON `chat_runs` (`gateway_scope`,`session_key`,`transcript_generation`,`provider_run_id`) WHERE "chat_runs"."provider_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `chat_runs_session_updated_id_idx` ON `chat_runs` (`gateway_scope`,`session_key`,`transcript_generation`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `chat_runs_active_session_idx` ON `chat_runs` (`gateway_scope`,`session_key`,`transcript_generation`,`admitted_at`,`id`) WHERE "chat_runs"."state" IN ('active', 'admitted', 'cancel-requested', 'interrupted', 'outcome-unknown');--> statement-breakpoint
CREATE INDEX `chat_runs_active_process_idx` ON `chat_runs` (`gateway_scope`,`transcript_generation`,`admitted_at`,`id`) WHERE "chat_runs"."state" IN ('active', 'admitted', 'cancel-requested', 'interrupted', 'outcome-unknown');--> statement-breakpoint
CREATE INDEX `chat_runs_retention_idx` ON `chat_runs` (`retention_expires_at`,`id`) WHERE "chat_runs"."retention_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `cache_entries_status_expires_key_idx` ON `cache_entries` (`last_attempt_status`,`expires_at`,`key`);--> statement-breakpoint
CREATE TABLE `task_automation_profiles` (
	`cron_job_id` text NOT NULL,
	`kind` text NOT NULL,
	`model` text,
	`recurring` integer NOT NULL,
	`schedule_summary` text,
	`session_target` text,
	`task_id` text PRIMARY KEY NOT NULL,
	`thinking` text,
	CONSTRAINT `fk_task_automation_profiles_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "task_automation_profiles_cron_job_id_check" CHECK(length("cron_job_id") BETWEEN 1 AND 200 AND instr("cron_job_id", char(0)) = 0 AND length(trim("cron_job_id", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "cron_job_id" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "task_automation_profiles_kind_check" CHECK("kind" = 'openclaw-cron'),
	CONSTRAINT "task_automation_profiles_model_check" CHECK("model" IS NULL OR (length("model") BETWEEN 1 AND 200 AND instr("model", char(0)) = 0 AND length(trim("model", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "model" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*'))),
	CONSTRAINT "task_automation_profiles_recurring_check" CHECK("recurring" IN (0, 1)),
	CONSTRAINT "task_automation_profiles_schedule_summary_check" CHECK("schedule_summary" IS NULL OR (length("schedule_summary") BETWEEN 1 AND 500 AND instr("schedule_summary", char(0)) = 0 AND length(trim("schedule_summary", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "schedule_summary" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*'))),
	CONSTRAINT "task_automation_profiles_session_target_check" CHECK("session_target" IS NULL OR (length("session_target") BETWEEN 1 AND 200 AND instr("session_target", char(0)) = 0 AND length(trim("session_target", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "session_target" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*'))),
	CONSTRAINT "task_automation_profiles_task_id_check" CHECK(length("task_id") = 36 AND instr("task_id", char(0)) = 0 AND length(replace("task_id", '-', '')) = 32 AND replace("task_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("task_id", 9, 1) = '-' AND substr("task_id", 14, 1) = '-' AND substr("task_id", 15, 1) = '7' AND substr("task_id", 19, 1) = '-' AND substr("task_id", 20, 1) GLOB '[89ab]' AND substr("task_id", 24, 1) = '-'),
	CONSTRAINT "task_automation_profiles_thinking_check" CHECK("thinking" IS NULL OR (length("thinking") BETWEEN 1 AND 200 AND instr("thinking", char(0)) = 0 AND length(trim("thinking", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "thinking" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')))
) STRICT;
--> statement-breakpoint
CREATE TABLE `task_events` (
	`actor_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`event_type` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`task_id` text NOT NULL,
	CONSTRAINT "task_events_actor_check" CHECK(("actor_kind" = 'user' AND length("actor_id") = 36 AND instr("actor_id", char(0)) = 0 AND length(replace("actor_id", '-', '')) = 32 AND replace("actor_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("actor_id", 9, 1) = '-' AND substr("actor_id", 14, 1) = '-' AND substr("actor_id", 15, 1) = '7' AND substr("actor_id", 19, 1) = '-' AND substr("actor_id", 20, 1) GLOB '[89ab]' AND substr("actor_id", 24, 1) = '-') OR ("actor_kind" = 'automation' AND length("actor_id") BETWEEN 1 AND 64 AND instr("actor_id", char(0)) = 0 AND "actor_id" = lower("actor_id") AND substr("actor_id", 1, 1) GLOB '[a-z0-9]' AND "actor_id" NOT GLOB '*[^a-z0-9._-]*')),
	CONSTRAINT "task_events_created_at_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000),
	CONSTRAINT "task_events_event_type_check" CHECK("event_type" IN ('assigned', 'created', 'deleted', 'moved', 'progress-added', 'progress-deleted', 'progress-updated', 'updated')),
	CONSTRAINT "task_events_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "task_events_payload_json_check" CHECK(length(CAST("payload_json" AS BLOB)) <= 4096 AND CASE WHEN json_valid("payload_json") THEN json_type("payload_json") = 'object' ELSE 0 END),
	CONSTRAINT "task_events_task_id_check" CHECK(length("task_id") = 36 AND instr("task_id", char(0)) = 0 AND length(replace("task_id", '-', '')) = 32 AND replace("task_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("task_id", 9, 1) = '-' AND substr("task_id", 14, 1) = '-' AND substr("task_id", 15, 1) = '7' AND substr("task_id", 19, 1) = '-' AND substr("task_id", 20, 1) GLOB '[89ab]' AND substr("task_id", 24, 1) = '-')
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `task_notification_outbox` (
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`event_id` text PRIMARY KEY NOT NULL,
	`lease_expires_at` integer,
	`lease_owner` text,
	`message` text NOT NULL,
	CONSTRAINT `fk_task_notification_outbox_event_id_task_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `task_events`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "task_notification_outbox_attempt_count_check" CHECK("attempt_count" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "task_notification_outbox_available_at_check" CHECK("available_at" BETWEEN 0 AND 8640000000000000 AND "available_at" >= "created_at"),
	CONSTRAINT "task_notification_outbox_created_at_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000),
	CONSTRAINT "task_notification_outbox_delivered_at_check" CHECK("delivered_at" IS NULL OR ("delivered_at" BETWEEN 0 AND 8640000000000000 AND "delivered_at" >= "created_at")),
	CONSTRAINT "task_notification_outbox_event_id_check" CHECK(length("event_id") = 36 AND instr("event_id", char(0)) = 0 AND length(replace("event_id", '-', '')) = 32 AND replace("event_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("event_id", 9, 1) = '-' AND substr("event_id", 14, 1) = '-' AND substr("event_id", 15, 1) = '7' AND substr("event_id", 19, 1) = '-' AND substr("event_id", 20, 1) GLOB '[89ab]' AND substr("event_id", 24, 1) = '-'),
	CONSTRAINT "task_notification_outbox_lease_check" CHECK(("lease_owner" IS NULL AND "lease_expires_at" IS NULL) OR ("delivered_at" IS NULL AND "lease_owner" IS NOT NULL AND length("lease_owner") = 36 AND instr("lease_owner", char(0)) = 0 AND length(replace("lease_owner", '-', '')) = 32 AND replace("lease_owner", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("lease_owner", 9, 1) = '-' AND substr("lease_owner", 14, 1) = '-' AND substr("lease_owner", 15, 1) = '7' AND substr("lease_owner", 19, 1) = '-' AND substr("lease_owner", 20, 1) GLOB '[89ab]' AND substr("lease_owner", 24, 1) = '-' AND "lease_expires_at" IS NOT NULL AND "lease_expires_at" BETWEEN 0 AND 8640000000000000)),
	CONSTRAINT "task_notification_outbox_message_check" CHECK(length("message") BETWEEN 1 AND 2048 AND instr("message", char(0)) = 0 AND length(trim("message", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "message" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*') AND length(CAST("message" AS BLOB)) <= 2048)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `task_labels` (
	`label` text NOT NULL,
	`task_id` text NOT NULL,
	CONSTRAINT `task_labels_pk` PRIMARY KEY(`task_id`, `label`),
	CONSTRAINT `fk_task_labels_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "task_labels_label_check" CHECK(length("label") BETWEEN 1 AND 64 AND instr("label", char(0)) = 0 AND length(trim("label", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "label" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "task_labels_task_id_check" CHECK(length("task_id") = 36 AND instr("task_id", char(0)) = 0 AND length(replace("task_id", '-', '')) = 32 AND replace("task_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("task_id", 9, 1) = '-' AND substr("task_id", 14, 1) = '-' AND substr("task_id", 15, 1) = '7' AND substr("task_id", 19, 1) = '-' AND substr("task_id", 20, 1) GLOB '[89ab]' AND substr("task_id", 24, 1) = '-')
) STRICT;
--> statement-breakpoint
CREATE TABLE `task_updates` (
	`author_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`message_markdown` text NOT NULL,
	`task_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_task_updates_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "task_updates_author_check" CHECK(("author_kind" = 'user' AND length("author_id") = 36 AND instr("author_id", char(0)) = 0 AND length(replace("author_id", '-', '')) = 32 AND replace("author_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("author_id", 9, 1) = '-' AND substr("author_id", 14, 1) = '-' AND substr("author_id", 15, 1) = '7' AND substr("author_id", 19, 1) = '-' AND substr("author_id", 20, 1) GLOB '[89ab]' AND substr("author_id", 24, 1) = '-') OR ("author_kind" = 'automation' AND length("author_id") BETWEEN 1 AND 64 AND instr("author_id", char(0)) = 0 AND "author_id" = lower("author_id") AND substr("author_id", 1, 1) GLOB '[a-z0-9]' AND "author_id" NOT GLOB '*[^a-z0-9._-]*')),
	CONSTRAINT "task_updates_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "task_updates_message_markdown_check" CHECK(length("message_markdown") BETWEEN 1 AND 20000 AND instr("message_markdown", char(0)) = 0 AND length(trim("message_markdown", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0),
	CONSTRAINT "task_updates_task_id_check" CHECK(length("task_id") = 36 AND instr("task_id", char(0)) = 0 AND length(replace("task_id", '-', '')) = 32 AND replace("task_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("task_id", 9, 1) = '-' AND substr("task_id", 14, 1) = '-' AND substr("task_id", 15, 1) = '7' AND substr("task_id", 19, 1) = '-' AND substr("task_id", 20, 1) GLOB '[89ab]' AND substr("task_id", 24, 1) = '-'),
	CONSTRAINT "task_updates_time_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" >= "created_at"),
	CONSTRAINT "task_updates_version_check" CHECK("version" BETWEEN 1 AND 9007199254740991)
) STRICT;
--> statement-breakpoint
CREATE TABLE `tasks` (
	`assignee` text,
	`body_markdown` text,
	`created_at` integer NOT NULL,
	`id` text NOT NULL,
	`number` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`priority` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tasks_assignee_check" CHECK("assignee" IS NULL OR "assignee" IN ('mira-2026', 'rajohan')),
	CONSTRAINT "tasks_body_markdown_check" CHECK("body_markdown" IS NULL OR (length("body_markdown") BETWEEN 1 AND 100000 AND instr("body_markdown", char(0)) = 0 AND length(trim("body_markdown", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0)),
	CONSTRAINT "tasks_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "tasks_number_check" CHECK("number" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "tasks_priority_check" CHECK("priority" IN ('low', 'medium', 'high')),
	CONSTRAINT "tasks_status_check" CHECK("status" IN ('todo', 'in-progress', 'blocked', 'done')),
	CONSTRAINT "tasks_title_check" CHECK(length("title") BETWEEN 1 AND 240 AND instr("title", char(0)) = 0 AND length(trim("title", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "title" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "tasks_time_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" >= "created_at"),
	CONSTRAINT "tasks_version_check" CHECK("version" BETWEEN 1 AND 9007199254740991)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `task_automation_profiles_cron_job_id_unique` ON `task_automation_profiles` (`cron_job_id`);--> statement-breakpoint
CREATE INDEX `task_events_task_created_id_idx` ON `task_events` (`task_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `task_notification_outbox_eligible_idx` ON `task_notification_outbox` (`delivered_at`,`available_at`,`lease_expires_at`,`created_at`,`event_id`);--> statement-breakpoint
CREATE INDEX `task_labels_label_task_idx` ON `task_labels` (`label`,`task_id`);--> statement-breakpoint
CREATE INDEX `task_updates_task_created_id_idx` ON `task_updates` (`task_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_updated_id_idx` ON `tasks` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_status_priority_updated_id_idx` ON `tasks` (`status`,`priority`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_status_updated_id_idx` ON `tasks` (`assignee`,`status`,`updated_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_id_unique` ON `tasks` (`id`);--> statement-breakpoint
CREATE TABLE `agent_task_runs` (
	`agent_id` text NOT NULL,
	`completed_at` integer,
	`completed_by_id` text,
	`completed_by_kind` text,
	`id` text PRIMARY KEY NOT NULL,
	`last_activity_at` integer NOT NULL,
	`last_updated_by_id` text NOT NULL,
	`last_updated_by_kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`started_by_id` text NOT NULL,
	`started_by_kind` text NOT NULL,
	`task` text NOT NULL,
	CONSTRAINT "agent_task_runs_agent_id_check" CHECK(length("agent_id") BETWEEN 1 AND 64 AND instr("agent_id", char(0)) = 0 AND "agent_id" = lower("agent_id") AND substr("agent_id", 1, 1) GLOB '[a-z0-9]' AND "agent_id" NOT GLOB '*[^a-z0-9._-]*'),
	CONSTRAINT "agent_task_runs_completed_actor_check" CHECK(("completed_at" IS NULL AND "completed_by_kind" IS NULL AND "completed_by_id" IS NULL) OR ("completed_at" IS NOT NULL AND "completed_by_kind" IS NOT NULL AND "completed_by_id" IS NOT NULL AND (("completed_by_kind" = 'user' AND length("completed_by_id") = 36 AND instr("completed_by_id", char(0)) = 0 AND length(replace("completed_by_id", '-', '')) = 32 AND replace("completed_by_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("completed_by_id", 9, 1) = '-' AND substr("completed_by_id", 14, 1) = '-' AND substr("completed_by_id", 15, 1) = '7' AND substr("completed_by_id", 19, 1) = '-' AND substr("completed_by_id", 20, 1) GLOB '[89ab]' AND substr("completed_by_id", 24, 1) = '-') OR ("completed_by_kind" = 'automation' AND length("completed_by_id") BETWEEN 1 AND 64 AND instr("completed_by_id", char(0)) = 0 AND "completed_by_id" = lower("completed_by_id") AND substr("completed_by_id", 1, 1) GLOB '[a-z0-9]' AND "completed_by_id" NOT GLOB '*[^a-z0-9._-]*')))),
	CONSTRAINT "agent_task_runs_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "agent_task_runs_last_updated_actor_check" CHECK(("last_updated_by_kind" = 'user' AND length("last_updated_by_id") = 36 AND instr("last_updated_by_id", char(0)) = 0 AND length(replace("last_updated_by_id", '-', '')) = 32 AND replace("last_updated_by_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("last_updated_by_id", 9, 1) = '-' AND substr("last_updated_by_id", 14, 1) = '-' AND substr("last_updated_by_id", 15, 1) = '7' AND substr("last_updated_by_id", 19, 1) = '-' AND substr("last_updated_by_id", 20, 1) GLOB '[89ab]' AND substr("last_updated_by_id", 24, 1) = '-') OR ("last_updated_by_kind" = 'automation' AND length("last_updated_by_id") BETWEEN 1 AND 64 AND instr("last_updated_by_id", char(0)) = 0 AND "last_updated_by_id" = lower("last_updated_by_id") AND substr("last_updated_by_id", 1, 1) GLOB '[a-z0-9]' AND "last_updated_by_id" NOT GLOB '*[^a-z0-9._-]*')),
	CONSTRAINT "agent_task_runs_started_actor_check" CHECK(("started_by_kind" = 'user' AND length("started_by_id") = 36 AND instr("started_by_id", char(0)) = 0 AND length(replace("started_by_id", '-', '')) = 32 AND replace("started_by_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("started_by_id", 9, 1) = '-' AND substr("started_by_id", 14, 1) = '-' AND substr("started_by_id", 15, 1) = '7' AND substr("started_by_id", 19, 1) = '-' AND substr("started_by_id", 20, 1) GLOB '[89ab]' AND substr("started_by_id", 24, 1) = '-') OR ("started_by_kind" = 'automation' AND length("started_by_id") BETWEEN 1 AND 64 AND instr("started_by_id", char(0)) = 0 AND "started_by_id" = lower("started_by_id") AND substr("started_by_id", 1, 1) GLOB '[a-z0-9]' AND "started_by_id" NOT GLOB '*[^a-z0-9._-]*')),
	CONSTRAINT "agent_task_runs_task_check" CHECK(length("task") BETWEEN 1 AND 512 AND instr("task", char(0)) = 0 AND length(trim("task", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "task" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "agent_task_runs_time_check" CHECK("started_at" BETWEEN 0 AND 8640000000000000 AND "last_activity_at" BETWEEN 0 AND 8640000000000000 AND "last_activity_at" >= "started_at" AND ("completed_at" IS NULL OR ("completed_at" BETWEEN 0 AND 8640000000000000 AND "completed_at" >= "last_activity_at")))
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_task_runs_one_active_agent_idx` ON `agent_task_runs` (`agent_id`) WHERE "agent_task_runs"."completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `agent_task_runs_started_id_idx` ON `agent_task_runs` (`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `agent_task_runs_agent_started_id_idx` ON `agent_task_runs` (`agent_id`,`started_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER chat_run_events_reject_replace
BEFORE INSERT ON chat_run_events
WHEN EXISTS (
	SELECT 1
	FROM chat_run_events
	WHERE id = NEW.id
		OR (chat_run_id = NEW.chat_run_id AND sequence = NEW.sequence)
)
BEGIN
	SELECT RAISE(ABORT, 'chat_run_events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER chat_run_events_reject_update
BEFORE UPDATE ON chat_run_events
BEGIN
	SELECT RAISE(ABORT, 'chat_run_events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER chat_run_events_reject_delete
BEFORE DELETE ON chat_run_events
WHEN EXISTS (SELECT 1 FROM chat_runs WHERE id = OLD.chat_run_id)
BEGIN
	SELECT RAISE(ABORT, 'chat_run_events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER chat_runs_reject_replace
BEFORE INSERT ON chat_runs
WHEN EXISTS (SELECT 1 FROM chat_runs WHERE id = NEW.id)
BEGIN
	SELECT RAISE(ABORT, 'chat_runs admission identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER chat_runs_reject_identity_update
BEFORE UPDATE OF
	id,
	actor_id,
	actor_kind,
	admitted_at,
	gateway_scope,
	session_key,
	transcript_generation,
	idempotency_key,
	request_json,
	request_sha256
ON chat_runs
BEGIN
	SELECT RAISE(ABORT, 'chat_runs admission identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER chat_runs_validate_monotonic_update
BEFORE UPDATE ON chat_runs
WHEN NEW.state_version <> OLD.state_version + 1
	OR NEW.updated_at < OLD.updated_at
	OR NEW.event_count < OLD.event_count
	OR NEW.last_event_sequence < OLD.last_event_sequence
	OR NEW.event_bytes < OLD.event_bytes
BEGIN
	SELECT RAISE(ABORT, 'chat_runs version, time, and counters must advance monotonically');
END;
--> statement-breakpoint
CREATE TRIGGER chat_runs_reject_settled_identity_update
BEFORE UPDATE ON chat_runs
WHEN (OLD.provider_run_id IS NOT NULL AND NEW.provider_run_id IS NOT OLD.provider_run_id)
	OR (OLD.history_message_id IS NOT NULL AND NEW.history_message_id IS NOT OLD.history_message_id)
	OR (OLD.dispatch_attempted_at IS NOT NULL AND NEW.dispatch_attempted_at IS NOT OLD.dispatch_attempted_at)
	OR (OLD.provider_acknowledged_at IS NOT NULL AND NEW.provider_acknowledged_at IS NOT OLD.provider_acknowledged_at)
	OR (OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS NOT OLD.cancel_requested_at)
	OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS NOT OLD.terminal_at)
	OR (OLD.retention_expires_at IS NOT NULL AND NEW.retention_expires_at IS NOT OLD.retention_expires_at)
	OR (OLD.reconciled_at IS NOT NULL AND NEW.reconciled_at IS NOT OLD.reconciled_at)
BEGIN
	SELECT RAISE(ABORT, 'chat_runs settled identities and timestamps are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER chat_transcript_generations_reject_replace
BEFORE INSERT ON chat_transcript_generations
WHEN EXISTS (
	SELECT 1
	FROM chat_transcript_generations
	WHERE gateway_scope = NEW.gateway_scope AND session_key = NEW.session_key
)
BEGIN
	SELECT RAISE(ABORT, 'chat transcript pointer identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER chat_transcript_generations_reject_identity_update
BEFORE UPDATE OF gateway_scope, session_key ON chat_transcript_generations
BEGIN
	SELECT RAISE(ABORT, 'chat transcript pointer identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER chat_transcript_generations_validate_monotonic_update
BEFORE UPDATE ON chat_transcript_generations
WHEN NEW.version <> OLD.version + 1
	OR NEW.updated_at < OLD.updated_at
	OR NEW.current_generation < OLD.current_generation
	OR NEW.current_generation > OLD.current_generation + 1
BEGIN
	SELECT RAISE(ABORT, 'chat transcript pointer must advance monotonically');
END;
--> statement-breakpoint
CREATE TRIGGER chat_transcript_generations_reject_delete
BEFORE DELETE ON chat_transcript_generations
BEGIN
	SELECT RAISE(ABORT, 'chat transcript pointers are durable');
END;
--> statement-breakpoint
CREATE TRIGGER chat_external_runtime_snapshots_reject_replace
BEFORE INSERT ON chat_external_runtime_snapshots
WHEN EXISTS (
	SELECT 1
	FROM chat_external_runtime_snapshots
	WHERE gateway_scope = NEW.gateway_scope AND session_key = NEW.session_key
)
BEGIN
	SELECT RAISE(ABORT, 'chat external runtime snapshot identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER chat_external_runtime_snapshots_validate_current_insert
BEFORE INSERT ON chat_external_runtime_snapshots
WHEN NOT EXISTS (
	SELECT 1
	FROM chat_transcript_generations
	WHERE gateway_scope = NEW.gateway_scope
		AND session_key = NEW.session_key
		AND current_generation = NEW.transcript_generation
		AND status = 'ready'
)
BEGIN
	SELECT RAISE(ABORT, 'chat external runtime snapshot transcript is not current');
END;
--> statement-breakpoint
CREATE TRIGGER chat_external_runtime_snapshots_reject_identity_update
BEFORE UPDATE OF gateway_scope, session_key, schema_version, transcript_generation
ON chat_external_runtime_snapshots
BEGIN
	SELECT RAISE(ABORT, 'chat external runtime snapshot identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER chat_external_runtime_snapshots_validate_monotonic_update
BEFORE UPDATE ON chat_external_runtime_snapshots
WHEN NEW.observation_epoch < OLD.observation_epoch
	OR (
		NEW.observation_epoch = OLD.observation_epoch
		AND NEW.updated_at < OLD.updated_at
	)
	OR (
		NEW.observation_epoch = OLD.observation_epoch
		AND NEW.updated_at = OLD.updated_at
		AND (
			NEW.snapshot_bytes IS NOT OLD.snapshot_bytes
			OR NEW.snapshot_json IS NOT OLD.snapshot_json
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'chat external runtime snapshot must advance monotonically');
END;
--> statement-breakpoint
CREATE TRIGGER chat_external_runtime_snapshots_validate_capacity_insert
BEFORE INSERT ON chat_external_runtime_snapshots
WHEN (
	SELECT COALESCE(SUM(json_array_length(snapshot_json, '$.entries')), 0)
	FROM chat_external_runtime_snapshots
	WHERE gateway_scope = NEW.gateway_scope
) + COALESCE(json_array_length(NEW.snapshot_json, '$.entries'), 0) > 32
BEGIN
	SELECT RAISE(ABORT, 'chat external runtime snapshot process capacity exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER chat_external_runtime_snapshots_validate_capacity_update
BEFORE UPDATE OF snapshot_json ON chat_external_runtime_snapshots
WHEN (
	SELECT COALESCE(SUM(json_array_length(snapshot_json, '$.entries')), 0)
	FROM chat_external_runtime_snapshots
	WHERE gateway_scope = NEW.gateway_scope
		AND session_key <> NEW.session_key
) + COALESCE(json_array_length(NEW.snapshot_json, '$.entries'), 0) > 32
BEGIN
	SELECT RAISE(ABORT, 'chat external runtime snapshot process capacity exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER chat_runtime_snapshots_reject_replace
BEFORE INSERT ON chat_runtime_snapshots
WHEN EXISTS (
	SELECT 1
	FROM chat_runtime_snapshots
	WHERE chat_run_id = NEW.chat_run_id
)
BEGIN
	SELECT RAISE(ABORT, 'chat_runtime_snapshots identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER chat_runtime_snapshots_reject_identity_update
BEFORE UPDATE OF chat_run_id, schema_version ON chat_runtime_snapshots
BEGIN
	SELECT RAISE(ABORT, 'chat_runtime_snapshots identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER chat_runtime_snapshots_validate_progress_update
BEFORE UPDATE OF
	first_sequence,
	through_sequence,
	updated_at,
	snapshot_bytes,
	snapshot_json
ON chat_runtime_snapshots
WHEN NEW.first_sequence < OLD.first_sequence
	OR NEW.through_sequence <= OLD.through_sequence
	OR NEW.updated_at < OLD.updated_at
BEGIN
	SELECT RAISE(ABORT, 'chat_runtime_snapshots progress must advance monotonically');
END;
--> statement-breakpoint
CREATE TRIGGER chat_runtime_snapshots_reject_delete
BEFORE DELETE ON chat_runtime_snapshots
WHEN EXISTS (SELECT 1 FROM chat_runs WHERE id = OLD.chat_run_id)
BEGIN
	SELECT RAISE(ABORT, 'chat_runtime_snapshots are parent-owned');
END;
--> statement-breakpoint
CREATE TRIGGER agent_task_runs_reject_replace
BEFORE INSERT ON agent_task_runs
WHEN EXISTS (SELECT 1 FROM agent_task_runs WHERE id = NEW.id)
BEGIN
	SELECT RAISE(ABORT, 'agent_task_runs identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER agent_task_runs_reject_identity_update
BEFORE UPDATE OF agent_id, id, started_at, started_by_id, started_by_kind, task ON agent_task_runs
BEGIN
	SELECT RAISE(ABORT, 'agent_task_runs identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER agent_task_runs_reject_activity_regression
BEFORE UPDATE OF last_activity_at ON agent_task_runs
WHEN NEW.last_activity_at < OLD.last_activity_at
BEGIN
	SELECT RAISE(ABORT, 'agent_task_runs activity is monotonic');
END;
--> statement-breakpoint
CREATE TRIGGER agent_task_runs_reject_completed_update
BEFORE UPDATE ON agent_task_runs
WHEN OLD.completed_at IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'completed agent_task_runs are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER agent_task_runs_reject_delete
BEFORE DELETE ON agent_task_runs
BEGIN
	SELECT RAISE(ABORT, 'agent_task_runs history cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER automation_credentials_validate_replacement_insert
BEFORE INSERT ON automation_credentials
WHEN NEW.replaces_credential_id IS NOT NULL
    AND NEW.replaces_credential_id <> NEW.id
    AND NOT EXISTS (
        SELECT 1
        FROM automation_credentials AS predecessor
        WHERE predecessor.id = NEW.replaces_credential_id
          AND predecessor.principal_id = NEW.principal_id
    )
BEGIN
	SELECT RAISE(ABORT, 'automation credential replacement must share principal');
END;
--> statement-breakpoint
CREATE TRIGGER automation_credentials_validate_replacement_update
BEFORE UPDATE OF principal_id, replaces_credential_id ON automation_credentials
WHEN NEW.replaces_credential_id IS NOT NULL
    AND NEW.replaces_credential_id <> NEW.id
    AND NOT EXISTS (
        SELECT 1
        FROM automation_credentials AS predecessor
        WHERE predecessor.id = NEW.replaces_credential_id
          AND predecessor.principal_id = NEW.principal_id
    )
BEGIN
	SELECT RAISE(ABORT, 'automation credential replacement must share principal');
END;
--> statement-breakpoint
CREATE TRIGGER automation_credentials_validate_predecessor_update
BEFORE UPDATE OF principal_id ON automation_credentials
WHEN EXISTS (
    SELECT 1
    FROM automation_credentials AS replacement
    WHERE replacement.replaces_credential_id = OLD.id
      AND replacement.principal_id <> NEW.principal_id
)
BEGIN
	SELECT RAISE(ABORT, 'automation credential predecessor must share principal');
END;
--> statement-breakpoint
CREATE TABLE `job_disable_intents` (
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`created_by_kind` text NOT NULL,
	`ended_at` integer,
	`ended_by_id` text,
	`ended_by_kind` text,
	`ended_reason` text,
	`expires_at` integer,
	`external_job_id` text,
	`external_provider` text,
	`id` text PRIMARY KEY,
	`reason` text NOT NULL,
	`scheduled_job_id` text,
	`target_kind` text NOT NULL,
	CONSTRAINT `fk_job_disable_intents_scheduled_job_id_scheduled_jobs_id_fk` FOREIGN KEY (`scheduled_job_id`) REFERENCES `scheduled_jobs`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "job_disable_intents_created_at_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000),
	CONSTRAINT "job_disable_intents_created_actor_check" CHECK((("created_by_kind" = 'user' AND length("created_by_id") = 36 AND instr("created_by_id", char(0)) = 0 AND length(replace("created_by_id", '-', '')) = 32 AND replace("created_by_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("created_by_id", 9, 1) = '-' AND substr("created_by_id", 14, 1) = '-' AND substr("created_by_id", 15, 1) = '7' AND substr("created_by_id", 19, 1) = '-' AND substr("created_by_id", 20, 1) GLOB '[89ab]' AND substr("created_by_id", 24, 1) = '-') OR ("created_by_kind" = 'automation' AND length("created_by_id") BETWEEN 1 AND 64 AND instr("created_by_id", char(0)) = 0 AND "created_by_id" = lower("created_by_id") AND substr("created_by_id", 1, 1) GLOB '[a-z0-9]' AND "created_by_id" NOT GLOB '*[^a-z0-9._-]*'))),
	CONSTRAINT "job_disable_intents_end_check" CHECK(("ended_at" IS NULL AND "ended_by_kind" IS NULL AND "ended_by_id" IS NULL AND "ended_reason" IS NULL) OR ("ended_at" IS NOT NULL AND "ended_at" BETWEEN 0 AND 8640000000000000 AND "ended_at" >= "created_at" AND "ended_by_kind" IS NOT NULL AND "ended_by_id" IS NOT NULL AND "ended_reason" IN ('expired', 're-enabled', 'replaced', 'target-deleted') AND (("ended_by_kind" = 'user' AND length("ended_by_id") = 36 AND instr("ended_by_id", char(0)) = 0 AND length(replace("ended_by_id", '-', '')) = 32 AND replace("ended_by_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("ended_by_id", 9, 1) = '-' AND substr("ended_by_id", 14, 1) = '-' AND substr("ended_by_id", 15, 1) = '7' AND substr("ended_by_id", 19, 1) = '-' AND substr("ended_by_id", 20, 1) GLOB '[89ab]' AND substr("ended_by_id", 24, 1) = '-') OR ("ended_by_kind" = 'automation' AND length("ended_by_id") BETWEEN 1 AND 64 AND instr("ended_by_id", char(0)) = 0 AND "ended_by_id" = lower("ended_by_id") AND substr("ended_by_id", 1, 1) GLOB '[a-z0-9]' AND "ended_by_id" NOT GLOB '*[^a-z0-9._-]*') OR ("ended_by_kind" = 'system' AND length("ended_by_id") BETWEEN 1 AND 128 AND instr("ended_by_id", char(0)) = 0 AND "ended_by_id" = lower("ended_by_id") AND substr("ended_by_id", 1, 1) GLOB '[a-z0-9]' AND "ended_by_id" NOT GLOB '*[^a-z0-9._-]*')) AND ("ended_reason" <> 'expired' OR ("ended_by_kind" = 'system' AND "expires_at" IS NOT NULL AND "ended_at" >= "expires_at")))),
	CONSTRAINT "job_disable_intents_expiry_check" CHECK("expires_at" IS NULL OR ("expires_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" > "created_at")),
	CONSTRAINT "job_disable_intents_external_job_id_check" CHECK("external_job_id" IS NULL OR (length("external_job_id") BETWEEN 1 AND 256 AND instr("external_job_id", char(0)) = 0 AND length(trim("external_job_id", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0)),
	CONSTRAINT "job_disable_intents_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "job_disable_intents_reason_check" CHECK(length("reason") BETWEEN 1 AND 1000 AND instr("reason", char(0)) = 0 AND length(trim("reason", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "reason" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*') AND length(CAST("reason" AS BLOB)) <= 4000),
	CONSTRAINT "job_disable_intents_target_check" CHECK(("target_kind" = 'dashboard-schedule' AND "scheduled_job_id" IS NOT NULL AND "external_provider" IS NULL AND "external_job_id" IS NULL) OR ("target_kind" = 'openclaw-cron' AND "scheduled_job_id" IS NULL AND "external_provider" = 'openclaw' AND "external_job_id" IS NOT NULL))
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `job_run_events` (
	`attempt` integer NOT NULL,
	`job_run_id` text NOT NULL,
	`kind` text NOT NULL,
	`message` text,
	`occurred_at` integer NOT NULL,
	`progress_json` text,
	`sequence` integer NOT NULL,
	`worker_instance_id` text,
	CONSTRAINT `job_run_events_pk` PRIMARY KEY(`job_run_id`, `sequence`),
	CONSTRAINT `fk_job_run_events_job_run_id_job_runs_id_fk` FOREIGN KEY (`job_run_id`) REFERENCES `job_runs`(`id`) ON UPDATE RESTRICT ON DELETE CASCADE,
	CONSTRAINT `fk_job_run_events_worker_instance_id_worker_instances_id_fk` FOREIGN KEY (`worker_instance_id`) REFERENCES `worker_instances`(`id`) ON UPDATE RESTRICT ON DELETE SET NULL,
	CONSTRAINT "job_run_events_attempt_check" CHECK("attempt" BETWEEN 0 AND 10),
	CONSTRAINT "job_run_events_kind_check" CHECK("kind" IN ('cancel-requested', 'cancelled', 'claimed', 'failed', 'lease-expired', 'output-truncated', 'progress', 'queued', 'retry-scheduled', 'stderr', 'stdout', 'succeeded', 'timed-out')),
	CONSTRAINT "job_run_events_message_check" CHECK(("message" IS NULL OR (length("message") BETWEEN 1 AND 4096 AND instr("message", char(0)) = 0 AND length(trim("message", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "message" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*') AND length(CAST("message" AS BLOB)) <= 4096))),
	CONSTRAINT "job_run_events_occurred_at_check" CHECK("occurred_at" BETWEEN 0 AND 8640000000000000),
	CONSTRAINT "job_run_events_payload_shape_check" CHECK(("kind" = 'progress' AND "progress_json" IS NOT NULL AND length(CAST("progress_json" AS BLOB)) <= 16384 AND CASE WHEN json_valid("progress_json") THEN json_type("progress_json") = 'object' ELSE 0 END) OR ("kind" IN ('stderr', 'stdout') AND "message" IS NOT NULL AND "progress_json" IS NULL) OR ("kind" NOT IN ('progress', 'stderr', 'stdout') AND "progress_json" IS NULL)),
	CONSTRAINT "job_run_events_sequence_check" CHECK("sequence" BETWEEN 1 AND 1000)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`action_key` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`attempt_limit` integer NOT NULL,
	`available_at` integer NOT NULL,
	`cancellation_policy` text NOT NULL,
	`cancel_requested_at` integer,
	`cancel_requested_by_id` text,
	`cancel_requested_by_kind` text,
	`display_name` text NOT NULL,
	`enqueue_sha256` text NOT NULL,
	`event_bytes` integer DEFAULT 0 NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`finished_at` integer,
	`first_started_at` integer,
	`heartbeat_at` integer,
	`id` text PRIMARY KEY,
	`idempotency_key` text NOT NULL,
	`last_attempt_started_at` integer,
	`lease_expires_at` integer,
	`lease_owner_id` text,
	`lease_token` text,
	`payload_event_count` integer DEFAULT 0 NOT NULL,
	`payload_json` text NOT NULL,
	`priority` integer NOT NULL,
	`queued_at` integer NOT NULL,
	`requested_by_id` text NOT NULL,
	`requested_by_kind` text NOT NULL,
	`required_worker_release_id` text,
	`resource_class` text NOT NULL,
	`resource_keys_json` text NOT NULL,
	`result_json` text,
	`retry_safe` integer NOT NULL,
	`scheduled_for_at` integer,
	`scheduled_job_id` text,
	`scheduled_job_version` integer,
	`state` text NOT NULL,
	`state_version` integer DEFAULT 1 NOT NULL,
	`terminal_code` text,
	`terminal_message` text,
	`timeout_ms` integer NOT NULL,
	`trigger_type` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_job_runs_lease_owner_id_worker_instances_id_fk` FOREIGN KEY (`lease_owner_id`) REFERENCES `worker_instances`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_job_runs_scheduled_job_id_scheduled_jobs_id_fk` FOREIGN KEY (`scheduled_job_id`) REFERENCES `scheduled_jobs`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "job_runs_action_key_check" CHECK(length("action_key") BETWEEN 1 AND 128 AND instr("action_key", char(0)) = 0 AND "action_key" = lower("action_key") AND substr("action_key", 1, 1) GLOB '[a-z0-9]' AND "action_key" NOT GLOB '*[^a-z0-9._-]*'),
	CONSTRAINT "job_runs_attempt_check" CHECK("attempt_limit" BETWEEN 1 AND 10 AND "attempt_count" BETWEEN 0 AND "attempt_limit" AND (("attempt_count" = 0 AND "first_started_at" IS NULL AND "last_attempt_started_at" IS NULL) OR ("attempt_count" > 0 AND "first_started_at" IS NOT NULL AND "last_attempt_started_at" IS NOT NULL))),
	CONSTRAINT "job_runs_available_at_check" CHECK("available_at" BETWEEN 0 AND 8640000000000000 AND "available_at" >= "queued_at"),
	CONSTRAINT "job_runs_cancellation_policy_check" CHECK("cancellation_policy" IN ('cooperative', 'never', 'queued-only')),
	CONSTRAINT "job_runs_cancel_request_check" CHECK(("state" <> 'cancelled' AND "cancel_requested_at" IS NULL AND "cancel_requested_by_kind" IS NULL AND "cancel_requested_by_id" IS NULL) OR ("cancellation_policy" <> 'never' AND "cancel_requested_at" IS NOT NULL AND "cancel_requested_at" BETWEEN 0 AND 8640000000000000 AND "cancel_requested_at" >= "queued_at" AND "cancel_requested_at" <= "updated_at" AND "cancel_requested_by_kind" IS NOT NULL AND "cancel_requested_by_id" IS NOT NULL AND (("cancel_requested_by_kind" = 'user' AND length("cancel_requested_by_id") = 36 AND instr("cancel_requested_by_id", char(0)) = 0 AND length(replace("cancel_requested_by_id", '-', '')) = 32 AND replace("cancel_requested_by_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("cancel_requested_by_id", 9, 1) = '-' AND substr("cancel_requested_by_id", 14, 1) = '-' AND substr("cancel_requested_by_id", 15, 1) = '7' AND substr("cancel_requested_by_id", 19, 1) = '-' AND substr("cancel_requested_by_id", 20, 1) GLOB '[89ab]' AND substr("cancel_requested_by_id", 24, 1) = '-') OR ("cancel_requested_by_kind" = 'automation' AND length("cancel_requested_by_id") BETWEEN 1 AND 64 AND instr("cancel_requested_by_id", char(0)) = 0 AND "cancel_requested_by_id" = lower("cancel_requested_by_id") AND substr("cancel_requested_by_id", 1, 1) GLOB '[a-z0-9]' AND "cancel_requested_by_id" NOT GLOB '*[^a-z0-9._-]*') OR ("cancel_requested_by_kind" = 'system' AND length("cancel_requested_by_id") BETWEEN 1 AND 128 AND instr("cancel_requested_by_id", char(0)) = 0 AND "cancel_requested_by_id" = lower("cancel_requested_by_id") AND substr("cancel_requested_by_id", 1, 1) GLOB '[a-z0-9]' AND "cancel_requested_by_id" NOT GLOB '*[^a-z0-9._-]*')))),
	CONSTRAINT "job_runs_display_name_check" CHECK(length("display_name") BETWEEN 1 AND 160 AND instr("display_name", char(0)) = 0 AND length(trim("display_name", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "display_name" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*') AND length(CAST("display_name" AS BLOB)) <= 640),
	CONSTRAINT "job_runs_enqueue_sha256_check" CHECK(length("enqueue_sha256") = 64 AND instr("enqueue_sha256", char(0)) = 0 AND "enqueue_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "job_runs_event_budget_check" CHECK("event_count" BETWEEN 0 AND 1000 AND "payload_event_count" BETWEEN 0 AND 967 AND "payload_event_count" <= "event_count" AND "event_bytes" BETWEEN 0 AND 1048576),
	CONSTRAINT "job_runs_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "job_runs_idempotency_key_check" CHECK(length("idempotency_key") BETWEEN 32 AND 128 AND instr("idempotency_key", char(0)) = 0 AND "idempotency_key" NOT GLOB '*[^A-Za-z0-9_-]*' AND (length("idempotency_key") % 4 = 0 OR (length("idempotency_key") % 4 = 2 AND substr("idempotency_key", -1, 1) GLOB '[AQgw]') OR (length("idempotency_key") % 4 = 3 AND substr("idempotency_key", -1, 1) GLOB '[AEIMQUYcgkosw048]'))),
	CONSTRAINT "job_runs_lease_check" CHECK(("state" <> 'running' AND "lease_owner_id" IS NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL AND "heartbeat_at" IS NULL) OR ("state" = 'running' AND "lease_owner_id" IS NOT NULL AND "lease_token" IS NOT NULL AND length("lease_token") = 36 AND instr("lease_token", char(0)) = 0 AND length(replace("lease_token", '-', '')) = 32 AND replace("lease_token", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("lease_token", 9, 1) = '-' AND substr("lease_token", 14, 1) = '-' AND substr("lease_token", 15, 1) = '7' AND substr("lease_token", 19, 1) = '-' AND substr("lease_token", 20, 1) GLOB '[89ab]' AND substr("lease_token", 24, 1) = '-' AND "lease_expires_at" IS NOT NULL AND "heartbeat_at" IS NOT NULL AND "heartbeat_at" BETWEEN 0 AND 8640000000000000 AND "lease_expires_at" BETWEEN 0 AND 8640000000000000 AND "heartbeat_at" >= "last_attempt_started_at" AND "lease_expires_at" > "heartbeat_at")),
	CONSTRAINT "job_runs_payload_json_check" CHECK(length(CAST("payload_json" AS BLOB)) <= 65536 AND CASE WHEN json_valid("payload_json") THEN json_type("payload_json") = 'object' ELSE 0 END),
	CONSTRAINT "job_runs_priority_check" CHECK("priority" BETWEEN -100 AND 100),
	CONSTRAINT "job_runs_requested_actor_check" CHECK((("requested_by_kind" = 'user' AND length("requested_by_id") = 36 AND instr("requested_by_id", char(0)) = 0 AND length(replace("requested_by_id", '-', '')) = 32 AND replace("requested_by_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("requested_by_id", 9, 1) = '-' AND substr("requested_by_id", 14, 1) = '-' AND substr("requested_by_id", 15, 1) = '7' AND substr("requested_by_id", 19, 1) = '-' AND substr("requested_by_id", 20, 1) GLOB '[89ab]' AND substr("requested_by_id", 24, 1) = '-') OR ("requested_by_kind" = 'automation' AND length("requested_by_id") BETWEEN 1 AND 64 AND instr("requested_by_id", char(0)) = 0 AND "requested_by_id" = lower("requested_by_id") AND substr("requested_by_id", 1, 1) GLOB '[a-z0-9]' AND "requested_by_id" NOT GLOB '*[^a-z0-9._-]*') OR ("requested_by_kind" = 'system' AND length("requested_by_id") BETWEEN 1 AND 128 AND instr("requested_by_id", char(0)) = 0 AND "requested_by_id" = lower("requested_by_id") AND substr("requested_by_id", 1, 1) GLOB '[a-z0-9]' AND "requested_by_id" NOT GLOB '*[^a-z0-9._-]*'))),
	CONSTRAINT "job_runs_required_worker_release_id_check" CHECK("required_worker_release_id" IS NULL OR length("required_worker_release_id") = 40 AND instr("required_worker_release_id", char(0)) = 0 AND "required_worker_release_id" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "job_runs_resource_class_check" CHECK("resource_class" IN ('exclusive', 'host-heavy', 'interactive', 'light', 'network')),
	CONSTRAINT "job_runs_resource_keys_json_check" CHECK(length(CAST("resource_keys_json" AS BLOB)) <= 4096 AND CASE WHEN json_valid("resource_keys_json") THEN json_type("resource_keys_json") = 'array' ELSE 0 END),
	CONSTRAINT "job_runs_result_json_check" CHECK("result_json" IS NULL OR (length(CAST("result_json" AS BLOB)) <= 65536 AND CASE WHEN json_valid("result_json") THEN json_type("result_json") = 'object' ELSE 0 END)),
	CONSTRAINT "job_runs_retry_safe_check" CHECK("retry_safe" IN (0, 1)),
	CONSTRAINT "job_runs_schedule_check" CHECK(("trigger_type" = 'schedule' AND "scheduled_job_id" IS NOT NULL AND "scheduled_job_version" BETWEEN 1 AND 9007199254740991 AND "scheduled_for_at" IS NOT NULL AND "scheduled_for_at" BETWEEN 0 AND 8640000000000000 AND "scheduled_for_at" <= "queued_at") OR ("trigger_type" = 'manual' AND ((("scheduled_job_id" IS NOT NULL AND "scheduled_job_version" BETWEEN 1 AND 9007199254740991) OR ("scheduled_job_id" IS NULL AND "scheduled_job_version" IS NULL)) AND "scheduled_for_at" IS NULL)) OR ("trigger_type" IN ('startup', 'system') AND "scheduled_job_id" IS NULL AND "scheduled_job_version" IS NULL AND "scheduled_for_at" IS NULL)),
	CONSTRAINT "job_runs_state_check" CHECK("state" IN ('cancelled', 'failed', 'queued', 'running', 'succeeded', 'timed-out') AND (("state" = 'queued' AND "finished_at" IS NULL AND "result_json" IS NULL AND "terminal_code" IS NULL AND "terminal_message" IS NULL) OR ("state" = 'running' AND "attempt_count" > 0 AND "finished_at" IS NULL AND "result_json" IS NULL AND "terminal_code" IS NULL AND "terminal_message" IS NULL) OR ("state" = 'succeeded' AND "attempt_count" > 0 AND "finished_at" IS NOT NULL AND "result_json" IS NOT NULL AND "terminal_code" IS NULL AND "terminal_message" IS NULL) OR ("state" IN ('failed', 'timed-out') AND ("attempt_count" > 0 OR ("state" = 'failed' AND "attempt_count" = 0 AND "cancellation_policy" = 'never' AND "trigger_type" = 'schedule' AND "terminal_code" = 'action-unavailable' AND "terminal_message" = 'The scheduled action is no longer available')) AND "finished_at" IS NOT NULL AND "result_json" IS NULL AND "terminal_code" IS NOT NULL AND "terminal_message" IS NOT NULL) OR ("state" = 'cancelled' AND "finished_at" IS NOT NULL AND "result_json" IS NULL AND "terminal_code" IS NOT NULL AND "terminal_message" IS NOT NULL))),
	CONSTRAINT "job_runs_state_version_check" CHECK("state_version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "job_runs_terminal_code_check" CHECK(("terminal_code" IS NULL OR (length("terminal_code") BETWEEN 1 AND 128 AND instr("terminal_code", char(0)) = 0 AND "terminal_code" = lower("terminal_code") AND substr("terminal_code", 1, 1) GLOB '[a-z0-9]' AND "terminal_code" NOT GLOB '*[^a-z0-9._/-]*'))),
	CONSTRAINT "job_runs_terminal_message_check" CHECK(("terminal_message" IS NULL OR (length("terminal_message") BETWEEN 1 AND 2000 AND instr("terminal_message", char(0)) = 0 AND length(trim("terminal_message", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "terminal_message" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*') AND length(CAST("terminal_message" AS BLOB)) <= 8000))),
	CONSTRAINT "job_runs_timeout_check" CHECK("timeout_ms" BETWEEN 1000 AND 86400000),
	CONSTRAINT "job_runs_time_check" CHECK("queued_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" >= "queued_at" AND ("first_started_at" IS NULL OR ("first_started_at" BETWEEN 0 AND 8640000000000000 AND "first_started_at" BETWEEN "queued_at" AND "updated_at")) AND ("last_attempt_started_at" IS NULL OR ("first_started_at" IS NOT NULL AND "last_attempt_started_at" BETWEEN 0 AND 8640000000000000 AND "last_attempt_started_at" BETWEEN "first_started_at" AND "updated_at")) AND ("heartbeat_at" IS NULL OR ("last_attempt_started_at" IS NOT NULL AND "heartbeat_at" BETWEEN 0 AND 8640000000000000 AND "heartbeat_at" BETWEEN "last_attempt_started_at" AND "updated_at")) AND ("cancel_requested_at" IS NULL OR ("cancel_requested_at" BETWEEN 0 AND 8640000000000000 AND "cancel_requested_at" BETWEEN "queued_at" AND "updated_at")) AND ("finished_at" IS NULL OR ("finished_at" BETWEEN 0 AND 8640000000000000 AND "finished_at" BETWEEN COALESCE("last_attempt_started_at", "queued_at") AND "updated_at")))
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `job_worker_control` (
	`claiming_paused` integer NOT NULL,
	`id` integer PRIMARY KEY,
	`updated_at` integer NOT NULL,
	`updated_by_id` text,
	`updated_by_kind` text,
	`version` integer NOT NULL,
	CONSTRAINT "job_worker_control_actor_check" CHECK(("updated_by_kind" IS NULL AND "updated_by_id" IS NULL) OR ("updated_by_kind" IS NOT NULL AND "updated_by_id" IS NOT NULL AND (("updated_by_kind" = 'user' AND length("updated_by_id") = 36 AND instr("updated_by_id", char(0)) = 0 AND length(replace("updated_by_id", '-', '')) = 32 AND replace("updated_by_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("updated_by_id", 9, 1) = '-' AND substr("updated_by_id", 14, 1) = '-' AND substr("updated_by_id", 15, 1) = '7' AND substr("updated_by_id", 19, 1) = '-' AND substr("updated_by_id", 20, 1) GLOB '[89ab]' AND substr("updated_by_id", 24, 1) = '-') OR ("updated_by_kind" = 'automation' AND length("updated_by_id") BETWEEN 1 AND 64 AND instr("updated_by_id", char(0)) = 0 AND "updated_by_id" = lower("updated_by_id") AND substr("updated_by_id", 1, 1) GLOB '[a-z0-9]' AND "updated_by_id" NOT GLOB '*[^a-z0-9._-]*')))),
	CONSTRAINT "job_worker_control_claiming_paused_check" CHECK("claiming_paused" IN (0, 1)),
	CONSTRAINT "job_worker_control_id_check" CHECK("id" = 1),
	CONSTRAINT "job_worker_control_updated_at_check" CHECK("updated_at" BETWEEN 0 AND 8640000000000000),
	CONSTRAINT "job_worker_control_version_check" CHECK("version" BETWEEN 1 AND 9007199254740991)
) STRICT;
--> statement-breakpoint
INSERT INTO job_worker_control (
	id, claiming_paused, updated_at, updated_by_kind, updated_by_id, version
) VALUES (1, 0, 0, NULL, NULL, 1);
--> statement-breakpoint
CREATE TABLE `resource_leases` (
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`job_run_id` text NOT NULL,
	`lease_token` text NOT NULL,
	`renewed_at` integer NOT NULL,
	`resource_key` text PRIMARY KEY,
	`worker_instance_id` text NOT NULL,
	CONSTRAINT `fk_resource_leases_job_run_id_job_runs_id_fk` FOREIGN KEY (`job_run_id`) REFERENCES `job_runs`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_resource_leases_worker_instance_id_worker_instances_id_fk` FOREIGN KEY (`worker_instance_id`) REFERENCES `worker_instances`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "resource_leases_lease_token_check" CHECK(length("lease_token") = 36 AND instr("lease_token", char(0)) = 0 AND length(replace("lease_token", '-', '')) = 32 AND replace("lease_token", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("lease_token", 9, 1) = '-' AND substr("lease_token", 14, 1) = '-' AND substr("lease_token", 15, 1) = '7' AND substr("lease_token", 19, 1) = '-' AND substr("lease_token", 20, 1) GLOB '[89ab]' AND substr("lease_token", 24, 1) = '-'),
	CONSTRAINT "resource_leases_resource_key_check" CHECK(length("resource_key") BETWEEN 1 AND 128 AND instr("resource_key", char(0)) = 0 AND "resource_key" = lower("resource_key") AND substr("resource_key", 1, 1) GLOB '[a-z0-9]' AND "resource_key" NOT GLOB '*[^a-z0-9._-]*'),
	CONSTRAINT "resource_leases_time_check" CHECK("acquired_at" BETWEEN 0 AND 8640000000000000 AND "renewed_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" BETWEEN 0 AND 8640000000000000 AND "renewed_at" >= "acquired_at" AND "expires_at" > "renewed_at")
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`action_key` text NOT NULL,
	`action_payload_json` text NOT NULL,
	`attempt_limit` integer NOT NULL,
	`cancellation_policy` text NOT NULL,
	`created_at` integer NOT NULL,
	`cron_expression` text,
	`description` text NOT NULL,
	`enabled` integer NOT NULL,
	`id` text PRIMARY KEY,
	`interval_ms` integer,
	`name` text NOT NULL,
	`next_run_at` integer,
	`priority` integer NOT NULL,
	`resource_class` text NOT NULL,
	`resource_keys_json` text NOT NULL,
	`retry_safe` integer NOT NULL,
	`schedule_kind` text NOT NULL,
	`time_of_day` text,
	`time_zone` text,
	`timeout_ms` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer NOT NULL,
	CONSTRAINT "scheduled_jobs_action_key_check" CHECK(length("action_key") BETWEEN 1 AND 128 AND instr("action_key", char(0)) = 0 AND "action_key" = lower("action_key") AND substr("action_key", 1, 1) GLOB '[a-z0-9]' AND "action_key" NOT GLOB '*[^a-z0-9._-]*'),
	CONSTRAINT "scheduled_jobs_action_payload_json_check" CHECK(length(CAST("action_payload_json" AS BLOB)) <= 65536 AND CASE WHEN json_valid("action_payload_json") THEN json_type("action_payload_json") = 'object' ELSE 0 END),
	CONSTRAINT "scheduled_jobs_attempt_limit_check" CHECK("attempt_limit" BETWEEN 1 AND 10),
	CONSTRAINT "scheduled_jobs_cancellation_policy_check" CHECK("cancellation_policy" IN ('cooperative', 'never', 'queued-only')),
	CONSTRAINT "scheduled_jobs_created_at_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000),
	CONSTRAINT "scheduled_jobs_description_check" CHECK(length("description") BETWEEN 1 AND 1000 AND instr("description", char(0)) = 0 AND length(trim("description", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "description" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*') AND length(CAST("description" AS BLOB)) <= 4000),
	CONSTRAINT "scheduled_jobs_enabled_check" CHECK("enabled" IN (0, 1)),
	CONSTRAINT "scheduled_jobs_id_check" CHECK(length("id") BETWEEN 1 AND 80 AND instr("id", char(0)) = 0 AND "id" = lower("id") AND substr("id", 1, 1) GLOB '[a-z0-9]' AND "id" NOT GLOB '*[^a-z0-9._-]*'),
	CONSTRAINT "scheduled_jobs_name_check" CHECK(length("name") BETWEEN 1 AND 160 AND instr("name", char(0)) = 0 AND length(trim("name", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "name" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*') AND length(CAST("name" AS BLOB)) <= 640),
	CONSTRAINT "scheduled_jobs_next_run_check" CHECK(("next_run_at" IS NULL OR "next_run_at" BETWEEN 0 AND 8640000000000000) AND ("enabled" = 0 OR "next_run_at" IS NOT NULL)),
	CONSTRAINT "scheduled_jobs_priority_check" CHECK("priority" BETWEEN -100 AND 100),
	CONSTRAINT "scheduled_jobs_resource_class_check" CHECK("resource_class" IN ('exclusive', 'host-heavy', 'interactive', 'light', 'network')),
	CONSTRAINT "scheduled_jobs_resource_keys_json_check" CHECK(length(CAST("resource_keys_json" AS BLOB)) <= 4096 AND CASE WHEN json_valid("resource_keys_json") THEN json_type("resource_keys_json") = 'array' ELSE 0 END),
	CONSTRAINT "scheduled_jobs_retry_safe_check" CHECK("retry_safe" IN (0, 1)),
	CONSTRAINT "scheduled_jobs_schedule_shape_check" CHECK(("schedule_kind" = 'interval' AND "interval_ms" BETWEEN 60000 AND 31536000000 AND "time_of_day" IS NULL AND "cron_expression" IS NULL AND "time_zone" IS NULL) OR ("schedule_kind" = 'daily' AND "interval_ms" IS NULL AND "time_of_day" IS NOT NULL AND instr("time_of_day", char(0)) = 0 AND "time_of_day" GLOB '[0-2][0-9]:[0-5][0-9]' AND CAST(substr("time_of_day", 1, 2) AS INTEGER) BETWEEN 0 AND 23 AND "cron_expression" IS NULL AND "time_zone" IS NOT NULL) OR ("schedule_kind" = 'cron' AND "interval_ms" IS NULL AND "time_of_day" IS NULL AND "cron_expression" IS NOT NULL AND length("cron_expression") BETWEEN 9 AND 200 AND instr("cron_expression", char(0)) = 0 AND "cron_expression" = trim("cron_expression") AND "cron_expression" NOT LIKE '%  %' AND "cron_expression" NOT GLOB '*[^-0-9*,/ ]*' AND length("cron_expression") - length(replace("cron_expression", ' ', '')) = 4 AND "time_zone" IS NOT NULL)),
	CONSTRAINT "scheduled_jobs_time_zone_check" CHECK("time_zone" IS NULL OR "time_zone" IN ('Africa/Abidjan', 'Africa/Accra', 'Africa/Addis_Ababa', 'Africa/Algiers', 'Africa/Asmara', 'Africa/Bamako', 'Africa/Bangui', 'Africa/Banjul', 'Africa/Bissau', 'Africa/Blantyre', 'Africa/Brazzaville', 'Africa/Bujumbura', 'Africa/Cairo', 'Africa/Casablanca', 'Africa/Ceuta', 'Africa/Conakry', 'Africa/Dakar', 'Africa/Dar_es_Salaam', 'Africa/Djibouti', 'Africa/Douala', 'Africa/El_Aaiun', 'Africa/Freetown', 'Africa/Gaborone', 'Africa/Harare', 'Africa/Johannesburg', 'Africa/Juba', 'Africa/Kampala', 'Africa/Khartoum', 'Africa/Kigali', 'Africa/Kinshasa', 'Africa/Lagos', 'Africa/Libreville', 'Africa/Lome', 'Africa/Luanda', 'Africa/Lubumbashi', 'Africa/Lusaka', 'Africa/Malabo', 'Africa/Maputo', 'Africa/Maseru', 'Africa/Mbabane', 'Africa/Mogadishu', 'Africa/Monrovia', 'Africa/Nairobi', 'Africa/Ndjamena', 'Africa/Niamey', 'Africa/Nouakchott', 'Africa/Ouagadougou', 'Africa/Porto-Novo', 'Africa/Sao_Tome', 'Africa/Tripoli', 'Africa/Tunis', 'Africa/Windhoek', 'America/Adak', 'America/Anchorage', 'America/Anguilla', 'America/Antigua', 'America/Araguaina', 'America/Argentina/Buenos_Aires', 'America/Argentina/Catamarca', 'America/Argentina/Cordoba', 'America/Argentina/Jujuy', 'America/Argentina/La_Rioja', 'America/Argentina/Mendoza', 'America/Argentina/Rio_Gallegos', 'America/Argentina/Salta', 'America/Argentina/San_Juan', 'America/Argentina/San_Luis', 'America/Argentina/Tucuman', 'America/Argentina/Ushuaia', 'America/Aruba', 'America/Asuncion', 'America/Atikokan', 'America/Bahia', 'America/Bahia_Banderas', 'America/Barbados', 'America/Belem', 'America/Belize', 'America/Blanc-Sablon', 'America/Boa_Vista', 'America/Bogota', 'America/Boise', 'America/Cambridge_Bay', 'America/Campo_Grande', 'America/Cancun', 'America/Caracas', 'America/Cayenne', 'America/Cayman', 'America/Chicago', 'America/Chihuahua', 'America/Ciudad_Juarez', 'America/Costa_Rica', 'America/Creston', 'America/Cuiaba', 'America/Curacao', 'America/Danmarkshavn', 'America/Dawson', 'America/Dawson_Creek', 'America/Denver', 'America/Detroit', 'America/Dominica', 'America/Edmonton', 'America/Eirunepe', 'America/El_Salvador', 'America/Fort_Nelson', 'America/Fortaleza', 'America/Glace_Bay', 'America/Goose_Bay', 'America/Grand_Turk', 'America/Grenada', 'America/Guadeloupe', 'America/Guatemala', 'America/Guayaquil', 'America/Guyana', 'America/Halifax', 'America/Havana', 'America/Hermosillo', 'America/Indiana/Indianapolis', 'America/Indiana/Knox', 'America/Indiana/Marengo', 'America/Indiana/Petersburg', 'America/Indiana/Tell_City', 'America/Indiana/Vevay', 'America/Indiana/Vincennes', 'America/Indiana/Winamac', 'America/Inuvik', 'America/Iqaluit', 'America/Jamaica', 'America/Juneau', 'America/Kentucky/Louisville', 'America/Kentucky/Monticello', 'America/Kralendijk', 'America/La_Paz', 'America/Lima', 'America/Los_Angeles', 'America/Lower_Princes', 'America/Maceio', 'America/Managua', 'America/Manaus', 'America/Marigot', 'America/Martinique', 'America/Matamoros', 'America/Mazatlan', 'America/Menominee', 'America/Merida', 'America/Metlakatla', 'America/Mexico_City', 'America/Miquelon', 'America/Moncton', 'America/Monterrey', 'America/Montevideo', 'America/Montserrat', 'America/Nassau', 'America/New_York', 'America/Nome', 'America/Noronha', 'America/North_Dakota/Beulah', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem', 'America/Nuuk', 'America/Ojinaga', 'America/Panama', 'America/Paramaribo', 'America/Phoenix', 'America/Port-au-Prince', 'America/Port_of_Spain', 'America/Porto_Velho', 'America/Puerto_Rico', 'America/Punta_Arenas', 'America/Rankin_Inlet', 'America/Recife', 'America/Regina', 'America/Resolute', 'America/Rio_Branco', 'America/Santarem', 'America/Santiago', 'America/Santo_Domingo', 'America/Sao_Paulo', 'America/Scoresbysund', 'America/Sitka', 'America/St_Barthelemy', 'America/St_Johns', 'America/St_Kitts', 'America/St_Lucia', 'America/St_Thomas', 'America/St_Vincent', 'America/Swift_Current', 'America/Tegucigalpa', 'America/Thule', 'America/Tijuana', 'America/Toronto', 'America/Tortola', 'America/Vancouver', 'America/Whitehorse', 'America/Winnipeg', 'America/Yakutat', 'Antarctica/Casey', 'Antarctica/Davis', 'Antarctica/DumontDUrville', 'Antarctica/Macquarie', 'Antarctica/Mawson', 'Antarctica/McMurdo', 'Antarctica/Palmer', 'Antarctica/Rothera', 'Antarctica/Syowa', 'Antarctica/Troll', 'Antarctica/Vostok', 'Arctic/Longyearbyen', 'Asia/Aden', 'Asia/Almaty', 'Asia/Amman', 'Asia/Anadyr', 'Asia/Aqtau', 'Asia/Aqtobe', 'Asia/Ashgabat', 'Asia/Atyrau', 'Asia/Baghdad', 'Asia/Bahrain', 'Asia/Baku', 'Asia/Bangkok', 'Asia/Barnaul', 'Asia/Beirut', 'Asia/Bishkek', 'Asia/Brunei', 'Asia/Chita', 'Asia/Choibalsan', 'Asia/Colombo', 'Asia/Damascus', 'Asia/Dhaka', 'Asia/Dili', 'Asia/Dubai', 'Asia/Dushanbe', 'Asia/Famagusta', 'Asia/Gaza', 'Asia/Hebron', 'Asia/Ho_Chi_Minh', 'Asia/Hong_Kong', 'Asia/Hovd', 'Asia/Irkutsk', 'Asia/Jakarta', 'Asia/Jayapura', 'Asia/Jerusalem', 'Asia/Kabul', 'Asia/Kamchatka', 'Asia/Karachi', 'Asia/Kathmandu', 'Asia/Khandyga', 'Asia/Kolkata', 'Asia/Krasnoyarsk', 'Asia/Kuala_Lumpur', 'Asia/Kuching', 'Asia/Kuwait', 'Asia/Macau', 'Asia/Magadan', 'Asia/Makassar', 'Asia/Manila', 'Asia/Muscat', 'Asia/Nicosia', 'Asia/Novokuznetsk', 'Asia/Novosibirsk', 'Asia/Omsk', 'Asia/Oral', 'Asia/Phnom_Penh', 'Asia/Pontianak', 'Asia/Pyongyang', 'Asia/Qatar', 'Asia/Qostanay', 'Asia/Qyzylorda', 'Asia/Riyadh', 'Asia/Sakhalin', 'Asia/Samarkand', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Srednekolymsk', 'Asia/Taipei', 'Asia/Tashkent', 'Asia/Tbilisi', 'Asia/Tehran', 'Asia/Thimphu', 'Asia/Tokyo', 'Asia/Tomsk', 'Asia/Ulaanbaatar', 'Asia/Urumqi', 'Asia/Ust-Nera', 'Asia/Vientiane', 'Asia/Vladivostok', 'Asia/Yakutsk', 'Asia/Yangon', 'Asia/Yekaterinburg', 'Asia/Yerevan', 'Atlantic/Azores', 'Atlantic/Bermuda', 'Atlantic/Canary', 'Atlantic/Cape_Verde', 'Atlantic/Faroe', 'Atlantic/Madeira', 'Atlantic/Reykjavik', 'Atlantic/South_Georgia', 'Atlantic/St_Helena', 'Atlantic/Stanley', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Broken_Hill', 'Australia/Darwin', 'Australia/Eucla', 'Australia/Hobart', 'Australia/Lindeman', 'Australia/Lord_Howe', 'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney', 'Etc/GMT+1', 'Etc/GMT+10', 'Etc/GMT+11', 'Etc/GMT+12', 'Etc/GMT+2', 'Etc/GMT+3', 'Etc/GMT+4', 'Etc/GMT+5', 'Etc/GMT+6', 'Etc/GMT+7', 'Etc/GMT+8', 'Etc/GMT+9', 'Etc/GMT-1', 'Etc/GMT-10', 'Etc/GMT-11', 'Etc/GMT-12', 'Etc/GMT-13', 'Etc/GMT-14', 'Etc/GMT-2', 'Etc/GMT-3', 'Etc/GMT-4', 'Etc/GMT-5', 'Etc/GMT-6', 'Etc/GMT-7', 'Etc/GMT-8', 'Etc/GMT-9', 'Europe/Amsterdam', 'Europe/Andorra', 'Europe/Astrakhan', 'Europe/Athens', 'Europe/Belgrade', 'Europe/Berlin', 'Europe/Bratislava', 'Europe/Brussels', 'Europe/Bucharest', 'Europe/Budapest', 'Europe/Busingen', 'Europe/Chisinau', 'Europe/Copenhagen', 'Europe/Dublin', 'Europe/Gibraltar', 'Europe/Guernsey', 'Europe/Helsinki', 'Europe/Isle_of_Man', 'Europe/Istanbul', 'Europe/Jersey', 'Europe/Kaliningrad', 'Europe/Kirov', 'Europe/Kyiv', 'Europe/Lisbon', 'Europe/Ljubljana', 'Europe/London', 'Europe/Luxembourg', 'Europe/Madrid', 'Europe/Malta', 'Europe/Mariehamn', 'Europe/Minsk', 'Europe/Monaco', 'Europe/Moscow', 'Europe/Oslo', 'Europe/Paris', 'Europe/Podgorica', 'Europe/Prague', 'Europe/Riga', 'Europe/Rome', 'Europe/Samara', 'Europe/San_Marino', 'Europe/Sarajevo', 'Europe/Saratov', 'Europe/Simferopol', 'Europe/Skopje', 'Europe/Sofia', 'Europe/Stockholm', 'Europe/Tallinn', 'Europe/Tirane', 'Europe/Ulyanovsk', 'Europe/Vaduz', 'Europe/Vatican', 'Europe/Vienna', 'Europe/Vilnius', 'Europe/Volgograd', 'Europe/Warsaw', 'Europe/Zagreb', 'Europe/Zurich', 'Indian/Antananarivo', 'Indian/Chagos', 'Indian/Christmas', 'Indian/Cocos', 'Indian/Comoro', 'Indian/Kerguelen', 'Indian/Mahe', 'Indian/Maldives', 'Indian/Mauritius', 'Indian/Mayotte', 'Indian/Reunion', 'Pacific/Apia', 'Pacific/Auckland', 'Pacific/Bougainville', 'Pacific/Chatham', 'Pacific/Chuuk', 'Pacific/Easter', 'Pacific/Efate', 'Pacific/Fakaofo', 'Pacific/Fiji', 'Pacific/Funafuti', 'Pacific/Galapagos', 'Pacific/Gambier', 'Pacific/Guadalcanal', 'Pacific/Guam', 'Pacific/Honolulu', 'Pacific/Kanton', 'Pacific/Kiritimati', 'Pacific/Kosrae', 'Pacific/Kwajalein', 'Pacific/Majuro', 'Pacific/Marquesas', 'Pacific/Midway', 'Pacific/Nauru', 'Pacific/Niue', 'Pacific/Norfolk', 'Pacific/Noumea', 'Pacific/Pago_Pago', 'Pacific/Palau', 'Pacific/Pitcairn', 'Pacific/Pohnpei', 'Pacific/Port_Moresby', 'Pacific/Rarotonga', 'Pacific/Saipan', 'Pacific/Tahiti', 'Pacific/Tarawa', 'Pacific/Tongatapu', 'Pacific/Wake', 'Pacific/Wallis', 'UTC')),
	CONSTRAINT "scheduled_jobs_timeout_check" CHECK("timeout_ms" BETWEEN 1000 AND 86400000),
	CONSTRAINT "scheduled_jobs_updated_at_check" CHECK("updated_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" >= "created_at"),
	CONSTRAINT "scheduled_jobs_version_check" CHECK("version" BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `worker_instances` (
	`action_keys_json` text DEFAULT '[]' NOT NULL,
	`capacity` integer NOT NULL,
	`draining_at` integer,
	`heartbeat_at` integer NOT NULL,
	`id` text PRIMARY KEY,
	`pid` integer NOT NULL,
	`release_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`state` text NOT NULL,
	`stopped_at` integer,
	CONSTRAINT "worker_instances_action_keys_json_check" CHECK(length(CAST("action_keys_json" AS BLOB)) <= 4096 AND CASE WHEN json_valid("action_keys_json") THEN json_type("action_keys_json") = 'array' ELSE 0 END AND CASE WHEN json_valid("action_keys_json") THEN json_array_length("action_keys_json") <= 32 ELSE 0 END),
	CONSTRAINT "worker_instances_capacity_check" CHECK("capacity" BETWEEN 1 AND 16),
	CONSTRAINT "worker_instances_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "worker_instances_pid_check" CHECK("pid" BETWEEN 1 AND 2147483647),
	CONSTRAINT "worker_instances_release_id_check" CHECK(length("release_id") = 40 AND instr("release_id", char(0)) = 0 AND "release_id" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "worker_instances_state_check" CHECK(("state" = 'online' AND "draining_at" IS NULL AND "stopped_at" IS NULL) OR ("state" = 'draining' AND "draining_at" IS NOT NULL AND "stopped_at" IS NULL) OR ("state" = 'stopped' AND "draining_at" IS NOT NULL AND "stopped_at" IS NOT NULL)),
	CONSTRAINT "worker_instances_time_check" CHECK("started_at" BETWEEN 0 AND 8640000000000000 AND "heartbeat_at" BETWEEN 0 AND 8640000000000000 AND "heartbeat_at" >= "started_at" AND ("draining_at" IS NULL OR ("draining_at" BETWEEN 0 AND 8640000000000000 AND "draining_at" >= "started_at")) AND ("stopped_at" IS NULL OR ("stopped_at" BETWEEN 0 AND 8640000000000000 AND "stopped_at" >= "draining_at")))
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `host_restart_claim_fence` (
	`armed_at` integer NOT NULL,
	`boot_identity` text NOT NULL,
	`expires_at` integer NOT NULL,
	`id` integer PRIMARY KEY NOT NULL,
	`job_run_id` text NOT NULL,
	`lease_token` text NOT NULL,
	`worker_instance_id` text NOT NULL,
	CONSTRAINT `fk_host_restart_claim_fence_job_run_id_job_runs_id_fk` FOREIGN KEY (`job_run_id`) REFERENCES `job_runs`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_host_restart_claim_fence_worker_instance_id_worker_instances_id_fk` FOREIGN KEY (`worker_instance_id`) REFERENCES `worker_instances`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "host_restart_claim_fence_boot_identity_check" CHECK(length("boot_identity") = 36 AND instr("boot_identity", char(0)) = 0 AND length(replace("boot_identity", '-', '')) = 32 AND replace("boot_identity", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("boot_identity", 9, 1) = '-' AND substr("boot_identity", 14, 1) = '-' AND substr("boot_identity", 19, 1) = '-' AND substr("boot_identity", 24, 1) = '-'),
	CONSTRAINT "host_restart_claim_fence_id_check" CHECK("id" = 1),
	CONSTRAINT "host_restart_claim_fence_lease_token_check" CHECK(length("lease_token") = 36 AND instr("lease_token", char(0)) = 0 AND length(replace("lease_token", '-', '')) = 32 AND replace("lease_token", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("lease_token", 9, 1) = '-' AND substr("lease_token", 14, 1) = '-' AND substr("lease_token", 15, 1) = '7' AND substr("lease_token", 19, 1) = '-' AND substr("lease_token", 20, 1) GLOB '[89ab]' AND substr("lease_token", 24, 1) = '-'),
	CONSTRAINT "host_restart_claim_fence_time_check" CHECK("armed_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" > "armed_at")
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE UNIQUE INDEX `job_disable_intents_active_schedule_unique` ON `job_disable_intents` (`scheduled_job_id`) WHERE "job_disable_intents"."scheduled_job_id" IS NOT NULL AND "job_disable_intents"."ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `job_disable_intents_active_external_unique` ON `job_disable_intents` (`external_provider`,`external_job_id`) WHERE "job_disable_intents"."external_job_id" IS NOT NULL AND "job_disable_intents"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `job_disable_intents_active_expiry_idx` ON `job_disable_intents` (`expires_at`,`id`) WHERE "job_disable_intents"."expires_at" IS NOT NULL AND "job_disable_intents"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `job_disable_intents_schedule_created_id_idx` ON `job_disable_intents` (`scheduled_job_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `job_disable_intents_external_created_id_idx` ON `job_disable_intents` (`external_provider`,`external_job_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `job_run_events_occurred_run_sequence_idx` ON `job_run_events` (`occurred_at`,`job_run_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `job_runs_idempotency_unique` ON `job_runs` (`requested_by_kind`,`requested_by_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `job_runs_claim_idx` ON `job_runs` ("available_at" asc,"priority" desc,"queued_at" asc,"id" asc) WHERE "job_runs"."state" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX `job_runs_one_active_schedule_idx` ON `job_runs` (`scheduled_job_id`) WHERE "job_runs"."scheduled_job_id" IS NOT NULL AND "job_runs"."state" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX `job_runs_action_active_idx` ON `job_runs` (`action_key`,"state" desc,"queued_at" desc,"id" desc) WHERE "job_runs"."state" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX `job_runs_delivery_production_history_idx` ON `job_runs` (`action_key`,"updated_at" desc,"id" desc) WHERE "job_runs"."action_key" = 'delivery.production.v1';--> statement-breakpoint
CREATE INDEX `job_runs_backup_attention_history_idx` ON `job_runs` (`action_key`,"updated_at" desc,"id" desc) WHERE "job_runs"."action_key" = 'backup.kopia.run' OR "job_runs"."action_key" = 'backup.walg.run';--> statement-breakpoint
CREATE INDEX `job_runs_backup_clear_history_idx` ON `job_runs` (json_extract("result_json", '$.type'),json_extract("result_json", '$.attentionRunId'),`queued_at`,`id`) WHERE "job_runs"."action_key" = 'backup.clear-attention' AND "job_runs"."state" = 'succeeded';--> statement-breakpoint
CREATE INDEX `job_runs_action_payload_terminal_idx` ON `job_runs` (`action_key`,`payload_json`,"queued_at" desc,"id" desc) WHERE "job_runs"."action_key" = 'maintenance.rotate-logs' AND length(CAST("job_runs"."payload_json" AS BLOB)) <= 128 AND "job_runs"."state" IN ('cancelled', 'failed', 'succeeded', 'timed-out');--> statement-breakpoint
CREATE INDEX `job_runs_service_action_terminal_idx` ON `job_runs` (`action_key`,"queued_at" desc,"id" desc) WHERE "job_runs"."action_key" IN ('openclaw.sessions.cleanup', 'openclaw.gateway.restart', 'openclaw.installation.update', 'host.system.cleanup', 'host.system.restart', 'host.system.update') AND "job_runs"."payload_json" = '{}' AND "job_runs"."state" IN ('cancelled', 'failed', 'succeeded', 'timed-out');--> statement-breakpoint
CREATE INDEX `job_runs_queued_id_idx` ON `job_runs` (`queued_at`,`id`);--> statement-breakpoint
CREATE INDEX `job_runs_schedule_queued_id_idx` ON `job_runs` (`scheduled_job_id`,`queued_at`,`id`);--> statement-breakpoint
CREATE INDEX `job_runs_running_lease_idx` ON `job_runs` (`lease_expires_at`,`id`) WHERE "job_runs"."state" = 'running';--> statement-breakpoint
CREATE INDEX `job_runs_running_owner_id_idx` ON `job_runs` (`lease_owner_id`,`id`) WHERE "job_runs"."state" = 'running';--> statement-breakpoint
CREATE INDEX `resource_leases_expiry_key_idx` ON `resource_leases` (`expires_at`,`resource_key`);--> statement-breakpoint
CREATE INDEX `resource_leases_run_key_idx` ON `resource_leases` (`job_run_id`,`resource_key`);--> statement-breakpoint
CREATE INDEX `scheduled_jobs_due_idx` ON `scheduled_jobs` (`next_run_at`,`id`) WHERE "scheduled_jobs"."enabled" = 1;--> statement-breakpoint
CREATE INDEX `scheduled_jobs_updated_id_idx` ON `scheduled_jobs` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `worker_instances_heartbeat_id_idx` ON `worker_instances` (`heartbeat_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER scheduled_jobs_validate_resource_keys_insert
BEFORE INSERT ON scheduled_jobs
WHEN json_array_length(NEW.resource_keys_json) > 32
    OR EXISTS (
        SELECT 1
        FROM json_each(NEW.resource_keys_json) AS entry
        WHERE entry.type <> 'text'
           OR length(CAST(entry.value AS TEXT)) NOT BETWEEN 1 AND 128
           OR CAST(entry.value AS TEXT) <> lower(CAST(entry.value AS TEXT))
           OR substr(CAST(entry.value AS TEXT), 1, 1) NOT GLOB '[a-z0-9]'
           OR CAST(entry.value AS TEXT) GLOB '*[^a-z0-9._-]*'
    )
    OR EXISTS (
        SELECT 1
        FROM json_each(NEW.resource_keys_json) AS current
        JOIN json_each(NEW.resource_keys_json) AS previous
          ON previous.key = current.key - 1
        WHERE CAST(current.value AS TEXT) <= CAST(previous.value AS TEXT)
    )
BEGIN
	SELECT RAISE(ABORT, 'scheduled_jobs resource keys must be canonical');
END;
--> statement-breakpoint
CREATE TRIGGER scheduled_jobs_validate_resource_keys_update
BEFORE UPDATE OF resource_keys_json ON scheduled_jobs
WHEN json_array_length(NEW.resource_keys_json) > 32
    OR EXISTS (
        SELECT 1
        FROM json_each(NEW.resource_keys_json) AS entry
        WHERE entry.type <> 'text'
           OR length(CAST(entry.value AS TEXT)) NOT BETWEEN 1 AND 128
           OR CAST(entry.value AS TEXT) <> lower(CAST(entry.value AS TEXT))
           OR substr(CAST(entry.value AS TEXT), 1, 1) NOT GLOB '[a-z0-9]'
           OR CAST(entry.value AS TEXT) GLOB '*[^a-z0-9._-]*'
    )
    OR EXISTS (
        SELECT 1
        FROM json_each(NEW.resource_keys_json) AS current
        JOIN json_each(NEW.resource_keys_json) AS previous
          ON previous.key = current.key - 1
        WHERE CAST(current.value AS TEXT) <= CAST(previous.value AS TEXT)
    )
BEGIN
	SELECT RAISE(ABORT, 'scheduled_jobs resource keys must be canonical');
END;
--> statement-breakpoint
CREATE TRIGGER scheduled_jobs_validate_cron_insert
BEFORE INSERT ON scheduled_jobs
WHEN NEW.schedule_kind = 'cron'
    AND NEW.cron_expression IS NOT NULL
    AND length(NEW.cron_expression) BETWEEN 9 AND 200
    AND instr(NEW.cron_expression, char(0)) = 0
    AND NEW.cron_expression = trim(NEW.cron_expression)
    AND NEW.cron_expression NOT LIKE '%  %'
    AND NEW.cron_expression NOT GLOB '*[^-0-9*,/ ]*'
    AND length(NEW.cron_expression) - length(replace(NEW.cron_expression, ' ', '')) = 4
    AND EXISTS (
        WITH RECURSIVE
        cron_fields(field_index, field_value, remaining, minimum_value, maximum_value) AS (
            SELECT
                0,
                substr(NEW.cron_expression, 1, instr(NEW.cron_expression, ' ') - 1),
                substr(NEW.cron_expression, instr(NEW.cron_expression, ' ') + 1),
                0,
                59
            UNION ALL
            SELECT
                field_index + 1,
                CASE
                    WHEN instr(remaining, ' ') = 0 THEN remaining
                    ELSE substr(remaining, 1, instr(remaining, ' ') - 1)
                END,
                CASE
                    WHEN instr(remaining, ' ') = 0 THEN ''
                    ELSE substr(remaining, instr(remaining, ' ') + 1)
                END,
                CASE field_index + 1 WHEN 2 THEN 1 WHEN 3 THEN 1 ELSE 0 END,
                CASE field_index + 1
                    WHEN 0 THEN 59
                    WHEN 1 THEN 23
                    WHEN 2 THEN 31
                    WHEN 3 THEN 12
                    ELSE 7
                END
            FROM cron_fields
            WHERE field_index < 4
        ),
        cron_parts(
            field_index,
            part_index,
            minimum_value,
            maximum_value,
            part_value,
            remaining
        ) AS (
            SELECT
                field_index,
                0,
                minimum_value,
                maximum_value,
                substr(field_value || ',', 1, instr(field_value || ',', ',') - 1),
                substr(field_value || ',', instr(field_value || ',', ',') + 1)
            FROM cron_fields
            UNION ALL
            SELECT
                field_index,
                part_index + 1,
                minimum_value,
                maximum_value,
                substr(remaining, 1, instr(remaining, ',') - 1),
                substr(remaining, instr(remaining, ',') + 1)
            FROM cron_parts
            WHERE remaining <> ''
        ),
        parsed_parts AS (
            SELECT
                *,
                length(part_value) - length(replace(part_value, '/', '')) AS slash_count,
                CASE
                    WHEN instr(part_value, '/') = 0 THEN part_value
                    ELSE substr(part_value, 1, instr(part_value, '/') - 1)
                END AS base_value,
                CASE
                    WHEN instr(part_value, '/') = 0 THEN NULL
                    ELSE substr(part_value, instr(part_value, '/') + 1)
                END AS step_value
            FROM cron_parts
        ),
        parsed_ranges AS (
            SELECT
                *,
                length(base_value) - length(replace(base_value, '-', '')) AS range_count,
                CASE
                    WHEN instr(base_value, '-') = 0 THEN base_value
                    ELSE substr(base_value, 1, instr(base_value, '-') - 1)
                END AS left_value,
                CASE
                    WHEN instr(base_value, '-') = 0 THEN NULL
                    ELSE substr(base_value, instr(base_value, '-') + 1)
                END AS right_value
            FROM parsed_parts
        ),
        invalid_parts AS (
            SELECT 1
            FROM parsed_ranges
            WHERE length(part_value) = 0
               OR slash_count > 1
               OR (
                    slash_count = 1
                    AND (
                        length(step_value) = 0
                        OR step_value GLOB '*[^0-9]*'
                        OR CAST(step_value AS INTEGER) < 1
                        OR CAST(step_value AS INTEGER) > maximum_value
                    )
               )
               OR (
                    base_value <> '*'
                    AND (
                        range_count > 1
                        OR (
                            range_count = 0
                            AND (
                                length(left_value) = 0
                                OR left_value GLOB '*[^0-9]*'
                                OR CAST(left_value AS INTEGER) < minimum_value
                                OR CAST(left_value AS INTEGER) > maximum_value
                            )
                        )
                        OR (
                            range_count = 1
                            AND (
                                length(left_value) = 0
                                OR left_value GLOB '*[^0-9]*'
                                OR length(right_value) = 0
                                OR right_value GLOB '*[^0-9]*'
                                OR CAST(left_value AS INTEGER) < minimum_value
                                OR CAST(left_value AS INTEGER) > maximum_value
                                OR CAST(right_value AS INTEGER) < minimum_value
                                OR CAST(right_value AS INTEGER) > maximum_value
                                OR CAST(left_value AS INTEGER) > CAST(right_value AS INTEGER)
                            )
                        )
                    )
               )
        ),
        field_modes AS (
            SELECT
                field_index,
                max(
                    CASE
                        WHEN part_index = 0 AND base_value = '*' THEN 1
                        ELSE 0
                    END
                ) AS starts_with_wildcard,
                max(
                    CASE
                        WHEN part_index = 0
                            AND base_value = '*'
                            AND (
                                step_value IS NULL
                                OR CAST(step_value AS INTEGER) = 1
                            )
                        THEN 1
                        ELSE 0
                    END
                ) AS unrestricted
            FROM parsed_ranges
            GROUP BY field_index
        ),
        domain_values(value) AS (
            SELECT 0
            UNION ALL
            SELECT value + 1
            FROM domain_values
            WHERE value < 59
        ),
        expanded_values(field_index, value) AS (
            SELECT DISTINCT
                parsed_ranges.field_index,
                CASE
                    WHEN parsed_ranges.field_index = 4 AND domain_values.value = 7
                    THEN 0
                    ELSE domain_values.value
                END
            FROM parsed_ranges
            JOIN domain_values
              ON domain_values.value BETWEEN parsed_ranges.minimum_value
                 AND parsed_ranges.maximum_value
            WHERE (
                    parsed_ranges.base_value = '*'
                    AND (
                        domain_values.value - parsed_ranges.minimum_value
                    ) % coalesce(CAST(parsed_ranges.step_value AS INTEGER), 1) = 0
                )
                OR (
                    parsed_ranges.base_value <> '*'
                    AND parsed_ranges.range_count = 0
                    AND domain_values.value >= CAST(parsed_ranges.left_value AS INTEGER)
                    AND domain_values.value <= CASE
                        WHEN parsed_ranges.step_value IS NULL
                        THEN CAST(parsed_ranges.left_value AS INTEGER)
                        ELSE parsed_ranges.maximum_value
                    END
                    AND (
                        domain_values.value - CAST(parsed_ranges.left_value AS INTEGER)
                    ) % coalesce(CAST(parsed_ranges.step_value AS INTEGER), 1) = 0
                )
                OR (
                    parsed_ranges.base_value <> '*'
                    AND parsed_ranges.range_count = 1
                    AND domain_values.value BETWEEN
                        CAST(parsed_ranges.left_value AS INTEGER)
                        AND CAST(parsed_ranges.right_value AS INTEGER)
                    AND (
                        domain_values.value - CAST(parsed_ranges.left_value AS INTEGER)
                    ) % coalesce(CAST(parsed_ranges.step_value AS INTEGER), 1) = 0
                )
        ),
        viability_required AS (
            SELECT 1
            FROM field_modes AS day_field
            JOIN field_modes AS weekday_field
              ON weekday_field.field_index = 4
            WHERE day_field.field_index = 2
              AND day_field.unrestricted = 0
              AND (
                    weekday_field.unrestricted = 1
                    OR day_field.starts_with_wildcard = 1
                    OR weekday_field.starts_with_wildcard = 1
              )
        ),
        viable_day_month AS (
            SELECT 1
            FROM expanded_values AS day_value
            JOIN expanded_values AS month_value
              ON month_value.field_index = 3
            WHERE day_value.field_index = 2
              AND day_value.value <= CASE month_value.value
                    WHEN 2 THEN 29
                    WHEN 4 THEN 30
                    WHEN 6 THEN 30
                    WHEN 9 THEN 30
                    WHEN 11 THEN 30
                    ELSE 31
              END
            LIMIT 1
        )
        SELECT 1
        FROM invalid_parts
        UNION ALL
        SELECT 1
        WHERE EXISTS (SELECT 1 FROM viability_required)
          AND NOT EXISTS (SELECT 1 FROM viable_day_month)
        LIMIT 1
    )
BEGIN
	SELECT RAISE(ABORT, 'scheduled_jobs cron expression must be semantically valid');
END;
--> statement-breakpoint
CREATE TRIGGER scheduled_jobs_validate_cron_update
BEFORE UPDATE OF schedule_kind, cron_expression ON scheduled_jobs
WHEN NEW.schedule_kind = 'cron'
    AND NEW.cron_expression IS NOT NULL
    AND length(NEW.cron_expression) BETWEEN 9 AND 200
    AND instr(NEW.cron_expression, char(0)) = 0
    AND NEW.cron_expression = trim(NEW.cron_expression)
    AND NEW.cron_expression NOT LIKE '%  %'
    AND NEW.cron_expression NOT GLOB '*[^-0-9*,/ ]*'
    AND length(NEW.cron_expression) - length(replace(NEW.cron_expression, ' ', '')) = 4
    AND EXISTS (
        WITH RECURSIVE
        cron_fields(field_index, field_value, remaining, minimum_value, maximum_value) AS (
            SELECT
                0,
                substr(NEW.cron_expression, 1, instr(NEW.cron_expression, ' ') - 1),
                substr(NEW.cron_expression, instr(NEW.cron_expression, ' ') + 1),
                0,
                59
            UNION ALL
            SELECT
                field_index + 1,
                CASE
                    WHEN instr(remaining, ' ') = 0 THEN remaining
                    ELSE substr(remaining, 1, instr(remaining, ' ') - 1)
                END,
                CASE
                    WHEN instr(remaining, ' ') = 0 THEN ''
                    ELSE substr(remaining, instr(remaining, ' ') + 1)
                END,
                CASE field_index + 1 WHEN 2 THEN 1 WHEN 3 THEN 1 ELSE 0 END,
                CASE field_index + 1
                    WHEN 0 THEN 59
                    WHEN 1 THEN 23
                    WHEN 2 THEN 31
                    WHEN 3 THEN 12
                    ELSE 7
                END
            FROM cron_fields
            WHERE field_index < 4
        ),
        cron_parts(
            field_index,
            part_index,
            minimum_value,
            maximum_value,
            part_value,
            remaining
        ) AS (
            SELECT
                field_index,
                0,
                minimum_value,
                maximum_value,
                substr(field_value || ',', 1, instr(field_value || ',', ',') - 1),
                substr(field_value || ',', instr(field_value || ',', ',') + 1)
            FROM cron_fields
            UNION ALL
            SELECT
                field_index,
                part_index + 1,
                minimum_value,
                maximum_value,
                substr(remaining, 1, instr(remaining, ',') - 1),
                substr(remaining, instr(remaining, ',') + 1)
            FROM cron_parts
            WHERE remaining <> ''
        ),
        parsed_parts AS (
            SELECT
                *,
                length(part_value) - length(replace(part_value, '/', '')) AS slash_count,
                CASE
                    WHEN instr(part_value, '/') = 0 THEN part_value
                    ELSE substr(part_value, 1, instr(part_value, '/') - 1)
                END AS base_value,
                CASE
                    WHEN instr(part_value, '/') = 0 THEN NULL
                    ELSE substr(part_value, instr(part_value, '/') + 1)
                END AS step_value
            FROM cron_parts
        ),
        parsed_ranges AS (
            SELECT
                *,
                length(base_value) - length(replace(base_value, '-', '')) AS range_count,
                CASE
                    WHEN instr(base_value, '-') = 0 THEN base_value
                    ELSE substr(base_value, 1, instr(base_value, '-') - 1)
                END AS left_value,
                CASE
                    WHEN instr(base_value, '-') = 0 THEN NULL
                    ELSE substr(base_value, instr(base_value, '-') + 1)
                END AS right_value
            FROM parsed_parts
        ),
        invalid_parts AS (
            SELECT 1
            FROM parsed_ranges
            WHERE length(part_value) = 0
               OR slash_count > 1
               OR (
                    slash_count = 1
                    AND (
                        length(step_value) = 0
                        OR step_value GLOB '*[^0-9]*'
                        OR CAST(step_value AS INTEGER) < 1
                        OR CAST(step_value AS INTEGER) > maximum_value
                    )
               )
               OR (
                    base_value <> '*'
                    AND (
                        range_count > 1
                        OR (
                            range_count = 0
                            AND (
                                length(left_value) = 0
                                OR left_value GLOB '*[^0-9]*'
                                OR CAST(left_value AS INTEGER) < minimum_value
                                OR CAST(left_value AS INTEGER) > maximum_value
                            )
                        )
                        OR (
                            range_count = 1
                            AND (
                                length(left_value) = 0
                                OR left_value GLOB '*[^0-9]*'
                                OR length(right_value) = 0
                                OR right_value GLOB '*[^0-9]*'
                                OR CAST(left_value AS INTEGER) < minimum_value
                                OR CAST(left_value AS INTEGER) > maximum_value
                                OR CAST(right_value AS INTEGER) < minimum_value
                                OR CAST(right_value AS INTEGER) > maximum_value
                                OR CAST(left_value AS INTEGER) > CAST(right_value AS INTEGER)
                            )
                        )
                    )
               )
        ),
        field_modes AS (
            SELECT
                field_index,
                max(
                    CASE
                        WHEN part_index = 0 AND base_value = '*' THEN 1
                        ELSE 0
                    END
                ) AS starts_with_wildcard,
                max(
                    CASE
                        WHEN part_index = 0
                            AND base_value = '*'
                            AND (
                                step_value IS NULL
                                OR CAST(step_value AS INTEGER) = 1
                            )
                        THEN 1
                        ELSE 0
                    END
                ) AS unrestricted
            FROM parsed_ranges
            GROUP BY field_index
        ),
        domain_values(value) AS (
            SELECT 0
            UNION ALL
            SELECT value + 1
            FROM domain_values
            WHERE value < 59
        ),
        expanded_values(field_index, value) AS (
            SELECT DISTINCT
                parsed_ranges.field_index,
                CASE
                    WHEN parsed_ranges.field_index = 4 AND domain_values.value = 7
                    THEN 0
                    ELSE domain_values.value
                END
            FROM parsed_ranges
            JOIN domain_values
              ON domain_values.value BETWEEN parsed_ranges.minimum_value
                 AND parsed_ranges.maximum_value
            WHERE (
                    parsed_ranges.base_value = '*'
                    AND (
                        domain_values.value - parsed_ranges.minimum_value
                    ) % coalesce(CAST(parsed_ranges.step_value AS INTEGER), 1) = 0
                )
                OR (
                    parsed_ranges.base_value <> '*'
                    AND parsed_ranges.range_count = 0
                    AND domain_values.value >= CAST(parsed_ranges.left_value AS INTEGER)
                    AND domain_values.value <= CASE
                        WHEN parsed_ranges.step_value IS NULL
                        THEN CAST(parsed_ranges.left_value AS INTEGER)
                        ELSE parsed_ranges.maximum_value
                    END
                    AND (
                        domain_values.value - CAST(parsed_ranges.left_value AS INTEGER)
                    ) % coalesce(CAST(parsed_ranges.step_value AS INTEGER), 1) = 0
                )
                OR (
                    parsed_ranges.base_value <> '*'
                    AND parsed_ranges.range_count = 1
                    AND domain_values.value BETWEEN
                        CAST(parsed_ranges.left_value AS INTEGER)
                        AND CAST(parsed_ranges.right_value AS INTEGER)
                    AND (
                        domain_values.value - CAST(parsed_ranges.left_value AS INTEGER)
                    ) % coalesce(CAST(parsed_ranges.step_value AS INTEGER), 1) = 0
                )
        ),
        viability_required AS (
            SELECT 1
            FROM field_modes AS day_field
            JOIN field_modes AS weekday_field
              ON weekday_field.field_index = 4
            WHERE day_field.field_index = 2
              AND day_field.unrestricted = 0
              AND (
                    weekday_field.unrestricted = 1
                    OR day_field.starts_with_wildcard = 1
                    OR weekday_field.starts_with_wildcard = 1
              )
        ),
        viable_day_month AS (
            SELECT 1
            FROM expanded_values AS day_value
            JOIN expanded_values AS month_value
              ON month_value.field_index = 3
            WHERE day_value.field_index = 2
              AND day_value.value <= CASE month_value.value
                    WHEN 2 THEN 29
                    WHEN 4 THEN 30
                    WHEN 6 THEN 30
                    WHEN 9 THEN 30
                    WHEN 11 THEN 30
                    ELSE 31
              END
            LIMIT 1
        )
        SELECT 1
        FROM invalid_parts
        UNION ALL
        SELECT 1
        WHERE EXISTS (SELECT 1 FROM viability_required)
          AND NOT EXISTS (SELECT 1 FROM viable_day_month)
        LIMIT 1
    )
BEGIN
	SELECT RAISE(ABORT, 'scheduled_jobs cron expression must be semantically valid');
END;
--> statement-breakpoint
CREATE TRIGGER scheduled_jobs_reject_replace
BEFORE INSERT ON scheduled_jobs
WHEN EXISTS (SELECT 1 FROM scheduled_jobs WHERE id = NEW.id)
BEGIN
	SELECT RAISE(ABORT, 'scheduled_jobs identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER scheduled_jobs_reject_identity_update
BEFORE UPDATE OF id, created_at ON scheduled_jobs
BEGIN
	SELECT RAISE(ABORT, 'scheduled_jobs identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER scheduled_jobs_validate_version_update
BEFORE UPDATE ON scheduled_jobs
WHEN (
        (
            NEW.action_key IS NOT OLD.action_key
            OR NEW.action_payload_json IS NOT OLD.action_payload_json
            OR NEW.attempt_limit IS NOT OLD.attempt_limit
            OR NEW.cancellation_policy IS NOT OLD.cancellation_policy
            OR NEW.cron_expression IS NOT OLD.cron_expression
            OR NEW.description IS NOT OLD.description
            OR NEW.enabled IS NOT OLD.enabled
            OR NEW.interval_ms IS NOT OLD.interval_ms
            OR NEW.name IS NOT OLD.name
            OR NEW.priority IS NOT OLD.priority
            OR NEW.resource_class IS NOT OLD.resource_class
            OR NEW.resource_keys_json IS NOT OLD.resource_keys_json
            OR NEW.retry_safe IS NOT OLD.retry_safe
            OR NEW.schedule_kind IS NOT OLD.schedule_kind
            OR NEW.time_of_day IS NOT OLD.time_of_day
            OR NEW.time_zone IS NOT OLD.time_zone
            OR NEW.timeout_ms IS NOT OLD.timeout_ms
        )
        AND (
            NEW.version <> OLD.version + 1
            OR NEW.updated_at < OLD.updated_at
        )
    )
    OR (
        NEW.action_key IS OLD.action_key
        AND NEW.action_payload_json IS OLD.action_payload_json
        AND NEW.attempt_limit IS OLD.attempt_limit
        AND NEW.cancellation_policy IS OLD.cancellation_policy
        AND NEW.cron_expression IS OLD.cron_expression
        AND NEW.description IS OLD.description
        AND NEW.enabled IS OLD.enabled
        AND NEW.interval_ms IS OLD.interval_ms
        AND NEW.name IS OLD.name
        AND NEW.priority IS OLD.priority
        AND NEW.resource_class IS OLD.resource_class
        AND NEW.resource_keys_json IS OLD.resource_keys_json
        AND NEW.retry_safe IS OLD.retry_safe
        AND NEW.schedule_kind IS OLD.schedule_kind
        AND NEW.time_of_day IS OLD.time_of_day
        AND NEW.time_zone IS OLD.time_zone
        AND NEW.timeout_ms IS OLD.timeout_ms
        AND (
            NEW.version <> OLD.version
            OR NEW.updated_at <> OLD.updated_at
        )
        AND NOT (
            OLD.enabled = 0
            AND NEW.enabled = 0
            AND NEW.next_run_at IS OLD.next_run_at
            AND NEW.version = OLD.version + 1
            AND NEW.updated_at >= OLD.updated_at
            AND EXISTS (
                SELECT 1
                FROM job_disable_intents AS replacement
                JOIN job_disable_intents AS replaced
                  ON replaced.scheduled_job_id = replacement.scheduled_job_id
                 AND replaced.id <> replacement.id
                WHERE replacement.scheduled_job_id = NEW.id
                  AND replacement.ended_at IS NULL
                  AND replacement.created_at = NEW.updated_at
                  AND replacement.created_at >= OLD.updated_at
                  AND replaced.created_at <= OLD.updated_at
                  AND replaced.ended_at = NEW.updated_at
                  AND replaced.ended_reason = 'replaced'
                  AND replaced.ended_by_kind = replacement.created_by_kind
                  AND replaced.ended_by_id = replacement.created_by_id
            )
        )
    )
BEGIN
	SELECT RAISE(ABORT, 'scheduled_jobs version transition is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER scheduled_jobs_reject_delete
BEFORE DELETE ON scheduled_jobs
BEGIN
	SELECT RAISE(ABORT, 'scheduled_jobs history cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER job_disable_intents_reject_replace
BEFORE INSERT ON job_disable_intents
WHEN EXISTS (SELECT 1 FROM job_disable_intents WHERE id = NEW.id)
BEGIN
	SELECT RAISE(ABORT, 'job_disable_intents identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER job_disable_intents_reject_content_update
BEFORE UPDATE OF
    id, target_kind, scheduled_job_id, external_provider, external_job_id,
    reason, created_by_kind, created_by_id, created_at, expires_at
ON job_disable_intents
BEGIN
	SELECT RAISE(ABORT, 'job_disable_intents content is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER job_disable_intents_reject_closed_update
BEFORE UPDATE ON job_disable_intents
WHEN OLD.ended_at IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'closed job_disable_intents are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER job_disable_intents_reject_delete
BEFORE DELETE ON job_disable_intents
BEGIN
	SELECT RAISE(ABORT, 'job_disable_intents history cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER worker_instances_reject_replace
BEFORE INSERT ON worker_instances
WHEN EXISTS (SELECT 1 FROM worker_instances WHERE id = NEW.id)
BEGIN
	SELECT RAISE(ABORT, 'worker_instances identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER worker_instances_validate_action_keys_insert
BEFORE INSERT ON worker_instances
WHEN json_array_length(NEW.action_keys_json) > 32
    OR EXISTS (
        SELECT 1
        FROM json_each(NEW.action_keys_json) AS entry
        WHERE entry.type <> 'text'
           OR length(CAST(entry.value AS TEXT)) NOT BETWEEN 1 AND 128
           OR CAST(entry.value AS TEXT) <> lower(CAST(entry.value AS TEXT))
           OR substr(CAST(entry.value AS TEXT), 1, 1) NOT GLOB '[a-z0-9]'
           OR CAST(entry.value AS TEXT) GLOB '*[^a-z0-9._-]*'
    )
    OR EXISTS (
        SELECT 1
        FROM json_each(NEW.action_keys_json) AS current
        JOIN json_each(NEW.action_keys_json) AS previous
          ON previous.key = current.key - 1
        WHERE CAST(current.value AS TEXT) <= CAST(previous.value AS TEXT)
    )
BEGIN
	SELECT RAISE(ABORT, 'worker_instances action keys must be canonical');
END;
--> statement-breakpoint
CREATE TRIGGER worker_instances_reject_identity_update
BEFORE UPDATE OF id, release_id, pid, capacity, started_at, action_keys_json ON worker_instances
BEGIN
	SELECT RAISE(ABORT, 'worker_instances identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER worker_instances_validate_lifecycle_update
BEFORE UPDATE ON worker_instances
WHEN NEW.heartbeat_at < OLD.heartbeat_at
    OR NOT (
        (OLD.state = 'online' AND NEW.state IN ('online', 'draining'))
        OR (OLD.state = 'draining' AND NEW.state IN ('draining', 'stopped'))
        OR (OLD.state = 'stopped' AND NEW.state = 'stopped')
    )
    OR (OLD.draining_at IS NOT NULL AND NEW.draining_at IS NOT OLD.draining_at)
    OR (OLD.stopped_at IS NOT NULL AND NEW.stopped_at IS NOT OLD.stopped_at)
    OR (
        OLD.state = 'stopped'
        AND (
            NEW.heartbeat_at IS NOT OLD.heartbeat_at
            OR NEW.draining_at IS NOT OLD.draining_at
            OR NEW.stopped_at IS NOT OLD.stopped_at
        )
    )
BEGIN
	SELECT RAISE(ABORT, 'worker_instances lifecycle transition is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER worker_instances_reject_active_delete
BEFORE DELETE ON worker_instances
WHEN OLD.state <> 'stopped'
BEGIN
	SELECT RAISE(ABORT, 'active worker_instances cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER job_worker_control_reject_replace
BEFORE INSERT ON job_worker_control
WHEN EXISTS (SELECT 1 FROM job_worker_control WHERE id = 1)
BEGIN
	SELECT RAISE(ABORT, 'job_worker_control singleton already exists');
END;
--> statement-breakpoint
CREATE TRIGGER job_worker_control_validate_update
BEFORE UPDATE ON job_worker_control
WHEN NEW.id <> OLD.id
    OR NEW.updated_at < OLD.updated_at
    OR NEW.version <> OLD.version + 1
    OR NEW.updated_by_kind IS NULL
    OR NEW.updated_by_id IS NULL
BEGIN
	SELECT RAISE(ABORT, 'job_worker_control transition is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER job_worker_control_reject_delete
BEFORE DELETE ON job_worker_control
BEGIN
	SELECT RAISE(ABORT, 'job_worker_control singleton cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER job_runs_validate_resource_keys_insert
BEFORE INSERT ON job_runs
WHEN json_array_length(NEW.resource_keys_json) > 32
    OR EXISTS (
        SELECT 1
        FROM json_each(NEW.resource_keys_json) AS entry
        WHERE entry.type <> 'text'
           OR length(CAST(entry.value AS TEXT)) NOT BETWEEN 1 AND 128
           OR CAST(entry.value AS TEXT) <> lower(CAST(entry.value AS TEXT))
           OR substr(CAST(entry.value AS TEXT), 1, 1) NOT GLOB '[a-z0-9]'
           OR CAST(entry.value AS TEXT) GLOB '*[^a-z0-9._-]*'
    )
    OR EXISTS (
        SELECT 1
        FROM json_each(NEW.resource_keys_json) AS current
        JOIN json_each(NEW.resource_keys_json) AS previous
          ON previous.key = current.key - 1
        WHERE CAST(current.value AS TEXT) <= CAST(previous.value AS TEXT)
    )
BEGIN
	SELECT RAISE(ABORT, 'job_runs resource keys must be canonical');
END;
--> statement-breakpoint
CREATE TRIGGER job_runs_reject_replace
BEFORE INSERT ON job_runs
WHEN EXISTS (
    SELECT 1
    FROM job_runs
    WHERE id = NEW.id
       OR (
           requested_by_kind = NEW.requested_by_kind
           AND requested_by_id = NEW.requested_by_id
           AND idempotency_key = NEW.idempotency_key
       )
)
BEGIN
	SELECT RAISE(ABORT, 'job_runs identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER job_runs_reject_snapshot_update
BEFORE UPDATE OF
    id, scheduled_job_id, scheduled_job_version, action_key, display_name,
    trigger_type, requested_by_kind, requested_by_id, idempotency_key,
    enqueue_sha256, payload_json, resource_class, resource_keys_json,
    priority, timeout_ms, attempt_limit, retry_safe, cancellation_policy,
    queued_at, scheduled_for_at
ON job_runs
WHEN NOT (
    OLD.action_key = 'delivery.production.v1'
    AND OLD.state IN ('cancelled', 'failed', 'timed-out')
    AND OLD.required_worker_release_id IS NULL
    AND NEW.required_worker_release_id IS NULL
    AND OLD.retry_safe = 1
    AND NEW.retry_safe = 1
    AND OLD.trigger_type = 'manual'
    AND NEW.trigger_type = 'manual'
    AND OLD.scheduled_job_id IS NULL
    AND NEW.scheduled_job_id IS NULL
    AND OLD.scheduled_job_version IS NULL
    AND NEW.scheduled_job_version IS NULL
    AND NEW.state = 'queued'
    AND NEW.attempt_count = OLD.attempt_count
    AND NEW.attempt_limit = CASE
        WHEN OLD.attempt_count >= OLD.attempt_limit THEN OLD.attempt_count + 1
        ELSE OLD.attempt_limit
    END
    AND NEW.id IS OLD.id
    AND NEW.action_key IS OLD.action_key
    AND NEW.display_name IS OLD.display_name
    AND NEW.requested_by_kind IS OLD.requested_by_kind
    AND NEW.requested_by_id IS OLD.requested_by_id
    AND NEW.idempotency_key IS OLD.idempotency_key
    AND NEW.enqueue_sha256 IS OLD.enqueue_sha256
    AND NEW.payload_json IS OLD.payload_json
    AND NEW.resource_class IS OLD.resource_class
    AND NEW.resource_keys_json IS OLD.resource_keys_json
    AND NEW.priority IS OLD.priority
    AND NEW.timeout_ms IS OLD.timeout_ms
    AND NEW.cancellation_policy IS OLD.cancellation_policy
    AND NEW.queued_at IS OLD.queued_at
    AND NEW.scheduled_for_at IS OLD.scheduled_for_at
)
BEGIN
	SELECT RAISE(ABORT, 'job_runs execution snapshot is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER job_runs_validate_lifecycle_update
BEFORE UPDATE ON job_runs
WHEN NOT (
        OLD.action_key = 'delivery.production.v1'
        AND OLD.state IN ('cancelled', 'failed', 'timed-out')
        AND OLD.required_worker_release_id IS NULL
        AND NEW.required_worker_release_id IS NULL
        AND OLD.retry_safe = 1
        AND NEW.retry_safe = 1
        AND OLD.trigger_type = 'manual'
        AND NEW.trigger_type = 'manual'
        AND OLD.scheduled_job_id IS NULL
        AND NEW.scheduled_job_id IS NULL
        AND OLD.scheduled_job_version IS NULL
        AND NEW.scheduled_job_version IS NULL
        AND NEW.state = 'queued'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.attempt_limit = CASE
            WHEN OLD.attempt_count >= OLD.attempt_limit THEN OLD.attempt_count + 1
            ELSE OLD.attempt_limit
        END
        AND NEW.attempt_count < NEW.attempt_limit
        AND NEW.available_at = NEW.updated_at
        AND NEW.available_at >= OLD.updated_at
        AND NEW.cancel_requested_at IS NULL
        AND NEW.cancel_requested_by_kind IS NULL
        AND NEW.cancel_requested_by_id IS NULL
        AND NEW.finished_at IS NULL
        AND NEW.first_started_at IS OLD.first_started_at
        AND NEW.heartbeat_at IS NULL
        AND NEW.last_attempt_started_at IS OLD.last_attempt_started_at
        AND NEW.lease_expires_at IS NULL
        AND NEW.lease_owner_id IS NULL
        AND NEW.lease_token IS NULL
        AND NEW.result_json IS NULL
        AND NEW.state_version = OLD.state_version + 1
        AND NEW.terminal_code IS NULL
        AND NEW.terminal_message IS NULL
        AND NEW.event_count = OLD.event_count
        AND NEW.payload_event_count = OLD.payload_event_count
        AND NEW.event_bytes = OLD.event_bytes
    )
AND (
    (
        OLD.state IN ('cancelled', 'failed', 'succeeded', 'timed-out')
        AND (
            NEW.state IS NOT OLD.state
            OR NEW.attempt_count IS NOT OLD.attempt_count
            OR NEW.available_at IS NOT OLD.available_at
            OR NEW.cancel_requested_at IS NOT OLD.cancel_requested_at
            OR NEW.cancel_requested_by_kind IS NOT OLD.cancel_requested_by_kind
            OR NEW.cancel_requested_by_id IS NOT OLD.cancel_requested_by_id
            OR NEW.finished_at IS NOT OLD.finished_at
            OR NEW.first_started_at IS NOT OLD.first_started_at
            OR NEW.heartbeat_at IS NOT OLD.heartbeat_at
            OR NEW.last_attempt_started_at IS NOT OLD.last_attempt_started_at
            OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
            OR NEW.lease_owner_id IS NOT OLD.lease_owner_id
            OR NEW.lease_token IS NOT OLD.lease_token
            OR NEW.result_json IS NOT OLD.result_json
            OR NEW.state_version IS NOT OLD.state_version
            OR NEW.terminal_code IS NOT OLD.terminal_code
            OR NEW.terminal_message IS NOT OLD.terminal_message
            OR NEW.updated_at IS NOT OLD.updated_at
        )
    )
    OR NEW.updated_at < OLD.updated_at
    OR NEW.attempt_count < OLD.attempt_count
    OR NEW.attempt_count > OLD.attempt_count + 1
    OR (
        OLD.state = 'queued'
        AND NEW.state = 'running'
        AND NEW.attempt_count <> OLD.attempt_count + 1
    )
    OR (
        NOT (
            OLD.state = 'queued'
            AND NEW.state = 'running'
        )
        AND NEW.attempt_count <> OLD.attempt_count
    )
    OR (
        OLD.state = 'queued'
        AND NEW.state NOT IN ('queued', 'running', 'cancelled')
        AND NOT (
            NEW.state = 'failed'
            AND OLD.cancellation_policy = 'never'
            AND OLD.trigger_type = 'schedule'
            AND NEW.terminal_code = 'action-unavailable'
            AND NEW.terminal_message = 'The scheduled action is no longer available'
            AND EXISTS (
                SELECT 1
                FROM scheduled_jobs AS schedule
                WHERE schedule.id = OLD.scheduled_job_id
                  AND schedule.enabled = 0
            )
        )
    )
    OR (
        OLD.state = 'running'
        AND NEW.state NOT IN (
            'running', 'queued', 'succeeded', 'failed', 'cancelled', 'timed-out'
        )
    )
    OR (
        OLD.state = 'running'
        AND NEW.state = 'queued'
        AND (
            OLD.retry_safe <> 1
            OR OLD.attempt_count >= OLD.attempt_limit
            OR OLD.cancel_requested_at IS NOT NULL
        )
    )
    OR (
        NEW.state = 'cancelled'
        AND (
            OLD.cancellation_policy = 'never'
            OR (
                OLD.state = 'running'
                AND OLD.cancellation_policy <> 'cooperative'
            )
        )
    )
    OR (
        OLD.cancel_requested_at IS NOT NULL
        AND (
            NEW.cancel_requested_at IS NOT OLD.cancel_requested_at
            OR NEW.cancel_requested_by_kind IS NOT OLD.cancel_requested_by_kind
            OR NEW.cancel_requested_by_id IS NOT OLD.cancel_requested_by_id
        )
    )
    OR (
        OLD.state = 'running'
        AND OLD.cancel_requested_at IS NULL
        AND NEW.cancel_requested_at IS NOT NULL
        AND OLD.cancellation_policy <> 'cooperative'
    )
    OR (
        OLD.first_started_at IS NOT NULL
        AND NEW.first_started_at IS NOT OLD.first_started_at
    )
    OR (
        OLD.last_attempt_started_at IS NOT NULL
        AND NEW.last_attempt_started_at < OLD.last_attempt_started_at
    )
    OR NEW.event_count < OLD.event_count
    OR NEW.event_count > OLD.event_count + 1
    OR NEW.payload_event_count < OLD.payload_event_count
    OR NEW.payload_event_count > OLD.payload_event_count + 1
    OR NEW.event_bytes < OLD.event_bytes
    OR (
        (
            NEW.state IS NOT OLD.state
            OR NEW.cancel_requested_at IS NOT OLD.cancel_requested_at
            OR NEW.cancel_requested_by_kind IS NOT OLD.cancel_requested_by_kind
            OR NEW.cancel_requested_by_id IS NOT OLD.cancel_requested_by_id
        )
        AND NEW.state_version <> OLD.state_version + 1
    )
    OR (
        NEW.state IS OLD.state
        AND NEW.cancel_requested_at IS OLD.cancel_requested_at
        AND NEW.cancel_requested_by_kind IS OLD.cancel_requested_by_kind
        AND NEW.cancel_requested_by_id IS OLD.cancel_requested_by_id
        AND NEW.state_version <> OLD.state_version
    )
)
BEGIN
	SELECT RAISE(ABORT, 'job_runs lifecycle transition is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER job_runs_reject_delete
BEFORE DELETE ON job_runs
BEGIN
	SELECT RAISE(ABORT, 'job_runs history cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER resource_leases_validate_insert
BEFORE INSERT ON resource_leases
WHEN NOT EXISTS (
    SELECT 1
    FROM job_runs AS run
    JOIN worker_instances AS worker
      ON worker.id = NEW.worker_instance_id
    WHERE run.id = NEW.job_run_id
      AND run.state = 'running'
      AND run.lease_owner_id = NEW.worker_instance_id
      AND run.lease_token = NEW.lease_token
      AND run.lease_expires_at = NEW.expires_at
      AND worker.state = 'online'
      AND EXISTS (
          SELECT 1
          FROM json_each(run.resource_keys_json) AS resource
          WHERE resource.value = NEW.resource_key
      )
)
BEGIN
	SELECT RAISE(ABORT, 'resource_leases must match one active fenced claim');
END;
--> statement-breakpoint
CREATE TRIGGER resource_leases_reject_identity_update
BEFORE UPDATE OF
    resource_key, job_run_id, worker_instance_id, lease_token, acquired_at
ON resource_leases
BEGIN
	SELECT RAISE(ABORT, 'resource_leases identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER resource_leases_validate_renewal_update
BEFORE UPDATE ON resource_leases
WHEN NEW.renewed_at < OLD.renewed_at
    OR NEW.expires_at <= OLD.expires_at
    OR NOT EXISTS (
        SELECT 1
        FROM job_runs AS run
        WHERE run.id = OLD.job_run_id
          AND run.state = 'running'
          AND run.lease_owner_id = OLD.worker_instance_id
          AND run.lease_token = OLD.lease_token
          AND run.lease_expires_at = NEW.expires_at
    )
BEGIN
	SELECT RAISE(ABORT, 'resource_leases renewal is not fenced');
END;
--> statement-breakpoint
CREATE TRIGGER job_run_events_validate_insert
BEFORE INSERT ON job_run_events
WHEN NOT EXISTS (
    SELECT 1
    FROM job_runs AS run
    WHERE run.id = NEW.job_run_id
      AND run.event_count < 1000
      AND NEW.sequence = run.event_count + 1
      AND run.event_count = (
          SELECT count(*)
          FROM job_run_events AS existing
          WHERE existing.job_run_id = NEW.job_run_id
      )
      AND NEW.attempt <= run.attempt_count
      AND (
          NEW.kind IN ('cancel-requested', 'cancelled', 'queued')
          OR NEW.attempt > 0
          OR (
              NEW.kind = 'failed'
              AND NEW.attempt = 0
              AND NEW.worker_instance_id IS NULL
              AND run.state = 'failed'
              AND run.attempt_count = 0
              AND run.cancellation_policy = 'never'
              AND run.trigger_type = 'schedule'
              AND run.terminal_code = 'action-unavailable'
              AND NEW.message = 'The scheduled action is no longer available'
          )
      )
      AND (
          NEW.kind <> 'queued'
          OR NEW.worker_instance_id IS NULL
      )
      AND NEW.occurred_at BETWEEN run.queued_at AND run.updated_at
      AND (
          run.event_count = 0
          OR NEW.occurred_at >= (
              SELECT previous.occurred_at
              FROM job_run_events AS previous
              WHERE previous.job_run_id = NEW.job_run_id
              ORDER BY previous.sequence DESC
              LIMIT 1
          )
      )
      AND (
          (run.event_count = 0 AND NEW.kind = 'queued' AND NEW.attempt = 0)
          OR (run.event_count > 0 AND NEW.kind <> 'queued')
      )
      AND (
          NEW.kind NOT IN ('progress', 'stderr', 'stdout')
          OR run.payload_event_count < 967
      )
      AND (
          NEW.kind NOT IN ('progress', 'stderr', 'stdout')
          OR run.event_bytes
              + length(CAST(COALESCE(NEW.message, '') AS BLOB))
              + length(CAST(COALESCE(NEW.progress_json, '') AS BLOB))
              <= 1007616
      )
      AND run.event_bytes
          + length(CAST(COALESCE(NEW.message, '') AS BLOB))
          + length(CAST(COALESCE(NEW.progress_json, '') AS BLOB))
          <= 1048576
      AND (
          NEW.kind <> 'claimed'
          OR (
              run.state = 'running'
              AND NEW.attempt = run.attempt_count
          )
      )
      AND (
          NEW.kind NOT IN ('progress', 'stderr', 'stdout', 'output-truncated')
          OR run.state = 'running'
      )
      AND (
          NEW.kind <> 'retry-scheduled'
          OR run.state = 'queued'
      )
      AND (
          NEW.kind <> 'cancel-requested'
          OR run.cancel_requested_at IS NOT NULL
      )
      AND (
          NEW.kind <> 'cancelled'
          OR run.state = 'cancelled'
      )
      AND (
          NEW.kind <> 'succeeded'
          OR run.state = 'succeeded'
      )
      AND (
          NEW.kind <> 'failed'
          OR run.state IN ('running', 'failed')
      )
      AND (
          NEW.kind <> 'timed-out'
          OR run.state = 'timed-out'
      )
)
BEGIN
	SELECT RAISE(ABORT, 'job_run_events must follow the parent run lifecycle');
END;
--> statement-breakpoint
CREATE TRIGGER job_run_events_reject_replace
BEFORE INSERT ON job_run_events
WHEN EXISTS (
    SELECT 1
    FROM job_run_events
    WHERE job_run_id = NEW.job_run_id
      AND sequence = NEW.sequence
)
BEGIN
	SELECT RAISE(ABORT, 'job_run_events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER job_run_events_update_parent_counters
AFTER INSERT ON job_run_events
BEGIN
	UPDATE job_runs
	SET event_count = event_count + 1,
	    payload_event_count = payload_event_count
	        + CASE
	              WHEN NEW.kind IN ('progress', 'stderr', 'stdout') THEN 1
	              ELSE 0
	          END,
	    event_bytes = event_bytes
	        + length(CAST(COALESCE(NEW.message, '') AS BLOB))
	        + length(CAST(COALESCE(NEW.progress_json, '') AS BLOB))
	WHERE id = NEW.job_run_id;
END;
--> statement-breakpoint
CREATE TRIGGER job_run_events_reject_update
BEFORE UPDATE ON job_run_events
BEGIN
	SELECT RAISE(ABORT, 'job_run_events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER job_run_events_reject_delete
BEFORE DELETE ON job_run_events
BEGIN
	SELECT RAISE(ABORT, 'job_run_events are append-only');
END;
--> statement-breakpoint
CREATE UNIQUE INDEX `incident_observations_run_incident_unique` ON `incident_observations` (`monitor_run_id`,`incident_id`);--> statement-breakpoint
CREATE INDEX `incident_observations_incident_observed_id_idx` ON `incident_observations` (`incident_id`,`observed_at`,`id`);--> statement-breakpoint
CREATE INDEX `incident_observations_run_idx` ON `incident_observations` (`monitor_run_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `incidents_monitor_fingerprint_unique` ON `incidents` (`monitor_key`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `incidents_active_monitor_seen_idx` ON `incidents` (`monitor_key`,`last_seen_at`) WHERE "incidents"."state" = 'active';--> statement-breakpoint
CREATE INDEX `incidents_last_seen_id_idx` ON `incidents` (`last_seen_at`,`id`);--> statement-breakpoint
CREATE INDEX `monitor_runs_monitor_completed_id_idx` ON `monitor_runs` (`monitor_key`,`completed_at`,`id`) WHERE "monitor_runs"."complete_snapshot" = 1 AND "monitor_runs"."state" = 'succeeded';--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_incident_generation_channel_unique` ON `notifications` (`incident_id`,`incident_generation`,`channel`) WHERE "notifications"."incident_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `notifications_unread_occurred_idx` ON `notifications` (`occurred_at`) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX `notifications_report_id_idx` ON `notifications` (`report_id`);--> statement-breakpoint
CREATE INDEX `notifications_occurred_id_idx` ON `notifications` (`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `realtime_events_expires_id_idx` ON `realtime_events` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `realtime_events_topic_id_idx` ON `realtime_events` (`topic`,`id`);--> statement-breakpoint
CREATE INDEX `reports_occurred_id_idx` ON `reports` (`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `reports_kind_occurred_id_idx` ON `reports` (`kind`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `reports_source_job_occurred_id_idx` ON `reports` (`source`,`source_job_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_recovery_codes_user_selector_unique` ON `user_recovery_codes` (`user_id`,`selector`);--> statement-breakpoint
CREATE INDEX `user_recovery_codes_user_used_created_idx` ON `user_recovery_codes` (`user_id`,`used_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `user_totp_factors_pending_user_expiry_idx` ON `user_totp_factors` (`user_id`,`enrollment_expires_at`,`id`) WHERE ("user_totp_factors"."confirmed_at" is null);--> statement-breakpoint
CREATE INDEX `user_totp_factors_confirmed_user_created_idx` ON `user_totp_factors` (`user_id`,`created_at`,`id`) WHERE ("user_totp_factors"."confirmed_at" is not null);--> statement-breakpoint
CREATE INDEX `user_totp_factors_pending_expiry_idx` ON `user_totp_factors` (`enrollment_expires_at`,`id`) WHERE ("user_totp_factors"."confirmed_at" is null);--> statement-breakpoint
CREATE UNIQUE INDEX `user_webauthn_credentials_credential_id_unique` ON `user_webauthn_credentials` (`credential_id`);--> statement-breakpoint
CREATE INDEX `user_webauthn_credentials_user_created_idx` ON `user_webauthn_credentials` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TRIGGER reports_validate_metadata_insert
BEFORE INSERT ON reports
WHEN CASE WHEN json_valid(NEW.metadata_json) THEN EXISTS (
	WITH RECURSIVE
	metadata_tree(id, parent, type, atom) AS (
		SELECT id, parent, type, atom FROM json_tree(NEW.metadata_json)
	),
	metadata_depth(id, type, atom, depth) AS (
		SELECT id, type, atom, 0 FROM metadata_tree WHERE parent IS NULL
		UNION ALL
		SELECT child.id, child.type, child.atom, parent.depth + 1
		FROM metadata_tree AS child
		JOIN metadata_depth AS parent ON child.parent = parent.id
	)
	SELECT 1
	FROM metadata_depth
	WHERE (type IN ('object', 'array') AND depth > 12)
		OR (type IN ('integer', 'real') AND (atom > 9007199254740991 OR atom < -9007199254740991))
) ELSE 0 END
BEGIN
	SELECT RAISE(ABORT, 'reports metadata must be bounded monitoring JSON');
END;
--> statement-breakpoint
CREATE TRIGGER reports_validate_metadata_update
BEFORE UPDATE OF metadata_json ON reports
WHEN CASE WHEN json_valid(NEW.metadata_json) THEN EXISTS (
	WITH RECURSIVE
	metadata_tree(id, parent, type, atom) AS (
		SELECT id, parent, type, atom FROM json_tree(NEW.metadata_json)
	),
	metadata_depth(id, type, atom, depth) AS (
		SELECT id, type, atom, 0 FROM metadata_tree WHERE parent IS NULL
		UNION ALL
		SELECT child.id, child.type, child.atom, parent.depth + 1
		FROM metadata_tree AS child
		JOIN metadata_depth AS parent ON child.parent = parent.id
	)
	SELECT 1
	FROM metadata_depth
	WHERE (type IN ('object', 'array') AND depth > 12)
		OR (type IN ('integer', 'real') AND (atom > 9007199254740991 OR atom < -9007199254740991))
) ELSE 0 END
BEGIN
	SELECT RAISE(ABORT, 'reports metadata must be bounded monitoring JSON');
END;
--> statement-breakpoint
CREATE TRIGGER incidents_validate_details_insert
BEFORE INSERT ON incidents
WHEN CASE WHEN json_valid(NEW.details_json) THEN EXISTS (
	WITH RECURSIVE
	metadata_tree(id, parent, type, atom) AS (
		SELECT id, parent, type, atom FROM json_tree(NEW.details_json)
	),
	metadata_depth(id, type, atom, depth) AS (
		SELECT id, type, atom, 0 FROM metadata_tree WHERE parent IS NULL
		UNION ALL
		SELECT child.id, child.type, child.atom, parent.depth + 1
		FROM metadata_tree AS child
		JOIN metadata_depth AS parent ON child.parent = parent.id
	)
	SELECT 1
	FROM metadata_depth
	WHERE (type IN ('object', 'array') AND depth > 12)
		OR (type IN ('integer', 'real') AND (atom > 9007199254740991 OR atom < -9007199254740991))
) ELSE 0 END
BEGIN
	SELECT RAISE(ABORT, 'incidents details must be bounded monitoring JSON');
END;
--> statement-breakpoint
CREATE TRIGGER incidents_validate_details_update
BEFORE UPDATE OF details_json ON incidents
WHEN CASE WHEN json_valid(NEW.details_json) THEN EXISTS (
	WITH RECURSIVE
	metadata_tree(id, parent, type, atom) AS (
		SELECT id, parent, type, atom FROM json_tree(NEW.details_json)
	),
	metadata_depth(id, type, atom, depth) AS (
		SELECT id, type, atom, 0 FROM metadata_tree WHERE parent IS NULL
		UNION ALL
		SELECT child.id, child.type, child.atom, parent.depth + 1
		FROM metadata_tree AS child
		JOIN metadata_depth AS parent ON child.parent = parent.id
	)
	SELECT 1
	FROM metadata_depth
	WHERE (type IN ('object', 'array') AND depth > 12)
		OR (type IN ('integer', 'real') AND (atom > 9007199254740991 OR atom < -9007199254740991))
) ELSE 0 END
BEGIN
	SELECT RAISE(ABORT, 'incidents details must be bounded monitoring JSON');
END;
--> statement-breakpoint
CREATE TRIGGER incident_observations_validate_details_insert
BEFORE INSERT ON incident_observations
WHEN CASE WHEN json_valid(NEW.details_json) THEN EXISTS (
	WITH RECURSIVE
	metadata_tree(id, parent, type, atom) AS (
		SELECT id, parent, type, atom FROM json_tree(NEW.details_json)
	),
	metadata_depth(id, type, atom, depth) AS (
		SELECT id, type, atom, 0 FROM metadata_tree WHERE parent IS NULL
		UNION ALL
		SELECT child.id, child.type, child.atom, parent.depth + 1
		FROM metadata_tree AS child
		JOIN metadata_depth AS parent ON child.parent = parent.id
	)
	SELECT 1
	FROM metadata_depth
	WHERE (type IN ('object', 'array') AND depth > 12)
		OR (type IN ('integer', 'real') AND (atom > 9007199254740991 OR atom < -9007199254740991))
) ELSE 0 END
BEGIN
	SELECT RAISE(ABORT, 'incident observations details must be bounded monitoring JSON');
END;
--> statement-breakpoint
CREATE TRIGGER incident_observations_validate_details_update
BEFORE UPDATE OF details_json ON incident_observations
WHEN CASE WHEN json_valid(NEW.details_json) THEN EXISTS (
	WITH RECURSIVE
	metadata_tree(id, parent, type, atom) AS (
		SELECT id, parent, type, atom FROM json_tree(NEW.details_json)
	),
	metadata_depth(id, type, atom, depth) AS (
		SELECT id, type, atom, 0 FROM metadata_tree WHERE parent IS NULL
		UNION ALL
		SELECT child.id, child.type, child.atom, parent.depth + 1
		FROM metadata_tree AS child
		JOIN metadata_depth AS parent ON child.parent = parent.id
	)
	SELECT 1
	FROM metadata_depth
	WHERE (type IN ('object', 'array') AND depth > 12)
		OR (type IN ('integer', 'real') AND (atom > 9007199254740991 OR atom < -9007199254740991))
) ELSE 0 END
BEGIN
	SELECT RAISE(ABORT, 'incident observations details must be bounded monitoring JSON');
END;
--> statement-breakpoint
CREATE TRIGGER audit_events_validate_metadata
BEFORE INSERT ON audit_events
WHEN EXISTS (
	WITH RECURSIVE
	metadata_tree(id, parent, key, type, atom) AS (
		SELECT id, parent, key, type, atom FROM json_tree(NEW.metadata_json)
	),
	metadata_depth(id, type, atom, depth) AS (
		SELECT id, type, atom, 0 FROM metadata_tree WHERE parent IS NULL
		UNION ALL
		SELECT child.id, child.type, child.atom, parent.depth + 1
		FROM metadata_tree AS child
		JOIN metadata_depth AS parent ON child.parent = parent.id
	)
	SELECT 1
	FROM metadata_depth
	WHERE (type IN ('object', 'array') AND depth > 12)
		OR (type IN ('integer', 'real') AND (atom > 9007199254740991 OR atom < -9007199254740991))
	UNION ALL
	SELECT 1
	FROM metadata_tree AS member
	JOIN metadata_tree AS parent ON parent.id = member.parent
	WHERE parent.type = 'object'
	GROUP BY member.parent, member.key
	HAVING count(*) > 1
)
BEGIN
	SELECT RAISE(ABORT, 'audit_events metadata must be a bounded JSON object');
END;
--> statement-breakpoint
CREATE TRIGGER audit_events_reject_replace
BEFORE INSERT ON audit_events
WHEN EXISTS (SELECT 1 FROM audit_events WHERE id = NEW.id)
BEGIN
	SELECT RAISE(ABORT, 'audit_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER audit_events_reject_update
BEFORE UPDATE ON audit_events
BEGIN
	SELECT RAISE(ABORT, 'audit_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER audit_events_reject_delete
BEFORE DELETE ON audit_events
BEGIN
	SELECT RAISE(ABORT, 'audit_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER schema_migrations_reject_replace
BEFORE INSERT ON schema_migrations
WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE id = NEW.id)
BEGIN
	SELECT RAISE(ABORT, 'schema_migrations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER schema_migrations_reject_update
BEFORE UPDATE ON schema_migrations
BEGIN
	SELECT RAISE(ABORT, 'schema_migrations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER schema_migrations_reject_delete
BEFORE DELETE ON schema_migrations
BEGIN
	SELECT RAISE(ABORT, 'schema_migrations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER task_events_validate_payload
BEFORE INSERT ON task_events
WHEN EXISTS (
	WITH RECURSIVE
	payload_tree(id, parent, key, type, atom) AS (
		SELECT id, parent, key, type, atom FROM json_tree(NEW.payload_json)
	),
	payload_depth(id, type, atom, depth) AS (
		SELECT id, type, atom, 0 FROM payload_tree WHERE parent IS NULL
		UNION ALL
		SELECT child.id, child.type, child.atom, parent.depth + 1
		FROM payload_tree AS child
		JOIN payload_depth AS parent ON child.parent = parent.id
	)
	SELECT 1
	FROM payload_depth
	WHERE (type IN ('object', 'array') AND depth > 12)
		OR (type IN ('integer', 'real') AND (atom > 9007199254740991 OR atom < -9007199254740991))
	UNION ALL
	SELECT 1
	FROM payload_tree AS member
	JOIN payload_tree AS parent ON parent.id = member.parent
	WHERE parent.type = 'object'
	GROUP BY member.parent, member.key
	HAVING count(*) > 1
)
BEGIN
	SELECT RAISE(ABORT, 'task_events payload must be a bounded JSON object');
END;
--> statement-breakpoint
CREATE TRIGGER task_events_reject_replace
BEFORE INSERT ON task_events
WHEN EXISTS (SELECT 1 FROM task_events WHERE id = NEW.id)
BEGIN
	SELECT RAISE(ABORT, 'task_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER task_events_reject_update
BEFORE UPDATE ON task_events
BEGIN
	SELECT RAISE(ABORT, 'task_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER task_events_reject_delete
BEFORE DELETE ON task_events
BEGIN
	SELECT RAISE(ABORT, 'task_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER host_restart_claim_fence_validate_insert
BEFORE INSERT ON host_restart_claim_fence
WHEN NOT EXISTS (
	SELECT 1
	FROM job_runs
	WHERE id = NEW.job_run_id
		AND action_key = 'host.system.restart'
		AND payload_json = '{}'
		AND state = 'running'
		AND lease_owner_id = NEW.worker_instance_id
		AND lease_token = NEW.lease_token
		AND lease_expires_at > NEW.armed_at
)
	OR EXISTS (
		SELECT 1
		FROM job_runs
		WHERE state = 'running' AND id <> NEW.job_run_id
	)
BEGIN
	SELECT RAISE(ABORT, 'host restart fence requires the only running exact restart claim');
END;
--> statement-breakpoint
CREATE TRIGGER host_restart_claim_fence_reject_update
BEFORE UPDATE ON host_restart_claim_fence
BEGIN
	SELECT RAISE(ABORT, 'host restart claim fence is immutable');
END;

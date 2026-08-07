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
	CONSTRAINT "automation_credentials_label_check" CHECK(length("label") BETWEEN 1 AND 128 AND instr("label", char(0)) = 0 AND length(trim("label", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "label" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
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
	CONSTRAINT "automation_principal_capabilities_capability_check" CHECK("capability" IN ('notifications:read', 'reports:read')),
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
	CONSTRAINT "automation_principals_label_check" CHECK(length("label") BETWEEN 1 AND 128 AND instr("label", char(0)) = 0 AND length(trim("label", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "label" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "automation_principals_time_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" >= "created_at" AND ("disabled_at" IS NULL OR ("disabled_at" BETWEEN 0 AND 8640000000000000 AND "disabled_at" >= "created_at" AND "disabled_at" <= "updated_at")))
) STRICT;
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
	`severity` text NOT NULL,
	`title` text NOT NULL,
	CONSTRAINT `fk_notifications_incident_id_incidents_id_fk` FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON DELETE RESTRICT,
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
	`title` text NOT NULL,
	CONSTRAINT "reports_metadata_json_check" CHECK(CASE WHEN json_valid("metadata_json") THEN json_type("metadata_json") = 'object' ELSE 0 END)
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
	CONSTRAINT "user_totp_factors_label_check" CHECK(length("label") BETWEEN 1 AND 128 AND instr("label", char(0)) = 0 AND length(trim("label", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "label" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
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
	CONSTRAINT "user_webauthn_credentials_label_check" CHECK(length("label") BETWEEN 1 AND 128 AND instr("label", char(0)) = 0 AND length(trim("label", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "label" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
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
	CONSTRAINT "task_automation_profiles_cron_job_id_check" CHECK(length("cron_job_id") BETWEEN 1 AND 200 AND instr("cron_job_id", char(0)) = 0 AND length(trim("cron_job_id", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "cron_job_id" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
	CONSTRAINT "task_automation_profiles_kind_check" CHECK("kind" = 'openclaw-cron'),
	CONSTRAINT "task_automation_profiles_model_check" CHECK("model" IS NULL OR (length("model") BETWEEN 1 AND 200 AND instr("model", char(0)) = 0 AND length(trim("model", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "model" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*'))),
	CONSTRAINT "task_automation_profiles_recurring_check" CHECK("recurring" IN (0, 1)),
	CONSTRAINT "task_automation_profiles_schedule_summary_check" CHECK("schedule_summary" IS NULL OR (length("schedule_summary") BETWEEN 1 AND 500 AND instr("schedule_summary", char(0)) = 0 AND length(trim("schedule_summary", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "schedule_summary" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*'))),
	CONSTRAINT "task_automation_profiles_session_target_check" CHECK("session_target" IS NULL OR (length("session_target") BETWEEN 1 AND 200 AND instr("session_target", char(0)) = 0 AND length(trim("session_target", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "session_target" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*'))),
	CONSTRAINT "task_automation_profiles_task_id_check" CHECK(length("task_id") = 36 AND instr("task_id", char(0)) = 0 AND length(replace("task_id", '-', '')) = 32 AND replace("task_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("task_id", 9, 1) = '-' AND substr("task_id", 14, 1) = '-' AND substr("task_id", 15, 1) = '7' AND substr("task_id", 19, 1) = '-' AND substr("task_id", 20, 1) GLOB '[89ab]' AND substr("task_id", 24, 1) = '-'),
	CONSTRAINT "task_automation_profiles_thinking_check" CHECK("thinking" IS NULL OR (length("thinking") BETWEEN 1 AND 200 AND instr("thinking", char(0)) = 0 AND length(trim("thinking", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "thinking" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')))
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
	CONSTRAINT "task_notification_outbox_message_check" CHECK(length("message") BETWEEN 1 AND 2048 AND instr("message", char(0)) = 0 AND length(trim("message", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "message" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*') AND length(CAST("message" AS BLOB)) <= 2048)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `task_labels` (
	`label` text NOT NULL,
	`task_id` text NOT NULL,
	CONSTRAINT `task_labels_pk` PRIMARY KEY(`task_id`, `label`),
	CONSTRAINT `fk_task_labels_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "task_labels_label_check" CHECK(length("label") BETWEEN 1 AND 64 AND instr("label", char(0)) = 0 AND length(trim("label", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "label" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
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
	`id` text PRIMARY KEY NOT NULL,
	`priority` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tasks_assignee_check" CHECK("assignee" IS NULL OR "assignee" IN ('mira-2026', 'rajohan')),
	CONSTRAINT "tasks_body_markdown_check" CHECK("body_markdown" IS NULL OR (length("body_markdown") BETWEEN 1 AND 100000 AND instr("body_markdown", char(0)) = 0 AND length(trim("body_markdown", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0)),
	CONSTRAINT "tasks_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "tasks_priority_check" CHECK("priority" IN ('low', 'medium', 'high')),
	CONSTRAINT "tasks_status_check" CHECK("status" IN ('todo', 'in-progress', 'blocked', 'done')),
	CONSTRAINT "tasks_title_check" CHECK(length("title") BETWEEN 1 AND 240 AND instr("title", char(0)) = 0 AND length(trim("title", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0 AND "title" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')),
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
CREATE UNIQUE INDEX `incident_observations_run_incident_unique` ON `incident_observations` (`monitor_run_id`,`incident_id`);--> statement-breakpoint
CREATE INDEX `incident_observations_incident_observed_id_idx` ON `incident_observations` (`incident_id`,`observed_at`,`id`);--> statement-breakpoint
CREATE INDEX `incident_observations_run_idx` ON `incident_observations` (`monitor_run_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `incidents_monitor_fingerprint_unique` ON `incidents` (`monitor_key`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `incidents_active_monitor_seen_idx` ON `incidents` (`monitor_key`,`last_seen_at`) WHERE "incidents"."state" = 'active';--> statement-breakpoint
CREATE INDEX `monitor_runs_monitor_completed_id_idx` ON `monitor_runs` (`monitor_key`,`completed_at`,`id`) WHERE "monitor_runs"."complete_snapshot" = 1 AND "monitor_runs"."state" = 'succeeded';--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_incident_generation_channel_unique` ON `notifications` (`incident_id`,`incident_generation`,`channel`) WHERE "notifications"."incident_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `notifications_unread_occurred_idx` ON `notifications` (`occurred_at`) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX `realtime_events_expires_id_idx` ON `realtime_events` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `realtime_events_topic_id_idx` ON `realtime_events` (`topic`,`id`);--> statement-breakpoint
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

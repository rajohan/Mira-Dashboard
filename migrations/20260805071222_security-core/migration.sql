CREATE TABLE `users` (
	`authentication_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	`username` text NOT NULL,
	CONSTRAINT "users_authentication_version_check" CHECK("authentication_version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "users_created_at_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" >= "created_at"),
	CONSTRAINT "users_disabled_at_check" CHECK("disabled_at" IS NULL OR ("disabled_at" BETWEEN 0 AND 8640000000000000 AND "disabled_at" >= "created_at" AND "disabled_at" <= "updated_at")),
	CONSTRAINT "users_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "users_password_hash_check" CHECK(length("password_hash") BETWEEN 32 AND 512 AND instr("password_hash", char(0)) = 0 AND substr("password_hash", 1, 10) = '$argon2id$'),
	CONSTRAINT "users_username_check" CHECK(length("username") BETWEEN 3 AND 32 AND instr("username", char(0)) = 0 AND "username" = lower("username") AND substr("username", 1, 1) GLOB '[a-z0-9]' AND "username" NOT GLOB '*[^a-z0-9._-]*')
) STRICT;
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`authenticated_at` integer NOT NULL,
	`authentication_version` integer NOT NULL,
	`auth_method` text NOT NULL,
	`created_at` integer NOT NULL,
	`elevated_at` integer,
	`elevated_method` text,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_seen_at` integer NOT NULL,
	`mfa_verified_at` integer,
	`user_agent` text,
	`user_id` text NOT NULL,
	`validator_hash` text NOT NULL,
	`validator_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_auth_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "auth_sessions_authentication_version_check" CHECK("authentication_version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "auth_sessions_auth_method_check" CHECK("auth_method" IN ('password', 'recovery', 'totp', 'webauthn')),
	CONSTRAINT "auth_sessions_elevated_method_check" CHECK("elevated_method" IS NULL OR "elevated_method" IN ('password', 'recovery', 'totp', 'webauthn')),
	CONSTRAINT "auth_sessions_expiry_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" > "created_at"),
	CONSTRAINT "auth_sessions_authentication_time_check" CHECK("authenticated_at" BETWEEN 0 AND 8640000000000000 AND "authenticated_at" <= "created_at"),
	CONSTRAINT "auth_sessions_last_seen_check" CHECK("last_seen_at" BETWEEN 0 AND 8640000000000000 AND "last_seen_at" >= "created_at" AND "last_seen_at" < "expires_at"),
	CONSTRAINT "auth_sessions_mfa_time_check" CHECK("mfa_verified_at" IS NULL OR ("mfa_verified_at" BETWEEN 0 AND 8640000000000000 AND "mfa_verified_at" >= "authenticated_at" AND "mfa_verified_at" < "expires_at")),
	CONSTRAINT "auth_sessions_elevation_check" CHECK(("elevated_at" IS NULL AND "elevated_method" IS NULL) OR ("elevated_at" IS NOT NULL AND "elevated_method" IS NOT NULL AND "elevated_at" BETWEEN 0 AND 8640000000000000 AND "elevated_at" >= "authenticated_at" AND "elevated_at" < "expires_at")),
	CONSTRAINT "auth_sessions_id_check" CHECK(length("id") = 32 AND instr("id", char(0)) = 0 AND "id" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "auth_sessions_user_agent_check" CHECK("user_agent" IS NULL OR (length("user_agent") BETWEEN 1 AND 512 AND instr("user_agent", char(0)) = 0 AND length(trim("user_agent", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0)),
	CONSTRAINT "auth_sessions_validator_hash_check" CHECK(length("validator_hash") = 64 AND instr("validator_hash", char(0)) = 0 AND "validator_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "auth_sessions_validator_version_check" CHECK("validator_version" = 1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `automation_principals` (
	`authorization_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "automation_principals_authorization_version_check" CHECK("authorization_version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "automation_principals_id_check" CHECK(length("id") BETWEEN 1 AND 64 AND instr("id", char(0)) = 0 AND "id" = lower("id") AND substr("id", 1, 1) GLOB '[a-z0-9]' AND "id" NOT GLOB '*[^a-z0-9._-]*'),
	CONSTRAINT "automation_principals_label_check" CHECK(length("label") BETWEEN 1 AND 128 AND instr("label", char(0)) = 0 AND length(trim("label", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0),
	CONSTRAINT "automation_principals_time_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" BETWEEN 0 AND 8640000000000000 AND "updated_at" >= "created_at" AND ("disabled_at" IS NULL OR ("disabled_at" BETWEEN 0 AND 8640000000000000 AND "disabled_at" >= "created_at" AND "disabled_at" <= "updated_at")))
) STRICT;
--> statement-breakpoint
CREATE TABLE `automation_credentials` (
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`last_used_at` integer,
	`prefix` text NOT NULL,
	`principal_id` text NOT NULL,
	`revoked_at` integer,
	`validator_hash` text NOT NULL,
	`validator_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_automation_credentials_principal_id_automation_principals_id_fk` FOREIGN KEY (`principal_id`) REFERENCES `automation_principals`(`id`) ON DELETE CASCADE,
	CONSTRAINT "automation_credentials_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "automation_credentials_label_check" CHECK(length("label") BETWEEN 1 AND 128 AND instr("label", char(0)) = 0 AND length(trim("label", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0),
	CONSTRAINT "automation_credentials_prefix_check" CHECK(length("prefix") = 32 AND instr("prefix", char(0)) = 0 AND "prefix" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "automation_credentials_validator_hash_check" CHECK(length("validator_hash") = 64 AND instr("validator_hash", char(0)) = 0 AND "validator_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "automation_credentials_validator_version_check" CHECK("validator_version" = 1),
	CONSTRAINT "automation_credentials_time_check" CHECK("created_at" BETWEEN 0 AND 8640000000000000 AND ("expires_at" IS NULL OR ("expires_at" BETWEEN 0 AND 8640000000000000 AND "expires_at" > "created_at")) AND ("revoked_at" IS NULL OR ("revoked_at" BETWEEN 0 AND 8640000000000000 AND "revoked_at" >= "created_at")) AND ("last_used_at" IS NULL OR ("last_used_at" BETWEEN 0 AND 8640000000000000 AND "last_used_at" >= "created_at" AND ("expires_at" IS NULL OR "last_used_at" < "expires_at") AND ("revoked_at" IS NULL OR "last_used_at" <= "revoked_at"))))
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
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expires_at_idx` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_last_seen_idx` ON `auth_sessions` (`user_id`,`last_seen_at`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_validator_hash_unique` ON `auth_sessions` (`validator_hash`);--> statement-breakpoint
CREATE INDEX `automation_credentials_principal_created_idx` ON `automation_credentials` (`principal_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_credentials_prefix_unique` ON `automation_credentials` (`prefix`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_credentials_validator_unique` ON `automation_credentials` (`validator_version`,`validator_hash`);--> statement-breakpoint
CREATE INDEX `audit_events_occurred_id_idx` ON `audit_events` (`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_request_occurred_idx` ON `audit_events` (`request_id`,`occurred_at`,`id`) WHERE "audit_events"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `audit_events_target_occurred_idx` ON `audit_events` (`target_type`,`target_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TRIGGER incidents_reject_nul_fingerprint_insert
BEFORE INSERT ON incidents
WHEN instr(NEW.fingerprint, char(0)) > 0
BEGIN
	SELECT RAISE(ABORT, 'incidents fingerprint must not contain NUL');
END;
--> statement-breakpoint
CREATE TRIGGER incidents_reject_nul_fingerprint_update
BEFORE UPDATE OF fingerprint ON incidents
WHEN instr(NEW.fingerprint, char(0)) > 0
BEGIN
	SELECT RAISE(ABORT, 'incidents fingerprint must not contain NUL');
END;
--> statement-breakpoint
CREATE TRIGGER monitor_runs_reject_nul_submission_sha256_insert
BEFORE INSERT ON monitor_runs
WHEN instr(NEW.submission_sha256, char(0)) > 0
BEGIN
	SELECT RAISE(ABORT, 'monitor_runs submission_sha256 must not contain NUL');
END;
--> statement-breakpoint
CREATE TRIGGER monitor_runs_reject_nul_submission_sha256_update
BEFORE UPDATE OF submission_sha256 ON monitor_runs
WHEN instr(NEW.submission_sha256, char(0)) > 0
BEGIN
	SELECT RAISE(ABORT, 'monitor_runs submission_sha256 must not contain NUL');
END;
--> statement-breakpoint
UPDATE incidents
SET fingerprint = fingerprint
WHERE instr(fingerprint, char(0)) > 0;
--> statement-breakpoint
UPDATE monitor_runs
SET submission_sha256 = submission_sha256
WHERE instr(submission_sha256, char(0)) > 0;
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

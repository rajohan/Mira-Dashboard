CREATE TABLE `incident_observations` (
	`details_json` text DEFAULT '{}' NOT NULL,
	`generation` integer NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`incident_id` text NOT NULL,
	`monitor_run_id` text NOT NULL,
	`observed_at` integer NOT NULL,
	CONSTRAINT `fk_incident_observations_incident_id_incidents_id_fk` FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_incident_observations_monitor_run_id_monitor_runs_id_fk` FOREIGN KEY (`monitor_run_id`) REFERENCES `monitor_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "incident_observations_details_json_check" CHECK(CASE WHEN json_valid("details_json") THEN json_type("details_json") = 'object' ELSE 0 END),
	CONSTRAINT "incident_observations_generation_check" CHECK("generation" >= 1)
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
	CONSTRAINT "incidents_generation_check" CHECK("generation" >= 1),
	CONSTRAINT "incidents_occurrence_count_check" CHECK("occurrence_count" >= 1),
	CONSTRAINT "incidents_severity_check" CHECK("severity" IN ('critical', 'error', 'info', 'warning')),
	CONSTRAINT "incidents_state_check" CHECK("state" IN ('active', 'resolved')),
	CONSTRAINT "incidents_resolution_check" CHECK(("state" = 'active' AND "resolved_at" IS NULL) OR ("state" = 'resolved' AND "resolved_at" IS NOT NULL))
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
	CONSTRAINT `fk_monitor_runs_report_id_reports_id_fk` FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON DELETE SET NULL,
	CONSTRAINT "monitor_runs_complete_snapshot_check" CHECK("complete_snapshot" IN (0, 1)),
	CONSTRAINT "monitor_runs_state_check" CHECK("state" IN ('failed', 'running', 'succeeded')),
	CONSTRAINT "monitor_runs_completion_check" CHECK(("state" = 'running' AND "completed_at" IS NULL) OR ("state" IN ('failed', 'succeeded') AND "completed_at" IS NOT NULL))
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
	CONSTRAINT "notifications_severity_check" CHECK("severity" IN ('critical', 'error', 'info', 'warning'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `realtime_events` (
	`entity_id` text,
	`entity_type` text NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`occurred_at` integer NOT NULL,
	`operation` text NOT NULL,
	`payload_json` text NOT NULL,
	`topic` text NOT NULL,
	CONSTRAINT "realtime_events_payload_json_check" CHECK(json_valid("payload_json")),
	CONSTRAINT "realtime_events_operation_check" CHECK("operation" IN ('created', 'deleted', 'snapshot-required', 'updated'))
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
	`release_id` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `incident_observations_incident_observed_id_idx` ON `incident_observations` (`incident_id`,`observed_at`,`id`);--> statement-breakpoint
CREATE INDEX `incident_observations_run_idx` ON `incident_observations` (`monitor_run_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `incidents_monitor_fingerprint_unique` ON `incidents` (`monitor_key`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `incidents_active_monitor_seen_idx` ON `incidents` (`monitor_key`,`last_seen_at`) WHERE "incidents"."state" = 'active';--> statement-breakpoint
CREATE INDEX `monitor_runs_monitor_started_idx` ON `monitor_runs` (`monitor_key`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_incident_generation_channel_unique` ON `notifications` (`incident_id`,`incident_generation`,`channel`) WHERE "notifications"."incident_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `notifications_unread_occurred_idx` ON `notifications` (`occurred_at`) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX `realtime_events_topic_id_idx` ON `realtime_events` (`topic`,`id`);--> statement-breakpoint
CREATE INDEX `reports_kind_occurred_id_idx` ON `reports` (`kind`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `reports_source_job_occurred_id_idx` ON `reports` (`source`,`source_job_id`,`occurred_at`,`id`);

DROP TRIGGER resource_leases_validate_insert;--> statement-breakpoint
CREATE TABLE `__new_worker_instances` (
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
	CONSTRAINT "worker_instances_action_keys_json_check" CHECK(length(CAST("action_keys_json" AS BLOB)) <= 4096 AND CASE WHEN json_valid("action_keys_json") THEN json_type("action_keys_json") = 'array' ELSE 0 END AND CASE WHEN json_valid("action_keys_json") THEN json_array_length("action_keys_json") <= 64 ELSE 0 END),
	CONSTRAINT "worker_instances_capacity_check" CHECK("capacity" BETWEEN 1 AND 16),
	CONSTRAINT "worker_instances_id_check" CHECK(length("id") = 36 AND instr("id", char(0)) = 0 AND length(replace("id", '-', '')) = 32 AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*' AND substr("id", 9, 1) = '-' AND substr("id", 14, 1) = '-' AND substr("id", 15, 1) = '7' AND substr("id", 19, 1) = '-' AND substr("id", 20, 1) GLOB '[89ab]' AND substr("id", 24, 1) = '-'),
	CONSTRAINT "worker_instances_pid_check" CHECK("pid" BETWEEN 1 AND 2147483647),
	CONSTRAINT "worker_instances_release_id_check" CHECK(length("release_id") = 40 AND instr("release_id", char(0)) = 0 AND "release_id" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "worker_instances_state_check" CHECK(("state" = 'online' AND "draining_at" IS NULL AND "stopped_at" IS NULL) OR ("state" = 'draining' AND "draining_at" IS NOT NULL AND "stopped_at" IS NULL) OR ("state" = 'stopped' AND "draining_at" IS NOT NULL AND "stopped_at" IS NOT NULL)),
	CONSTRAINT "worker_instances_time_check" CHECK("started_at" BETWEEN 0 AND 8640000000000000 AND "heartbeat_at" BETWEEN 0 AND 8640000000000000 AND "heartbeat_at" >= "started_at" AND ("draining_at" IS NULL OR ("draining_at" BETWEEN 0 AND 8640000000000000 AND "draining_at" >= "started_at")) AND ("stopped_at" IS NULL OR ("stopped_at" BETWEEN 0 AND 8640000000000000 AND "stopped_at" >= "draining_at")))
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO `__new_worker_instances`(`action_keys_json`, `capacity`, `draining_at`, `heartbeat_at`, `id`, `pid`, `release_id`, `started_at`, `state`, `stopped_at`) SELECT `action_keys_json`, `capacity`, `draining_at`, `heartbeat_at`, `id`, `pid`, `release_id`, `started_at`, `state`, `stopped_at` FROM `worker_instances`;--> statement-breakpoint
DROP TABLE `worker_instances`;--> statement-breakpoint
ALTER TABLE `__new_worker_instances` RENAME TO `worker_instances`;--> statement-breakpoint
CREATE INDEX `worker_instances_heartbeat_id_idx` ON `worker_instances` (`heartbeat_at`,`id`);--> statement-breakpoint
CREATE TRIGGER worker_instances_reject_replace
BEFORE INSERT ON worker_instances
WHEN EXISTS (SELECT 1 FROM worker_instances WHERE id = NEW.id)
BEGIN
	SELECT RAISE(ABORT, 'worker_instances identity is immutable');
END;--> statement-breakpoint
CREATE TRIGGER worker_instances_validate_action_keys_insert
BEFORE INSERT ON worker_instances
WHEN json_array_length(NEW.action_keys_json) > 64
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
END;--> statement-breakpoint
CREATE TRIGGER worker_instances_reject_identity_update
BEFORE UPDATE OF id, release_id, pid, capacity, started_at, action_keys_json ON worker_instances
BEGIN
	SELECT RAISE(ABORT, 'worker_instances identity is immutable');
END;--> statement-breakpoint
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
END;--> statement-breakpoint
CREATE TRIGGER worker_instances_reject_active_delete
BEFORE DELETE ON worker_instances
WHEN OLD.state <> 'stopped'
BEGIN
	SELECT RAISE(ABORT, 'active worker_instances cannot be deleted');
END;--> statement-breakpoint
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

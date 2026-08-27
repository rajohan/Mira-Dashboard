CREATE TABLE `notification_incident_links` (
	`incident_generation` integer NOT NULL,
	`incident_id` text NOT NULL,
	`notification_id` text NOT NULL,
	CONSTRAINT `notification_incident_links_pk` PRIMARY KEY(`notification_id`, `incident_id`, `incident_generation`),
	CONSTRAINT `fk_notification_incident_links_incident_id_incidents_id_fk` FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_notification_incident_links_notification_id_notifications_id_fk` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE CASCADE,
	CONSTRAINT "notification_incident_links_generation_check" CHECK("incident_generation" >= 1)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `notification_incident_links_incident_idx` ON `notification_incident_links` (`incident_id`,`incident_generation`,`notification_id`);

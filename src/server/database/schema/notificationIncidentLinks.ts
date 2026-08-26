import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
} from "drizzle-orm/sqlite-core";

import { incidents } from "./incidents.ts";
import { notifications } from "./notifications.ts";

/** Exact incident generations represented by one aggregate lifecycle notification. */
export const notificationIncidentLinks = sqliteTable(
    "notification_incident_links",
    {
        incidentGeneration: integer("incident_generation").notNull(),
        incidentId: text("incident_id")
            .notNull()
            .references(() => incidents.id, { onDelete: "restrict" }),
        notificationId: text("notification_id")
            .notNull()
            .references(() => notifications.id, { onDelete: "cascade" }),
    },
    (table) => [
        check(
            "notification_incident_links_generation_check",
            sql`${table.incidentGeneration} >= 1`
        ),
        primaryKey({
            columns: [table.notificationId, table.incidentId, table.incidentGeneration],
            name: "notification_incident_links_pk",
        }),
        index("notification_incident_links_incident_idx").on(
            table.incidentId,
            table.incidentGeneration,
            table.notificationId
        ),
    ]
);

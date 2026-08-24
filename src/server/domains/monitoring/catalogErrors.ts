import { Schema } from "effect";

const TaggedErrorClass = Schema.TaggedError;

export const monitoringCatalogResourceKinds = [
    "incident",
    "notification",
    "report",
] as const;

export type MonitoringCatalogResourceKind =
    (typeof monitoringCatalogResourceKinds)[number];

/** Expected exact-record lookup failure. */
export class MonitoringCatalogNotFoundError extends TaggedErrorClass<MonitoringCatalogNotFoundError>(
    "mira-dashboard/server/domains/monitoring/MonitoringCatalogNotFoundError"
)("MonitoringCatalogNotFoundError", {
    id: Schema.String,
    resource: Schema.Literals(monitoringCatalogResourceKinds),
}) {}

/** Expected immutable-id replay conflict. */
export class MonitoringCatalogConflictError extends TaggedErrorClass<MonitoringCatalogConflictError>(
    "mira-dashboard/server/domains/monitoring/MonitoringCatalogConflictError"
)("MonitoringCatalogConflictError", {
    id: Schema.String,
    resource: Schema.Literals(["notification", "report"]),
}) {}

/** Expected producer-input failure at a catalog-specific mutation boundary. */
export class MonitoringCatalogValidationError extends TaggedErrorClass<MonitoringCatalogValidationError>(
    "mira-dashboard/server/domains/monitoring/MonitoringCatalogValidationError"
)("MonitoringCatalogValidationError", {
    id: Schema.String,
    maximumOccurredAtMs: Schema.Number,
    occurredAtMs: Schema.Number,
    resource: Schema.Literals(["notification", "report"]),
}) {}

/** Expected bounded-work precondition failure for one catalog mutation. */
export class MonitoringCatalogPreconditionError extends TaggedErrorClass<MonitoringCatalogPreconditionError>(
    "mira-dashboard/server/domains/monitoring/MonitoringCatalogPreconditionError"
)("MonitoringCatalogPreconditionError", {
    id: Schema.String,
    linkedNotificationCount: Schema.Number,
    maximumLinkedNotifications: Schema.Number,
    resource: Schema.Literal("report"),
}) {}

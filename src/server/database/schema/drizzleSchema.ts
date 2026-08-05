/**
 * Complete table catalog consumed only by Drizzle Kit and database composition roots.
 * Domain code imports its own tables directly rather than using this catalog as a barrel.
 */
export { auditEvents } from "./auditEvents.ts";
export { authSessions } from "./authSessions.ts";
export { automationCredentials } from "./automationCredentials.ts";
export { automationPrincipalCapabilities } from "./automationPrincipalCapabilities.ts";
export { automationPrincipals } from "./automationPrincipals.ts";
export { incidentObservations } from "./incidentObservations.ts";
export { incidents } from "./incidents.ts";
export { monitorRuns } from "./monitorRuns.ts";
export { notifications } from "./notifications.ts";
export { realtimeEvents } from "./realtime.ts";
export { reports } from "./reports.ts";
export { schemaMigrations } from "./schemaMigrations.ts";
export { users } from "./users.ts";

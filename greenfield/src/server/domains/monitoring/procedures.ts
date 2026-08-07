import { router } from "../../trpc/trpc.ts";
import { incidentRoutes, notificationRoutes, reportRoutes } from "./catalogRoutes.ts";
import { monitoringRoutes } from "./ingestionRoutes.ts";

export const incidentProcedureNames = Object.freeze(Object.keys(incidentRoutes));
export const monitoringProcedureNames = Object.freeze(Object.keys(monitoringRoutes));
export const notificationProcedureNames = Object.freeze(Object.keys(notificationRoutes));
export const reportProcedureNames = Object.freeze(Object.keys(reportRoutes));

/** Capability-scoped incident lifecycle router. */
export const incidentRouter = router(incidentRoutes);
/** Automation-only complete-snapshot ingestion router. */
export const monitoringRouter = router(monitoringRoutes);
/** Dashboard notification inventory and acknowledgement router. */
export const notificationRouter = router(notificationRoutes);
/** Immutable monitoring report catalog router. */
export const reportRouter = router(reportRoutes);

import { agentProcedureNames, agentRouter } from "../domains/agents/procedures.ts";
import {
    jobProcedureNames,
    jobRouter,
    scheduleProcedureNames,
    scheduleRouter,
} from "../domains/jobs/procedures.ts";
import {
    incidentProcedureNames,
    incidentRouter,
    monitoringProcedureNames,
    monitoringRouter,
    notificationProcedureNames,
    notificationRouter,
    reportProcedureNames,
    reportRouter,
} from "../domains/monitoring/procedures.ts";
import { eventsProcedureNames, eventsRouter } from "../domains/realtime/procedures.ts";
import {
    automationSecurityProcedureNames,
    automationSecurityRouter,
} from "../domains/security/automation/procedures.ts";
import {
    accountSecurityProcedureNames,
    accountSecurityRouter,
} from "../domains/security/mfa/procedures.ts";
import { authProcedureNames, authRouter } from "../domains/security/procedures.ts";
import {
    securityAuditProcedureNames,
    securityAuditRouter,
} from "../domains/security/securityAuditProcedures.ts";
import { systemProcedureNames, systemRouter } from "../domains/system/procedures.ts";
import { taskProcedureNames, taskRouter } from "../domains/tasks/procedures.ts";
import { router } from "./trpc.ts";

function namespacedProcedureNames(
    namespace: string,
    procedureNames: readonly string[]
): readonly string[] {
    return procedureNames.map((procedureName) => `${namespace}.${procedureName}`);
}

/** Root tRPC router for the application. */
export const appRouter = router({
    agents: agentRouter,
    accountSecurity: accountSecurityRouter,
    auth: authRouter,
    automationSecurity: automationSecurityRouter,
    events: eventsRouter,
    incidents: incidentRouter,
    jobs: jobRouter,
    monitoring: monitoringRouter,
    notifications: notificationRouter,
    reports: reportRouter,
    schedules: scheduleRouter,
    securityAudit: securityAuditRouter,
    system: systemRouter,
    tasks: taskRouter,
});

/** First-party procedure inventory produced by the same route records as the root router. */
export const appRouterProcedureNames = Object.freeze([
    ...namespacedProcedureNames("agents", agentProcedureNames),
    ...namespacedProcedureNames("accountSecurity", accountSecurityProcedureNames),
    ...namespacedProcedureNames("auth", authProcedureNames),
    ...namespacedProcedureNames("automationSecurity", automationSecurityProcedureNames),
    ...namespacedProcedureNames("events", eventsProcedureNames),
    ...namespacedProcedureNames("incidents", incidentProcedureNames),
    ...namespacedProcedureNames("jobs", jobProcedureNames),
    ...namespacedProcedureNames("monitoring", monitoringProcedureNames),
    ...namespacedProcedureNames("notifications", notificationProcedureNames),
    ...namespacedProcedureNames("reports", reportProcedureNames),
    ...namespacedProcedureNames("schedules", scheduleProcedureNames),
    ...namespacedProcedureNames("securityAudit", securityAuditProcedureNames),
    ...namespacedProcedureNames("system", systemProcedureNames),
    ...namespacedProcedureNames("tasks", taskProcedureNames),
]);

/** Type-only root API contract consumed by TypeScript clients. */
export type AppRouter = typeof appRouter;

import { agentProcedureNames, agentRouter } from "../domains/agents/procedures.ts";
import { cacheProcedureNames, cacheRouter } from "../domains/cache/procedures.ts";
import { chatProcedureNames, chatRouter } from "../domains/chat/procedures.ts";
import {
    databaseProcedureNames,
    databaseRouter,
} from "../domains/database/procedures.ts";
import { dockerProcedureNames, dockerRouter } from "../domains/docker/routes.ts";
import {
    workspaceFileProcedureNames,
    workspaceFilesRouter,
} from "../domains/files/procedures.ts";
import {
    gatewayProcedureNames,
    gatewayRouter,
} from "../domains/gatewayConnection/procedures.ts";
import {
    gatewaySessionProcedureNames,
    gatewaySessionsRouter,
} from "../domains/gatewaySessions/procedures.ts";
import {
    jobProcedureNames,
    jobRouter,
    scheduleProcedureNames,
    scheduleRouter,
} from "../domains/jobs/procedures.ts";
import { logProcedureNames, logsRouter } from "../domains/logs/procedures.ts";
import {
    moltbookProcedureNames,
    moltbookRouter,
} from "../domains/moltbook/procedures.ts";
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
import {
    openClawCronProcedureNames,
    openClawCronRouter,
} from "../domains/openClawCron/procedures.ts";
import {
    openClawSettingsProcedureNames,
    openClawSettingsRouter,
} from "../domains/openClawSettings/procedures.ts";
import {
    openClawTaskProcedureNames,
    openClawTasksRouter,
} from "../domains/openClawTasks/procedures.ts";
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
import {
    serviceActionsProcedureNames,
    serviceActionsRouter,
} from "../domains/serviceActions/routes.ts";
import { systemProcedureNames, systemRouter } from "../domains/system/procedures.ts";
import { taskProcedureNames, taskRouter } from "../domains/tasks/procedures.ts";
import {
    terminalProcedureNames,
    terminalRouter,
} from "../domains/terminal/procedures.ts";
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
    cache: cacheRouter,
    chat: chatRouter,
    database: databaseRouter,
    docker: dockerRouter,
    events: eventsRouter,
    files: workspaceFilesRouter,
    gateway: gatewayRouter,
    gatewaySessions: gatewaySessionsRouter,
    incidents: incidentRouter,
    jobs: jobRouter,
    logs: logsRouter,
    monitoring: monitoringRouter,
    moltbook: moltbookRouter,
    notifications: notificationRouter,
    openClawCron: openClawCronRouter,
    openClawSettings: openClawSettingsRouter,
    openClawTasks: openClawTasksRouter,
    reports: reportRouter,
    schedules: scheduleRouter,
    securityAudit: securityAuditRouter,
    serviceActions: serviceActionsRouter,
    system: systemRouter,
    tasks: taskRouter,
    terminal: terminalRouter,
});

/** First-party procedure inventory produced by the same route records as the root router. */
export const appRouterProcedureNames = Object.freeze([
    ...namespacedProcedureNames("agents", agentProcedureNames),
    ...namespacedProcedureNames("accountSecurity", accountSecurityProcedureNames),
    ...namespacedProcedureNames("auth", authProcedureNames),
    ...namespacedProcedureNames("automationSecurity", automationSecurityProcedureNames),
    ...namespacedProcedureNames("cache", cacheProcedureNames),
    ...namespacedProcedureNames("chat", chatProcedureNames),
    ...namespacedProcedureNames("database", databaseProcedureNames),
    ...namespacedProcedureNames("docker", dockerProcedureNames),
    ...namespacedProcedureNames("events", eventsProcedureNames),
    ...namespacedProcedureNames("files", workspaceFileProcedureNames),
    ...namespacedProcedureNames("gateway", gatewayProcedureNames),
    ...namespacedProcedureNames("gatewaySessions", gatewaySessionProcedureNames),
    ...namespacedProcedureNames("incidents", incidentProcedureNames),
    ...namespacedProcedureNames("jobs", jobProcedureNames),
    ...namespacedProcedureNames("logs", logProcedureNames),
    ...namespacedProcedureNames("monitoring", monitoringProcedureNames),
    ...namespacedProcedureNames("moltbook", moltbookProcedureNames),
    ...namespacedProcedureNames("notifications", notificationProcedureNames),
    ...namespacedProcedureNames("openClawCron", openClawCronProcedureNames),
    ...namespacedProcedureNames("openClawSettings", openClawSettingsProcedureNames),
    ...namespacedProcedureNames("openClawTasks", openClawTaskProcedureNames),
    ...namespacedProcedureNames("reports", reportProcedureNames),
    ...namespacedProcedureNames("schedules", scheduleProcedureNames),
    ...namespacedProcedureNames("securityAudit", securityAuditProcedureNames),
    ...namespacedProcedureNames("serviceActions", serviceActionsProcedureNames),
    ...namespacedProcedureNames("system", systemProcedureNames),
    ...namespacedProcedureNames("tasks", taskProcedureNames),
    ...namespacedProcedureNames("terminal", terminalProcedureNames),
]);

/** Type-only root API contract consumed by TypeScript clients. */
export type AppRouter = typeof appRouter;

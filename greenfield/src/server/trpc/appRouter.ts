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
import { router } from "./trpc.ts";

function namespacedProcedureNames(
    namespace: string,
    procedureNames: readonly string[]
): readonly string[] {
    return procedureNames.map((procedureName) => `${namespace}.${procedureName}`);
}

/** Root tRPC router for the application. */
export const appRouter = router({
    accountSecurity: accountSecurityRouter,
    auth: authRouter,
    automationSecurity: automationSecurityRouter,
    events: eventsRouter,
    securityAudit: securityAuditRouter,
    system: systemRouter,
});

/** First-party procedure inventory produced by the same route records as the root router. */
export const appRouterProcedureNames = Object.freeze([
    ...namespacedProcedureNames("accountSecurity", accountSecurityProcedureNames),
    ...namespacedProcedureNames("auth", authProcedureNames),
    ...namespacedProcedureNames("automationSecurity", automationSecurityProcedureNames),
    ...namespacedProcedureNames("events", eventsProcedureNames),
    ...namespacedProcedureNames("securityAudit", securityAuditProcedureNames),
    ...namespacedProcedureNames("system", systemProcedureNames),
]);

/** Type-only root API contract consumed by TypeScript clients. */
export type AppRouter = typeof appRouter;

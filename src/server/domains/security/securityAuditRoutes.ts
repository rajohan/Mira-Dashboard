import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    type SecurityAuditEventSummary,
    listSecurityAuditEventsInputSchema,
    listSecurityAuditEventsResultSchema,
    securityAuditEventSummarySchema,
} from "../../../contracts/securityAudit.ts";
import { appendClearedDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import { sessionProcedure } from "../../trpc/trpc.ts";

function mutableAuditEvent(
    event: SecurityAuditEventSummary
): v.InferInput<typeof securityAuditEventSummarySchema> {
    const { addedCapabilities, removedCapabilities, ...metadata } = event.metadata;
    return {
        ...event,
        metadata: {
            ...metadata,
            ...(addedCapabilities === undefined
                ? {}
                : {
                      addedCapabilities: [...addedCapabilities],
                  }),
            ...(removedCapabilities === undefined
                ? {}
                : {
                      removedCapabilities: [...removedCapabilities],
                  }),
        },
    };
}

/** Browser-session-only immutable security audit routes. */
export const securityAuditRoutes = {
    listEvents: sessionProcedure
        .input(listSecurityAuditEventsInputSchema)
        .output(listSecurityAuditEventsResultSchema)
        .query(({ ctx, input }) => {
            const result = ctx.securityAuditLifecycle.listEvents(
                ctx.sessionIdentity,
                input
            );
            if (result.status === "listed") {
                const output = v.parse(
                    listSecurityAuditEventsResultSchema,
                    result.result
                );
                return {
                    ...output,
                    events: output.events.map(mutableAuditEvent),
                };
            }
            appendClearedDashboardSessionCookie(ctx.responseHeaders);
            throw new TRPCError({
                code: "UNAUTHORIZED",
                message: "Authentication state changed; sign in again",
            });
        }),
};

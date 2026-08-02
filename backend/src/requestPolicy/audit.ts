import type { DashboardUser } from "../../../contracts/auth.ts";
import type { AutomationPrincipal, AutomationScope } from "../automationAuth.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { routeFailureResponse } from "../routeSupport.ts";
import {
    type AuditActor,
    type AuditOutcome,
    writeAuditEvent,
} from "../services/auditEvents.ts";
import { SAFE_REQUEST_METHODS } from "./classification.ts";

const logger = createStructuredLogger("http");

export function requestActor(
    user: DashboardUser | undefined,
    automationPrincipal?: AutomationPrincipal
): AuditActor {
    if (automationPrincipal) {
        return { id: automationPrincipal.id, type: "automation" };
    }
    if (!user) return { id: "anonymous", type: "anonymous" };
    return { id: `${user.id}:${user.username}`, type: "user" };
}

export function auditOutcomeForStatus(status: number): AuditOutcome {
    if (status === 401 || status === 403) return "denied";
    return status >= 400 ? "failed" : "accepted";
}

export function isAuditedMutation(
    isApi: boolean,
    request: Request,
    automationScope?: AutomationScope
): boolean {
    if (!isApi) return false;
    return (
        !SAFE_REQUEST_METHODS.has(request.method.toUpperCase()) ||
        automationScope?.endsWith(":write") === true
    );
}
function writeRequestAudit(
    actor: AuditActor,
    outcome: AuditOutcome,
    request: Request,
    requestId: string,
    routePath: string,
    status?: number,
    automationScope?: AutomationScope,
    persistAuditEvent: typeof writeAuditEvent = writeAuditEvent
): void {
    persistAuditEvent({
        actor,
        action: "http.request",
        metadata: {
            method: request.method.toUpperCase(),
            ...(status !== undefined && { status }),
            ...(automationScope && { automationScope }),
        },
        outcome,
        requestId,
        targetId: routePath,
        targetType: "http-route",
    });
}

export function didWriteRequestAudit(
    actor: AuditActor,
    outcome: AuditOutcome,
    request: Request,
    requestId: string,
    routePath: string,
    status?: number,
    automationScope?: AutomationScope,
    persistAuditEvent: typeof writeAuditEvent = writeAuditEvent
): boolean {
    try {
        writeRequestAudit(
            actor,
            outcome,
            request,
            requestId,
            routePath,
            status,
            automationScope,
            persistAuditEvent
        );
        return true;
    } catch (error) {
        logger.error("audit.request_persistence_failed", {
            error,
            outcome,
            requestId,
        });
        return false;
    }
}

export function auditedForbiddenResponse(
    actor: AuditActor,
    request: Request,
    requestId: string,
    routePath: string,
    automationScope: AutomationScope | undefined,
    error: { code?: string; message: string },
    persistAuditEvent: typeof writeAuditEvent
): Response {
    const didRecordDenial = didWriteRequestAudit(
        actor,
        "denied",
        request,
        requestId,
        routePath,
        403,
        automationScope,
        persistAuditEvent
    );
    return routeFailureResponse(
        didRecordDenial
            ? {
                  ...(error.code && { code: error.code }),
                  context: "request.authorization",
                  message: error.message,
                  status: 403,
              }
            : {
                  code: "audit_unavailable",
                  context: "request.audit",
                  message: "Audit trail unavailable",
                  status: 503,
              },
        request
    );
}

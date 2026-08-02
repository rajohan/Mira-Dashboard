import type { Server } from "bun";

import { hasRecentMfaVerification } from "../auth/sessionPolicy.ts";
import {
    authenticateAutomationRequest,
    type AutomationAuthentication,
    requiredAutomationScope,
} from "../http/automationAuth.ts";
import { authSession } from "../http/core.ts";
import { runWithRequestAuditContext } from "../http/requestAuditContext.ts";
import {
    isAllowedMutationSource,
    requestIdFor,
    withRequestSecurity,
} from "../http/requestSecurity.ts";
import { routeErrorResponse, routeFailureResponse } from "../http/routeSupport.ts";
import {
    recordHttpRequestMetric,
    resetHttpRequestMetrics,
} from "../lib/httpRequestMetrics.ts";
import { hashedLogCorrelation, runWithLogContext } from "../lib/logContext.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { writeAuditEvent } from "../services/auditEvents.ts";
import {
    auditOutcomeForStatus,
    auditedForbiddenResponse,
    didWriteRequestAudit,
    isAuditedMutation,
    requestActor,
} from "./audit.ts";
import {
    isApiRoute,
    isAuthRoute,
    isDeploymentCutoverMutationBlocked,
    isDevelopmentHostMutationBlocked,
    isPublicApiRoute,
    requiresRecentMfa,
} from "./classification.ts";
import {
    apiRule,
    authRule,
    checkRateLimit,
    resetRequestRateLimitsForTests,
    withCurrentRateLimitHeaders,
} from "./rateLimit.ts";

export {
    isDeploymentCutoverMutationBlocked,
    isDevelopmentExternalNotificationSuppressed,
    isDevelopmentGatewayMethodAllowed,
    isDevelopmentGatewayMethodBlocked,
    isDevelopmentGatewayProxyEventAllowed,
    isDevelopmentGatewayProxyMethodAllowed,
    isDevelopmentHostMutationBlocked,
    isDevelopmentSafeMode,
    requiresRecentMfa,
    requiresRecentMfaForGatewayMethod,
} from "./classification.ts";

const logger = createStructuredLogger("http");

type BunHandler = (
    request: Request,
    server: Server<unknown>
) => Response | Promise<Response>;
type BunRouteEntry =
    | Response
    | BunHandler
    | {
          DELETE?: BunHandler | Response;
          GET?: BunHandler | Response;
          PATCH?: BunHandler | Response;
          POST?: BunHandler | Response;
          PUT?: BunHandler | Response;
      };
type SecuredHandler<T> = T extends (
    ...arguments_: infer Arguments
) => Response | Promise<Response>
    ? (...arguments_: Arguments) => Promise<Response>
    : T extends Response
      ? BunHandler
      : never;
type SecuredRouteEntry<T> = T extends BunHandler | Response
    ? SecuredHandler<T>
    : T extends Record<string, unknown>
      ? { [Method in keyof T]: SecuredHandler<T[Method]> }
      : never;
type SecuredRoutes<T extends Record<string, unknown>> = {
    [Path in keyof T]: SecuredRouteEntry<T[Path]>;
};
interface RequestPolicyOptions {
    authenticateAutomation?: (request: Request) => AutomationAuthentication;
    persistAuditEvent?: typeof writeAuditEvent;
}

async function callHandler(
    handler: BunHandler | Response,
    request: Request,
    server: Server<unknown>
): Promise<Response> {
    if (handler instanceof Response) {
        return handler.clone() as Response;
    }
    return handler(request, server);
}
function secureHandler(
    routePath: string,
    handler: BunHandler | Response,
    authenticateAutomation: (request: Request) => AutomationAuthentication,
    persistAuditEvent: typeof writeAuditEvent
): BunHandler {
    return async (request, server) => {
        const startedAt = performance.now();
        const requestIdentifier = requestIdFor(request);
        let correlatedSessionId: string | undefined;
        let responseStatus = 500;
        try {
            const response = await (async () => {
                const pathname = new URL(request.url).pathname || routePath;
                const isApi = isApiRoute(pathname);
                let rateRule = isApi ? apiRule : undefined;
                if (isAuthRoute(pathname)) {
                    rateRule = authRule;
                }
                if (rateRule) {
                    const limited = checkRateLimit(request, server, rateRule);
                    if (limited) return limited;
                }

                if (isApi && !isAllowedMutationSource(request)) {
                    return routeFailureResponse(
                        {
                            code: "forbidden_origin",
                            context: "request.origin",
                            message: "Forbidden request origin",
                            status: 403,
                        },
                        request
                    );
                }
                if (isApi && isDeploymentCutoverMutationBlocked(request)) {
                    return routeFailureResponse(
                        {
                            code: "deployment_cutover_in_progress",
                            context: "request.deployment-cutover",
                            message:
                                "Dashboard writes are paused while the release is verified",
                            retryAfterSeconds: 5,
                            status: 503,
                        },
                        request
                    );
                }

                const requiresAuthentication = isApi && !isPublicApiRoute(request);
                const automationAuthentication = requiresAuthentication
                    ? authenticateAutomation(request)
                    : ({ kind: "absent" } as const);
                if (automationAuthentication.kind === "invalid") {
                    return routeFailureResponse(
                        {
                            code: "invalid_automation_credential",
                            context: "request.automation-authentication",
                            message: "Invalid automation credential",
                            status: 401,
                        },
                        request
                    );
                }
                const automationPrincipal =
                    automationAuthentication.kind === "authenticated"
                        ? automationAuthentication.principal
                        : undefined;
                const automationScope = automationPrincipal
                    ? requiredAutomationScope(request)
                    : undefined;
                if (
                    automationPrincipal &&
                    (!automationScope || !automationPrincipal.scopes.has(automationScope))
                ) {
                    return auditedForbiddenResponse(
                        requestActor(undefined, automationPrincipal),
                        request,
                        requestIdentifier,
                        routePath,
                        automationScope,
                        {
                            code: "automation_scope_denied",
                            message: "Automation credential scope denied",
                        },
                        persistAuditEvent
                    );
                }
                const isAuditedMutationCandidate = isAuditedMutation(
                    isApi,
                    request,
                    automationScope
                );
                const session =
                    !automationPrincipal &&
                    (requiresAuthentication || isAuditedMutationCandidate)
                        ? authSession(request)
                        : undefined;
                const isAuditedMutationRequest =
                    isAuditedMutationCandidate &&
                    (!isPublicApiRoute(request) || session !== undefined);
                correlatedSessionId = session
                    ? hashedLogCorrelation("dashboard-session", session.sessionId)
                    : undefined;
                if (requiresAuthentication && !session && !automationPrincipal) {
                    return routeFailureResponse(
                        {
                            context: "request.authentication",
                            message: "Unauthorized",
                            status: 401,
                        },
                        request
                    );
                }

                const user = session
                    ? { id: session.id, username: session.username }
                    : undefined;
                const actor = requestActor(user, automationPrincipal);
                if (isApi && isDevelopmentHostMutationBlocked(request)) {
                    return auditedForbiddenResponse(
                        actor,
                        request,
                        requestIdentifier,
                        routePath,
                        automationScope,
                        {
                            code: "development_host_mutation_disabled",
                            message: "Host-control actions are disabled in Dashboard dev",
                        },
                        persistAuditEvent
                    );
                }
                const isPrivilegedRequest =
                    Boolean(session) &&
                    !automationPrincipal &&
                    requiresRecentMfa(request);
                if (
                    isPrivilegedRequest &&
                    session &&
                    (!session.mfaEnabled || !hasRecentMfaVerification(session))
                ) {
                    return auditedForbiddenResponse(
                        actor,
                        request,
                        requestIdentifier,
                        routePath,
                        automationScope,
                        {
                            code: session.mfaEnabled
                                ? "step_up_required"
                                : "mfa_enrollment_required",
                            message: session.mfaEnabled
                                ? "Recent MFA verification is required"
                                : "Multi-factor authentication must be enabled",
                        },
                        persistAuditEvent
                    );
                }
                const isMutation = isAuditedMutationRequest || isPrivilegedRequest;
                let handlerResponse: Response;
                let didRecordAttempt = false;
                if (isMutation) {
                    didRecordAttempt = didWriteRequestAudit(
                        actor,
                        "attempted",
                        request,
                        requestIdentifier,
                        routePath,
                        undefined,
                        automationScope,
                        persistAuditEvent
                    );
                    if (!didRecordAttempt) {
                        return routeFailureResponse(
                            {
                                code: "audit_unavailable",
                                context: "request.audit",
                                message: "Audit trail unavailable",
                                status: 503,
                            },
                            request
                        );
                    }
                }
                try {
                    handlerResponse = await runWithRequestAuditContext(
                        { actor, requestId: requestIdentifier },
                        () =>
                            runWithLogContext(
                                {
                                    requestId: requestIdentifier,
                                    ...(correlatedSessionId && {
                                        sessionId: correlatedSessionId,
                                    }),
                                },
                                () => callHandler(handler, request, server)
                            )
                    );
                } catch (error) {
                    handlerResponse = routeErrorResponse(request, error, {
                        context: "request.handler",
                        message: "Internal server error",
                    });
                }

                if (isMutation && didRecordAttempt) {
                    didWriteRequestAudit(
                        actor,
                        auditOutcomeForStatus(handlerResponse.status),
                        request,
                        requestIdentifier,
                        routePath,
                        handlerResponse.status,
                        automationScope,
                        persistAuditEvent
                    );
                }

                if (!rateRule) return handlerResponse;
                return withCurrentRateLimitHeaders(
                    handlerResponse,
                    rateRule,
                    request,
                    server
                );
            })();

            responseStatus = response.status;
            return withRequestSecurity(request, response, server);
        } finally {
            const durationMs =
                Math.round(Math.max(0, performance.now() - startedAt) * 100) / 100;
            recordHttpRequestMetric({
                durationMs,
                method: request.method,
                route: routePath,
                status: responseStatus,
            });
            const fields = {
                durationMs,
                method: request.method.toUpperCase(),
                requestId: requestIdentifier,
                route: routePath,
                ...(correlatedSessionId && { sessionId: correlatedSessionId }),
                status: responseStatus,
            };
            if (responseStatus >= 500) {
                logger.error("http.request", fields);
            } else if (responseStatus >= 400) {
                logger.warn("http.request", fields);
            } else {
                logger.info("http.request", fields);
            }
        }
    };
}

function secureEntry(
    routePath: string,
    entry: BunRouteEntry,
    authenticateAutomation: (request: Request) => AutomationAuthentication,
    persistAuditEvent: typeof writeAuditEvent
): BunRouteEntry {
    if (typeof entry === "function" || entry instanceof Response) {
        return secureHandler(routePath, entry, authenticateAutomation, persistAuditEvent);
    }

    return Object.fromEntries(
        Object.entries(entry).map(([method, handler]) => [
            method,
            secureHandler(routePath, handler, authenticateAutomation, persistAuditEvent),
        ])
    );
}

export function withRequestPolicy<T extends Record<string, unknown>>(
    routes: T,
    options: RequestPolicyOptions = {}
): SecuredRoutes<T> {
    const authenticateAutomation =
        options.authenticateAutomation ?? authenticateAutomationRequest;
    const persistAuditEvent = options.persistAuditEvent ?? writeAuditEvent;
    return Object.fromEntries(
        Object.entries(routes).map(([routePath, entry]) => [
            routePath,
            secureEntry(
                routePath,
                entry as BunRouteEntry,
                authenticateAutomation,
                persistAuditEvent
            ),
        ])
    ) as SecuredRoutes<T>;
}

export function resetRequestPolicyForTests(): void {
    resetRequestRateLimitsForTests();
    resetHttpRequestMetrics();
}

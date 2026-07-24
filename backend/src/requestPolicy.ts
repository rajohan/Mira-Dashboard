import { isIP } from "node:net";

import type { Server } from "bun";

import type { AuthUser } from "./auth.ts";
import { hasRecentMfaVerification } from "./auth.ts";
import {
    authenticateAutomationRequest,
    type AutomationAuthentication,
    type AutomationPrincipal,
    type AutomationScope,
    requiredAutomationScope,
} from "./automationAuth.ts";
import {
    authSession,
    HttpError,
    isTrustedProxyAddress,
    json,
    requestIp,
} from "./http.ts";
import { errorMessage, httpStatusCode } from "./lib/errors.ts";
import { runWithRequestAuditContext } from "./requestAuditContext.ts";
import {
    isAllowedMutationSource,
    requestIdFor,
    withRequestSecurity,
} from "./requestSecurity.ts";
import {
    type AuditActor,
    type AuditOutcome,
    writeAuditEvent,
} from "./services/auditEvents.ts";

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

interface RateLimitBucket {
    lastSeenAt: number;
    resetAt: number;
    used: number;
}

interface RateLimitRule {
    keyPrefix: string;
    max: number;
    message: string;
    windowMs: number;
}

interface RequestPolicyOptions {
    authenticateAutomation?: (request: Request) => AutomationAuthentication;
    persistAuditEvent?: typeof writeAuditEvent;
}

const apiRule: RateLimitRule = {
    keyPrefix: "api",
    max: 600,
    message: "Too many requests, please try again later",
    windowMs: 60_000,
};

const authRule: RateLimitRule = {
    keyPrefix: "auth",
    max: 20,
    message: "Too many authentication attempts, please try again later",
    windowMs: 60_000,
};

const buckets = new Map<string, RateLimitBucket>();
const BUCKET_CLEANUP_INTERVAL_MS = 60_000;
const BUCKET_STALE_MS = Math.max(apiRule.windowMs, authRule.windowMs) * 2;
const SAFE_REQUEST_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PUBLIC_API_METHODS = new Map<string, ReadonlySet<string>>([
    ["/api/health", new Set(["GET", "HEAD"])],
    ["/api/auth/bootstrap", new Set(["GET", "HEAD"])],
    ["/api/auth/login", new Set(["POST"])],
    ["/api/auth/login/recovery", new Set(["POST"])],
    ["/api/auth/login/totp", new Set(["POST"])],
    ["/api/auth/login/webauthn/options", new Set(["POST"])],
    ["/api/auth/login/webauthn/verify", new Set(["POST"])],
    ["/api/auth/logout", new Set(["POST"])],
    ["/api/auth/register-first-user", new Set(["POST"])],
    ["/api/auth/session", new Set(["GET", "HEAD"])],
]);
const READ_ONLY_GATEWAY_METHODS = new Set([
    "chat.history",
    "chat.runtimeSnapshot",
    "models.list",
    "sessions.list",
    "subscribe",
    "unsubscribe",
]);
const rateLimitState: { bucketCleanupTimer: Timer | undefined } = {
    bucketCleanupTimer: undefined,
};

function cleanupStaleBuckets(): void {
    const staleBefore = Date.now() - BUCKET_STALE_MS;
    for (const [key, bucket] of buckets) {
        if (bucket.lastSeenAt < staleBefore) {
            buckets.delete(key);
        }
    }
}

function ensureBucketCleanupTimer(): void {
    if (rateLimitState.bucketCleanupTimer) return;
    rateLimitState.bucketCleanupTimer = setInterval(
        cleanupStaleBuckets,
        BUCKET_CLEANUP_INTERVAL_MS
    );
    rateLimitState.bucketCleanupTimer.unref();
}

function isApiRoute(pathname: string): boolean {
    return pathname === "/api" || pathname.startsWith("/api/");
}

function isAuthRoute(pathname: string): boolean {
    return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

function isPublicApiRoute(request: Request): boolean {
    const pathname = new URL(request.url).pathname;
    return PUBLIC_API_METHODS.get(pathname)?.has(request.method.toUpperCase()) === true;
}

function rateLimitKey(
    rule: RateLimitRule,
    request: Request,
    server: Server<unknown>
): string {
    const peerAddress = requestIp(request, server);
    const trustedClientAddress = isTrustedProxyAddress(peerAddress)
        ? trustedProxyClientAddress(request)
        : undefined;
    return `${rule.keyPrefix}:${trustedClientAddress || peerAddress || "unknown"}`;
}

function trustedProxyClientAddress(request: Request): string | undefined {
    const realIp = request.headers.get("x-real-ip")?.trim();
    if (realIp && isIP(realIp)) return realIp;

    const forwardedFor = request.headers.get("x-forwarded-for")?.trim();
    if (!forwardedFor || forwardedFor.includes(",")) return undefined;
    return isIP(forwardedFor) ? forwardedFor : undefined;
}

function withRateLimitHeaders(
    response: Response,
    rule: RateLimitRule,
    remaining: number,
    resetAt: number
): Response {
    const headers = new Headers(response.headers);
    const resetSeconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
    headers.set("RateLimit-Policy", `${rule.max};w=${Math.floor(rule.windowMs / 1000)}`);
    headers.set(
        "RateLimit",
        `limit=${rule.max}, remaining=${Math.max(remaining, 0)}, reset=${resetSeconds}`
    );
    return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
    });
}

function checkRateLimit(
    request: Request,
    server: Server<unknown>,
    rule: RateLimitRule
): Response | undefined {
    const now = Date.now();
    ensureBucketCleanupTimer();
    const key = rateLimitKey(rule, request, server);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { lastSeenAt: now, resetAt: now + rule.windowMs, used: 0 };
        buckets.set(key, bucket);
    }

    bucket.lastSeenAt = now;
    bucket.used += 1;
    if (bucket.used <= rule.max) {
        return undefined;
    }

    const remaining = rule.max - bucket.used;
    const response = json({ error: rule.message }, { status: 429 });
    const withHeaders = withRateLimitHeaders(response, rule, remaining, bucket.resetAt);
    const headers = new Headers(withHeaders.headers);
    headers.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
    return new Response(withHeaders.body, {
        headers,
        status: withHeaders.status,
        statusText: withHeaders.statusText,
    });
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

function requestActor(
    user: AuthUser | undefined,
    automationPrincipal?: AutomationPrincipal
): AuditActor {
    if (automationPrincipal) {
        return { id: automationPrincipal.id, type: "automation" };
    }
    if (!user) return { id: "anonymous", type: "anonymous" };
    return { id: `${user.id}:${user.username}`, type: "user" };
}

function auditOutcomeForStatus(status: number): AuditOutcome {
    if (status === 401 || status === 403) return "denied";
    return status >= 400 ? "failed" : "accepted";
}

function isAuditedMutation(
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

/** Identifies host-control actions that require a freshly verified second factor. */
export function requiresRecentMfa(request: Request): boolean {
    const url = new URL(request.url);
    let pathname: string;
    try {
        pathname = decodeURIComponent(url.pathname);
    } catch {
        // An authenticated request with an ambiguous path must not bypass the
        // privileged-route classifier.
        return true;
    }
    const method = request.method.toUpperCase();
    const isMutation = !SAFE_REQUEST_METHODS.has(method);

    if (
        method === "GET" &&
        pathname === "/api/config-files/openclaw.json" &&
        url.searchParams.get("reveal") === "1"
    ) {
        return true;
    }
    if (
        (pathname === "/api/backup" && method === "POST") ||
        (pathname === "/api/restart" && method === "POST")
    ) {
        return true;
    }
    if (!isMutation) return false;
    if (
        pathname === "/api/config" ||
        pathname === "/api/settings" ||
        pathname.startsWith("/api/cache/") ||
        pathname.startsWith("/api/config-files/") ||
        pathname.startsWith("/api/files/") ||
        pathname.startsWith("/api/skills/")
    ) {
        return true;
    }
    return [
        "/api/backups/",
        "/api/cron/",
        "/api/docker/",
        "/api/exec",
        "/api/job-executions/",
        "/api/jobs",
        "/api/ops/",
        "/api/pull-requests/",
        "/api/sessions/",
        "/api/terminal/",
    ].some(
        (prefix) => pathname === prefix.replace(/\/$/u, "") || pathname.startsWith(prefix)
    );
}

/** Requires fresh MFA for every Gateway RPC except the explicit read-only set. */
export function requiresRecentMfaForGatewayMethod(method: string): boolean {
    return !READ_ONLY_GATEWAY_METHODS.has(method);
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

function didWriteRequestAudit(
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
        console.error(
            `[Audit] Request ${requestId} ${outcome} persistence failed:`,
            error
        );
        return false;
    }
}

function secureHandler(
    routePath: string,
    handler: BunHandler | Response,
    authenticateAutomation: (request: Request) => AutomationAuthentication,
    persistAuditEvent: typeof writeAuditEvent
): BunHandler {
    return async (request, server) => {
        const response = await (async () => {
            const pathname = new URL(request.url).pathname || routePath;
            const isApi = isApiRoute(pathname);
            const requestIdentifier = requestIdFor(request);
            const rateRule = isAuthRoute(pathname)
                ? authRule
                : isApi
                  ? apiRule
                  : undefined;
            if (rateRule) {
                const limited = checkRateLimit(request, server, rateRule);
                if (limited) return limited;
            }

            if (isApi && !isAllowedMutationSource(request)) {
                return json({ error: "Forbidden request origin" }, { status: 403 });
            }

            const requiresAuthentication = isApi && !isPublicApiRoute(request);
            const automationAuthentication = requiresAuthentication
                ? authenticateAutomation(request)
                : ({ kind: "absent" } as const);
            if (automationAuthentication.kind === "invalid") {
                return json({ error: "Invalid automation credential" }, { status: 401 });
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
                const didRecordDenial = didWriteRequestAudit(
                    requestActor(undefined, automationPrincipal),
                    "denied",
                    request,
                    requestIdentifier,
                    routePath,
                    403,
                    automationScope,
                    persistAuditEvent
                );
                if (!didRecordDenial) {
                    return json({ error: "Audit trail unavailable" }, { status: 503 });
                }
                return json(
                    { error: "Automation credential scope denied" },
                    { status: 403 }
                );
            }
            const isAuditedMutationRequest = isAuditedMutation(
                isApi,
                request,
                automationScope
            );
            const session =
                !automationPrincipal &&
                (requiresAuthentication || isAuditedMutationRequest)
                    ? authSession(request)
                    : undefined;
            if (requiresAuthentication && !session && !automationPrincipal) {
                return json({ error: "Unauthorized" }, { status: 401 });
            }

            const user = session
                ? { id: session.id, username: session.username }
                : undefined;
            const actor = requestActor(user, automationPrincipal);
            const isPrivilegedRequest =
                Boolean(session) && !automationPrincipal && requiresRecentMfa(request);
            if (
                isPrivilegedRequest &&
                session &&
                (!session.mfaEnabled || !hasRecentMfaVerification(session))
            ) {
                const didRecordDenial = didWriteRequestAudit(
                    actor,
                    "denied",
                    request,
                    requestIdentifier,
                    routePath,
                    403,
                    automationScope,
                    persistAuditEvent
                );
                if (!didRecordDenial) {
                    return json({ error: "Audit trail unavailable" }, { status: 503 });
                }
                return json(
                    {
                        code: session.mfaEnabled
                            ? "step_up_required"
                            : "mfa_enrollment_required",
                        error: session.mfaEnabled
                            ? "Recent MFA verification is required"
                            : "Multi-factor authentication must be enabled",
                    },
                    { status: 403 }
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
                    return json({ error: "Audit trail unavailable" }, { status: 503 });
                }
            }
            try {
                handlerResponse = await runWithRequestAuditContext(
                    { actor, requestId: requestIdentifier },
                    () => callHandler(handler, request, server)
                );
            } catch (error) {
                if (error instanceof HttpError) {
                    handlerResponse = json(
                        { error: error.message },
                        { status: error.statusCode }
                    );
                } else if (error instanceof SyntaxError) {
                    handlerResponse = json({ error: "Invalid JSON" }, { status: 400 });
                } else {
                    const mappedStatus = httpStatusCode(error);
                    if (mappedStatus === 500) {
                        console.error(
                            `[BunServer] Request ${requestIdentifier} failed:`,
                            error
                        );
                        handlerResponse = json(
                            { error: "Internal server error" },
                            { status: 500 }
                        );
                    } else {
                        handlerResponse = json(
                            { error: errorMessage(error, "Request failed") },
                            { status: mappedStatus }
                        );
                    }
                }
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
            const key = rateLimitKey(rateRule, request, server);
            const bucket = buckets.get(key);
            if (!bucket) return handlerResponse;
            return withRateLimitHeaders(
                handlerResponse,
                rateRule,
                rateRule.max - bucket.used,
                bucket.resetAt
            );
        })();

        return withRequestSecurity(request, response, server);
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
            secureHandler(
                routePath,
                handler as BunHandler | Response,
                authenticateAutomation,
                persistAuditEvent
            ),
        ])
    ) as BunRouteEntry;
}

export function withRequestPolicy<T extends Record<string, unknown>>(
    routes: T,
    options: RequestPolicyOptions = {}
): T {
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
    ) as T;
}

export function resetRequestPolicyForTests(): void {
    buckets.clear();
    if (rateLimitState.bucketCleanupTimer) {
        clearInterval(rateLimitState.bucketCleanupTimer);
        rateLimitState.bucketCleanupTimer = undefined;
    }
}

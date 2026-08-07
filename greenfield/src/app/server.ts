import { secondsToMilliseconds } from "date-fns";
import * as v from "valibot";

import { healthLivenessPath, healthReadinessPath } from "../contracts/system.ts";
import type { AgentService } from "../server/domains/agents/service.ts";
import type { AuthenticationLifecycleService } from "../server/domains/security/authenticationLifecycle.ts";
import type { AutomationSecurityLifecycleService } from "../server/domains/security/automation/lifecycle.ts";
import type { MfaAccountLifecycleService } from "../server/domains/security/mfa/accountLifecycle.ts";
import type { MfaLoginLifecycleService } from "../server/domains/security/mfa/loginLifecycle.ts";
import type { SecurityAuditLifecycleService } from "../server/domains/security/securityAuditLifecycle.ts";
import type { TaskService } from "../server/domains/tasks/service.ts";
import type { ReadinessController } from "../server/platform/readiness/readinessState.ts";
import type { ApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import { readRuntimeIdentity } from "../server/platform/runtime/readRuntimeIdentity.ts";
import type { FrontendAssetHandler } from "../server/rawHttp/frontendAssets.ts";
import {
    type HealthProbeMethod,
    livenessResponse,
    readinessResponse,
} from "../server/rawHttp/health.ts";
import { parseBrowserOrigin } from "../server/rawHttp/requestSecurity.ts";
import type { AuthenticateCredential } from "../server/trpc/context.ts";
import { positiveSafeIntegerSchema } from "../shared/validation.ts";
import { createTrpcHttpHandler } from "./trpcHttpHandler.ts";
import { isTrpcRequestPath, serverRequestBodyMaximumBytes } from "./trpcRequestPolicy.ts";

const serverIdleTimeoutSeconds = 10;
const serverGracefulShutdownTimeoutDefaultMs = secondsToMilliseconds(5);
const serverGracefulShutdownTimeoutMaximumMs = secondsToMilliseconds(60);
const serverGracefulShutdownTimeoutMessage =
    "Server graceful shutdown timeout is invalid";
const serverGracefulShutdownTimeoutSchema = v.pipe(
    positiveSafeIntegerSchema(serverGracefulShutdownTimeoutMessage),
    v.maxValue(
        serverGracefulShutdownTimeoutMaximumMs,
        serverGracefulShutdownTimeoutMessage
    )
);

async function primaryErrorAfterCleanup(
    primaryError: unknown,
    cleanup: () => Promise<void> | void
): Promise<unknown> {
    try {
        await cleanup();
    } catch {
        // The process boundary cannot recover from a cleanup double-fault.
        // Preserve the initiating failure, which identifies the original defect.
    }
    return primaryError;
}

async function disposeRuntimeAndFlush(
    applicationRuntime: ApplicationRuntime
): Promise<void> {
    try {
        await applicationRuntime.dispose();
    } catch (error) {
        throw await primaryErrorAfterCleanup(error, () => {
            applicationRuntime.logger.flush();
        });
    }
    applicationRuntime.logger.flush();
}

function responseWithRequestId(response: Response, requestId: string): Response {
    const headers = new Headers(response.headers);
    const cacheDirectives = new Set(
        (headers.get("cache-control") ?? "")
            .toLowerCase()
            .split(",")
            .map((directive) => directive.trim())
    );
    if (!(cacheDirectives.has("public") && cacheDirectives.has("immutable"))) {
        headers.set("x-request-id", requestId);
    }
    return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
    });
}

function requestDurationMs(startedAtMs: number): number {
    const elapsedMs = performance.now() - startedAtMs;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.round(elapsedMs));
}

function requestOutcome(status: number): "rejected" | "server-error" | "success" {
    if (status >= 500) return "server-error";
    if (status >= 400) return "rejected";
    return "success";
}

function internalServerErrorResponse(requestId: string): Response {
    return new Response("Internal Server Error", {
        headers: {
            "cache-control": "no-store",
            "x-request-id": requestId,
        },
        status: 500,
    });
}

function cancelledRequestResponse(requestId: string): Response {
    return new Response(null, {
        headers: {
            "cache-control": "no-store",
            "x-request-id": requestId,
        },
        status: 499,
    });
}

export {
    authenticationRequestBodyMaximumBytes,
    serverRequestBodyMaximumBytes,
    taskContentRequestBodyMaximumBytes,
    taskProgressRequestBodyMaximumBytes,
    trpcMaximumBatchSize,
    trpcRequestBodyMaximumBytes,
} from "./trpcRequestPolicy.ts";

/** Bun server startup dependencies and listen options. */
export interface ServerOptions {
    readonly agentService: AgentService["Service"];
    readonly applicationRuntime: ApplicationRuntime;
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly automationSecurityLifecycle: AutomationSecurityLifecycleService;
    readonly authenticateCredential: AuthenticateCredential;
    /** Explicit public browser origin when TLS terminates at a trusted proxy. */
    readonly browserOrigin?: string;
    /** Manifest-indexed browser artifacts and controlled SPA navigation. */
    readonly frontendAssets?: FrontendAssetHandler;
    /** Graceful request-drain budget before active connections are forced closed. */
    readonly gracefulShutdownTimeoutMs?: number;
    readonly hostname?: string;
    readonly mfaAccountLifecycle: MfaAccountLifecycleService;
    readonly mfaLoginLifecycle: MfaLoginLifecycleService;
    readonly port: number;
    readonly readiness: ReadinessController;
    readonly securityAuditLifecycle: SecurityAuditLifecycleService;
    readonly taskService: TaskService["Service"];
    /** Exact proxy peers allowed to supply one overwritten client address. */
    readonly trustedProxyAddresses?: readonly string[];
}

/** Bun listener and coordinated process-runtime shutdown boundary. */
export interface ApplicationServer {
    readonly port: number;
    readonly url: URL;
    stop(force?: boolean): Promise<void>;
}

/**
 * Prewarms process services and then creates the one Bun HTTP server.
 * @param options Server listen options.
 * @returns A started Bun server.
 */
export async function createServer(options: ServerOptions): Promise<ApplicationServer> {
    try {
        const logger = options.applicationRuntime.logger;
        readRuntimeIdentity();
        const gracefulShutdownTimeoutMs = v.parse(
            serverGracefulShutdownTimeoutSchema,
            options.gracefulShutdownTimeoutMs ?? serverGracefulShutdownTimeoutDefaultMs
        );
        const browserOrigin =
            options.browserOrigin === undefined
                ? undefined
                : parseBrowserOrigin(options.browserOrigin);
        const handleTrpcHttpRequest = createTrpcHttpHandler({
            agentService: options.agentService,
            applicationRuntime: options.applicationRuntime,
            authenticateCredential: options.authenticateCredential,
            authenticationLifecycle: options.authenticationLifecycle,
            automationSecurityLifecycle: options.automationSecurityLifecycle,
            browserOrigin,
            mfaAccountLifecycle: options.mfaAccountLifecycle,
            mfaLoginLifecycle: options.mfaLoginLifecycle,
            securityAuditLifecycle: options.securityAuditLifecycle,
            taskService: options.taskService,
            trustedProxyAddresses: options.trustedProxyAddresses,
        });
        await options.applicationRuntime.initialize();

        const server = Bun.serve({
            async fetch(request, bunServer) {
                const requestId = crypto.randomUUID();
                const startedAtMs = performance.now();
                try {
                    const requestUrl = new URL(request.url);
                    const pathname = requestUrl.pathname;
                    let response: Response;
                    if (isTrpcRequestPath(pathname)) {
                        response = await handleTrpcHttpRequest(
                            request,
                            requestUrl,
                            bunServer,
                            requestId
                        );
                    } else {
                        const healthProbeMethod: HealthProbeMethod | undefined =
                            request.method === "GET" || request.method === "HEAD"
                                ? request.method
                                : undefined;
                        if (healthProbeMethod && pathname === healthLivenessPath) {
                            response = livenessResponse(healthProbeMethod);
                        } else if (
                            healthProbeMethod &&
                            pathname === healthReadinessPath
                        ) {
                            response = readinessResponse(
                                healthProbeMethod,
                                options.readiness
                            );
                        } else {
                            const frontendResponse = await options.frontendAssets?.(
                                request,
                                requestUrl
                            );
                            response =
                                frontendResponse ??
                                new Response("Not found", { status: 404 });
                        }
                    }
                    if (request.signal.aborted) {
                        logger.info({
                            component: "http",
                            durationMs: requestDurationMs(startedAtMs),
                            event: "http.request.cancelled",
                            fields: { kind: "http-request", method: request.method },
                            outcome: "cancelled",
                            requestId,
                        });
                        return cancelledRequestResponse(requestId);
                    }
                    const correlatedResponse = responseWithRequestId(response, requestId);
                    logger.info({
                        component: "http",
                        durationMs: requestDurationMs(startedAtMs),
                        event: "http.response.created",
                        fields: {
                            kind: "http-response",
                            method: request.method,
                            status: correlatedResponse.status,
                        },
                        outcome: requestOutcome(correlatedResponse.status),
                        requestId,
                    });
                    return correlatedResponse;
                } catch (error) {
                    if (request.signal.aborted) {
                        logger.info({
                            component: "http",
                            durationMs: requestDurationMs(startedAtMs),
                            event: "http.request.cancelled",
                            fields: { kind: "http-request", method: request.method },
                            outcome: "cancelled",
                            requestId,
                        });
                        return cancelledRequestResponse(requestId);
                    }
                    logger.error({
                        component: "http",
                        durationMs: requestDurationMs(startedAtMs),
                        event: "http.request.failed",
                        failure: error,
                        fields: { kind: "http-request", method: request.method },
                        outcome: "server-error",
                        requestId,
                    });
                    return internalServerErrorResponse(requestId);
                }
            },
            hostname: options.hostname,
            idleTimeout: serverIdleTimeoutSeconds,
            maxRequestBodySize: serverRequestBodyMaximumBytes,
            port: options.port,
        });
        let serverPort: number;
        try {
            serverPort = v.parse(
                positiveSafeIntegerSchema("Bun server port is invalid"),
                server.port
            );
        } catch (error) {
            throw await primaryErrorAfterCleanup(error, () => server.stop(true));
        }
        const forceStopController = new AbortController();
        let stopPromise: Promise<void> | undefined;

        return Object.freeze({
            port: serverPort,
            stop(force = false) {
                if (force) forceStopController.abort();
                if (stopPromise !== undefined) return stopPromise;

                // Withdraw readiness before listener drain begins so the proxy stops
                // admitting new work while active HTTP and SSE requests settle.
                options.readiness.markUnavailable();
                stopPromise = (async () => {
                    try {
                        await options.applicationRuntime.shutdownListener({
                            forceSignal: forceStopController.signal,
                            gracefulShutdownTimeoutMs,
                            stop: (forceListener) => server.stop(forceListener),
                        });
                    } catch (error) {
                        // A listener-stop rejection cannot prove that no request can still enter
                        // the runtime. Withdraw readiness and preserve process services for the
                        // supervisor's terminal containment instead of disposing them underneath
                        // a potentially live listener.
                        options.readiness.markUnavailable();
                        throw error;
                    }
                    await disposeRuntimeAndFlush(options.applicationRuntime);
                })();
                return stopPromise;
            },
            url: server.url,
        });
    } catch (error) {
        throw await primaryErrorAfterCleanup(error, () =>
            disposeRuntimeAndFlush(options.applicationRuntime)
        );
    }
}

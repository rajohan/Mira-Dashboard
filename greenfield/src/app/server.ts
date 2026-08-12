import { secondsToMilliseconds } from "date-fns";
import * as v from "valibot";

import { chatAttachmentLimits } from "../contracts/chatMedia.ts";
import { workspaceFileLimits } from "../contracts/files.ts";
import { healthLivenessPath, healthReadinessPath } from "../contracts/system.ts";
import type { AgentService } from "../server/domains/agents/service.ts";
import type { CacheService } from "../server/domains/cache/service.ts";
import type { ChatService } from "../server/domains/chat/service.ts";
import type { WorkspaceFileRawHttpHandler } from "../server/domains/files/rawHttp.ts";
import type { WorkspaceFilesService } from "../server/domains/files/service.ts";
import type { GatewayConnectionService } from "../server/domains/gatewayConnection/service.ts";
import type { GatewaySessionsService } from "../server/domains/gatewaySessions/service.ts";
import type { JobService } from "../server/domains/jobs/service.ts";
import type { LogsService } from "../server/domains/logs/service.ts";
import type { MonitoringCatalogService } from "../server/domains/monitoring/catalogService.ts";
import type { MonitoringService } from "../server/domains/monitoring/service.ts";
import type { OpenClawCronService } from "../server/domains/openClawCron/service.ts";
import type { OpenClawConfigurationBackupRawHttpHandler } from "../server/domains/openClawSettings/configurationBackupRawHttp.ts";
import type { OpenClawSettingsService } from "../server/domains/openClawSettings/service.ts";
import type { OpenClawTasksService } from "../server/domains/openClawTasks/service.ts";
import type { AuthenticationLifecycleService } from "../server/domains/security/authenticationLifecycle.ts";
import type { AutomationSecurityLifecycleService } from "../server/domains/security/automation/lifecycle.ts";
import type { MfaAccountLifecycleService } from "../server/domains/security/mfa/accountLifecycle.ts";
import type { MfaLoginLifecycleService } from "../server/domains/security/mfa/loginLifecycle.ts";
import type { SecurityAuditLifecycleService } from "../server/domains/security/securityAuditLifecycle.ts";
import type { SystemHealthDiagnosticsService } from "../server/domains/system/healthDiagnosticsService.ts";
import type { TaskService } from "../server/domains/tasks/service.ts";
import type { TerminalService } from "../server/domains/terminal/service.ts";
import type { ReadinessController } from "../server/platform/readiness/readinessState.ts";
import type { ApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import { readRuntimeIdentity } from "../server/platform/runtime/readRuntimeIdentity.ts";
import type { ChatRawHttpHandler } from "../server/rawHttp/chatMedia.ts";
import type { FrontendAssetHandler } from "../server/rawHttp/frontendAssets.ts";
import {
    type HealthProbeMethod,
    livenessResponse,
    readinessResponse,
} from "../server/rawHttp/health.ts";
import { parseBrowserOrigin } from "../server/rawHttp/requestSecurity.ts";
import type {
    TerminalSocketBoundary,
    TerminalSocketConnection,
} from "../server/rawHttp/terminalSocket.ts";
import type { AuthenticateCredential } from "../server/trpc/context.ts";
import { positiveSafeIntegerSchema } from "../shared/validation.ts";
import { createTrpcHttpHandler } from "./trpcHttpHandler.ts";
import { isTrpcRequestPath, serverRequestBodyMaximumBytes } from "./trpcRequestPolicy.ts";

/** Listener ceiling for raw uploads; each mounted route retains its own tighter policy. */
export const serverListenerRequestBodyMaximumBytes = Math.max(
    serverRequestBodyMaximumBytes,
    chatAttachmentLimits.maximumFileBytes,
    workspaceFileLimits.maximumUploadBytes
);

const serverIdleTimeoutSeconds = 10;
const disabledTerminalSocketWebSocketHandler = Object.freeze({
    backpressureLimit: 1,
    closeOnBackpressureLimit: true,
    idleTimeout: 1,
    maxPayloadLength: 1,
    message(socket: Bun.ServerWebSocket<TerminalSocketConnection>) {
        socket.close(1011, "Interactive terminal unavailable");
    },
    open(socket: Bun.ServerWebSocket<TerminalSocketConnection>) {
        socket.close(1011, "Interactive terminal unavailable");
    },
    perMessageDeflate: false,
    sendPings: true,
} satisfies Bun.WebSocketHandler<TerminalSocketConnection>);
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
    applicationRuntime: ApplicationRuntime,
    disposeBeforeRuntime?: () => Promise<void> | void
): Promise<void> {
    let lifecycleFailure: unknown;
    let runtimeFailure: unknown;
    try {
        await disposeBeforeRuntime?.();
    } catch (error) {
        lifecycleFailure = error;
    }
    try {
        await applicationRuntime.dispose();
    } catch (error) {
        runtimeFailure = error;
    }
    applicationRuntime.logger.flush();
    if (lifecycleFailure !== undefined) {
        throw lifecycleFailure instanceof Error
            ? lifecycleFailure
            : new Error("Dashboard lifecycle disposal failed", {
                  cause: lifecycleFailure,
              });
    }
    if (runtimeFailure !== undefined) {
        throw runtimeFailure instanceof Error
            ? runtimeFailure
            : new Error("Dashboard runtime disposal failed", { cause: runtimeFailure });
    }
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
    readonly cacheService: CacheService["Service"];
    /** Raw attachment/media routes mounted before browser asset fallback. */
    readonly chatRawHttpHandler?: ChatRawHttpHandler;
    readonly chatService?: ChatService;
    readonly workspaceFilesService?: WorkspaceFilesService;
    /** Ticket-bound Files GET/HEAD/PUT routes mounted before browser asset fallback. */
    readonly workspaceFileRawHttpHandler?: WorkspaceFileRawHttpHandler;
    /** Process-owned domain adapters disposed after listener drain, before runtime DB. */
    readonly disposeBeforeRuntime?: () => Promise<void> | void;
    readonly gatewayConnectionService: GatewayConnectionService;
    readonly gatewaySessionsService: GatewaySessionsService;
    /** Manifest-indexed browser artifacts and controlled SPA navigation. */
    readonly frontendAssets?: FrontendAssetHandler;
    /** Graceful request-drain budget before active connections are forced closed. */
    readonly gracefulShutdownTimeoutMs?: number;
    readonly hostname?: string;
    readonly mfaAccountLifecycle: MfaAccountLifecycleService;
    readonly mfaLoginLifecycle: MfaLoginLifecycleService;
    readonly jobService: JobService["Service"];
    readonly logsService?: LogsService;
    readonly monitoringCatalogService: MonitoringCatalogService["Service"];
    readonly monitoringService: MonitoringService["Service"];
    readonly openClawCronService: OpenClawCronService;
    /** One-shot secret-bearing configuration export mounted before browser assets. */
    readonly openClawConfigurationBackupRawHttpHandler?: OpenClawConfigurationBackupRawHttpHandler;
    readonly openClawSettingsService: OpenClawSettingsService;
    readonly openClawTasksService?: OpenClawTasksService;
    readonly port: number;
    readonly readiness: ReadinessController;
    readonly securityAuditLifecycle: SecurityAuditLifecycleService;
    readonly systemHealthDiagnosticsService: SystemHealthDiagnosticsService;
    readonly taskService: TaskService["Service"];
    readonly terminalService?: TerminalService;
    /** Browser-session-only upgrade boundary for the worker-owned interactive PTY. */
    readonly terminalSocketBoundary?: TerminalSocketBoundary;
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
            cacheService: options.cacheService,
            chatService: options.chatService,
            workspaceFilesService: options.workspaceFilesService,
            gatewayConnectionService: options.gatewayConnectionService,
            gatewaySessionsService: options.gatewaySessionsService,
            mfaAccountLifecycle: options.mfaAccountLifecycle,
            mfaLoginLifecycle: options.mfaLoginLifecycle,
            jobService: options.jobService,
            ...(options.logsService === undefined
                ? {}
                : { logsService: options.logsService }),
            monitoringCatalogService: options.monitoringCatalogService,
            monitoringService: options.monitoringService,
            openClawCronService: options.openClawCronService,
            openClawSettingsService: options.openClawSettingsService,
            openClawTasksService: options.openClawTasksService,
            securityAuditLifecycle: options.securityAuditLifecycle,
            systemHealthDiagnosticsService: options.systemHealthDiagnosticsService,
            taskService: options.taskService,
            ...(options.terminalService === undefined
                ? {}
                : { terminalService: options.terminalService }),
            trustedProxyAddresses: options.trustedProxyAddresses,
        });
        await options.applicationRuntime.initialize();

        const server = Bun.serve<TerminalSocketConnection>({
            async fetch(request, bunServer) {
                const requestId = crypto.randomUUID();
                const startedAtMs = performance.now();
                try {
                    const requestUrl = new URL(request.url);
                    const pathname = requestUrl.pathname;
                    const terminalSocketResult =
                        await options.terminalSocketBoundary?.handle(
                            request,
                            requestUrl,
                            bunServer
                        );
                    if (terminalSocketResult?.kind === "upgraded") return;
                    let response: Response;
                    if (terminalSocketResult?.kind === "response") {
                        response = terminalSocketResult.response;
                    } else if (isTrpcRequestPath(pathname)) {
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
                            const workspaceFileResponse =
                                await options.workspaceFileRawHttpHandler?.(
                                    request,
                                    requestUrl
                                );
                            const configurationBackupResponse =
                                workspaceFileResponse ??
                                (await options.openClawConfigurationBackupRawHttpHandler?.(
                                    request,
                                    requestUrl
                                ));
                            const chatResponse =
                                configurationBackupResponse ??
                                (await options.chatRawHttpHandler?.(request, requestUrl));
                            if (chatResponse === undefined) {
                                const frontendResponse = await options.frontendAssets?.(
                                    request,
                                    requestUrl
                                );
                                response =
                                    frontendResponse ??
                                    new Response("Not found", { status: 404 });
                            } else {
                                response = chatResponse;
                            }
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
            maxRequestBodySize: serverListenerRequestBodyMaximumBytes,
            port: options.port,
            websocket:
                options.terminalSocketBoundary?.websocket ??
                disabledTerminalSocketWebSocketHandler,
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
                options.terminalSocketBoundary?.shutdown();
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
                    await disposeRuntimeAndFlush(
                        options.applicationRuntime,
                        options.disposeBeforeRuntime
                    );
                })();
                return stopPromise;
            },
            url: server.url,
        });
    } catch (error) {
        throw await primaryErrorAfterCleanup(error, async () => {
            options.terminalSocketBoundary?.shutdown();
            await disposeRuntimeAndFlush(
                options.applicationRuntime,
                options.disposeBeforeRuntime
            );
        });
    }
}

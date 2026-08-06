import { secondsToMilliseconds } from "date-fns";
import * as v from "valibot";

import { healthLivenessPath, healthReadinessPath } from "../contracts/system.ts";
import type { AuthenticationLifecycleService } from "../server/domains/security/authenticationLifecycle.ts";
import type { AutomationSecurityLifecycleService } from "../server/domains/security/automation/lifecycle.ts";
import type { MfaAccountLifecycleService } from "../server/domains/security/mfa/accountLifecycle.ts";
import type { MfaLoginLifecycleService } from "../server/domains/security/mfa/loginLifecycle.ts";
import type { ReadinessController } from "../server/platform/readiness/readinessState.ts";
import type { ApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import { readRuntimeIdentity } from "../server/platform/runtime/readRuntimeIdentity.ts";
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
    cleanup: () => Promise<void>
): Promise<unknown> {
    try {
        await cleanup();
    } catch {
        // The process boundary cannot recover from a cleanup double-fault.
        // Preserve the initiating failure, which identifies the original defect.
    }
    return primaryError;
}

export {
    authenticationRequestBodyMaximumBytes,
    serverRequestBodyMaximumBytes,
    trpcMaximumBatchSize,
    trpcRequestBodyMaximumBytes,
} from "./trpcRequestPolicy.ts";

/** Bun server startup dependencies and listen options. */
export interface ServerOptions {
    readonly applicationRuntime: ApplicationRuntime;
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly automationSecurityLifecycle: AutomationSecurityLifecycleService;
    readonly authenticateCredential: AuthenticateCredential;
    /** Explicit public browser origin when TLS terminates at a trusted proxy. */
    readonly browserOrigin?: string;
    /** Graceful request-drain budget before active connections are forced closed. */
    readonly gracefulShutdownTimeoutMs?: number;
    readonly hostname?: string;
    readonly mfaAccountLifecycle: MfaAccountLifecycleService;
    readonly mfaLoginLifecycle: MfaLoginLifecycleService;
    readonly port: number;
    readonly readiness: ReadinessController;
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
            applicationRuntime: options.applicationRuntime,
            authenticateCredential: options.authenticateCredential,
            authenticationLifecycle: options.authenticationLifecycle,
            automationSecurityLifecycle: options.automationSecurityLifecycle,
            browserOrigin,
            mfaAccountLifecycle: options.mfaAccountLifecycle,
            mfaLoginLifecycle: options.mfaLoginLifecycle,
            trustedProxyAddresses: options.trustedProxyAddresses,
        });
        await options.applicationRuntime.initialize();

        const server = Bun.serve({
            async fetch(request, bunServer) {
                const requestUrl = new URL(request.url);
                const pathname = requestUrl.pathname;
                if (isTrpcRequestPath(pathname)) {
                    return handleTrpcHttpRequest(request, requestUrl, bunServer);
                }
                const healthProbeMethod: HealthProbeMethod | undefined =
                    request.method === "GET" || request.method === "HEAD"
                        ? request.method
                        : undefined;
                if (healthProbeMethod && pathname === healthLivenessPath) {
                    return livenessResponse(healthProbeMethod);
                }
                if (healthProbeMethod && pathname === healthReadinessPath) {
                    return readinessResponse(healthProbeMethod, options.readiness);
                }
                return new Response("Not found", { status: 404 });
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
                stopPromise ??= (async () => {
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
                    await options.applicationRuntime.dispose();
                })();
                return stopPromise;
            },
            url: server.url,
        });
    } catch (error) {
        throw await primaryErrorAfterCleanup(error, () =>
            options.applicationRuntime.dispose()
        );
    }
}

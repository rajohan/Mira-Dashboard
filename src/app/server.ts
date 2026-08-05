import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { secondsToMilliseconds } from "date-fns";
import * as v from "valibot";

import type { AuthenticationLifecycleService } from "../server/domains/security/authenticationLifecycle.ts";
import { hasAmbiguousAuthenticationCredentials } from "../server/domains/security/requestAuthentication.ts";
import type { ReadinessState } from "../server/platform/readiness/readinessState.ts";
import type { ApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import { readRuntimeIdentity } from "../server/platform/runtime/readRuntimeIdentity.ts";
import { createAuthenticationClientSourceResolver } from "../server/rawHttp/authenticationClientSource.ts";
import {
    type HealthProbeMethod,
    livenessResponse,
    readinessResponse,
} from "../server/rawHttp/health.ts";
import {
    isAllowedRequestSource,
    parseBrowserOrigin,
} from "../server/rawHttp/requestSecurity.ts";
import { appRouter } from "../server/trpc/appRouter.ts";
import {
    createRequestContext,
    type AuthenticateRequest,
} from "../server/trpc/context.ts";
import { positiveSafeIntegerSchema } from "../shared/validation.ts";

const trpcEndpoint = "/trpc";
const authenticationProcedurePrefix = "auth.";
const batchableAuthenticationProcedures = new Set(["auth.sessions", "auth.status"]);
const longLivedTrpcProcedures = new Set(["events.stream"]);
const serverIdleTimeoutSeconds = 10;
const authenticationHandlerIdleTimeoutSeconds = 120;
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

function createShutdownDeadline(timeoutMs: number): {
    cancel(): void;
    readonly outcome: Promise<"timed-out">;
} {
    const deadline = Promise.withResolvers<"timed-out">();
    const timeout = setTimeout(() => deadline.resolve("timed-out"), timeoutMs);
    return {
        cancel: () => clearTimeout(timeout),
        outcome: deadline.promise,
    };
}

async function primaryErrorAfterCleanup(
    primaryError: unknown,
    cleanup: () => Promise<void>
): Promise<unknown> {
    try {
        await cleanup();
    } catch {
        // The process boundary cannot recover from a cleanup double-fault.
        // Preserve the initiating failure, which identifies the startup defect.
    }
    return primaryError;
}

/** Bun-level ceiling for every request before the Fetch handler is invoked. */
export const serverRequestBodyMaximumBytes = 64 * 1024;
/** Default raw body ceiling for current non-authentication tRPC procedures. */
export const trpcRequestBodyMaximumBytes = serverRequestBodyMaximumBytes;
/** Raw body ceiling for public and authenticated authentication procedures. */
export const authenticationRequestBodyMaximumBytes = 16 * 1024;
/** Maximum procedure count accepted by the tRPC adapter in one request. */
export const trpcMaximumBatchSize = 8;

interface TrpcProcedureSelection {
    readonly containsAuthenticationProcedure: boolean;
    readonly containsDisallowedAuthenticationBatchProcedure: boolean;
    readonly containsLongLivedProcedure: boolean;
}

function readTrpcProcedureSelection(url: URL): TrpcProcedureSelection {
    const encodedProcedures = url.pathname.slice(`${trpcEndpoint}/`.length);
    try {
        const procedures = decodeURIComponent(encodedProcedures)
            .split(",")
            .map((procedure) => procedure.replace(/\/+$/u, ""));
        const authenticationProcedures = procedures.filter((procedure) =>
            procedure.startsWith(authenticationProcedurePrefix)
        );
        return {
            containsAuthenticationProcedure: authenticationProcedures.length > 0,
            containsDisallowedAuthenticationBatchProcedure: authenticationProcedures.some(
                (procedure) => !batchableAuthenticationProcedures.has(procedure)
            ),
            containsLongLivedProcedure: procedures.some((procedure) =>
                longLivedTrpcProcedures.has(procedure)
            ),
        };
    } catch {
        const containsAuthenticationProcedure = /(?:^|,|%2c)auth(?:\.|%2e)/iu.test(
            encodedProcedures
        );
        return {
            containsAuthenticationProcedure,
            containsDisallowedAuthenticationBatchProcedure:
                containsAuthenticationProcedure,
            containsLongLivedProcedure: false,
        };
    }
}

async function cancelRequestBody(request: Request, reason: string): Promise<void> {
    if (request.body === null) return;
    try {
        await request.body.cancel(reason);
    } catch {
        // The peer may have already closed while the rejected body was cancelled.
    }
}

function noStoreTextResponse(body: string, status: number): Response {
    return new Response(body, {
        headers: { "cache-control": "no-store" },
        status,
    });
}

function trpcMethodNotAllowedResponse(): Response {
    return new Response(null, {
        headers: {
            allow: "GET, POST",
            "cache-control": "no-store",
        },
        status: 405,
    });
}

function declaredBodyExceedsLimit(request: Request, maximumBytes: number): boolean {
    const contentLength = request.headers.get("content-length")?.trim();
    return (
        contentLength !== undefined &&
        /^\d+$/u.test(contentLength) &&
        Number(contentLength) > maximumBytes
    );
}

function requestDeclaresBody(request: Request): boolean {
    const contentLength = request.headers.get("content-length")?.trim();
    return (
        request.body !== null ||
        request.headers.get("transfer-encoding") !== null ||
        (contentLength !== undefined &&
            (!/^\d+$/u.test(contentLength) || Number(contentLength) > 0))
    );
}

type BoundedRequestBodyResult =
    | { readonly kind: "accepted"; readonly request: Request }
    | { readonly kind: "too-large" };

async function requestWithBoundedBody(
    request: Request,
    maximumBytes: number
): Promise<BoundedRequestBodyResult> {
    request.signal.throwIfAborted();
    if (declaredBodyExceedsLimit(request, maximumBytes)) {
        await cancelRequestBody(request, "tRPC request body is too large");
        return { kind: "too-large" };
    }
    if (request.body === null) return { kind: "accepted", request };

    const reader = (request.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            request.signal.throwIfAborted();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maximumBytes) {
                await reader.cancel("tRPC request body is too large").catch(() => {});
                return { kind: "too-large" };
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return {
        kind: "accepted",
        // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- GET and HEAD bodies are rejected before this request is rebuilt.
        request: new Request(request, { body, signal: request.signal }),
    };
}

/** Bun server startup dependencies and listen options. */
export interface ServerOptions {
    readonly applicationRuntime: ApplicationRuntime;
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly authenticateRequest: AuthenticateRequest;
    /** Explicit public browser origin when TLS terminates at a trusted proxy. */
    readonly browserOrigin?: string;
    /** Graceful request-drain budget before active connections are forced closed. */
    readonly gracefulShutdownTimeoutMs?: number;
    readonly hostname?: string;
    readonly port: number;
    readonly readiness: ReadinessState;
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
        const authenticationClientSource = createAuthenticationClientSourceResolver({
            trustedProxyAddresses: options.trustedProxyAddresses,
        });
        await options.applicationRuntime.initialize();

        const server = Bun.serve({
            async fetch(request, bunServer) {
                const requestUrl = new URL(request.url);
                const pathname = requestUrl.pathname;
                const isTrpcRequest =
                    pathname === trpcEndpoint || pathname.startsWith(`${trpcEndpoint}/`);
                if (isTrpcRequest) {
                    if (!isAllowedRequestSource(request, browserOrigin)) {
                        return noStoreTextResponse("Forbidden", 403);
                    }
                    if (hasAmbiguousAuthenticationCredentials(request)) {
                        return noStoreTextResponse(
                            "Ambiguous authentication credentials",
                            400
                        );
                    }
                    if (request.method === "HEAD") {
                        await cancelRequestBody(
                            request,
                            "tRPC HEAD requests are not allowed"
                        );
                        return trpcMethodNotAllowedResponse();
                    }
                    const procedureSelection = readTrpcProcedureSelection(requestUrl);
                    if (
                        requestUrl.searchParams.get("batch") === "1" &&
                        procedureSelection.containsDisallowedAuthenticationBatchProcedure
                    ) {
                        return noStoreTextResponse(
                            "Authentication procedure is not batchable",
                            400
                        );
                    }
                    const authenticationClientSourceId =
                        authenticationClientSource.resolve(
                            request,
                            bunServer.requestIP(request)?.address
                        );
                    if (request.method === "GET" && requestDeclaresBody(request)) {
                        await cancelRequestBody(
                            request,
                            "tRPC GET bodies are not allowed"
                        );
                        return noStoreTextResponse(
                            "tRPC GET bodies are not allowed",
                            400
                        );
                    }
                    const boundedBody = await requestWithBoundedBody(
                        request,
                        procedureSelection.containsAuthenticationProcedure
                            ? authenticationRequestBodyMaximumBytes
                            : trpcRequestBodyMaximumBytes
                    );
                    if (boundedBody.kind === "too-large") {
                        return noStoreTextResponse("Request body is too large", 413);
                    }
                    if (procedureSelection.containsLongLivedProcedure) {
                        bunServer.timeout(request, 0);
                    } else if (procedureSelection.containsAuthenticationProcedure) {
                        // The body is already bounded. Allow the lifecycle's own queue,
                        // Gateway deadline, and Argon work budgets to finish normally.
                        bunServer.timeout(
                            request,
                            authenticationHandlerIdleTimeoutSeconds
                        );
                    }
                    return fetchRequestHandler({
                        createContext: ({ req, resHeaders }) =>
                            createRequestContext({
                                applicationRuntime: options.applicationRuntime,
                                authenticationClientSourceId,
                                authenticationLifecycle: options.authenticationLifecycle,
                                authenticateRequest: options.authenticateRequest,
                                request: req,
                                responseHeaders: resHeaders,
                            }),
                        endpoint: trpcEndpoint,
                        maxBatchSize: trpcMaximumBatchSize,
                        req: boundedBody.request,
                        responseMeta: () => ({
                            headers: new Headers({ "cache-control": "no-store" }),
                        }),
                        router: appRouter,
                    });
                }
                const healthProbeMethod: HealthProbeMethod | undefined =
                    request.method === "GET" || request.method === "HEAD"
                        ? request.method
                        : undefined;
                if (healthProbeMethod && pathname === "/api/health/live") {
                    return livenessResponse(healthProbeMethod);
                }
                if (healthProbeMethod && pathname === "/api/health/ready") {
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
        const forceStopRequest = Promise.withResolvers<"forced">();
        let forceStopRequested = false;
        let stopPromise: Promise<void> | undefined;

        return Object.freeze({
            port: serverPort,
            stop(force = false) {
                if (force && !forceStopRequested) {
                    forceStopRequested = true;
                    forceStopRequest.resolve("forced");
                }
                stopPromise ??= (async () => {
                    try {
                        if (forceStopRequested) {
                            await server.stop(true);
                            return;
                        }

                        const gracefulStop = server.stop(false);
                        const deadline = createShutdownDeadline(
                            gracefulShutdownTimeoutMs
                        );
                        try {
                            const outcome = await Promise.race([
                                gracefulStop.then(() => "drained" as const),
                                forceStopRequest.promise,
                                deadline.outcome,
                            ]);
                            if (outcome !== "drained") {
                                await server.stop(true);
                            }
                        } finally {
                            deadline.cancel();
                        }
                    } finally {
                        await options.applicationRuntime.dispose();
                    }
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

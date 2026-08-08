import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import type { AgentService } from "../server/domains/agents/service.ts";
import type { JobService } from "../server/domains/jobs/service.ts";
import type { MonitoringCatalogService } from "../server/domains/monitoring/catalogService.ts";
import type { MonitoringService } from "../server/domains/monitoring/service.ts";
import type { AuthenticationLifecycleService } from "../server/domains/security/authenticationLifecycle.ts";
import type { AutomationSecurityLifecycleService } from "../server/domains/security/automation/lifecycle.ts";
import type { MfaAccountLifecycleService } from "../server/domains/security/mfa/accountLifecycle.ts";
import type { MfaLoginLifecycleService } from "../server/domains/security/mfa/loginLifecycle.ts";
import type { SecurityAuditLifecycleService } from "../server/domains/security/securityAuditLifecycle.ts";
import type { TaskService } from "../server/domains/tasks/service.ts";
import type { ApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import { createAuthenticationClientSourceResolver } from "../server/rawHttp/authenticationClientSource.ts";
import { readAuthenticationHttpCredentials } from "../server/rawHttp/authenticationCredentials.ts";
import { isAllowedRequestSource } from "../server/rawHttp/requestSecurity.ts";
import { appRouter } from "../server/trpc/appRouter.ts";
import {
    type AuthenticateCredential,
    createRequestContext,
} from "../server/trpc/context.ts";
import {
    readTrpcRequestPolicy,
    trpcEndpoint,
    trpcMaximumBatchSize,
} from "./trpcRequestPolicy.ts";

interface TrpcBunServer {
    requestIP(request: Request): { readonly address: string } | null;
    timeout(request: Request, seconds: number): void;
}

/** Dependencies owned by the application composition root, excluding listener lifecycle. */
export interface TrpcHttpHandlerOptions {
    readonly agentService: AgentService["Service"];
    readonly applicationRuntime: ApplicationRuntime;
    readonly authenticateCredential: AuthenticateCredential;
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly automationSecurityLifecycle: AutomationSecurityLifecycleService;
    readonly browserOrigin?: string;
    readonly mfaAccountLifecycle: MfaAccountLifecycleService;
    readonly mfaLoginLifecycle: MfaLoginLifecycleService;
    readonly jobService: JobService["Service"];
    readonly monitoringCatalogService: MonitoringCatalogService["Service"];
    readonly monitoringService: MonitoringService["Service"];
    readonly securityAuditLifecycle: SecurityAuditLifecycleService;
    readonly taskService: TaskService["Service"];
    readonly trustedProxyAddresses?: readonly string[];
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

async function requestWithBoundedPostBody(
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
        request: new Request(request, {
            body,
            method: "POST",
            signal: request.signal,
        }),
    };
}

/**
 * Builds the tRPC HTTP adapter with strict pre-context security and resource policy.
 * @returns Handler invoked only for requests under the exact tRPC mount.
 */
export function createTrpcHttpHandler(options: TrpcHttpHandlerOptions) {
    const authenticationClientSource = createAuthenticationClientSourceResolver({
        trustedProxyAddresses: options.trustedProxyAddresses,
    });

    async function dispatchTrpcHttpRequest(
        request: Request,
        requestUrl: URL,
        bunServer: TrpcBunServer,
        requestId: string
    ): Promise<Response> {
        if (!isAllowedRequestSource(request, options.browserOrigin)) {
            await cancelRequestBody(request, "tRPC request source is forbidden");
            return noStoreTextResponse("Forbidden", 403);
        }
        const credentials = readAuthenticationHttpCredentials(request);
        if (credentials.isAmbiguous) {
            await cancelRequestBody(
                request,
                "tRPC authentication credentials are ambiguous"
            );
            return noStoreTextResponse("Ambiguous authentication credentials", 400);
        }
        if (request.method !== "GET" && request.method !== "POST") {
            await cancelRequestBody(
                request,
                `tRPC ${request.method} requests are not allowed`
            );
            return trpcMethodNotAllowedResponse();
        }
        const requestPolicy = readTrpcRequestPolicy(requestUrl);
        if (requestPolicy.rejectsBatch) {
            await cancelRequestBody(
                request,
                "tRPC security procedure batch is forbidden"
            );
            return noStoreTextResponse("Security procedure is not batchable", 400);
        }
        const authenticationClientSourceId = authenticationClientSource.resolve(
            request,
            bunServer.requestIP(request)?.address
        );
        if (request.method === "GET" && requestDeclaresBody(request)) {
            await cancelRequestBody(request, "tRPC GET bodies are not allowed");
            return noStoreTextResponse("tRPC GET bodies are not allowed", 400);
        }
        let adapterRequest = request;
        if (request.method === "POST") {
            const boundedBody = await requestWithBoundedPostBody(
                request,
                requestPolicy.requestBodyMaximumBytes
            );
            if (boundedBody.kind === "too-large") {
                return noStoreTextResponse("Request body is too large", 413);
            }
            adapterRequest = boundedBody.request;
        }
        if (requestPolicy.handlerIdleTimeoutSeconds !== undefined) {
            bunServer.timeout(request, requestPolicy.handlerIdleTimeoutSeconds);
        }
        return fetchRequestHandler({
            createContext: ({ req, resHeaders }) =>
                createRequestContext({
                    agentService: options.agentService,
                    applicationRuntime: options.applicationRuntime,
                    authenticationClientSourceId,
                    authenticationCredential: credentials.authentication,
                    authenticationLifecycle: options.authenticationLifecycle,
                    automationSecurityLifecycle: options.automationSecurityLifecycle,
                    authenticateCredential: options.authenticateCredential,
                    mfaAccountLifecycle: options.mfaAccountLifecycle,
                    mfaLoginLifecycle: options.mfaLoginLifecycle,
                    jobService: options.jobService,
                    monitoringCatalogService: options.monitoringCatalogService,
                    monitoringService: options.monitoringService,
                    pendingLoginCredential: credentials.pendingLogin,
                    request: req,
                    requestId,
                    responseHeaders: resHeaders,
                    securityAuditLifecycle: options.securityAuditLifecycle,
                    taskService: options.taskService,
                }),
            endpoint: trpcEndpoint,
            maxBatchSize: trpcMaximumBatchSize,
            onError: ({ error, path, type }) => {
                if (
                    error.code !== "INTERNAL_SERVER_ERROR" ||
                    request.signal.aborted ||
                    adapterRequest.signal.aborted
                ) {
                    return;
                }
                options.applicationRuntime.logger.error({
                    component: "trpc",
                    event: "trpc.request.defect",
                    failure: error.cause ?? error,
                    fields: {
                        kind: "trpc-defect",
                        path,
                        procedureType: type,
                    },
                    outcome: "server-error",
                    requestId,
                });
            },
            req: adapterRequest,
            responseMeta: () => ({
                headers: new Headers({ "cache-control": "no-store" }),
            }),
            router: appRouter,
        });
    }

    return dispatchTrpcHttpRequest;
}

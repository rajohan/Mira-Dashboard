import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import type { QualificationEventFeed } from "../realtime/eventFeed.ts";
import { QualificationReleaseReadiness } from "../topology/releaseReadiness.ts";
import { createQualificationRouter } from "./router.ts";

const trpcEndpoint = "/trpc";

/** Transport ceiling covering the escaped 8 KiB qualification payload contract. */
export const qualificationRequestBodyMaximumBytes = 64 * 1024;

/** Runtime options for one ephemeral qualification release. */
export interface QualificationServerOptions {
    eventFeed: QualificationEventFeed;
    hostname?: string;
    maximumStreamDurationMs?: number;
    port?: number;
    releaseId: string;
    requiredCookie?: string;
    requireSecureProxy?: boolean;
}

function healthResponse(
    method: "GET" | "HEAD",
    payload: { releaseId: string; status: "live" | "not-ready" | "ready" },
    status: 200 | 503
): Response {
    return new Response(method === "HEAD" ? null : JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
        status,
    });
}

function rejectedProxyRequest(request: Request, options: QualificationServerOptions) {
    if (!options.requireSecureProxy) {
        return null;
    }
    if (request.headers.get("x-forwarded-proto") !== "https") {
        return new Response("Secure proxy metadata required", { status: 400 });
    }
    if (
        options.requiredCookie !== undefined &&
        request.headers.get("cookie") !== options.requiredCookie
    ) {
        return new Response("Qualification credential required", { status: 401 });
    }
    return null;
}

/**
 * Starts an ephemeral Bun HTTP server around the tRPC Fetch adapter.
 * @param options Release identity, event source, and listener options.
 * @returns A controlled qualification release.
 */
export function startQualificationServer(options: QualificationServerOptions) {
    const readiness = new QualificationReleaseReadiness(options.releaseId);
    const router = createQualificationRouter({
        maximumStreamDurationMs: options.maximumStreamDurationMs,
    });
    const server = Bun.serve({
        fetch(request) {
            const pathname = new URL(request.url).pathname;
            const method = request.method;
            const healthMethod = method === "GET" || method === "HEAD" ? method : null;
            if (healthMethod && pathname === "/api/health/live") {
                return healthResponse(
                    healthMethod,
                    { releaseId: options.releaseId, status: "live" },
                    200
                );
            }
            if (healthMethod && pathname === "/api/health/ready") {
                const snapshot = readiness.snapshot();
                return healthResponse(
                    healthMethod,
                    snapshot,
                    snapshot.status === "ready" ? 200 : 503
                );
            }
            if (pathname === trpcEndpoint || pathname.startsWith(`${trpcEndpoint}/`)) {
                const rejection = rejectedProxyRequest(request, options);
                if (rejection) {
                    return rejection;
                }
                return fetchRequestHandler({
                    createContext: () => ({
                        eventFeed: options.eventFeed,
                        releaseId: options.releaseId,
                    }),
                    endpoint: trpcEndpoint,
                    req: request,
                    router,
                });
            }
            return new Response("Not found", { status: 404 });
        },
        hostname: options.hostname,
        maxRequestBodySize: qualificationRequestBodyMaximumBytes,
        port: options.port ?? 0,
    });
    let stopPromise: Promise<void> | undefined;

    return {
        port: server.port,
        readiness,
        releaseId: options.releaseId,
        server,
        stop(force = true): Promise<void> {
            readiness.markStopping();
            stopPromise ??= server.stop(force);
            return stopPromise;
        },
        url: server.url,
    };
}

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import type { ReadinessState } from "../server/platform/readiness/readinessState.ts";
import { readRuntimeIdentity } from "../server/platform/runtime/readRuntimeIdentity.ts";
import {
    type HealthProbeMethod,
    livenessResponse,
    readinessResponse,
} from "../server/rawHttp/health.ts";
import { appRouter } from "../server/trpc/appRouter.ts";
import { createRequestContext } from "../server/trpc/context.ts";

const trpcEndpoint = "/trpc";

/** Transport ceiling sized for the bounded worst-case monitoring snapshot contract. */
export const serverRequestBodyMaximumBytes = 16 * 1024 * 1024;

/** Bun server startup dependencies and listen options. */
export interface ServerOptions {
    hostname?: string;
    port: number;
    readiness: ReadinessState;
}

/**
 * Creates the Bun HTTP server after validating the runtime baseline.
 * @param options Server listen options.
 * @returns A started Bun server.
 */
export function createServer(options: ServerOptions) {
    readRuntimeIdentity();

    return Bun.serve({
        fetch(request) {
            const pathname = new URL(request.url).pathname;
            const isTrpcRequest =
                pathname === trpcEndpoint || pathname.startsWith(`${trpcEndpoint}/`);
            if (isTrpcRequest) {
                return fetchRequestHandler({
                    createContext: createRequestContext,
                    endpoint: trpcEndpoint,
                    req: request,
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
        maxRequestBodySize: serverRequestBodyMaximumBytes,
        port: options.port,
    });
}

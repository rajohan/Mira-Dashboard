import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { livenessResponse, readinessResponse } from "../server/rawHttp/health.ts";
import { appRouter } from "../server/trpc/appRouter.ts";
import { createRequestContext } from "../server/trpc/context.ts";

const trpcEndpoint = "/trpc";

/** Greenfield Bun server startup options. */
export interface GreenfieldServerOptions {
    port: number;
}

/**
 * Creates the greenfield Bun HTTP server without mutating the current production composition.
 * @param options Server listen options.
 * @returns A started Bun server.
 */
export function createGreenfieldServer(options: GreenfieldServerOptions) {
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
            if (request.method === "GET" && pathname === "/api/health/live") {
                return livenessResponse();
            }
            if (request.method === "GET" && pathname === "/api/health/ready") {
                return readinessResponse();
            }
            return new Response("Not found", { status: 404 });
        },
        port: options.port,
    });
}

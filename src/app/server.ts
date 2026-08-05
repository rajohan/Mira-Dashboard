import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import * as v from "valibot";

import type { ReadinessState } from "../server/platform/readiness/readinessState.ts";
import type { ApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import { readRuntimeIdentity } from "../server/platform/runtime/readRuntimeIdentity.ts";
import {
    type HealthProbeMethod,
    livenessResponse,
    readinessResponse,
} from "../server/rawHttp/health.ts";
import { appRouter } from "../server/trpc/appRouter.ts";
import {
    createRequestContext,
    type AuthenticateRequest,
} from "../server/trpc/context.ts";
import { positiveSafeIntegerSchema } from "../shared/validation.ts";

const trpcEndpoint = "/trpc";

/** Transport ceiling sized for the bounded worst-case monitoring snapshot contract. */
export const serverRequestBodyMaximumBytes = 16 * 1024 * 1024;

/** Bun server startup dependencies and listen options. */
export interface ServerOptions {
    readonly applicationRuntime: ApplicationRuntime;
    readonly authenticateRequest: AuthenticateRequest;
    readonly hostname?: string;
    readonly port: number;
    readonly readiness: ReadinessState;
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
        await options.applicationRuntime.initialize();

        const server = Bun.serve({
            fetch(request) {
                const pathname = new URL(request.url).pathname;
                const isTrpcRequest =
                    pathname === trpcEndpoint || pathname.startsWith(`${trpcEndpoint}/`);
                if (isTrpcRequest) {
                    return fetchRequestHandler({
                        createContext: ({ req }) =>
                            createRequestContext({
                                applicationRuntime: options.applicationRuntime,
                                authenticateRequest: options.authenticateRequest,
                                request: req,
                            }),
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
        let serverPort: number;
        try {
            serverPort = v.parse(
                positiveSafeIntegerSchema("Bun server port is invalid"),
                server.port
            );
        } catch (error) {
            await server.stop(true);
            throw error;
        }
        let stopPromise: Promise<void> | undefined;

        return Object.freeze({
            port: serverPort,
            stop(force = false) {
                stopPromise ??= (async () => {
                    try {
                        await server.stop(force);
                    } finally {
                        await options.applicationRuntime.dispose();
                    }
                })();
                return stopPromise;
            },
            url: server.url,
        });
    } catch (error) {
        await options.applicationRuntime.dispose();
        throw error;
    }
}

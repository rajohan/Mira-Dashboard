import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import { createAuthenticationRepository } from "../server/domains/security/repository.ts";
import { createRequestAuthenticator } from "../server/domains/security/requestAuthentication.ts";
import { createServer, type ApplicationServer, type ServerOptions } from "./server.ts";

/** Production composition inputs above the generic Bun/tRPC server primitive. */
export interface DashboardServerOptions extends Omit<
    ServerOptions,
    "authenticateRequest" | "browserOrigin"
> {
    readonly authenticationLeaseDurationMs?: number;
    /** Canonical public origin used by browser Origin checks behind the proxy. */
    readonly browserOrigin: string;
    readonly database: SQLiteBunDatabase;
    readonly sessionIdleDurationMs?: number;
}

/**
 * Wires the migrated SQLite identity store into real request authentication.
 * The caller retains database and process-runtime lifecycle ownership.
 * @param options Server, database, and bounded authentication policy options.
 * @returns A started Bun server using persisted session and automation identities.
 */
export function createDashboardServer(
    options: DashboardServerOptions
): Promise<ApplicationServer> {
    const repository = createAuthenticationRepository(options.database);
    const authenticator = createRequestAuthenticator({
        authenticationLeaseDurationMs: options.authenticationLeaseDurationMs,
        repository,
        sessionIdleDurationMs: options.sessionIdleDurationMs,
    });
    return createServer({
        applicationRuntime: options.applicationRuntime,
        authenticateRequest: (request) => authenticator.authenticate(request),
        browserOrigin: options.browserOrigin,
        gracefulShutdownTimeoutMs: options.gracefulShutdownTimeoutMs,
        hostname: options.hostname,
        port: options.port,
        readiness: options.readiness,
    });
}

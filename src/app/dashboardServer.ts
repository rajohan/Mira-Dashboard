import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import {
    createAuthenticationLifecycleService,
    type VerifyGatewayCredential,
} from "../server/domains/security/authenticationLifecycle.ts";
import { createAuthenticationLifecycleRepository } from "../server/domains/security/lifecycleRepository.ts";
import { createAuthenticationRepository } from "../server/domains/security/repository.ts";
import { createRequestAuthenticator } from "../server/domains/security/requestAuthentication.ts";
import { createServer, type ApplicationServer, type ServerOptions } from "./server.ts";

/** Production composition inputs above the generic Bun/tRPC server primitive. */
export interface DashboardServerOptions extends Omit<
    ServerOptions,
    "authenticateRequest" | "authenticationLifecycle" | "browserOrigin" | "hostname"
> {
    readonly authenticationLeaseDurationMs?: number;
    /** Canonical public origin used by browser Origin checks behind the proxy. */
    readonly browserOrigin: string;
    readonly database: SQLiteBunDatabase;
    readonly gatewayVerificationTimeoutMs?: number;
    readonly sessionIdleDurationMs?: number;
    readonly trustedProxyAddresses?: readonly string[];
    readonly verifyGatewayCredential: VerifyGatewayCredential;
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
    const authenticationLifecycle = createAuthenticationLifecycleService({
        gatewayVerificationTimeoutMs: options.gatewayVerificationTimeoutMs,
        repository: createAuthenticationLifecycleRepository(options.database),
        sessionIdleDurationMs: options.sessionIdleDurationMs,
        verifyGatewayCredential: options.verifyGatewayCredential,
    });
    return createServer({
        applicationRuntime: options.applicationRuntime,
        authenticationLifecycle,
        authenticateRequest: (request) => authenticator.authenticate(request),
        browserOrigin: options.browserOrigin,
        gracefulShutdownTimeoutMs: options.gracefulShutdownTimeoutMs,
        hostname: "127.0.0.1",
        port: options.port,
        readiness: options.readiness,
        trustedProxyAddresses: options.trustedProxyAddresses,
    });
}

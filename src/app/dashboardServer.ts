import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import {
    createAuthenticationLifecycleService,
    type VerifyGatewayCredential,
} from "../server/domains/security/authenticationLifecycle.ts";
import { createAuthenticationLifecycleRepository } from "../server/domains/security/authenticationLifecycleRepository.ts";
import {
    authenticationWorkBudgetMaximumUnits,
    authenticationWorkBudgetWindowMs,
    totpWorkBudgetMaximumUnits,
    totpWorkBudgetWindowMs,
} from "../server/domains/security/authenticationRateLimit.ts";
import { createAuthenticationWorkBudget } from "../server/domains/security/authenticationWorkBudget.ts";
import { createMfaAccountLifecycleService } from "../server/domains/security/mfa/accountLifecycle.ts";
import { createMfaLifecycleRepository } from "../server/domains/security/mfa/lifecycleRepository.ts";
import { createMfaLoginLifecycleService } from "../server/domains/security/mfa/loginLifecycle.ts";
import type { TotpSecretCipher } from "../server/domains/security/mfa/totpSecretCipher.ts";
import { createRequestAuthenticator } from "../server/domains/security/requestAuthentication.ts";
import { createRequestAuthenticationRepository } from "../server/domains/security/requestAuthenticationRepository.ts";
import { createServer, type ApplicationServer, type ServerOptions } from "./server.ts";

/** Production composition inputs above the generic Bun/tRPC server primitive. */
export interface DashboardServerOptions extends Omit<
    ServerOptions,
    | "authenticateCredential"
    | "authenticationLifecycle"
    | "browserOrigin"
    | "hostname"
    | "mfaAccountLifecycle"
    | "mfaLoginLifecycle"
> {
    readonly authenticationLeaseDurationMs?: number;
    /** Canonical public origin used by browser Origin checks behind the proxy. */
    readonly browserOrigin: string;
    readonly database: SQLiteBunDatabase;
    readonly gatewayVerificationTimeoutMs?: number;
    /** Shared composition clock for deterministic lifecycle and request-auth behavior. */
    readonly now?: () => Date;
    readonly recentAuthenticationWindowMs?: number;
    readonly sessionIdleDurationMs?: number;
    readonly totpSecretCipher: TotpSecretCipher;
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
    const authenticationWork = options.applicationRuntime.services.authentication;
    const passwordWorkGate = authenticationWork.passwordWorkGate;
    const passwordWorkBudget = createAuthenticationWorkBudget(
        authenticationWorkBudgetMaximumUnits,
        authenticationWorkBudgetWindowMs
    );
    const totpWorkBudget = createAuthenticationWorkBudget(
        totpWorkBudgetMaximumUnits,
        totpWorkBudgetWindowMs
    );
    const repository = createRequestAuthenticationRepository(options.database);
    const authenticator = createRequestAuthenticator({
        authenticationLeaseDurationMs: options.authenticationLeaseDurationMs,
        ...(options.now !== undefined && { now: options.now }),
        repository,
        sessionIdleDurationMs: options.sessionIdleDurationMs,
    });
    const mfaRepository = createMfaLifecycleRepository(options.database);
    const mfaLoginLifecycle = createMfaLoginLifecycleService({
        ...(options.now !== undefined && { now: options.now }),
        passwordWorkBudget,
        passwordWorkGate,
        repository: mfaRepository,
        sessionIdleDurationMs: options.sessionIdleDurationMs,
        totpSecretCipher: options.totpSecretCipher,
        totpWorkBudget,
        totpWorkGate: authenticationWork.totpWorkGate,
    });
    const mfaAccountLifecycle = createMfaAccountLifecycleService({
        ...(options.now !== undefined && { now: options.now }),
        passwordWorkBudget,
        passwordWorkGate,
        recentAuthenticationWindowMs: options.recentAuthenticationWindowMs,
        repository: mfaRepository,
        sessionIdleDurationMs: options.sessionIdleDurationMs,
        totpSecretCipher: options.totpSecretCipher,
        totpWorkBudget,
        totpWorkGate: authenticationWork.totpWorkGate,
    });
    const authenticationLifecycle = createAuthenticationLifecycleService({
        gatewayVerificationTimeoutMs: options.gatewayVerificationTimeoutMs,
        gatewayWorkRuntime: authenticationWork,
        mfaLoginLifecycle,
        ...(options.now !== undefined && { now: options.now }),
        passwordWorkBudget,
        passwordWorkGate,
        recentAuthenticationWindowMs: options.recentAuthenticationWindowMs,
        repository: createAuthenticationLifecycleRepository(options.database),
        sessionIdleDurationMs: options.sessionIdleDurationMs,
        verifyGatewayCredential: options.verifyGatewayCredential,
    });
    return createServer({
        applicationRuntime: options.applicationRuntime,
        authenticateCredential: (credential) => authenticator.authenticate(credential),
        authenticationLifecycle,
        browserOrigin: options.browserOrigin,
        gracefulShutdownTimeoutMs: options.gracefulShutdownTimeoutMs,
        hostname: "127.0.0.1",
        mfaAccountLifecycle,
        mfaLoginLifecycle,
        port: options.port,
        readiness: options.readiness,
        trustedProxyAddresses: options.trustedProxyAddresses,
    });
}

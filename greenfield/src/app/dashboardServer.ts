import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import { createAuthenticationLifecycleService } from "../server/domains/security/authenticationLifecycle.ts";
import { createAuthenticationLifecycleRepository } from "../server/domains/security/authenticationLifecycleRepository.ts";
import {
    authenticationWorkBudgetMaximumUnits,
    authenticationWorkBudgetWindowMs,
    totpWorkBudgetMaximumUnits,
    totpWorkBudgetWindowMs,
    webAuthnWorkBudgetMaximumUnits,
    webAuthnWorkBudgetWindowMs,
} from "../server/domains/security/authenticationRateLimit.ts";
import { createAuthenticationWorkBudget } from "../server/domains/security/authenticationWorkBudget.ts";
import { createAutomationSecurityLifecycleService } from "../server/domains/security/automation/lifecycle.ts";
import { createAutomationLifecycleRepository } from "../server/domains/security/automation/lifecycleRepository.ts";
import { createMfaAccountLifecycleService } from "../server/domains/security/mfa/accountLifecycle.ts";
import { createMfaLifecycleRepository } from "../server/domains/security/mfa/lifecycleRepository.ts";
import { createMfaLoginLifecycleService } from "../server/domains/security/mfa/loginLifecycle.ts";
import type { TotpSecretCipher } from "../server/domains/security/mfa/totpSecretCipher.ts";
import { createWebAuthnAdapter } from "../server/domains/security/mfa/webauthn/adapter.ts";
import type { WebAuthnRelyingPartyConfiguration } from "../server/domains/security/mfa/webauthn/relyingPartyConfiguration.ts";
import { createRequestAuthenticator } from "../server/domains/security/requestAuthentication.ts";
import { createRequestAuthenticationRepository } from "../server/domains/security/requestAuthenticationRepository.ts";
import { createGatewayCredentialVerifier } from "../server/platform/gateway/gatewayCredentialVerifier.ts";
import { parseBrowserOrigin } from "../server/rawHttp/requestSecurity.ts";
import { createServer, type ApplicationServer, type ServerOptions } from "./server.ts";

/** Production composition inputs above the generic Bun/tRPC server primitive. */
export interface DashboardServerOptions extends Omit<
    ServerOptions,
    | "authenticateCredential"
    | "authenticationLifecycle"
    | "automationSecurityLifecycle"
    | "browserOrigin"
    | "hostname"
    | "mfaAccountLifecycle"
    | "mfaLoginLifecycle"
> {
    readonly authenticationLeaseDurationMs?: number;
    /** Canonical public origin used by browser Origin checks behind the proxy. */
    readonly browserOrigin: string;
    readonly database: SQLiteBunDatabase;
    /** Explicit native WebSocket endpoint used only for one-shot bootstrap verification. */
    readonly gatewayUrl: string;
    readonly gatewayVerificationTimeoutMs?: number;
    /** Shared composition clock for deterministic lifecycle and request-auth behavior. */
    readonly now?: () => Date;
    readonly recentAuthenticationWindowMs?: number;
    readonly sessionIdleDurationMs?: number;
    readonly totpSecretCipher: TotpSecretCipher;
    readonly trustedProxyAddresses?: readonly string[];
    /** Explicit WebAuthn trust configuration; request host headers are never used. */
    readonly webAuthnRelyingParty?: WebAuthnRelyingPartyConfiguration;
    readonly webAuthnVerificationTimeoutMs?: number;
}

/**
 * Ensures the HTTP and WebAuthn browser trust boundaries cannot diverge.
 * @param browserOrigin Explicit public Dashboard browser origin.
 * @param relyingParty Optional validated WebAuthn trust configuration.
 * @returns The canonical Dashboard browser origin.
 */
export function validateDashboardWebAuthnBrowserOrigin(
    browserOrigin: string,
    relyingParty?: WebAuthnRelyingPartyConfiguration
): string {
    const canonicalOrigin = parseBrowserOrigin(browserOrigin);
    if (
        relyingParty !== undefined &&
        !relyingParty.allowedOrigins.includes(canonicalOrigin)
    ) {
        throw new TypeError(
            "Dashboard browser origin is absent from the WebAuthn origin allowlist"
        );
    }
    return canonicalOrigin;
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
    const browserOrigin = validateDashboardWebAuthnBrowserOrigin(
        options.browserOrigin,
        options.webAuthnRelyingParty
    );
    const verifyGatewayCredential = createGatewayCredentialVerifier({
        url: options.gatewayUrl,
    });
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
    const webAuthnWorkBudget = createAuthenticationWorkBudget(
        webAuthnWorkBudgetMaximumUnits,
        webAuthnWorkBudgetWindowMs
    );
    const webAuthn =
        options.webAuthnRelyingParty === undefined
            ? undefined
            : Object.freeze({
                  adapter: createWebAuthnAdapter(options.webAuthnRelyingParty),
                  relyingParty: options.webAuthnRelyingParty,
                  ...(options.webAuthnVerificationTimeoutMs === undefined
                      ? {}
                      : {
                            verificationTimeoutMs: options.webAuthnVerificationTimeoutMs,
                        }),
                  workBudget: webAuthnWorkBudget,
                  workRuntime: authenticationWork,
              });
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
        ...(webAuthn === undefined ? {} : { webAuthn }),
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
        ...(webAuthn === undefined
            ? {}
            : {
                  webAuthnAdapter: webAuthn.adapter,
                  webAuthnRelyingParty: webAuthn.relyingParty,
                  ...(webAuthn.verificationTimeoutMs === undefined
                      ? {}
                      : {
                            webAuthnVerificationTimeoutMs: webAuthn.verificationTimeoutMs,
                        }),
                  webAuthnWorkBudget,
                  webAuthnWorkRuntime: authenticationWork,
              }),
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
        verifyGatewayCredential,
    });
    const automationSecurityLifecycle = createAutomationSecurityLifecycleService({
        ...(options.now !== undefined && { now: options.now }),
        recentAuthenticationWindowMs: options.recentAuthenticationWindowMs,
        repository: createAutomationLifecycleRepository(options.database),
        sessionIdleDurationMs: options.sessionIdleDurationMs,
    });
    return createServer({
        applicationRuntime: options.applicationRuntime,
        authenticateCredential: (credential) => authenticator.authenticate(credential),
        authenticationLifecycle,
        automationSecurityLifecycle,
        browserOrigin,
        gracefulShutdownTimeoutMs: options.gracefulShutdownTimeoutMs,
        hostname: "127.0.0.1",
        mfaAccountLifecycle,
        mfaLoginLifecycle,
        port: options.port,
        readiness: options.readiness,
        trustedProxyAddresses: options.trustedProxyAddresses,
    });
}

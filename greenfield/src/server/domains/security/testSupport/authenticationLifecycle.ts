import { addSeconds } from "date-fns";

import { sha256Hex } from "../../../shared/crypto.ts";
import {
    createTestAuthenticationWorkGate,
    createTestGatewayWorkRuntime,
} from "../../../test/support/authenticationWorkGate.ts";
import { openFreshMigratedDatabase } from "../../../test/support/freshDatabase.ts";
import {
    createAuthenticationLifecycleService,
    type PendingLoginLifecyclePort,
    type VerifyGatewayCredential,
} from "../authenticationLifecycle.ts";
import { createAuthenticationLifecycleRepository } from "../authenticationLifecycleRepository.ts";
import { type AuthenticationWorkBudget } from "../authenticationWorkBudget.ts";
import type { AuthenticationWorkRuntimeService } from "../authenticationWorkGate.ts";

export const authenticationLifecycleMetadata = Object.freeze({
    clientSourceId: "client-source-1",
    requestId: "request-1",
    userAgent: " \tTest\0 Browser\n",
});

export function fakeAuthenticationPasswordHash(password: string): string {
    return `$argon2id$v=19$m=65536,t=3,p=1$${"A".repeat(43)}$${sha256Hex(password).slice(0, 42)}E`;
}

export function authenticationAbortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Authentication request aborted", "AbortError");
}

export interface AuthenticationLifecycleHarnessOptions {
    readonly gatewayVerificationTimeoutMs?: number;
    readonly gatewayWorkRuntime?: Pick<
        AuthenticationWorkRuntimeService,
        "runGatewayVerification"
    >;
    readonly hashPassword?: (password: string) => Promise<string>;
    readonly mfaLoginLifecycle?: PendingLoginLifecyclePort;
    readonly passwordWorkBudget?: AuthenticationWorkBudget;
    readonly recentAuthenticationWindowMs?: number;
    readonly verifyGatewayCredential?: VerifyGatewayCredential;
    readonly verifyPassword?: (password: string, hash: string) => Promise<boolean>;
}

const unavailablePendingLoginLifecycle: PendingLoginLifecyclePort = Object.freeze({
    beginPendingLogin: () => ({ status: "mfa-unavailable" as const }),
});

export async function createAuthenticationLifecycleHarness(
    options: AuthenticationLifecycleHarnessOptions = {}
) {
    const database = await openFreshMigratedDatabase();
    let clock = new Date("2026-08-05T09:00:00.000Z");
    let gatewayCredentialIsValid = true;
    let gatewayVerificationError: Error | undefined;
    let gatewayVerificationCalls = 0;
    let passwordHashAdvanceSeconds = 0;
    let passwordHashCalls = 0;
    let passwordVerificationAdvanceSeconds = 0;
    let passwordVerificationCalls = 0;
    const service = createAuthenticationLifecycleService({
        generateId: () => Bun.randomUUIDv7(),
        ...(options.gatewayVerificationTimeoutMs !== undefined && {
            gatewayVerificationTimeoutMs: options.gatewayVerificationTimeoutMs,
        }),
        hashPassword: async (password) => {
            passwordHashCalls += 1;
            const result = await (options.hashPassword?.(password) ??
                Promise.resolve(fakeAuthenticationPasswordHash(password)));
            clock = addSeconds(clock, passwordHashAdvanceSeconds);
            return result;
        },
        gatewayWorkRuntime: options.gatewayWorkRuntime ?? createTestGatewayWorkRuntime(),
        mfaLoginLifecycle: options.mfaLoginLifecycle ?? unavailablePendingLoginLifecycle,
        now: () => clock,
        ...(options.passwordWorkBudget !== undefined && {
            passwordWorkBudget: options.passwordWorkBudget,
        }),
        passwordWorkGate: createTestAuthenticationWorkGate(),
        ...(options.recentAuthenticationWindowMs !== undefined && {
            recentAuthenticationWindowMs: options.recentAuthenticationWindowMs,
        }),
        repository: createAuthenticationLifecycleRepository(database.orm),
        verifyGatewayCredential: (credential, signal) => {
            gatewayVerificationCalls += 1;
            if (options.verifyGatewayCredential !== undefined) {
                return options.verifyGatewayCredential(credential, signal);
            }
            return gatewayVerificationError === undefined
                ? Promise.resolve(gatewayCredentialIsValid)
                : Promise.reject(gatewayVerificationError);
        },
        verifyPassword: async (password, hash) => {
            passwordVerificationCalls += 1;
            const result = await (options.verifyPassword?.(password, hash) ??
                Promise.resolve(hash === fakeAuthenticationPasswordHash(password)));
            clock = addSeconds(clock, passwordVerificationAdvanceSeconds);
            return result;
        },
    });
    return {
        advanceSeconds(seconds: number) {
            clock = addSeconds(clock, seconds);
        },
        database,
        gatewayVerificationCalls: () => gatewayVerificationCalls,
        passwordHashCalls: () => passwordHashCalls,
        passwordVerificationCalls: () => passwordVerificationCalls,
        service,
        setGatewayCredentialIsValid(value: boolean) {
            gatewayCredentialIsValid = value;
        },
        setGatewayVerificationError(error: Error | undefined) {
            gatewayVerificationError = error;
        },
        setPasswordHashAdvanceSeconds(seconds: number) {
            passwordHashAdvanceSeconds = seconds;
        },
        setPasswordVerificationAdvanceSeconds(seconds: number) {
            passwordVerificationAdvanceSeconds = seconds;
        },
    };
}

export async function bootstrapAuthenticationLifecycle(
    harness: Awaited<ReturnType<typeof createAuthenticationLifecycleHarness>>,
    password = "current-password-1"
) {
    const result = await harness.service.bootstrap(
        {
            gatewayCredential: "gateway-token",
            password,
            username: "operator",
        },
        authenticationLifecycleMetadata
    );
    if (result.status !== "created") {
        throw new Error(`Expected bootstrap creation, received ${result.status}`);
    }
    return result;
}

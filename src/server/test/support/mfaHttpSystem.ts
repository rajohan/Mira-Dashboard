import { generate } from "otplib";
import * as v from "valibot";

import { createDashboardServer } from "../../../app/dashboardServer.ts";
import type { ApplicationServer } from "../../../app/server.ts";
import {
    beginTotpEnrollmentResultSchema,
    confirmTotpEnrollmentResultSchema,
    type TotpEnrollment,
} from "../../../contracts/accountSecurity.ts";
import { authenticatedSessionResultSchema } from "../../../contracts/auth.ts";
import { dashboardTotpPolicy } from "../../domains/security/mfa/totp.ts";
import { createTotpSecretCipher } from "../../domains/security/mfa/totpSecretCipher.ts";
import { createWebAuthnRelyingPartyConfiguration } from "../../domains/security/mfa/webauthn/relyingPartyConfiguration.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import { dashboardSessionCookieName } from "../../rawHttp/authenticationCredentials.ts";
import { openFreshMigratedDatabase } from "./freshDatabase.ts";
import { startGatewayCredentialVerifierFixture } from "./gatewayCredentialVerifier.ts";
import { createTestDashboardApplicationRuntime } from "./requestContext.ts";

export const mfaHttpSystemBrowserOrigin = "https://dashboard.example";
export const mfaHttpSystemPassword = "correct-horse-battery";
export const mfaHttpSystemUsername = "operator";
export const mfaHttpSystemWebAuthnRelyingParty = createWebAuthnRelyingPartyConfiguration({
    allowedOrigins: [mfaHttpSystemBrowserOrigin],
    rpId: "dashboard.example",
    rpName: "Mira Dashboard",
});

export type MfaHttpSystemDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

type AuthenticatedSessionResult = v.InferOutput<typeof authenticatedSessionResultSchema>;
type ConfirmTotpEnrollmentResult = v.InferOutput<
    typeof confirmTotpEnrollmentResultSchema
>;
type EnabledTotpEnrollmentResult = Extract<
    ConfirmTotpEnrollmentResult,
    { readonly enabledNow: true }
>;

export interface TrpcWireResponse {
    readonly response: Response;
    readonly setCookies: readonly string[];
    readonly text: string;
}

export class MutableClock {
    #timeMs: number;

    constructor(initial: Date) {
        this.#timeMs = initial.getTime();
    }

    readonly now = (): Date => new Date(this.#timeMs);

    advance(milliseconds: number): void {
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
            throw new RangeError("Test clock advance is invalid");
        }
        this.#timeMs += milliseconds;
    }
}

export class CookieJar {
    readonly #cookies = new Map<string, string>();

    apply(setCookies: readonly string[]): void {
        for (const directive of setCookies) {
            const pair = directive.split(";", 1)[0];
            const separator = pair?.indexOf("=") ?? -1;
            if (pair === undefined || separator < 1) {
                throw new Error("System test received a malformed Set-Cookie header");
            }
            const name = pair.slice(0, separator);
            const value = pair.slice(separator + 1);
            const isCleared = directive
                .split(";")
                .some((attribute) => attribute.trim().toLowerCase() === "max-age=0");
            if (isCleared || value.length === 0) {
                this.#cookies.delete(name);
            } else {
                this.#cookies.set(name, value);
            }
        }
    }

    get(name: string): string | undefined {
        return this.#cookies.get(name);
    }

    header(): string | undefined {
        if (this.#cookies.size === 0) return undefined;
        return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }

    set(name: string, value: string): void {
        this.#cookies.set(name, value);
    }
}

export interface EnrolledMfaHttpSystem {
    readonly bootstrap: AuthenticatedSessionResult;
    readonly bootstrapCookie: string;
    readonly bootstrapResponse: TrpcWireResponse;
    readonly clock: MutableClock;
    readonly confirmation: EnabledTotpEnrollmentResult;
    readonly confirmationResponse: TrpcWireResponse;
    readonly database: MfaHttpSystemDatabase;
    readonly enrollment: TotpEnrollment;
    readonly enrollmentResponse: TrpcWireResponse;
    readonly jar: CookieJar;
    readonly observedGatewayCredential: string;
    readonly server: ApplicationServer;
    close(): Promise<void>;
}

async function createDeterministicTotpSecretCipher() {
    let nonceCounter = 0;
    const keyBase64 = new Uint8Array(32).fill(90).toBase64();
    return createTotpSecretCipher(
        JSON.stringify({
            activeKeyId: "system-test",
            formatVersion: 1,
            keys: [{ id: "system-test", keyBase64 }],
        }),
        {
            randomBytes(byteLength) {
                if (byteLength !== 12) {
                    throw new Error("Unexpected deterministic nonce length");
                }
                const bytes = new Uint8Array(byteLength);
                new DataView(bytes.buffer).setUint32(8, nonceCounter);
                nonceCounter += 1;
                return bytes;
            },
        }
    );
}

export async function generateTotpCode(secret: string, at: Date): Promise<string> {
    return generate({
        algorithm: dashboardTotpPolicy.algorithm,
        digits: dashboardTotpPolicy.digits,
        epoch: Math.floor(at.getTime() / 1000),
        period: dashboardTotpPolicy.periodSeconds,
        secret,
        strategy: "totp",
    });
}

function requestHeaders(cookieHeader: string | undefined): Headers {
    const headers = new Headers({
        origin: mfaHttpSystemBrowserOrigin,
        "sec-fetch-site": "same-origin",
        "user-agent": "Mira MFA production-composition system test",
    });
    if (cookieHeader !== undefined) headers.set("cookie", cookieHeader);
    return headers;
}

async function readTrpcResponse(
    response: Response,
    jar: CookieJar | undefined
): Promise<TrpcWireResponse> {
    const setCookies = response.headers.getSetCookie();
    jar?.apply(setCookies);
    return {
        response,
        setCookies,
        text: await response.text(),
    };
}

export async function postTrpcMutation(
    baseUrl: URL,
    procedure: string,
    input: unknown,
    options: {
        readonly cookieHeader?: string;
        readonly jar?: CookieJar;
    } = {}
): Promise<TrpcWireResponse> {
    const cookieHeader = options.cookieHeader ?? options.jar?.header();
    const headers = requestHeaders(cookieHeader);
    headers.set("content-type", "application/json");
    const response = await fetch(new URL(`/trpc/${procedure}`, baseUrl), {
        body: JSON.stringify({ json: input }),
        headers,
        method: "POST",
    });
    return readTrpcResponse(response, options.jar);
}

export async function getTrpcQuery(
    baseUrl: URL,
    procedure: string,
    jar: CookieJar
): Promise<TrpcWireResponse> {
    const response = await fetch(new URL(`/trpc/${procedure}`, baseUrl), {
        headers: requestHeaders(jar.header()),
        method: "GET",
    });
    return readTrpcResponse(response, jar);
}

export function trpcData(result: TrpcWireResponse): unknown {
    const envelope = JSON.parse(result.text) as {
        readonly result?: { readonly data?: { readonly json?: unknown } };
    };
    const data = envelope.result?.data;
    if (data === undefined || !Object.hasOwn(data, "json")) {
        throw new Error(`tRPC response did not contain data: ${result.text}`);
    }
    return data.json;
}

export function hasClearedCookie(setCookies: readonly string[], name: string): boolean {
    return setCookies.some(
        (directive) =>
            directive.startsWith(`${name}=`) &&
            directive
                .split(";")
                .some((attribute) => attribute.trim().toLowerCase() === "max-age=0")
    );
}

export function hasSetCookie(setCookies: readonly string[], name: string): boolean {
    return setCookies.some(
        (directive) =>
            directive.startsWith(`${name}=`) && !hasClearedCookie([directive], name)
    );
}

function requiredCount(row: { readonly count: number } | null, label: string): number {
    if (row === null || !Number.isSafeInteger(row.count) || row.count < 0) {
        throw new Error(`${label} count is invalid`);
    }
    return row.count;
}

export function sessionCount(database: MfaHttpSystemDatabase): number {
    const row = database.sqlite
        .query<{ count: number }, []>("SELECT count(*) AS count FROM auth_sessions")
        .get();
    return requiredCount(row, "Session");
}

export function pendingLoginCount(database: MfaHttpSystemDatabase): number {
    const row = database.sqlite
        .query<{ count: number }, []>("SELECT count(*) AS count FROM auth_pending_logins")
        .get();
    return requiredCount(row, "Pending-login");
}

export function sessionExists(
    database: MfaHttpSystemDatabase,
    sessionId: string
): boolean {
    const row = database.sqlite
        .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM auth_sessions WHERE id = ?"
        )
        .get(sessionId);
    return requiredCount(row, "Selected session") === 1;
}

export function recoveryCodeUsedAt(
    database: MfaHttpSystemDatabase,
    selector: string
): number | null | undefined {
    return database.sqlite
        .query<{ usedAt: number | null }, [string]>(
            'SELECT used_at AS "usedAt" FROM user_recovery_codes WHERE selector = ?'
        )
        .get(selector)?.usedAt;
}

export function encryptedTotpSecret(
    database: MfaHttpSystemDatabase,
    factorId: string
): string | undefined {
    return database.sqlite
        .query<{ encryptedSecret: string }, [string]>(
            'SELECT encrypted_secret AS "encryptedSecret" FROM user_totp_factors WHERE id = ?'
        )
        .get(factorId)?.encryptedSecret;
}

export async function openEnrolledMfaHttpSystem(): Promise<EnrolledMfaHttpSystem> {
    const database = await openFreshMigratedDatabase();
    const clock = new MutableClock(new Date("2026-08-05T12:00:00.000Z"));
    const jar = new CookieJar();
    const gateway = startGatewayCredentialVerifierFixture({
        validCredential: "gateway-token",
    });
    let server: ApplicationServer | undefined;

    try {
        server = await createDashboardServer({
            applicationRuntime: createTestDashboardApplicationRuntime(database.orm),
            browserOrigin: mfaHttpSystemBrowserOrigin,
            gatewayUrl: gateway.url,
            now: clock.now,
            port: 0,
            readiness: createReadinessController(),
            totpSecretCipher: await createDeterministicTotpSecretCipher(),
            webAuthnRelyingParty: mfaHttpSystemWebAuthnRelyingParty,
        });
        const bootstrapResponse = await postTrpcMutation(
            server.url,
            "auth.bootstrap",
            {
                email: "operator@example.com",
                gatewayCredential: "gateway-token",
                password: mfaHttpSystemPassword,
                username: mfaHttpSystemUsername,
            },
            { jar }
        );
        const bootstrap = v.parse(
            authenticatedSessionResultSchema,
            trpcData(bootstrapResponse)
        );
        const bootstrapCookie = jar.get(dashboardSessionCookieName);
        if (bootstrapCookie === undefined) {
            throw new Error("Bootstrap did not issue a session cookie");
        }
        const observedGatewayCredential = gateway.observedCredentials.at(-1);
        if (observedGatewayCredential === undefined) {
            throw new Error("Bootstrap did not verify the Gateway credential");
        }

        const enrollmentResponse = await postTrpcMutation(
            server.url,
            "accountSecurity.beginTotpEnrollment",
            { label: "System authenticator" },
            { jar }
        );
        const enrollment = v.parse(
            beginTotpEnrollmentResultSchema,
            trpcData(enrollmentResponse)
        ).enrollment;
        const confirmationResponse = await postTrpcMutation(
            server.url,
            "accountSecurity.confirmTotpEnrollment",
            {
                code: await generateTotpCode(enrollment.secret, clock.now()),
                factorId: enrollment.factorId,
            },
            { jar }
        );
        const confirmation = v.parse(
            confirmTotpEnrollmentResultSchema,
            trpcData(confirmationResponse)
        );
        if (!confirmation.enabledNow) {
            throw new Error("First TOTP confirmation did not enable MFA");
        }
        const enrolledServer = server;

        return {
            bootstrap,
            bootstrapCookie,
            bootstrapResponse,
            clock,
            confirmation,
            confirmationResponse,
            database,
            enrollment,
            enrollmentResponse,
            jar,
            observedGatewayCredential,
            server: enrolledServer,
            async close() {
                try {
                    await enrolledServer.stop(true);
                } finally {
                    try {
                        await gateway.stop();
                    } finally {
                        database.sqlite.close(true);
                    }
                }
            },
        };
    } catch (error) {
        try {
            if (server !== undefined) await server.stop(true);
        } finally {
            try {
                await gateway.stop();
            } finally {
                database.sqlite.close(true);
            }
        }
        throw error;
    }
}

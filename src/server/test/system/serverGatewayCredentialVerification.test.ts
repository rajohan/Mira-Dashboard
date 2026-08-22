import { describe, expect, test } from "bun:test";

import { Effect, Layer, Stream } from "effect";

import { createDashboardServer } from "../../../app/dashboardServer.ts";
import type { ApplicationServer } from "../../../app/server.ts";
import { testTotpSecretCipher } from "../../domains/security/testSupport/authentication.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import { RealtimeEventPumpService } from "../../platform/realtime/eventPumpService.ts";
import { createApplicationRuntime } from "../../platform/runtime/applicationRuntime.ts";
import { openFreshMigratedDatabase } from "../support/freshDatabase.ts";
import {
    type GatewayCredentialFixtureBehavior,
    startGatewayCredentialVerifierFixture,
} from "../support/gatewayCredentialVerifier.ts";
import {
    type MfaHttpSystemDatabase,
    mfaHttpSystemBrowserOrigin,
    postTrpcMutation,
} from "../support/mfaHttpSystem.ts";
import { captureFailure } from "../support/promise.ts";
import {
    createTestStructuredLogger,
    withTestDashboardDatabase,
} from "../support/requestContext.ts";

const validGatewayCredential = "valid-gateway-token";

function createGatewayVerificationRuntime() {
    const unusedMetricsSnapshot = Effect.die(
        "Gateway verification system tests do not use realtime metrics"
    );
    return createApplicationRuntime({
        logger: createTestStructuredLogger(),
        realtimeEventPumpLayer: Layer.succeed(
            RealtimeEventPumpService,
            RealtimeEventPumpService.of({
                metricsSnapshot: unusedMetricsSnapshot,
                stream: () => Stream.empty,
                wake: Effect.void,
            })
        ),
    });
}

async function openGatewayVerificationSystem(
    behavior: GatewayCredentialFixtureBehavior = "normal",
    gatewayVerificationTimeoutMs?: number
) {
    const database = await openFreshMigratedDatabase();
    const gateway = startGatewayCredentialVerifierFixture({
        behavior,
        validCredential: validGatewayCredential,
    });
    let server: ApplicationServer | undefined;
    try {
        const startedServer = await createDashboardServer({
            applicationRuntime: withTestDashboardDatabase(
                createGatewayVerificationRuntime(),
                database.orm
            ),
            browserOrigin: mfaHttpSystemBrowserOrigin,
            gatewayUrl: gateway.url,
            ...(gatewayVerificationTimeoutMs === undefined
                ? {}
                : { gatewayVerificationTimeoutMs }),
            port: 0,
            readiness: createReadinessController(),
            totpSecretCipher: testTotpSecretCipher,
        });
        server = startedServer;
        return {
            database,
            gateway,
            server: startedServer,
            async close(): Promise<void> {
                try {
                    await startedServer.stop(true);
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

function countRows(
    database: MfaHttpSystemDatabase,
    table: "audit_events" | "auth_rate_limit_buckets" | "auth_sessions" | "users"
): number {
    const row = database.sqlite
        .query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
        .get();
    if (row === null) throw new Error("System-test count row is unavailable");
    return row.count;
}

async function waitForGatewayConnectionState(
    gateway: ReturnType<typeof startGatewayCredentialVerifierFixture>,
    state: { readonly accepted?: number; readonly open?: number }
): Promise<void> {
    const deadline = Date.now() + 1000;
    while (
        ((state.accepted !== undefined &&
            gateway.acceptedConnections !== state.accepted) ||
            (state.open !== undefined && gateway.openConnections !== state.open)) &&
        Date.now() < deadline
    ) {
        await Bun.sleep(5);
    }
    if (state.accepted !== undefined) {
        expect(gateway.acceptedConnections).toBe(state.accepted);
    }
    if (state.open !== undefined) {
        expect(gateway.openConnections).toBe(state.open);
    }
}

function postAbortableBootstrap(
    server: ApplicationServer,
    gatewayCredential: string,
    signal: AbortSignal
): Promise<Response> {
    return fetch(new URL("/trpc/auth.bootstrap", server.url), {
        body: JSON.stringify({ json: bootstrapInput(gatewayCredential) }),
        headers: {
            "content-type": "application/json",
            origin: mfaHttpSystemBrowserOrigin,
            "sec-fetch-site": "same-origin",
            "user-agent": "Mira Gateway cancellation system test",
        },
        method: "POST",
        signal,
    });
}

function bootstrapInput(gatewayCredential: string) {
    return {
        email: "operator@example.com",
        gatewayCredential,
        password: "correct-horse-battery",
        username: "operator",
    };
}

describe("native Gateway bootstrap verification through the real server", () => {
    test("distinguishes structured token mismatch and publishes a user only after a valid hello", async () => {
        const system = await openGatewayVerificationSystem();
        try {
            const invalid = await postTrpcMutation(
                system.server.url,
                "auth.bootstrap",
                bootstrapInput("invalid-gateway-token")
            );

            expect(invalid.response.status).toBe(401);
            expect(invalid.response.headers.get("cache-control")).toBe("no-store");
            expect(invalid.text).toContain("Gateway credential is invalid");
            expect(invalid.text).not.toContain("invalid-gateway-token");
            expect(countRows(system.database, "users")).toBe(0);
            expect(countRows(system.database, "auth_sessions")).toBe(0);

            const valid = await postTrpcMutation(
                system.server.url,
                "auth.bootstrap",
                bootstrapInput(validGatewayCredential)
            );
            expect(valid.response.status).toBe(200);
            expect(valid.response.headers.get("set-cookie")).toContain(
                "__Host-mira_dashboard_session="
            );
            expect(valid.text).not.toContain(validGatewayCredential);
            expect(countRows(system.database, "users")).toBe(1);
            expect(countRows(system.database, "auth_sessions")).toBe(1);
            expect(system.gateway.observedCredentials).toEqual([
                "invalid-gateway-token",
                validGatewayCredential,
            ]);
        } finally {
            await system.close();
        }
    });

    for (const behavior of [
        "auth-none",
        "malformed-response",
        "read-only-scope",
    ] as const) {
        test(`maps ${behavior} to a redacted unavailable result`, async () => {
            const system = await openGatewayVerificationSystem(behavior);
            try {
                const response = await postTrpcMutation(
                    system.server.url,
                    "auth.bootstrap",
                    bootstrapInput(validGatewayCredential)
                );

                expect(response.response.status, response.text).toBe(503);
                expect(response.text).toContain(
                    "Gateway credential verification is unavailable"
                );
                expect(response.text).not.toContain(validGatewayCredential);
                expect(response.text).not.toContain("fixture-nonce");
                expect(countRows(system.database, "users")).toBe(0);
                expect(countRows(system.database, "auth_sessions")).toBe(0);
            } finally {
                await system.close();
            }
        });
    }

    test("aborts a silent socket at the Effect-owned deadline without publishing state", async () => {
        const system = await openGatewayVerificationSystem("silent", 100);
        try {
            const response = await postTrpcMutation(
                system.server.url,
                "auth.bootstrap",
                bootstrapInput(validGatewayCredential)
            );

            expect(response.response.status, response.text).toBe(503);
            expect(response.text).toContain(
                "Gateway credential verification is unavailable"
            );
            expect(countRows(system.database, "users")).toBe(0);
            expect(countRows(system.database, "auth_sessions")).toBe(0);
            await waitForGatewayConnectionState(system.gateway, { open: 0 });
            expect(system.gateway.acceptedConnections).toBe(1);
        } finally {
            await system.close();
        }
    });

    test("propagates a real HTTP abort through Effect to the native socket", async () => {
        const system = await openGatewayVerificationSystem("silent", 5000);
        const controller = new AbortController();
        const protectedTables = [
            "audit_events",
            "auth_rate_limit_buckets",
            "auth_sessions",
            "users",
        ] as const;
        const countsBeforeAbort: Record<(typeof protectedTables)[number], number> = {
            audit_events: countRows(system.database, "audit_events"),
            auth_rate_limit_buckets: countRows(
                system.database,
                "auth_rate_limit_buckets"
            ),
            auth_sessions: countRows(system.database, "auth_sessions"),
            users: countRows(system.database, "users"),
        };
        try {
            const request = postAbortableBootstrap(
                system.server,
                validGatewayCredential,
                controller.signal
            );
            await waitForGatewayConnectionState(system.gateway, {
                accepted: 1,
                open: 1,
            });
            controller.abort();

            expect(await captureFailure(() => request)).toMatchObject({
                name: "AbortError",
            });
            await waitForGatewayConnectionState(system.gateway, { open: 0 });
            expect(system.gateway.acceptedConnections).toBe(1);
            for (const table of protectedTables) {
                expect(countRows(system.database, table)).toBe(countsBeforeAbort[table]);
            }
        } finally {
            controller.abort();
            await system.close();
        }
    });
});

import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as v from "valibot";

import { listAutomationPrincipalsResultSchema } from "../contracts/automationSecurity.ts";
import { createWebAuthnRelyingPartyConfiguration } from "../server/domains/security/mfa/webauthn/relyingPartyConfiguration.ts";
import {
    authenticationTestNow,
    authenticationTestPrincipalId,
    seedAuthenticationTestDatabase,
    testTotpSecretCipher,
} from "../server/domains/security/testSupport/authentication.ts";
import { createReadinessController } from "../server/platform/readiness/readinessState.ts";
import { createDashboardApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import { dashboardSessionCookieName } from "../server/rawHttp/authenticationCredentials.ts";
import { runTestImmediateDatabaseWrite } from "../server/test/support/databaseWriteAdmission.ts";
import { migrationsDirectory } from "../server/test/support/freshDatabase.ts";
import {
    createTestApplicationRuntime,
    createTestStructuredLogger,
} from "../server/test/support/requestContext.ts";
import {
    createDashboardServer,
    validateDashboardWebAuthnBrowserOrigin,
} from "./dashboardServer.ts";

describe("Dashboard security composition", () => {
    test("requires the HTTP browser origin in the WebAuthn allowlist", () => {
        const relyingParty = createWebAuthnRelyingPartyConfiguration({
            allowedOrigins: ["https://dashboard.example"],
            rpId: "dashboard.example",
            rpName: "Mira Dashboard",
        });

        expect(
            validateDashboardWebAuthnBrowserOrigin(
                "https://dashboard.example",
                relyingParty
            )
        ).toBe("https://dashboard.example");
        expect(() =>
            validateDashboardWebAuthnBrowserOrigin(
                "https://admin.dashboard.example",
                relyingParty
            )
        ).toThrow(
            "Dashboard browser origin is absent from the WebAuthn origin allowlist"
        );
    });

    test("releases an already-initialized runtime when composition preflight fails", async () => {
        let disposeCalls = 0;
        let initializeCalls = 0;
        const applicationRuntime = Object.freeze({
            ...createTestApplicationRuntime({
                dispose: () => {
                    disposeCalls += 1;
                    return Promise.resolve();
                },
                initialize: () => {
                    initializeCalls += 1;
                    return Promise.resolve();
                },
            }),
            database: Object.freeze({
                orm: () => Promise.reject(new Error("Database must not be reached")),
                run: runTestImmediateDatabaseWrite,
            }),
        });
        await applicationRuntime.initialize();

        expect(
            createDashboardServer({
                applicationRuntime,
                browserOrigin: "not-an-origin",
                gatewayUrl: "ws://127.0.0.1:1",
                port: 0,
                readiness: createReadinessController(),
                totpSecretCipher: testTotpSecretCipher,
            })
        ).rejects.toBeInstanceOf(TypeError);

        expect(initializeCalls).toBe(1);
        expect(disposeCalls).toBe(1);
    });

    test("wires the persisted automation lifecycle through the production server", async () => {
        const stateDirectory = await mkdtemp(
            path.join(os.tmpdir(), "dashboard-server-composition-")
        );
        await chmod(stateDirectory, 0o700);
        const applicationRuntime = createDashboardApplicationRuntime({
            database: {
                migrationsDirectory,
                releaseId: "0".repeat(40),
                startupMode: "initialize-empty",
                stateDirectory,
            },
            logger: createTestStructuredLogger(),
        });
        let server: Awaited<ReturnType<typeof createDashboardServer>> | undefined;

        try {
            await applicationRuntime.initialize();
            const database = await applicationRuntime.database.orm();
            const fixture = seedAuthenticationTestDatabase(
                database,
                authenticationTestNow
            );
            server = await createDashboardServer({
                applicationRuntime,
                browserOrigin: "https://dashboard.example",
                gatewayUrl: "ws://127.0.0.1:1",
                now: () => authenticationTestNow,
                port: 0,
                readiness: createReadinessController(),
                totpSecretCipher: testTotpSecretCipher,
            });
            const input = encodeURIComponent(JSON.stringify({ json: {} }));
            const response = await fetch(
                new URL(
                    `/trpc/automationSecurity.listPrincipals?input=${input}`,
                    server.url
                ),
                {
                    headers: {
                        cookie: `${dashboardSessionCookieName}=${fixture.session.token}`,
                    },
                }
            );
            const body = (await response.json()) as {
                readonly error?: unknown;
                readonly result?: { readonly data?: { readonly json?: unknown } };
            };

            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(body.error).toBeUndefined();
            const result = v.parse(
                listAutomationPrincipalsResultSchema,
                body.result?.data?.json
            );
            expect(
                result.principals.find(({ id }) => id === authenticationTestPrincipalId)
            ).toMatchObject({
                activeCredentialCount: 1,
                capabilities: ["reports:read"],
                disabled: false,
                id: authenticationTestPrincipalId,
            });
        } finally {
            try {
                await (server === undefined
                    ? applicationRuntime.dispose()
                    : server.stop(true));
            } finally {
                await rm(stateDirectory, { force: true, recursive: true });
            }
        }
    });
});

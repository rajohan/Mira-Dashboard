import { describe, expect, test } from "bun:test";

import { createWebAuthnRelyingPartyConfiguration } from "../server/domains/security/mfa/webauthn/relyingPartyConfiguration.ts";
import {
    authenticationTestNow,
    authenticationTestPrincipalId,
    openAuthenticationTestDatabase,
    testTotpSecretCipher,
} from "../server/domains/security/testSupport/authentication.ts";
import { createReadinessController } from "../server/platform/readiness/readinessState.ts";
import { dashboardSessionCookieName } from "../server/rawHttp/authenticationCredentials.ts";
import { createTestApplicationRuntime } from "../server/test/support/requestContext.ts";
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

    test("wires the persisted automation lifecycle through the production server", async () => {
        const fixture = await openAuthenticationTestDatabase();
        const server = await createDashboardServer({
            applicationRuntime: createTestApplicationRuntime(),
            browserOrigin: "https://dashboard.example",
            database: fixture.database.orm,
            now: () => authenticationTestNow,
            port: 0,
            readiness: createReadinessController(),
            totpSecretCipher: testTotpSecretCipher,
            verifyGatewayCredential: () => Promise.resolve(false),
        });

        try {
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
            const body = await response.text();

            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(body).toContain(authenticationTestPrincipalId);
        } finally {
            await server.stop(true);
            fixture.database.sqlite.close(true);
        }
    });
});

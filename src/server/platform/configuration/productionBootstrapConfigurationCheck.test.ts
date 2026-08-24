import { describe, expect, test } from "bun:test";

import { assertProductionBootstrapConfiguration } from "./productionBootstrapConfigurationCheck.ts";

function validEnvironment(): Record<string, unknown> {
    const key = Buffer.alloc(32, 1).toString("base64");
    return {
        MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD: "observer-password",
        MIRA_DASHBOARD_OPENCLAW_ROOT: "/home/ubuntu/.openclaw",
        MIRA_DASHBOARD_PROJECT_ROOT: "/home/ubuntu/projects/mira-dashboard",
        MIRA_DASHBOARD_PUBLIC_ORIGIN: "https://dashboard.example.com",
        MIRA_DASHBOARD_RESEND_FROM_EMAIL: "no-reply@example.com",
        MIRA_DASHBOARD_TOTP_KEYRING: JSON.stringify({
            activeKeyId: "primary",
            formatVersion: 1,
            keys: [{ id: "primary", keyBase64: key }],
        }),
        MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "https://dashboard.example.com",
        MIRA_DASHBOARD_WEBAUTHN_RP_ID: "example.com",
        MIRA_DASHBOARD_WORKSPACE_ROOT: "/home/ubuntu/.openclaw/workspace",
        MOLTBOOK_API_KEY: "moltbook-key",
        NODE_ENV: "production",
        OPENCLAW_GATEWAY_TOKEN: "gateway-token",
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
        PORT: "3100",
        RESEND_API_KEY: "resend-key",
    };
}

describe("production bootstrap configuration check", () => {
    test("accepts only complete values parsed by both production roles", () => {
        const environment = validEnvironment();
        expect(() => assertProductionBootstrapConfiguration(environment)).not.toThrow();
        environment.MIRA_DASHBOARD_PUBLIC_ORIGIN = "invalid";
        expect(() => assertProductionBootstrapConfiguration(environment)).toThrow();
    });

    test("requires the database observability credential", () => {
        const environment = validEnvironment();
        delete environment.MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD;
        expect(() => assertProductionBootstrapConfiguration(environment)).toThrow(
            "Production Doppler configuration is incomplete"
        );
    });
});

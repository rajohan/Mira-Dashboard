import { describe, expect, test } from "bun:test";

import { environmentSource } from "../../../app/environmentSource.ts";
import {
    applicationConfigurationEnvironmentNames,
    applicationConfigurationRegistry,
    configurationMetadata,
    configurationEnvironmentNamesForRole,
} from "../../../shared/configuration/applicationConfigurationRegistry.ts";

describe("application configuration registry", () => {
    test("accounts for every accepted environment name exactly once", () => {
        expect(applicationConfigurationEnvironmentNames).toEqual([
            "NODE_ENV",
            "MIRA_DASHBOARD_PROJECT_ROOT",
            "PORT",
            "MIRA_DASHBOARD_PUBLIC_ORIGIN",
            "MIRA_DASHBOARD_TRUSTED_PROXY_IPS",
            "OPENCLAW_GATEWAY_URL",
            "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
            "MIRA_DASHBOARD_WEBAUTHN_ORIGINS",
            "MIRA_DASHBOARD_WEBAUTHN_RP_NAME",
            "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
            "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
            "MIRA_DASHBOARD_TOTP_KEYRING",
            "MIRA_DASHBOARD_LOG_LEVEL",
        ]);
        expect(applicationConfigurationRegistry).toHaveLength(13);
        expect(
            new Set(
                applicationConfigurationRegistry.map((entry) => entry.environmentName)
            ).size
        ).toBe(applicationConfigurationRegistry.length);
        expect(
            new Set(applicationConfigurationRegistry.map((entry) => entry.field)).size
        ).toBe(applicationConfigurationRegistry.length);
    });

    test("publishes complete immutable operational metadata", () => {
        expect(Object.isFrozen(applicationConfigurationRegistry)).toBe(true);
        for (const entry of applicationConfigurationRegistry) {
            expect(configurationMetadata(entry.environmentName)).toBe(entry);
            expect(entry.description.length).toBeGreaterThan(0);
            expect(entry.operationalEffect.length).toBeGreaterThan(0);
            expect(entry.roles.length).toBeGreaterThan(0);
            expect(entry.validationConstraints.length).toBeGreaterThan(0);
            expect(entry.valueType.length).toBeGreaterThan(0);
            expect(typeof entry.restartRequired).toBe("boolean");
            expect(typeof entry.secret).toBe("boolean");
            expect(typeof entry.overridePolicy.development).toBe("boolean");
            expect(typeof entry.overridePolicy.test).toBe("boolean");
            expect(Object.isFrozen(entry)).toBe(true);
            expect(Object.isFrozen(entry.roles)).toBe(true);
            expect(Object.isFrozen(entry.overridePolicy)).toBe(true);
            if (entry.allowedValues !== null) {
                expect(entry.allowedValues.length).toBeGreaterThan(0);
                expect(Object.isFrozen(entry.allowedValues)).toBe(true);
            }
            if (entry.secret) expect(entry.browserExposure).not.toBe("value");
        }
        expect(
            applicationConfigurationRegistry
                .filter((entry) => entry.secret)
                .map((entry) => entry.environmentName)
        ).toEqual(["MIRA_DASHBOARD_TOTP_KEYRING"]);
    });

    test("names parsed fields consistently with typed web configuration", () => {
        expect(
            Object.fromEntries(
                applicationConfigurationRegistry.map((entry) => [
                    entry.environmentName,
                    entry.field,
                ])
            )
        ).toEqual({
            MIRA_DASHBOARD_LOG_LEVEL: "logLevel",
            MIRA_DASHBOARD_PROJECT_ROOT: "projectRoot",
            MIRA_DASHBOARD_PUBLIC_ORIGIN: "publicOrigin",
            MIRA_DASHBOARD_RECENT_AUTH_MINUTES: "recentAuthenticationWindowMs",
            MIRA_DASHBOARD_SESSION_IDLE_MINUTES: "sessionIdleDurationMs",
            MIRA_DASHBOARD_TOTP_KEYRING: "totpKeyring",
            MIRA_DASHBOARD_TRUSTED_PROXY_IPS: "trustedProxyAddresses",
            MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "webAuthnRelyingParty.allowedOrigins",
            MIRA_DASHBOARD_WEBAUTHN_RP_ID: "webAuthnRelyingParty.rpId",
            MIRA_DASHBOARD_WEBAUTHN_RP_NAME: "webAuthnRelyingParty.rpName",
            NODE_ENV: "nodeEnvironment",
            OPENCLAW_GATEWAY_URL: "gatewayUrl",
            PORT: "port",
        });
    });

    test("projects only the registered keys for each composition role", () => {
        const environment = environmentSource("web");
        const webEnvironmentNames = configurationEnvironmentNamesForRole("web");

        expect(Object.keys(environment)).toEqual([...webEnvironmentNames]);
        expect(Object.getPrototypeOf(environment)).toBeNull();
        expect(Object.isFrozen(environment)).toBe(true);
        for (const environmentName of webEnvironmentNames) {
            if (configurationMetadata(environmentName).secret) {
                expect(Object.hasOwn(environment, environmentName)).toBe(true);
                expect(
                    environment[environmentName] === undefined ||
                        typeof environment[environmentName] === "string"
                ).toBe(true);
                continue;
            }
            expect(environment[environmentName]).toBe(process.env[environmentName]);
        }

        const workerEnvironment = environmentSource("worker");
        expect(Object.keys(workerEnvironment)).toEqual([
            "NODE_ENV",
            "MIRA_DASHBOARD_PROJECT_ROOT",
            "MIRA_DASHBOARD_LOG_LEVEL",
        ]);
        expect(workerEnvironment).not.toHaveProperty("MIRA_DASHBOARD_TOTP_KEYRING");
    });
});

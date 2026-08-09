import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";

import { Redacted } from "effect";

import { ApplicationConfigurationError } from "./applicationConfigurationError.ts";
import {
    parseWebConfiguration,
    webConfigurationEnvironmentNames,
    webConfigurationEnvironmentSchema,
} from "./webConfiguration.ts";

function encodedKey(byte: number): string {
    return Buffer.alloc(32, byte).toString("base64");
}

function serializedKeyring(overrides: Readonly<Record<string, unknown>> = {}): string {
    return JSON.stringify({
        activeKeyId: "primary",
        formatVersion: 1,
        keys: [{ id: "primary", keyBase64: encodedKey(1) }],
        ...overrides,
    });
}

function validEnvironment(): Record<string, unknown> {
    return {
        ELEVENLABS_API_KEY: "elevenlabs-api-key-test-value",
        MIRA_DASHBOARD_LOG_LEVEL: "info",
        MIRA_DASHBOARD_PROJECT_ROOT: "/srv/mira-dashboard",
        MIRA_DASHBOARD_PUBLIC_ORIGIN: "https://dashboard.example.com",
        MIRA_DASHBOARD_RECENT_AUTH_MINUTES: "10",
        MIRA_DASHBOARD_SESSION_IDLE_MINUTES: "30",
        MIRA_DASHBOARD_TOTP_KEYRING: serializedKeyring(),
        MIRA_DASHBOARD_TRUSTED_PROXY_IPS: "127.0.0.1,::1",
        MIRA_DASHBOARD_WEBAUTHN_ORIGINS:
            "https://dashboard.example.com,https://admin.example.com",
        MIRA_DASHBOARD_WEBAUTHN_RP_ID: "example.com",
        MIRA_DASHBOARD_WEBAUTHN_RP_NAME: "Mira Dashboard",
        NODE_ENV: "production",
        OPENCLAW_GATEWAY_TOKEN: "gateway-token-test-value",
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
        PORT: "3100",
    };
}

function expectConfigurationError(
    environment: Readonly<Record<string, unknown>>,
    field: string,
    reason: "inconsistent" | "invalid" | "missing"
): void {
    try {
        parseWebConfiguration(environment);
        throw new Error("Expected application configuration parsing to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(ApplicationConfigurationError);
        expect(error).toMatchObject({ field, reason });
    }
}

describe("web application configuration", () => {
    test("parses defaults, domain policy, secrets, and deeply frozen output", () => {
        const environment = validEnvironment();
        delete environment.MIRA_DASHBOARD_LOG_LEVEL;
        delete environment.OPENCLAW_GATEWAY_URL;
        delete environment.PORT;
        const before = { ...environment };
        Object.freeze(environment);

        const configuration = parseWebConfiguration(environment);

        expect(configuration).toMatchObject({
            gatewayUrl: "ws://127.0.0.1:18789/",
            logLevel: "info",
            nodeEnvironment: "production",
            port: 3100,
            projectRoot: "/srv/mira-dashboard",
            publicOrigin: "https://dashboard.example.com",
            recentAuthenticationWindowMs: 600_000,
            sessionIdleDurationMs: 1_800_000,
            trustedProxyAddresses: ["127.0.0.1", "::1"],
            webAuthnRelyingParty: {
                allowedOrigins: [
                    "https://admin.example.com",
                    "https://dashboard.example.com",
                ],
                rpId: "example.com",
                rpName: "Mira Dashboard",
            },
        });
        expect(Redacted.value(configuration.totpKeyring)).toBe(
            environment.MIRA_DASHBOARD_TOTP_KEYRING as string
        );
        expect(Redacted.value(configuration.gatewayToken)).toBe(
            environment.OPENCLAW_GATEWAY_TOKEN as string
        );
        expect(Redacted.value(configuration.elevenLabsApiKey!)).toBe(
            environment.ELEVENLABS_API_KEY as string
        );
        expect(JSON.stringify(configuration.elevenLabsApiKey)).toBe(
            '"<redacted:elevenlabs-api-key>"'
        );
        expect(JSON.stringify(configuration.gatewayToken)).toBe(
            '"<redacted:gateway-token>"'
        );
        expect(JSON.stringify(configuration.totpKeyring)).toBe(
            '"<redacted:totp-keyring>"'
        );
        expect(environment).toEqual(before);
        expect(Object.isFrozen(configuration)).toBe(true);
        expect(Object.isFrozen(configuration.trustedProxyAddresses)).toBe(true);
        expect(Object.isFrozen(configuration.webAuthnRelyingParty)).toBe(true);
        expect(Object.isFrozen(configuration.webAuthnRelyingParty.allowedOrigins)).toBe(
            true
        );
        expect(Object.isFrozen(configuration.totpKeyring)).toBe(true);
        expect(Object.isFrozen(configuration.gatewayToken)).toBe(true);
        expect(Object.isFrozen(configuration.elevenLabsApiKey)).toBe(true);
    });

    test("keeps optional speech capability absent when its credential is absent", () => {
        const environment = validEnvironment();
        delete environment.ELEVENLABS_API_KEY;

        const configuration = parseWebConfiguration(environment);

        expect(configuration).not.toHaveProperty("elevenLabsApiKey");
    });

    test("observes only registered keys and ignores unrelated host variables", () => {
        const environment = validEnvironment();
        const observed = new Set<string | symbol>();
        const guarded = new Proxy(environment, {
            getOwnPropertyDescriptor(target, property) {
                observed.add(property);
                if (
                    typeof property === "string" &&
                    !webConfigurationEnvironmentNames.includes(
                        property as (typeof webConfigurationEnvironmentNames)[number]
                    )
                ) {
                    throw new Error("Unregistered environment key was observed");
                }
                return Reflect.getOwnPropertyDescriptor(target, property);
            },
        });

        const baseline = parseWebConfiguration(environment);
        const parsed = parseWebConfiguration(guarded);

        expect(JSON.stringify(parsed)).toBe(JSON.stringify(baseline));
        expect([...observed].map(String).toSorted()).toEqual(
            [...webConfigurationEnvironmentNames].toSorted()
        );
        expect(
            parseWebConfiguration({ ...environment, HOST_SECRET: "must-not-be-read" })
                .publicOrigin
        ).toBe(baseline.publicOrigin);
        expect(Object.keys(webConfigurationEnvironmentSchema.entries).toSorted()).toEqual(
            [...webConfigurationEnvironmentNames].toSorted()
        );
    });

    test("rejects accessors, hostile descriptors, and inherited values without leakage", () => {
        const sentinel = "configuration-source-sentinel";
        let getterCalls = 0;
        const accessorEnvironment = validEnvironment();
        Object.defineProperty(accessorEnvironment, "NODE_ENV", {
            enumerable: true,
            get() {
                getterCalls += 1;
                throw new Error(sentinel);
            },
        });
        const hostileEnvironment = new Proxy(validEnvironment(), {
            getOwnPropertyDescriptor(target, property) {
                if (property === "PORT") throw new Error(sentinel);
                return Reflect.getOwnPropertyDescriptor(target, property);
            },
        });
        const inheritedEnvironment = Object.assign(
            Object.create({ MIRA_DASHBOARD_PUBLIC_ORIGIN: "https://inherited.invalid" }),
            validEnvironment()
        ) as Record<string, unknown>;
        delete inheritedEnvironment.MIRA_DASHBOARD_PUBLIC_ORIGIN;

        for (const [environment, field, reason] of [
            [accessorEnvironment, "NODE_ENV", "invalid"],
            [hostileEnvironment, "PORT", "invalid"],
            [inheritedEnvironment, "MIRA_DASHBOARD_PUBLIC_ORIGIN", "missing"],
        ] as const) {
            let caught: unknown;
            try {
                parseWebConfiguration(environment);
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(ApplicationConfigurationError);
            expect(caught).toMatchObject({ field, reason });
            expect(String(caught)).not.toContain(sentinel);
            expect((caught as Error).stack ?? "").not.toContain(sentinel);
            expect(inspect(caught)).not.toContain(sentinel);
            expect(JSON.stringify(caught)).not.toContain(sentinel);
            expect("cause" in (caught as object)).toBe(false);
        }
        expect(getterCalls).toBe(0);
    });

    test("allows only the existing localhost WebAuthn policy outside production", () => {
        for (const nodeEnvironment of ["development", "test"] as const) {
            const configuration = parseWebConfiguration({
                ...validEnvironment(),
                MIRA_DASHBOARD_PUBLIC_ORIGIN: "http://localhost:3100",
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "http://localhost:3100",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "localhost",
                NODE_ENV: nodeEnvironment,
            });
            expect(configuration.publicOrigin).toBe("http://localhost:3100");
        }
        expectConfigurationError(
            {
                ...validEnvironment(),
                MIRA_DASHBOARD_PUBLIC_ORIGIN: "http://localhost:3100",
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "http://localhost:3100",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "localhost",
            },
            "MIRA_DASHBOARD_PUBLIC_ORIGIN",
            "inconsistent"
        );
    });

    test("classifies missing required fields without retaining values", () => {
        for (const field of [
            "MIRA_DASHBOARD_PROJECT_ROOT",
            "MIRA_DASHBOARD_PUBLIC_ORIGIN",
            "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
            "MIRA_DASHBOARD_WEBAUTHN_ORIGINS",
            "MIRA_DASHBOARD_TOTP_KEYRING",
            "OPENCLAW_GATEWAY_TOKEN",
        ] as const) {
            const environment = validEnvironment();
            delete environment[field];
            expectConfigurationError(environment, field, "missing");
        }
    });

    test("rejects hostile scalar, URL, path, duration, and list values", () => {
        const cases: readonly [string, unknown, string, "inconsistent" | "invalid"][] = [
            ["ELEVENLABS_API_KEY", "", "ELEVENLABS_API_KEY", "invalid"],
            ["ELEVENLABS_API_KEY", " secret", "ELEVENLABS_API_KEY", "invalid"],
            ["ELEVENLABS_API_KEY", "secret\nvalue", "ELEVENLABS_API_KEY", "invalid"],
            ["NODE_ENV", "staging", "NODE_ENV", "invalid"],
            ["PORT", "0", "PORT", "invalid"],
            ["PORT", "01", "PORT", "invalid"],
            ["PORT", "65536", "PORT", "invalid"],
            ["PORT", 3100, "PORT", "invalid"],
            [
                "MIRA_DASHBOARD_PROJECT_ROOT",
                "relative/path",
                "MIRA_DASHBOARD_PROJECT_ROOT",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_PROJECT_ROOT",
                "/",
                "MIRA_DASHBOARD_PROJECT_ROOT",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_PROJECT_ROOT",
                "/srv/../srv/mira-dashboard",
                "MIRA_DASHBOARD_PROJECT_ROOT",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_PUBLIC_ORIGIN",
                "https://dashboard.example.com/path",
                "MIRA_DASHBOARD_PUBLIC_ORIGIN",
                "invalid",
            ],
            [
                "OPENCLAW_GATEWAY_URL",
                "ws://127.0.0.1:18789/?",
                "OPENCLAW_GATEWAY_URL",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
                "4",
                "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
                "1441",
                "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
                "0",
                "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
                "61",
                "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_TRUSTED_PROXY_IPS",
                "127.0.0.1, ::1",
                "MIRA_DASHBOARD_TRUSTED_PROXY_IPS",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_TRUSTED_PROXY_IPS",
                "127.0.0.1,::ffff:127.0.0.1",
                "MIRA_DASHBOARD_TRUSTED_PROXY_IPS",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
                "Example.com",
                "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_WEBAUTHN_ORIGINS",
                "https://dashboard.example.com,https://dashboard.example.com",
                "MIRA_DASHBOARD_WEBAUTHN_ORIGINS",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_WEBAUTHN_ORIGINS",
                "https://other.example.net",
                "MIRA_DASHBOARD_WEBAUTHN_ORIGINS",
                "inconsistent",
            ],
            [
                "MIRA_DASHBOARD_WEBAUTHN_RP_NAME",
                "Mira\u0000Dashboard",
                "MIRA_DASHBOARD_WEBAUTHN_RP_NAME",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_WEBAUTHN_RP_NAME",
                "Mira Cafe\u0301",
                "MIRA_DASHBOARD_WEBAUTHN_RP_NAME",
                "invalid",
            ],
            [
                "MIRA_DASHBOARD_LOG_LEVEL",
                "verbose",
                "MIRA_DASHBOARD_LOG_LEVEL",
                "invalid",
            ],
        ];

        for (const [key, value, field, reason] of cases) {
            expectConfigurationError(
                { ...validEnvironment(), [key]: value },
                field,
                reason
            );
        }
    });

    test("rejects bounded list and keyring integrity violations", () => {
        expectConfigurationError(
            {
                ...validEnvironment(),
                MIRA_DASHBOARD_TRUSTED_PROXY_IPS: Array.from(
                    { length: 33 },
                    (_, index) => `10.0.0.${index + 1}`
                ).join(","),
            },
            "MIRA_DASHBOARD_TRUSTED_PROXY_IPS",
            "invalid"
        );

        const keyringCases = [
            serializedKeyring({ extra: true }),
            serializedKeyring({ activeKeyId: "missing" }),
            serializedKeyring({
                keys: [
                    {
                        id: "primary",
                        keyBase64: Buffer.alloc(31, 1).toString("base64"),
                    },
                ],
            }),
            serializedKeyring({
                keys: [
                    { id: "primary", keyBase64: encodedKey(1) },
                    { id: "primary", keyBase64: encodedKey(2) },
                ],
            }),
            serializedKeyring({
                keys: [
                    { id: "primary", keyBase64: encodedKey(1) },
                    { id: "secondary", keyBase64: encodedKey(1) },
                ],
            }),
            serializedKeyring({
                keys: Array.from({ length: 9 }, (_, index) => ({
                    id: `key-${index}`,
                    keyBase64: encodedKey(index + 1),
                })),
            }),
        ];
        for (const keyring of keyringCases) {
            expectConfigurationError(
                { ...validEnvironment(), MIRA_DASHBOARD_TOTP_KEYRING: keyring },
                "MIRA_DASHBOARD_TOTP_KEYRING",
                "invalid"
            );
        }
    });

    test("redacts rejected secret values from errors, inspection, and JSON", () => {
        const sentinel = "never-render-this-secret";
        let caught: unknown;
        try {
            parseWebConfiguration({
                ...validEnvironment(),
                MIRA_DASHBOARD_TOTP_KEYRING: `{"${sentinel}":true}`,
            });
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(ApplicationConfigurationError);
        const error = caught as ApplicationConfigurationError;
        expect(error).toMatchObject({
            _tag: "ApplicationConfigurationError",
            field: "MIRA_DASHBOARD_TOTP_KEYRING",
            reason: "invalid",
        });
        for (const rendering of [
            String(error),
            error.stack ?? "",
            inspect(error),
            JSON.stringify(error),
        ]) {
            expect(rendering).not.toContain(sentinel);
        }
        expect(JSON.stringify(error)).toBe(
            '{"_tag":"ApplicationConfigurationError","field":"MIRA_DASHBOARD_TOTP_KEYRING","reason":"invalid"}'
        );
        expect("cause" in error).toBe(false);
    });
});

import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";

import { Redacted } from "effect";

import { ApplicationConfigurationError } from "./applicationConfigurationError.ts";
import {
    parseWorkerConfiguration,
    workerConfigurationEnvironmentNames,
    workerConfigurationEnvironmentSchema,
} from "./workerConfiguration.ts";

function validEnvironment(): Record<string, unknown> {
    return {
        MIRA_DASHBOARD_LOG_LEVEL: "warn",
        MIRA_DASHBOARD_PROJECT_ROOT: "/srv/mira-dashboard",
        NODE_ENV: "production",
        OPENCLAW_GATEWAY_TOKEN: "worker-gateway-token-test-value",
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
    };
}

function configurationFailure(environment: Readonly<Record<string, unknown>>): unknown {
    try {
        parseWorkerConfiguration(environment);
    } catch (error) {
        return error;
    }
    throw new Error("Expected worker configuration parsing to fail");
}

describe("worker application configuration", () => {
    test("parses role defaults into frozen configuration", () => {
        const environment = validEnvironment();
        delete environment.MIRA_DASHBOARD_LOG_LEVEL;
        delete environment.NODE_ENV;
        delete environment.OPENCLAW_GATEWAY_URL;

        const configuration = parseWorkerConfiguration(environment);

        expect(configuration).toMatchObject({
            gatewayUrl: "ws://127.0.0.1:18789/",
            logLevel: "info",
            nodeEnvironment: "production",
            projectRoot: "/srv/mira-dashboard",
        });
        expect(Redacted.value(configuration.gatewayToken)).toBe(
            "worker-gateway-token-test-value"
        );
        expect(JSON.stringify(configuration.gatewayToken)).toBe(
            '"<redacted:gateway-token>"'
        );
        expect(JSON.stringify(configuration)).not.toContain(
            "worker-gateway-token-test-value"
        );
        expect(inspect(configuration)).not.toContain("worker-gateway-token-test-value");
        expect(Object.isFrozen(configuration)).toBe(true);
        expect(Object.isFrozen(configuration.gatewayToken)).toBe(true);
    });

    test("observes only the worker registry projection", () => {
        const observed = new Set<string | symbol>();
        const guarded = new Proxy(validEnvironment(), {
            getOwnPropertyDescriptor(target, property) {
                observed.add(property);
                if (
                    typeof property === "string" &&
                    !workerConfigurationEnvironmentNames.includes(
                        property as (typeof workerConfigurationEnvironmentNames)[number]
                    )
                ) {
                    throw new Error("Unregistered environment key was observed");
                }
                return Reflect.getOwnPropertyDescriptor(target, property);
            },
        });

        expect(parseWorkerConfiguration(guarded).logLevel).toBe("warn");
        expect([...observed].map(String).toSorted()).toEqual(
            [...workerConfigurationEnvironmentNames].toSorted()
        );
        expect(
            Object.keys(workerConfigurationEnvironmentSchema.entries).toSorted()
        ).toEqual([...workerConfigurationEnvironmentNames].toSorted());
    });

    test("does not observe web-only secrets", () => {
        const environment = validEnvironment();
        Object.defineProperty(environment, "MIRA_DASHBOARD_TOTP_KEYRING", {
            get() {
                throw new Error("secret getter must not run");
            },
        });

        expect(parseWorkerConfiguration(environment).projectRoot).toBe(
            "/srv/mira-dashboard"
        );
    });

    test("rejects Gateway credential values without retaining secret material", () => {
        const secret = "worker-secret-sentinel";
        for (const [field, value, reason] of [
            ["OPENCLAW_GATEWAY_TOKEN", ` ${secret}`, "invalid"],
            ["OPENCLAW_GATEWAY_URL", `ws://${secret}.example`, "invalid"],
        ] as const) {
            const environment = validEnvironment();
            environment[field] = value;
            const failure = configurationFailure(environment);

            expect(failure).toBeInstanceOf(ApplicationConfigurationError);
            expect(failure).toMatchObject({ field, reason });
            expect(String(failure)).not.toContain(secret);
            expect((failure as Error).stack ?? "").not.toContain(secret);
            expect(inspect(failure)).not.toContain(secret);
            expect(JSON.stringify(failure)).not.toContain(secret);
            expect("cause" in (failure as object)).toBe(false);
        }
    });

    test("rejects hostile role fields with redacted errors", () => {
        for (const [field, value, reason] of [
            ["NODE_ENV", "staging", "invalid"],
            ["MIRA_DASHBOARD_LOG_LEVEL", "verbose", "invalid"],
            ["MIRA_DASHBOARD_PROJECT_ROOT", "relative", "invalid"],
            ["MIRA_DASHBOARD_PROJECT_ROOT", undefined, "missing"],
            ["OPENCLAW_GATEWAY_TOKEN", undefined, "missing"],
            ["OPENCLAW_GATEWAY_URL", "wss://gateway.example.com", "invalid"],
        ] as const) {
            const environment = validEnvironment();
            if (value === undefined) delete environment[field];
            else environment[field] = value;
            const failure = configurationFailure(environment);
            expect(failure).toBeInstanceOf(ApplicationConfigurationError);
            expect(failure).toMatchObject({ field, reason });
            expect(JSON.stringify(failure)).not.toContain(String(value));
            expect("cause" in (failure as object)).toBe(false);
        }
    });

    test("rejects registered accessors without invoking them", () => {
        let getterCalls = 0;
        const environment = validEnvironment();
        Object.defineProperty(environment, "NODE_ENV", {
            enumerable: true,
            get() {
                getterCalls += 1;
                return "production";
            },
        });

        expect(configurationFailure(environment)).toMatchObject({
            field: "NODE_ENV",
            reason: "invalid",
        });
        expect(getterCalls).toBe(0);
    });
});

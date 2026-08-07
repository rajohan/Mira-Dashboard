import { describe, expect, test } from "bun:test";

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

        const configuration = parseWorkerConfiguration(environment);

        expect(configuration).toEqual({
            logLevel: "info",
            nodeEnvironment: "production",
            projectRoot: "/srv/mira-dashboard",
        });
        expect(Object.isFrozen(configuration)).toBe(true);
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

    test("rejects hostile role fields with redacted errors", () => {
        for (const [field, value, reason] of [
            ["NODE_ENV", "staging", "invalid"],
            ["MIRA_DASHBOARD_LOG_LEVEL", "verbose", "invalid"],
            ["MIRA_DASHBOARD_PROJECT_ROOT", "relative", "invalid"],
            ["MIRA_DASHBOARD_PROJECT_ROOT", undefined, "missing"],
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

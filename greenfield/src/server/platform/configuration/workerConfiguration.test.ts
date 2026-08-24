import { describe, expect, test } from "bun:test";

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
        MIRA_DASHBOARD_OPENCLAW_ROOT: "/srv/openclaw",
        MIRA_DASHBOARD_PROJECT_ROOT: "/srv/mira-dashboard",
        MIRA_DASHBOARD_WORKSPACE_ROOT: "/srv/mira-workspace",
        MOLTBOOK_API_KEY: "worker-moltbook-key-test-value",
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
            moltbookAgentName: "mira_2026",
            nodeEnvironment: "production",
            openClawRoot: "/srv/openclaw",
            projectRoot: "/srv/mira-dashboard",
            workspaceRoot: "/srv/mira-workspace",
        });
        expect(Redacted.value(configuration.gatewayToken)).toBe(
            "worker-gateway-token-test-value"
        );
        expect(JSON.stringify(configuration.gatewayToken)).toBe(
            '"<redacted:gateway-token>"'
        );
        expect(Redacted.value(configuration.moltbookApiKey)).toBe(
            "worker-moltbook-key-test-value"
        );
        expect(JSON.stringify(configuration.moltbookApiKey)).toBe(
            '"<redacted:moltbook-api-key>"'
        );
        expect(JSON.stringify(configuration)).not.toContain(
            "worker-gateway-token-test-value"
        );
        expect(JSON.stringify(configuration)).not.toContain(
            "worker-moltbook-key-test-value"
        );
        expect(Bun.inspect(configuration)).not.toContain(
            "worker-gateway-token-test-value"
        );
        expect(Bun.inspect(configuration)).not.toContain(
            "worker-moltbook-key-test-value"
        );
        expect(Object.isFrozen(configuration)).toBe(true);
        expect(Object.isFrozen(configuration.gatewayToken)).toBe(true);
        expect(Object.isFrozen(configuration.moltbookApiKey)).toBe(true);
        expect(configuration.databaseObservabilityPassword).toBeUndefined();
        expect(configuration.dockerRegistryCredentials).toBeUndefined();
        expect(configuration.githubCredentials).toBeUndefined();
    });

    test("accepts only the database password without topology and redacts it", () => {
        const environment = validEnvironment();
        environment.MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD = "private-password";
        const configuration = parseWorkerConfiguration(environment);

        expect(Redacted.value(configuration.databaseObservabilityPassword!)).toBe(
            "private-password"
        );
        expect(JSON.stringify(configuration)).not.toContain("private-password");
        expect(Bun.inspect(configuration)).not.toContain("private-password");
        expect(JSON.stringify(configuration.databaseObservabilityPassword)).toBe(
            '"<redacted:database-observability-password>"'
        );

        for (const accepted of ["pass/word", "pass%2Fword", "pass@word"]) {
            const candidate = validEnvironment();
            candidate.MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD = accepted;
            expect(
                Redacted.value(
                    parseWorkerConfiguration(candidate).databaseObservabilityPassword!
                )
            ).toBe(accepted);
        }

        for (const invalid of [" private-password", "private-password "]) {
            const candidate = validEnvironment();
            candidate.MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD = invalid;
            expect(configurationFailure(candidate)).toMatchObject({
                field: "MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD",
                reason: "invalid",
            });
        }
    });

    test("accepts complete registry pairs as frozen worker-only redacted values", () => {
        const environment = validEnvironment();
        environment.DOCKER_LOGIN = "docker-user-sentinel";
        environment.DOCKER_TOKEN = "docker-token-sentinel";
        environment.MIRA_GITHUB_USERNAME = "github-user-sentinel";
        environment.MIRA_GITHUB_TOKEN = "github-token-sentinel";
        environment.RAJOHAN_GITHUB_TOKEN = "reviewer-token-sentinel";

        const configuration = parseWorkerConfiguration(environment);
        const credentials = configuration.dockerRegistryCredentials!;
        const githubCredentials = configuration.githubCredentials!;

        expect(Redacted.value(credentials.dockerHub!.username)).toBe(
            "docker-user-sentinel"
        );
        expect(Redacted.value(credentials.dockerHub!.token)).toBe(
            "docker-token-sentinel"
        );
        expect(Redacted.value(credentials.github!.username)).toBe("github-user-sentinel");
        expect(Redacted.value(credentials.github!.token)).toBe("github-token-sentinel");
        expect(Redacted.value(githubCredentials.ordinary!.username)).toBe(
            "github-user-sentinel"
        );
        expect(Redacted.value(githubCredentials.ordinary!.token)).toBe(
            "github-token-sentinel"
        );
        expect(Redacted.value(githubCredentials.reviewerToken!)).toBe(
            "reviewer-token-sentinel"
        );
        for (const secret of [
            "docker-user-sentinel",
            "docker-token-sentinel",
            "github-user-sentinel",
            "github-token-sentinel",
            "reviewer-token-sentinel",
        ]) {
            expect(JSON.stringify(configuration)).not.toContain(secret);
            expect(Bun.inspect(configuration)).not.toContain(secret);
        }
        expect(Object.isFrozen(credentials)).toBe(true);
        expect(Object.isFrozen(credentials.dockerHub)).toBe(true);
        expect(Object.isFrozen(credentials.github)).toBe(true);
        expect(Object.isFrozen(credentials.dockerHub!.username)).toBe(true);
        expect(Object.isFrozen(credentials.dockerHub!.token)).toBe(true);
        expect(Object.isFrozen(credentials.github!.username)).toBe(true);
        expect(Object.isFrozen(credentials.github!.token)).toBe(true);
        expect(Object.isFrozen(githubCredentials)).toBe(true);
        expect(Object.isFrozen(githubCredentials.ordinary)).toBe(true);
        expect(Object.isFrozen(githubCredentials.ordinary!.username)).toBe(true);
        expect(Object.isFrozen(githubCredentials.ordinary!.token)).toBe(true);
        expect(Object.isFrozen(githubCredentials.reviewerToken)).toBe(true);
    });

    test("requires each optional registry username and token as one complete pair", () => {
        for (const [configuredField, missingField] of [
            ["DOCKER_LOGIN", "DOCKER_TOKEN"],
            ["DOCKER_TOKEN", "DOCKER_LOGIN"],
            ["MIRA_GITHUB_USERNAME", "MIRA_GITHUB_TOKEN"],
            ["MIRA_GITHUB_TOKEN", "MIRA_GITHUB_USERNAME"],
        ] as const) {
            const environment = validEnvironment();
            environment[configuredField] = `${configuredField}-private-sentinel`;
            const failure = configurationFailure(environment);

            expect(failure).toBeInstanceOf(ApplicationConfigurationError);
            expect(failure).toMatchObject({ field: missingField, reason: "missing" });
            expect(String(failure)).not.toContain("private-sentinel");
            expect(Bun.inspect(failure)).not.toContain("private-sentinel");
            expect(JSON.stringify(failure)).not.toContain("private-sentinel");
        }
    });

    test("rejects invalid registry credentials without retaining them", () => {
        for (const [field, value, pairField, pairValue] of [
            ["DOCKER_LOGIN", " docker-user-sentinel", "DOCKER_TOKEN", "token"],
            ["DOCKER_TOKEN", "docker-token-sentinel\n", "DOCKER_LOGIN", "user"],
            [
                "MIRA_GITHUB_USERNAME",
                "github-user-sentinel ",
                "MIRA_GITHUB_TOKEN",
                "token",
            ],
            [
                "MIRA_GITHUB_TOKEN",
                `${"github-token-sentinel".repeat(200)}x`,
                "MIRA_GITHUB_USERNAME",
                "user",
            ],
        ] as const) {
            const environment = validEnvironment();
            environment[field] = value;
            environment[pairField] = pairValue;
            const failure = configurationFailure(environment);

            expect(failure).toBeInstanceOf(ApplicationConfigurationError);
            expect(failure).toMatchObject({ field, reason: "invalid" });
            expect(String(failure)).not.toContain("sentinel");
            expect((failure as Error).stack ?? "").not.toContain("sentinel");
            expect(Bun.inspect(failure)).not.toContain("sentinel");
            expect(JSON.stringify(failure)).not.toContain("sentinel");
            expect("cause" in (failure as object)).toBe(false);
        }
    });

    test("accepts the reviewer credential independently and rejects invalid values", () => {
        const environment = validEnvironment();
        environment.RAJOHAN_GITHUB_TOKEN = "reviewer-token-sentinel";

        const configuration = parseWorkerConfiguration(environment);
        expect(configuration.githubCredentials?.ordinary).toBeUndefined();
        expect(Redacted.value(configuration.githubCredentials!.reviewerToken!)).toBe(
            "reviewer-token-sentinel"
        );
        expect(JSON.stringify(configuration)).not.toContain("reviewer-token-sentinel");

        environment.RAJOHAN_GITHUB_TOKEN = " reviewer-token-sentinel";
        expect(configurationFailure(environment)).toMatchObject({
            field: "RAJOHAN_GITHUB_TOKEN",
            reason: "invalid",
        });
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
            ["MOLTBOOK_API_KEY", ` ${secret}`, "invalid"],
            ["MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD", ` ${secret}`, "invalid"],
            ["OPENCLAW_GATEWAY_URL", `ws://${secret}.example`, "invalid"],
        ] as const) {
            const environment = validEnvironment();
            environment[field] = value;
            const failure = configurationFailure(environment);

            expect(failure).toBeInstanceOf(ApplicationConfigurationError);
            expect(failure).toMatchObject({ field, reason });
            expect(String(failure)).not.toContain(secret);
            expect((failure as Error).stack ?? "").not.toContain(secret);
            expect(Bun.inspect(failure)).not.toContain(secret);
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
            ["MIRA_DASHBOARD_OPENCLAW_ROOT", "relative", "invalid"],
            ["MIRA_DASHBOARD_OPENCLAW_ROOT", undefined, "missing"],
            ["MIRA_DASHBOARD_WORKSPACE_ROOT", "relative", "invalid"],
            ["MIRA_DASHBOARD_WORKSPACE_ROOT", undefined, "missing"],
            ["MOLTBOOK_AGENT_NAME", " mira_2026", "invalid"],
            ["MOLTBOOK_API_KEY", undefined, "missing"],
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

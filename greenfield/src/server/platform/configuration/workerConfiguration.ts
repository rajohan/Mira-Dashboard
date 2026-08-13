import { Redacted } from "effect";
import * as v from "valibot";

import { configurationEnvironmentNamesForRole } from "../../../shared/configuration/applicationConfigurationRegistry.ts";
import { configurationDatabaseObservabilityPassword } from "./databaseObservabilityConfiguration.ts";
import {
    configurationDockerRegistryCredentials,
    type DockerRegistryCredentialsConfiguration,
} from "./dockerRegistryConfiguration.ts";
import {
    configurationGatewayToken,
    configurationGatewayUrl,
} from "./gatewayConfiguration.ts";
import {
    configurationMoltbookAgentName,
    configurationMoltbookApiKey,
} from "./moltbookConfiguration.ts";
import {
    configurationChoice,
    configurationOpenClawRoot,
    configurationProjectRoot,
    configurationWorkspaceRoot,
    pickApplicationEnvironment,
    type ApplicationLogLevel,
    type ApplicationNodeEnvironment,
} from "./processConfiguration.ts";

/** Immutable, validated configuration consumed by the greenfield worker process. */
export interface WorkerConfiguration {
    readonly databaseObservabilityPassword?: Redacted.Redacted<string>;
    readonly dockerRegistryCredentials?: DockerRegistryCredentialsConfiguration;
    readonly gatewayToken: Redacted.Redacted<string>;
    readonly gatewayUrl: string;
    readonly logLevel: ApplicationLogLevel;
    readonly moltbookAgentName: string;
    readonly moltbookApiKey: Redacted.Redacted<string>;
    readonly nodeEnvironment: ApplicationNodeEnvironment;
    readonly openClawRoot: string;
    readonly projectRoot: string;
    readonly workspaceRoot: string;
}

const optionalEnvironmentValueSchema = v.optional(v.unknown());

/** Valibot projection for the complete accepted worker-process environment surface. */
export const workerConfigurationEnvironmentSchema = v.object({
    DOCKER_LOGIN: optionalEnvironmentValueSchema,
    DOCKER_TOKEN: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD: optionalEnvironmentValueSchema,
    MIRA_GITHUB_TOKEN: optionalEnvironmentValueSchema,
    MIRA_GITHUB_USERNAME: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_LOG_LEVEL: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_OPENCLAW_ROOT: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_PROJECT_ROOT: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_WORKSPACE_ROOT: optionalEnvironmentValueSchema,
    MOLTBOOK_AGENT_NAME: optionalEnvironmentValueSchema,
    MOLTBOOK_API_KEY: optionalEnvironmentValueSchema,
    NODE_ENV: optionalEnvironmentValueSchema,
    OPENCLAW_GATEWAY_TOKEN: optionalEnvironmentValueSchema,
    OPENCLAW_GATEWAY_URL: optionalEnvironmentValueSchema,
});

/** Registered environment names consumed by the worker-process parser. */
export const workerConfigurationEnvironmentNames =
    configurationEnvironmentNamesForRole("worker");

/**
 * Parses an injected untrusted environment record into immutable worker configuration.
 * @param source Untrusted injected environment-like record.
 * @returns Frozen worker configuration with a redacted Gateway credential and no web-only fields.
 */
export function parseWorkerConfiguration(
    source: Readonly<Record<string, unknown>>
): WorkerConfiguration {
    const input = pickApplicationEnvironment(
        "worker",
        workerConfigurationEnvironmentNames,
        source,
        (projection) => v.parse(workerConfigurationEnvironmentSchema, projection)
    );
    const databaseObservabilityPassword =
        configurationDatabaseObservabilityPassword(input);
    const dockerRegistryCredentials = configurationDockerRegistryCredentials(input);
    return Object.freeze({
        ...(databaseObservabilityPassword === undefined
            ? {}
            : {
                  databaseObservabilityPassword,
              }),
        ...(dockerRegistryCredentials === undefined ? {} : { dockerRegistryCredentials }),
        gatewayToken: configurationGatewayToken(input),
        gatewayUrl: configurationGatewayUrl(input),
        logLevel: configurationChoice(input, "MIRA_DASHBOARD_LOG_LEVEL", [
            "debug",
            "error",
            "info",
            "warn",
        ] as const),
        moltbookAgentName: configurationMoltbookAgentName(input),
        moltbookApiKey: configurationMoltbookApiKey(input),
        nodeEnvironment: configurationChoice(input, "NODE_ENV", [
            "development",
            "production",
            "test",
        ] as const),
        openClawRoot: configurationOpenClawRoot(input),
        projectRoot: configurationProjectRoot(input),
        workspaceRoot: configurationWorkspaceRoot(input),
    });
}

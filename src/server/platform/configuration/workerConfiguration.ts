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
    configurationGitHubCredentials,
    type GitHubCredentialsConfiguration,
} from "./githubCredentialsConfiguration.ts";
import {
    configurationMoltbookAgentName,
    configurationMoltbookApiKey,
} from "./moltbookConfiguration.ts";
import {
    configurationChoice,
    configurationOpenClawRoot,
    configurationProjectRoot,
    configurationWebPort,
    configurationWorkspaceRoot,
    pickApplicationEnvironment,
    type ApplicationLogLevel,
    type ApplicationNodeEnvironment,
} from "./processConfiguration.ts";
import {
    configurationQuotaCredentials,
    type QuotaCredentialsConfiguration,
} from "./quotaConfiguration.ts";

/** Immutable, validated configuration consumed by the greenfield worker process. */
export interface WorkerConfiguration {
    readonly databaseObservabilityPassword?: Redacted.Redacted<string>;
    readonly dockerRegistryCredentials?: DockerRegistryCredentialsConfiguration;
    readonly gatewayToken: Redacted.Redacted<string>;
    readonly gatewayUrl: string;
    readonly githubCredentials?: GitHubCredentialsConfiguration;
    readonly logLevel: ApplicationLogLevel;
    readonly moltbookAgentName: string;
    readonly moltbookApiKey: Redacted.Redacted<string>;
    readonly nodeEnvironment: ApplicationNodeEnvironment;
    readonly openClawRoot: string;
    readonly port: number;
    readonly projectRoot: string;
    readonly quotaCredentials?: QuotaCredentialsConfiguration;
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
    RAJOHAN_GITHUB_TOKEN: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_LOG_LEVEL: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_OPENCLAW_ROOT: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_PROJECT_ROOT: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_WORKSPACE_ROOT: optionalEnvironmentValueSchema,
    MOLTBOOK_AGENT_NAME: optionalEnvironmentValueSchema,
    MOLTBOOK_API_KEY: optionalEnvironmentValueSchema,
    NODE_ENV: optionalEnvironmentValueSchema,
    OPENROUTER_API_KEY: optionalEnvironmentValueSchema,
    OPENCLAW_GATEWAY_TOKEN: optionalEnvironmentValueSchema,
    OPENCLAW_GATEWAY_URL: optionalEnvironmentValueSchema,
    PORT: optionalEnvironmentValueSchema,
    SYNTHETIC_API_KEY: optionalEnvironmentValueSchema,
    ELEVENLABS_API_KEY: optionalEnvironmentValueSchema,
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
    const githubCredentials = configurationGitHubCredentials(input);
    const quotaCredentials = configurationQuotaCredentials(input);
    return Object.freeze({
        ...(databaseObservabilityPassword === undefined
            ? {}
            : {
                  databaseObservabilityPassword,
              }),
        ...(dockerRegistryCredentials === undefined ? {} : { dockerRegistryCredentials }),
        ...(githubCredentials === undefined ? {} : { githubCredentials }),
        ...(quotaCredentials === undefined ? {} : { quotaCredentials }),
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
        port: configurationWebPort(input),
        projectRoot: configurationProjectRoot(input),
        workspaceRoot: configurationWorkspaceRoot(input),
    });
}

import { Redacted } from "effect";

import {
    applicationConfigurationLimits,
    type ApplicationConfigurationEnvironmentName,
} from "../../../shared/configuration/applicationConfigurationRegistry.ts";
import {
    configurationError,
    type PickedApplicationEnvironment,
    requiredConfigurationString,
} from "./processConfiguration.ts";

/** One complete worker-only registry login retained only as redacted values. */
export interface DockerRegistryCredentialConfiguration {
    readonly token: Redacted.Redacted<string>;
    readonly username: Redacted.Redacted<string>;
}

/** Optional credentials for the two reviewed updater registry authorities. */
export interface DockerRegistryCredentialsConfiguration {
    readonly dockerHub?: DockerRegistryCredentialConfiguration;
    readonly github?: DockerRegistryCredentialConfiguration;
}

function isAbsent(value: unknown): boolean {
    return value === null || value === undefined || value === "";
}

function credentialPair(
    input: PickedApplicationEnvironment,
    usernameField: ApplicationConfigurationEnvironmentName,
    tokenField: ApplicationConfigurationEnvironmentName,
    label: string
): DockerRegistryCredentialConfiguration | undefined {
    const usernameAbsent = isAbsent(input[usernameField]);
    const tokenAbsent = isAbsent(input[tokenField]);
    if (usernameAbsent && tokenAbsent) return undefined;
    if (usernameAbsent) configurationError(usernameField, "missing");
    if (tokenAbsent) configurationError(tokenField, "missing");
    const username = requiredConfigurationString(
        input,
        usernameField,
        applicationConfigurationLimits.dockerRegistryUsernameMaximumLength
    );
    const token = requiredConfigurationString(
        input,
        tokenField,
        applicationConfigurationLimits.dockerRegistryTokenMaximumLength
    );
    return Object.freeze({
        token: Object.freeze(Redacted.make(token, { label: `${label}-registry-token` })),
        username: Object.freeze(
            Redacted.make(username, { label: `${label}-registry-username` })
        ),
    });
}

/**
 * Parses the two optional registry pairs without accepting any registry host or topology input.
 * @param input Registry-projected worker environment.
 * @returns Frozen redacted registry credentials when at least one complete pair is configured.
 */
export function configurationDockerRegistryCredentials(
    input: PickedApplicationEnvironment
): DockerRegistryCredentialsConfiguration | undefined {
    const dockerHub = credentialPair(input, "DOCKER_LOGIN", "DOCKER_TOKEN", "docker-hub");
    const github = credentialPair(
        input,
        "MIRA_GITHUB_USERNAME",
        "MIRA_GITHUB_TOKEN",
        "github"
    );
    if (dockerHub === undefined && github === undefined) return undefined;
    return Object.freeze({
        ...(dockerHub === undefined ? {} : { dockerHub }),
        ...(github === undefined ? {} : { github }),
    });
}

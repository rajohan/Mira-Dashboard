import { Redacted } from "effect";

import { applicationConfigurationLimits } from "../../../shared/configuration/applicationConfigurationRegistry.ts";
import {
    configurationError,
    type PickedApplicationEnvironment,
    requiredConfigurationString,
} from "./processConfiguration.ts";

export interface QuotaCredentialsConfiguration {
    readonly elevenLabs?: Redacted.Redacted<string>;
    readonly openRouter?: Redacted.Redacted<string>;
    readonly synthetic?: Redacted.Redacted<string>;
}

function optionalSecret(
    input: PickedApplicationEnvironment,
    field: "ELEVENLABS_API_KEY" | "OPENROUTER_API_KEY" | "SYNTHETIC_API_KEY",
    label: string
): Redacted.Redacted<string> | undefined {
    if (input[field] === null || input[field] === undefined) return undefined;
    if (input[field] === "") return configurationError(field, "invalid");
    return Object.freeze(
        Redacted.make(
            requiredConfigurationString(
                input,
                field,
                applicationConfigurationLimits.quotaApiKeyMaximumLength
            ),
            { label }
        )
    );
}

/**
 * Parses optional worker-only quota credentials without provider fallback.
 * @returns The configured provider credentials, or undefined when none exist.
 */
export function configurationQuotaCredentials(
    input: PickedApplicationEnvironment
): QuotaCredentialsConfiguration | undefined {
    const configuration = Object.freeze({
        elevenLabs: optionalSecret(input, "ELEVENLABS_API_KEY", "quota-elevenlabs"),
        openRouter: optionalSecret(input, "OPENROUTER_API_KEY", "quota-openrouter"),
        synthetic: optionalSecret(input, "SYNTHETIC_API_KEY", "quota-synthetic"),
    });
    return Object.values(configuration).some((value) => value !== undefined)
        ? configuration
        : undefined;
}

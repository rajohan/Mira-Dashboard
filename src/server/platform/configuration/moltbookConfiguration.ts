import { Redacted } from "effect";

import { applicationConfigurationLimits } from "../../../shared/configuration/applicationConfigurationRegistry.ts";
import {
    type PickedApplicationEnvironment,
    requiredConfigurationString,
} from "./processConfiguration.ts";

/**
 * Parses the worker-only Moltbook API credential into a non-inspectable value.
 * @param input Registry-projected worker configuration.
 * @returns Frozen redacted Moltbook credential.
 */
export function configurationMoltbookApiKey(
    input: PickedApplicationEnvironment
): Redacted.Redacted<string> {
    const raw = requiredConfigurationString(
        input,
        "MOLTBOOK_API_KEY",
        applicationConfigurationLimits.moltbookApiKeyMaximumLength
    );
    return Object.freeze(Redacted.make(raw, { label: "moltbook-api-key" }));
}

/**
 * Parses the profile identity later encoded into the one fixed provider URL.
 * @param input Registry-projected worker configuration.
 * @returns Validated Moltbook agent identity.
 */
export function configurationMoltbookAgentName(
    input: PickedApplicationEnvironment
): string {
    return requiredConfigurationString(
        input,
        "MOLTBOOK_AGENT_NAME",
        applicationConfigurationLimits.moltbookAgentNameMaximumLength
    );
}

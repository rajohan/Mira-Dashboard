import { Redacted } from "effect";

import { applicationConfigurationLimits } from "../../../shared/configuration/applicationConfigurationRegistry.ts";
import {
    type PickedApplicationEnvironment,
    requiredConfigurationString,
} from "./processConfiguration.ts";

const field = "MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD" as const;

/**
 * Parses the optional dedicated observer password without accepting topology or database names.
 * @param input Registry-projected worker environment.
 * @returns A redacted password when database observability is configured.
 */
export function configurationDatabaseObservabilityPassword(
    input: PickedApplicationEnvironment
): Redacted.Redacted<string> | undefined {
    if (input[field] === null || input[field] === undefined || input[field] === "") {
        return undefined;
    }
    const password = requiredConfigurationString(
        input,
        field,
        applicationConfigurationLimits.databaseObservabilityPasswordMaximumLength
    );
    return Object.freeze(
        Redacted.make(password, { label: "database-observability-password" })
    );
}

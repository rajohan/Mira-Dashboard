import { Redacted } from "effect";

import { applicationConfigurationLimits } from "../../../shared/configuration/applicationConfigurationRegistry.ts";
import { databaseObservabilityObserverRole } from "../../../shared/databaseObservabilityPolicy.ts";
import {
    configurationError,
    type PickedApplicationEnvironment,
    requiredConfigurationString,
} from "./processConfiguration.ts";

const field = "MIRA_DASHBOARD_DATABASE_OBSERVABILITY_URL" as const;

/**
 * Parses the optional dedicated monitoring principal without exposing its value.
 * Only the exact loopback PgBouncer endpoint is accepted; database selection is code-owned.
 * @returns A redacted canonical monitoring URL when configured.
 */
export function configurationDatabaseObservabilityUrl(
    input: PickedApplicationEnvironment
): Redacted.Redacted<string> | undefined {
    if (input[field] === null || input[field] === undefined || input[field] === "") {
        return undefined;
    }
    const raw = requiredConfigurationString(
        input,
        field,
        applicationConfigurationLimits.databaseObservabilityUrlMaximumLength
    );
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return configurationError(field, "invalid");
    }
    let decodedUsername: string;
    let decodedPassword: string;
    try {
        decodedUsername = decodeURIComponent(url.username);
        decodedPassword = decodeURIComponent(url.password);
    } catch {
        return configurationError(field, "invalid");
    }
    if (
        url.protocol !== "postgresql:" ||
        url.hostname !== "127.0.0.1" ||
        url.port !== "6432" ||
        url.pathname !== "/postgres" ||
        decodedUsername === "" ||
        decodedPassword === "" ||
        decodedUsername !== url.username ||
        decodedUsername !== databaseObservabilityObserverRole ||
        decodedPassword !== url.password ||
        decodedUsername !== decodedUsername.trim() ||
        decodedPassword !== decodedPassword.trim() ||
        /[\p{Cc}\p{Cf}/@]/u.test(decodedUsername) ||
        /[\p{Cc}\p{Cf}/@]/u.test(decodedPassword) ||
        url.search !== "" ||
        url.hash !== "" ||
        url.href !== raw
    ) {
        return configurationError(field, "invalid");
    }
    return Object.freeze(Redacted.make(raw, { label: "database-observability-url" }));
}

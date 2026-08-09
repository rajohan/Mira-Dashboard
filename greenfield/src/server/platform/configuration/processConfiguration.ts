import path from "node:path";

import {
    applicationConfigurationLimits,
    configurationMetadata,
    type ApplicationConfigurationEnvironmentName,
    type ApplicationProcessRole,
} from "../../../shared/configuration/applicationConfigurationRegistry.ts";
import {
    ApplicationConfigurationError,
    type ApplicationConfigurationFailureReason,
} from "./applicationConfigurationError.ts";

export type ApplicationNodeEnvironment = "development" | "production" | "test";
export type ApplicationLogLevel = "debug" | "error" | "info" | "warn";

export type PickedApplicationEnvironment = Readonly<
    Partial<Record<ApplicationConfigurationEnvironmentName, unknown>>
>;

type RuntimeApplicationRole = Extract<ApplicationProcessRole, "web" | "worker">;
type ProjectedEnvironment = Readonly<Partial<Record<string, unknown>>>;

const unsafeTextPattern = /[\p{Cc}\p{Cf}]/u;

/** Throws one redacted immutable-configuration failure. */
export function configurationError(
    field: ApplicationConfigurationEnvironmentName,
    reason: ApplicationConfigurationFailureReason
): never {
    throw new ApplicationConfigurationError(field, reason);
}

/**
 * Reads only an explicit process role's own data properties and applies registry defaults.
 * @param role Runtime process role being composed.
 * @param environmentNames Exact registered names for the role.
 * @param source Untrusted environment-like source.
 * @param parseProjection Role schema parser for the observed projection.
 * @returns Frozen selected values with defaults applied.
 */
export function pickApplicationEnvironment(
    role: RuntimeApplicationRole,
    environmentNames: readonly ApplicationConfigurationEnvironmentName[],
    source: Readonly<Record<string, unknown>>,
    parseProjection: (
        projection: Readonly<Record<string, unknown>>
    ) => ProjectedEnvironment
): PickedApplicationEnvironment {
    const sourceProjection = Object.create(null) as Record<string, unknown>;
    for (const environmentName of environmentNames) {
        let descriptor: PropertyDescriptor | undefined;
        try {
            descriptor = Object.getOwnPropertyDescriptor(source, environmentName);
        } catch {
            configurationError(environmentName, "invalid");
        }
        if (descriptor === undefined) continue;
        if (!("value" in descriptor)) configurationError(environmentName, "invalid");
        sourceProjection[environmentName] = descriptor.value;
    }

    const projected = parseProjection(sourceProjection);
    const picked = Object.create(null) as Record<
        ApplicationConfigurationEnvironmentName,
        unknown
    >;
    for (const environmentName of environmentNames) {
        const metadata = configurationMetadata(environmentName);
        if (!metadata.roles.includes(role))
            configurationError(environmentName, "invalid");
        const supplied = projected[environmentName];
        picked[environmentName] =
            supplied === undefined ? metadata.defaultValue : supplied;
    }
    return Object.freeze(picked);
}

/**
 * Reads one bounded trimmed string without retaining rejected input.
 * @returns Validated string value.
 */
export function requiredConfigurationString(
    input: PickedApplicationEnvironment,
    field: ApplicationConfigurationEnvironmentName,
    maximumLength: number,
    allowEmpty = false
): string {
    const value = input[field];
    if (value === null || value === undefined || value === "") {
        if (allowEmpty && value === "") return value;
        configurationError(field, "missing");
    }
    if (
        typeof value !== "string" ||
        value.length > maximumLength ||
        value !== value.trim() ||
        unsafeTextPattern.test(value)
    ) {
        configurationError(field, "invalid");
    }
    return value;
}

/**
 * Parses one exact enumerated configuration value.
 * @returns Exact selected choice.
 */
export function configurationChoice<T extends string>(
    input: PickedApplicationEnvironment,
    field: ApplicationConfigurationEnvironmentName,
    choices: readonly T[]
): T {
    const value = requiredConfigurationString(input, field, 32);
    if (!choices.includes(value as T)) configurationError(field, "invalid");
    return value as T;
}

/**
 * Parses the lexical project root before the composition root performs realpath validation.
 * @returns Normalized absolute project-root candidate.
 */
export function configurationProjectRoot(input: PickedApplicationEnvironment): string {
    const field = "MIRA_DASHBOARD_PROJECT_ROOT" as const;
    const value = requiredConfigurationString(
        input,
        field,
        applicationConfigurationLimits.projectRootMaximumLength
    );
    if (
        !path.isAbsolute(value) ||
        value === path.parse(value).root ||
        path.resolve(value) !== value
    ) {
        configurationError(field, "invalid");
    }
    return value;
}

/**
 * Parses the explicit lexical workspace root before descriptor adapters open it.
 * @returns Normalized absolute non-root workspace candidate.
 */
export function configurationWorkspaceRoot(input: PickedApplicationEnvironment): string {
    const field = "MIRA_DASHBOARD_WORKSPACE_ROOT" as const;
    const value = requiredConfigurationString(
        input,
        field,
        applicationConfigurationLimits.workspaceRootMaximumLength
    );
    if (
        !path.isAbsolute(value) ||
        value === path.parse(value).root ||
        path.resolve(value) !== value
    ) {
        configurationError(field, "invalid");
    }
    return value;
}

/**
 * Parses the explicit OpenClaw home without consulting HOME or runtime discovery.
 * @param input Registry-projected web configuration.
 * @returns Normalized absolute non-root OpenClaw path.
 */
export function configurationOpenClawRoot(input: PickedApplicationEnvironment): string {
    const field = "MIRA_DASHBOARD_OPENCLAW_ROOT" as const;
    const value = requiredConfigurationString(
        input,
        field,
        applicationConfigurationLimits.openClawRootMaximumLength
    );
    if (
        !path.isAbsolute(value) ||
        value === path.parse(value).root ||
        path.resolve(value) !== value
    ) {
        configurationError(field, "invalid");
    }
    return value;
}

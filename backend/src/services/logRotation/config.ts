import fs from "node:fs/promises";

export interface LogRotationOptions {
    isDryRun: boolean;
    config?: string;
    group?: string;
    verbose?: boolean;
}

export interface LogRotationPolicy {
    name?: string;
    enabled?: boolean;
    paths?: string[];
    excludePaths?: string[];
    archivePaths?: string[];
    approvedRoots?: string[];
    archiveOnly?: boolean;
    archiveRetentionScope?: "directory" | "basename" | "parent";
    archiveMinAgeMinutes?: number;
    compress?: boolean;
    shouldCompress?: boolean;
    skipEmpty?: boolean;
    missingOk?: boolean;
    maxSizeMb?: number;
    keep?: number;
    keepDays?: number;
    strategy?: "copytruncate" | "rename";
    daily?: boolean;
    weekly?: boolean;
}

export interface LogRotationConfig {
    version: number;
    approvedRoots?: string[];
    excludePaths?: string[];
    defaults?: LogRotationPolicy;
    groups: LogRotationPolicy[];
}

export function byteLimitFromMb(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1024 * 1024 : undefined;
}

export function mergePolicy(
    defaults: LogRotationPolicy,
    group: LogRotationPolicy
): LogRotationPolicy {
    return {
        shouldCompress: true,
        skipEmpty: true,
        missingOk: true,
        maxSizeMb: 10,
        keep: 7,
        strategy: "copytruncate",
        daily: false,
        weekly: false,
        ...defaults,
        ...group,
    };
}

export function shouldCompressPolicy(policy: LogRotationPolicy): boolean {
    return policy.shouldCompress ?? policy.compress ?? true;
}

export async function loadLogRotationConfig(
    filePath: string
): Promise<LogRotationConfig> {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as LogRotationConfig;
}

/** Validates one log-rotation configuration without performing file I/O. */
export function validateLogRotationConfig(config: LogRotationConfig): void {
    if (!config || typeof config !== "object") {
        throw new Error("Config must be an object");
    }
    if (
        config.defaults !== undefined &&
        (config.defaults === null ||
            typeof config.defaults !== "object" ||
            Array.isArray(config.defaults))
    ) {
        throw new Error("Config defaults must be an object");
    }
    if (config.version !== 1) {
        throw new Error("Config version must be 1");
    }
    if (!Array.isArray(config.groups)) {
        throw new TypeError("Config groups must be an array");
    }
    validateNonEmptyOptionalStringArray(config.approvedRoots, "approvedRoots");
    validateNonEmptyOptionalStringArray(
        config.defaults?.approvedRoots,
        "defaults.approvedRoots"
    );
    validateOptionalStringArray(config.defaults?.paths, "defaults.paths");
    validateOptionalStringArray(
        config.defaults?.excludePaths,
        "defaults.excludePaths"
    );
    validateOptionalStringArray(
        config.defaults?.archivePaths,
        "defaults.archivePaths"
    );
    validatePolicyTypes(config.defaults, "defaults");
    validateOptionalStringArray(config.excludePaths, "excludePaths");
    validateArchiveRetentionScope(
        config.defaults?.archiveRetentionScope,
        "defaults.archiveRetentionScope"
    );
    if (
        config.defaults?.strategy !== undefined &&
        config.defaults.strategy !== "copytruncate" &&
        config.defaults.strategy !== "rename"
    ) {
        throw new Error("defaults.strategy has unsupported strategy");
    }
    for (const group of config.groups) {
        if (typeof group.name !== "string" || group.name.trim() === "") {
            throw new Error("Every group needs a string name");
        }
        validateNonEmptyOptionalStringArray(
            group.approvedRoots,
            `Group ${group.name} approvedRoots`
        );
        validateOptionalStringArray(group.paths, `Group ${group.name} paths`);
        validateOptionalStringArray(
            group.excludePaths,
            `Group ${group.name} excludePaths`
        );
        validateOptionalStringArray(
            group.archivePaths,
            `Group ${group.name} archivePaths`
        );
        validateArchiveRetentionScope(
            group.archiveRetentionScope,
            `Group ${group.name} archiveRetentionScope`
        );
        validatePolicyTypes(group, `Group ${group.name}`);
        const effectivePolicy = mergePolicy(config.defaults ?? {}, group);
        if (effectivePolicy.daily === true && effectivePolicy.weekly === true) {
            throw new Error(
                `Group ${group.name} cannot set both daily and weekly rotation`
            );
        }
        const hasPaths =
            Array.isArray(effectivePolicy.paths) && effectivePolicy.paths.length > 0;
        const hasArchivePaths =
            Array.isArray(effectivePolicy.archivePaths) &&
            effectivePolicy.archivePaths.length > 0;
        if (!hasArchivePaths && effectivePolicy.archiveOnly === true) {
            throw new Error(
                `Archive-only group ${group.name} needs at least one archivePaths pattern`
            );
        }
        if (!hasPaths && effectivePolicy.archiveOnly !== true) {
            throw new Error(`Group ${group.name} needs at least one path pattern`);
        }
        if (
            effectivePolicy.strategy !== undefined &&
            effectivePolicy.strategy !== "copytruncate" &&
            effectivePolicy.strategy !== "rename"
        ) {
            throw new Error(`Group ${group.name} has unsupported strategy`);
        }
    }
}

function validatePolicyTypes(
    policy: LogRotationPolicy | undefined,
    label: string
): void {
    if (policy === undefined) return;
    for (const field of [
        "enabled",
        "archiveOnly",
        "daily",
        "weekly",
        "compress",
        "shouldCompress",
        "skipEmpty",
        "missingOk",
    ] as const) {
        if (policy[field] !== undefined && typeof policy[field] !== "boolean") {
            throw new TypeError(`${label}.${field} must be a boolean`);
        }
    }
    for (const field of [
        "maxSizeMb",
        "keepDays",
        "archiveMinAgeMinutes",
    ] as const) {
        if (
            policy[field] !== undefined &&
            (typeof policy[field] !== "number" || policy[field] < 0)
        ) {
            throw new TypeError(`${label}.${field} must be a non-negative number`);
        }
    }
    if (
        policy.keep !== undefined &&
        (typeof policy.keep !== "number" ||
            policy.keep < 1 ||
            !Number.isSafeInteger(policy.keep))
    ) {
        throw new TypeError(`${label}.keep must be a positive integer`);
    }
}

function validateOptionalStringArray(value: unknown, fieldName: string): void {
    if (value === undefined) return;
    if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string" || entry.trim() === "")
    ) {
        throw new TypeError(`${fieldName} must be an array of non-empty strings`);
    }
}

function validateNonEmptyOptionalStringArray(
    value: unknown,
    fieldName: string
): void {
    validateOptionalStringArray(value, fieldName);
    if (Array.isArray(value) && value.length === 0) {
        throw new TypeError(`${fieldName} must include at least one entry`);
    }
}

function validateArchiveRetentionScope(value: unknown, fieldName: string): void {
    if (value === undefined) return;
    if (value !== "directory" && value !== "basename" && value !== "parent") {
        throw new TypeError(`${fieldName} must be directory, basename, or parent`);
    }
}

import { type AppObservabilityMetrics, parseAppObservabilityMetrics } from "./metrics";
import {
    contractEnum,
    contractFiniteNumber,
    contractRecord,
    contractString,
    invalidContract,
    optionalContractString,
    requiresContractBoolean,
} from "./runtime";

export interface ReleaseMigrationIdentity {
    checksum: string;
    name: string;
    version: number;
}

export interface ReleaseSchema {
    maximumCompatible: number;
    migrationInventorySha256: string;
    migrationRegistrySha256: string;
    migrations: ReleaseMigrationIdentity[];
    minimumCompatible: number;
    target: number;
}

export type RuntimeReleaseIssue =
    | "build-identity-invalid"
    | "manifest-code-mismatch"
    | "manifest-invalid"
    | "manifest-missing";

export type RuntimeReleaseSource = "git" | "manifest" | "unknown";

export interface RuntimeReleaseIdentity {
    artifactCount?: number;
    backendCommit: string;
    commitSha?: string;
    frontendCommit: string;
    issue?: RuntimeReleaseIssue;
    manifestFormatVersion?: number;
    ready: boolean;
    schema?: ReleaseSchema;
    source: RuntimeReleaseSource;
}

export interface DatabaseReadiness {
    currentSchemaVersion?: number;
    maximumCompatibleSchemaVersion: number;
    minimumCompatibleSchemaVersion: number;
    ready: boolean;
    targetSchemaVersion: number;
}

export interface DashboardReadinessSnapshot {
    checks: {
        database: DatabaseReadiness;
        frontend: { ready: boolean };
        release: {
            backendCommit: string;
            frontendCommit: string;
            issue?: RuntimeReleaseIssue;
            manifestFormatVersion?: number;
            ready: boolean;
            source: RuntimeReleaseSource;
        };
        worker: { ready: boolean };
    };
    dependencies: {
        gatewayConnected: boolean;
    };
    status: "isReady" | "notReady";
}

export interface DashboardDiagnosticsResponse extends DashboardReadinessSnapshot {
    observability: AppObservabilityMetrics;
    releaseDetails: RuntimeReleaseIdentity;
    sessionCount: number;
}

export interface DashboardLivenessResponse {
    status: "isOk";
    uptimeSeconds: number;
}

const RELEASE_ISSUES = [
    "build-identity-invalid",
    "manifest-code-mismatch",
    "manifest-invalid",
    "manifest-missing",
] as const;
const RELEASE_SOURCES = ["git", "manifest", "unknown"] as const;

function parseDatabaseReadiness(value: unknown, path: string): DatabaseReadiness {
    const input = contractRecord(value, path);
    const currentSchemaVersion =
        input.currentSchemaVersion === undefined
            ? undefined
            : contractFiniteNumber(
                  input.currentSchemaVersion,
                  `${path}.currentSchemaVersion`
              );
    return {
        maximumCompatibleSchemaVersion: contractFiniteNumber(
            input.maximumCompatibleSchemaVersion,
            `${path}.maximumCompatibleSchemaVersion`
        ),
        minimumCompatibleSchemaVersion: contractFiniteNumber(
            input.minimumCompatibleSchemaVersion,
            `${path}.minimumCompatibleSchemaVersion`
        ),
        ready: requiresContractBoolean(input.ready, `${path}.ready`),
        targetSchemaVersion: contractFiniteNumber(
            input.targetSchemaVersion,
            `${path}.targetSchemaVersion`
        ),
        ...(currentSchemaVersion !== undefined && { currentSchemaVersion }),
    };
}

function parseReleaseSchema(value: unknown, path: string): ReleaseSchema {
    const input = contractRecord(value, path);
    if (!Array.isArray(input.migrations)) {
        return invalidContract(`${path}.migrations`, "must be an array");
    }
    return {
        maximumCompatible: contractFiniteNumber(
            input.maximumCompatible,
            `${path}.maximumCompatible`
        ),
        migrationInventorySha256: contractString(
            input.migrationInventorySha256,
            `${path}.migrationInventorySha256`
        ),
        migrationRegistrySha256: contractString(
            input.migrationRegistrySha256,
            `${path}.migrationRegistrySha256`
        ),
        migrations: input.migrations.map((migration, index) => {
            const entryPath = `${path}.migrations[${index}]`;
            const entry = contractRecord(migration, entryPath);
            return {
                checksum: contractString(entry.checksum, `${entryPath}.checksum`),
                name: contractString(entry.name, `${entryPath}.name`),
                version: contractFiniteNumber(entry.version, `${entryPath}.version`),
            };
        }),
        minimumCompatible: contractFiniteNumber(
            input.minimumCompatible,
            `${path}.minimumCompatible`
        ),
        target: contractFiniteNumber(input.target, `${path}.target`),
    };
}

function parseRuntimeReleaseIdentity(
    value: unknown,
    path: string
): RuntimeReleaseIdentity {
    const input = contractRecord(value, path);
    const artifactCount =
        input.artifactCount === undefined
            ? undefined
            : contractFiniteNumber(input.artifactCount, `${path}.artifactCount`);
    const commitSha = optionalContractString(input.commitSha, `${path}.commitSha`);
    const issue =
        input.issue === undefined
            ? undefined
            : contractEnum(input.issue, RELEASE_ISSUES, `${path}.issue`);
    const manifestFormatVersion =
        input.manifestFormatVersion === undefined
            ? undefined
            : contractFiniteNumber(
                  input.manifestFormatVersion,
                  `${path}.manifestFormatVersion`
              );
    const schema =
        input.schema === undefined
            ? undefined
            : parseReleaseSchema(input.schema, `${path}.schema`);
    return {
        backendCommit: contractString(input.backendCommit, `${path}.backendCommit`, {
            allowEmpty: true,
            trim: false,
        }),
        frontendCommit: contractString(input.frontendCommit, `${path}.frontendCommit`, {
            allowEmpty: true,
            trim: false,
        }),
        ready: requiresContractBoolean(input.ready, `${path}.ready`),
        source: contractEnum(input.source, RELEASE_SOURCES, `${path}.source`),
        ...(artifactCount !== undefined && { artifactCount }),
        ...(commitSha !== undefined && { commitSha }),
        ...(issue !== undefined && { issue }),
        ...(manifestFormatVersion !== undefined && { manifestFormatVersion }),
        ...(schema !== undefined && { schema }),
    };
}

function parseReadinessSnapshot(
    value: unknown,
    path: string
): DashboardReadinessSnapshot {
    const input = contractRecord(value, path);
    const checks = contractRecord(input.checks, `${path}.checks`);
    const frontend = contractRecord(checks.frontend, `${path}.checks.frontend`);
    const release = contractRecord(checks.release, `${path}.checks.release`);
    const worker = contractRecord(checks.worker, `${path}.checks.worker`);
    const dependencies = contractRecord(input.dependencies, `${path}.dependencies`);
    const releaseIssue =
        release.issue === undefined
            ? undefined
            : contractEnum(release.issue, RELEASE_ISSUES, `${path}.checks.release.issue`);
    const manifestFormatVersion =
        release.manifestFormatVersion === undefined
            ? undefined
            : contractFiniteNumber(
                  release.manifestFormatVersion,
                  `${path}.checks.release.manifestFormatVersion`
              );
    return {
        checks: {
            database: parseDatabaseReadiness(checks.database, `${path}.checks.database`),
            frontend: {
                ready: requiresContractBoolean(
                    frontend.ready,
                    `${path}.checks.frontend.ready`
                ),
            },
            release: {
                backendCommit: contractString(
                    release.backendCommit,
                    `${path}.checks.release.backendCommit`,
                    { allowEmpty: true, trim: false }
                ),
                frontendCommit: contractString(
                    release.frontendCommit,
                    `${path}.checks.release.frontendCommit`,
                    { allowEmpty: true, trim: false }
                ),
                ready: requiresContractBoolean(
                    release.ready,
                    `${path}.checks.release.ready`
                ),
                source: contractEnum(
                    release.source,
                    RELEASE_SOURCES,
                    `${path}.checks.release.source`
                ),
                ...(releaseIssue !== undefined && { issue: releaseIssue }),
                ...(manifestFormatVersion !== undefined && {
                    manifestFormatVersion,
                }),
            },
            worker: {
                ready: requiresContractBoolean(
                    worker.ready,
                    `${path}.checks.worker.ready`
                ),
            },
        },
        dependencies: {
            gatewayConnected: requiresContractBoolean(
                dependencies.gatewayConnected,
                `${path}.dependencies.gatewayConnected`
            ),
        },
        status: contractEnum(
            input.status,
            ["isReady", "notReady"] as const,
            `${path}.status`
        ),
    };
}

/** Parses the authenticated diagnostics payload at the frontend boundary. */
export function parseDashboardDiagnosticsResponse(
    value: unknown
): DashboardDiagnosticsResponse {
    const input = contractRecord(value, "response");
    return {
        ...parseReadinessSnapshot(input, "response"),
        observability: parseAppObservabilityMetrics(
            input.observability,
            "response.observability"
        ),
        releaseDetails: parseRuntimeReleaseIdentity(
            input.releaseDetails,
            "response.releaseDetails"
        ),
        sessionCount: contractFiniteNumber(input.sessionCount, "response.sessionCount"),
    };
}

export function parseDashboardLivenessResponse(
    value: unknown
): DashboardLivenessResponse {
    const input = contractRecord(value, "response");
    return {
        status: contractEnum(input.status, ["isOk"] as const, "response.status"),
        uptimeSeconds: contractFiniteNumber(
            input.uptimeSeconds,
            "response.uptimeSeconds"
        ),
    };
}

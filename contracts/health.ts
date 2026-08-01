import * as v from "valibot";

import { appObservabilityMetricsSchema } from "./metrics";
import { finiteNumberSchema, parseContract } from "./runtime";

export const RELEASE_ISSUES = [
    "build-identity-invalid",
    "manifest-code-mismatch",
    "manifest-invalid",
    "manifest-missing",
] as const;
export const RELEASE_SOURCES = ["git", "manifest", "unknown"] as const;

export const runtimeReleaseIssueSchema = v.picklist(RELEASE_ISSUES);
export const runtimeReleaseSourceSchema = v.picklist(RELEASE_SOURCES);

export const releaseMigrationIdentitySchema = v.strictObject({
    checksum: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    name: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    version: finiteNumberSchema,
});

export const releaseSchemaSchema = v.strictObject({
    maximumCompatible: finiteNumberSchema,
    migrationInventorySha256: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    migrationRegistrySha256: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    migrations: v.array(releaseMigrationIdentitySchema),
    minimumCompatible: finiteNumberSchema,
    target: finiteNumberSchema,
});

export const runtimeReleaseIdentitySchema = v.strictObject({
    artifactCount: v.optional(finiteNumberSchema),
    backendCommit: v.string(),
    commitSha: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
    frontendCommit: v.string(),
    issue: v.optional(runtimeReleaseIssueSchema),
    manifestFormatVersion: v.optional(finiteNumberSchema),
    ready: v.boolean(),
    schema: v.optional(releaseSchemaSchema),
    source: runtimeReleaseSourceSchema,
});

export const databaseReadinessSchema = v.strictObject({
    currentSchemaVersion: v.optional(finiteNumberSchema),
    maximumCompatibleSchemaVersion: finiteNumberSchema,
    minimumCompatibleSchemaVersion: finiteNumberSchema,
    ready: v.boolean(),
    targetSchemaVersion: finiteNumberSchema,
});

const releaseReadinessSchema = v.strictObject({
    issue: v.optional(runtimeReleaseIssueSchema),
    manifestFormatVersion: v.optional(finiteNumberSchema),
    ready: v.boolean(),
    source: runtimeReleaseSourceSchema,
});

export const dashboardReadinessSnapshotSchema = v.strictObject({
    checks: v.strictObject({
        database: databaseReadinessSchema,
        frontend: v.strictObject({ ready: v.boolean() }),
        release: releaseReadinessSchema,
        worker: v.strictObject({ ready: v.boolean() }),
    }),
    dependencies: v.strictObject({
        gatewayConnected: v.boolean(),
    }),
    status: v.picklist(["isReady", "notReady"]),
});

export const dashboardDiagnosticsResponseSchema = v.strictObject({
    ...dashboardReadinessSnapshotSchema.entries,
    observability: appObservabilityMetricsSchema,
    releaseDetails: runtimeReleaseIdentitySchema,
    sessionCount: finiteNumberSchema,
});

export const dashboardLivenessResponseSchema = v.strictObject({
    status: v.literal("isOk"),
    uptimeSeconds: finiteNumberSchema,
});

export type ReleaseMigrationIdentity = v.InferOutput<
    typeof releaseMigrationIdentitySchema
>;
export type ReleaseSchema = v.InferOutput<typeof releaseSchemaSchema>;
export type RuntimeReleaseIssue = v.InferOutput<typeof runtimeReleaseIssueSchema>;
export type RuntimeReleaseSource = v.InferOutput<typeof runtimeReleaseSourceSchema>;
export type RuntimeReleaseIdentity = v.InferOutput<typeof runtimeReleaseIdentitySchema>;
export type DatabaseReadiness = v.InferOutput<typeof databaseReadinessSchema>;
export type DashboardReadinessSnapshot = v.InferOutput<
    typeof dashboardReadinessSnapshotSchema
>;
export type DashboardDiagnosticsResponse = v.InferOutput<
    typeof dashboardDiagnosticsResponseSchema
>;
export type DashboardLivenessResponse = v.InferOutput<
    typeof dashboardLivenessResponseSchema
>;

/**
 * Parses the authenticated diagnostics payload at the frontend boundary.
 * @param value Value to process.
 * @returns Parsed the authenticated diagnostics payload at the frontend boundary.
 */
export function parseDashboardDiagnosticsResponse(
    value: unknown
): DashboardDiagnosticsResponse {
    return parseContract(dashboardDiagnosticsResponseSchema, value, "response");
}

export function parseDashboardLivenessResponse(
    value: unknown
): DashboardLivenessResponse {
    return parseContract(dashboardLivenessResponseSchema, value, "response");
}

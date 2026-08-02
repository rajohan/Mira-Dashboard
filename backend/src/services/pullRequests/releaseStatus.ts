import type {
    DashboardReleaseStatus,
    DashboardReleaseSummary,
    DeploymentJob,
} from "../../../../contracts/delivery/deployments.ts";
import { database } from "../../database/connection.ts";
import { errorMessage } from "../../lib/errors.ts";
import {
    DEPLOYMENT_RUNTIME_FAILURE_NOTE_PATTERNS,
    DEPLOYMENT_RUNTIME_FAILURE_NOTE_PREDICATE_SQL,
} from "../deploymentRuntimeResults.ts";
import type { ManagedDashboardRelease } from "../releases/managerModel.ts";
import { readDashboardReleaseState } from "../releases/releaseActivation.ts";
import { resolveDashboardReleasesRoot } from "../releases/releaseLayout.ts";
import { assertManagedDashboardReleaseRollbackSchemaCompatible } from "../releases/schemaCompatibility.ts";
import { dashboardCommitUrl, pullRequestLogger as logger } from "./support.ts";

interface DeploymentRuntimeResultRow {
    note: string | null;
    status: DeploymentJob["status"];
}

/**
 * Rejects a previous slot whose latest meaningful runtime result failed
 * readiness. Build failures and cancelled jobs do not disqualify an otherwise
 * verified immutable release.
 * @param commitSha Commit sha value.
 * @param excludedJobId Excluded job identifier.
 * @returns Rollback runtime ineligibility reason result.
 */
function rollbackRuntimeIneligibilityReason(
    commitSha: string,
    excludedJobId?: string
): string | undefined {
    const row = database
        .prepare(
            `
            SELECT status, note
            FROM deployment_jobs
            WHERE commit_sha = ?
              ${excludedJobId ? "AND id <> ?" : ""}
              AND (
                  status = 'isOk'
                  OR (
                      status = 'failed'
                      AND (
                          ${DEPLOYMENT_RUNTIME_FAILURE_NOTE_PREDICATE_SQL}
                      )
                  )
              )
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            `
        )
        .get(
            commitSha,
            ...(excludedJobId ? [excludedJobId] : []),
            ...DEPLOYMENT_RUNTIME_FAILURE_NOTE_PATTERNS
        ) as DeploymentRuntimeResultRow | undefined;
    return row?.status === "failed"
        ? "Previous release failed its latest runtime readiness check"
        : undefined;
}

export async function rollbackIneligibilityReason(
    activeRelease: ManagedDashboardRelease,
    rollbackRelease: ManagedDashboardRelease,
    excludedJobId?: string
): Promise<string | undefined> {
    const runtimeReason = rollbackRuntimeIneligibilityReason(
        rollbackRelease.commitSha,
        excludedJobId
    );
    if (runtimeReason) return runtimeReason;

    try {
        await assertManagedDashboardReleaseRollbackSchemaCompatible(
            activeRelease,
            rollbackRelease
        );
        return undefined;
    } catch (error) {
        return errorMessage(
            error,
            "Previous release schema compatibility could not be verified"
        );
    }
}

function dashboardReleaseSummary(
    release: ManagedDashboardRelease
): DashboardReleaseSummary {
    return {
        builtAt: release.manifest.builtAt,
        commitSha: release.commitSha,
        commitTitle: release.manifest.commitTitle,
        commitUrl: dashboardCommitUrl(release.commitSha),
        schema: {
            maximumCompatible: release.manifest.schema.maximumCompatible,
            minimumCompatible: release.manifest.schema.minimumCompatible,
            target: release.manifest.schema.target,
        },
    };
}

/**
 * Reads the managed production release slots without exposing host paths.
 * @returns Read the managed production release slots without exposing host paths.
 */
export async function getDashboardReleaseStatus(): Promise<DashboardReleaseStatus> {
    let state: Awaited<ReturnType<typeof readDashboardReleaseState>>;
    try {
        state = await readDashboardReleaseState(resolveDashboardReleasesRoot());
    } catch (error) {
        if (
            process.env.NODE_ENV === "production" ||
            process.env.MIRA_DASHBOARD_DEV_SAFE_MODE !== "1"
        ) {
            throw error;
        }
        logger.warn("release_status.isolated_metadata_unavailable", { error });
        return {
            rollback: {
                available: false,
                reason: "Production release metadata is unavailable in isolated PR dev",
            },
        };
    }
    const current = state.current ? dashboardReleaseSummary(state.current) : undefined;
    const previous = state.previous ? dashboardReleaseSummary(state.previous) : undefined;
    const isRollbackAvailable =
        current !== undefined &&
        previous !== undefined &&
        current.commitSha !== previous.commitSha;
    const ineligibilityReason =
        isRollbackAvailable && state.current && state.previous
            ? await rollbackIneligibilityReason(state.current, state.previous)
            : undefined;

    return {
        current,
        previous,
        rollback: {
            available: isRollbackAvailable && !ineligibilityReason,
            ...((!isRollbackAvailable || ineligibilityReason) && {
                reason:
                    ineligibilityReason ??
                    (current
                        ? "No distinct previous release is available"
                        : "No active managed release is available"),
            }),
        },
    };
}

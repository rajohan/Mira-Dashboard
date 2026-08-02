import { FULL_COMMIT_SHA_PATTERN, isRecord } from "./support.ts";

const MAX_DEPLOYMENT_CUTOVER_CONTEXT_BYTES = 4096;
const DEPLOYMENT_CUTOVER_CONTEXT_FORMAT_VERSION = 2;
const SQLITE_CUTOVER_SNAPSHOT_ID_PATTERN =
    /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

export interface DeploymentCutoverContext {
    candidateCommit: string;
    databaseSnapshotId: string;
    formatVersion: typeof DEPLOYMENT_CUTOVER_CONTEXT_FORMAT_VERSION;
    preActivationCommit: string;
    preActivationPreviousCommit?: string;
    rollbackCommit: string;
}

export function createDeploymentCutoverContext(
    candidateCommit: string,
    databaseSnapshotId: string,
    preActivationCommit: string,
    rollbackCommit: string,
    preActivationPreviousCommit: string | undefined
): DeploymentCutoverContext {
    if (
        !FULL_COMMIT_SHA_PATTERN.test(candidateCommit) ||
        !FULL_COMMIT_SHA_PATTERN.test(preActivationCommit) ||
        !FULL_COMMIT_SHA_PATTERN.test(rollbackCommit)
    ) {
        throw new TypeError("Release cutover context requires full commit SHAs");
    }
    if (!SQLITE_CUTOVER_SNAPSHOT_ID_PATTERN.test(databaseSnapshotId)) {
        throw new TypeError("Release cutover context requires a lowercase UUIDv7");
    }
    if (rollbackCommit === candidateCommit) {
        throw new TypeError(
            "Release cutover context requires a distinct rollback commit"
        );
    }
    if (
        preActivationPreviousCommit !== undefined &&
        (preActivationPreviousCommit === preActivationCommit ||
            !FULL_COMMIT_SHA_PATTERN.test(preActivationPreviousCommit))
    ) {
        throw new TypeError(
            "Release cutover context requires a distinct full pre-activation previous SHA"
        );
    }
    if (candidateCommit === preActivationCommit) {
        if (rollbackCommit !== preActivationPreviousCommit) {
            throw new TypeError(
                "Redeploy cutover context requires the pre-activation previous release as rollback target"
            );
        }
    } else if (rollbackCommit !== preActivationCommit) {
        throw new TypeError(
            "New release cutover context requires the pre-activation current release as rollback target"
        );
    }
    return {
        candidateCommit,
        databaseSnapshotId,
        formatVersion: DEPLOYMENT_CUTOVER_CONTEXT_FORMAT_VERSION,
        preActivationCommit,
        ...(preActivationPreviousCommit && { preActivationPreviousCommit }),
        rollbackCommit,
    };
}

export function parseDeploymentCutoverContext(
    outputJson: string,
    expectedDeploymentId: string,
    expectedCandidateCommit: string
): DeploymentCutoverContext | undefined {
    if (Buffer.byteLength(outputJson, "utf8") > MAX_DEPLOYMENT_CUTOVER_CONTEXT_BYTES) {
        return undefined;
    }
    let output: unknown;
    try {
        output = JSON.parse(outputJson) as unknown;
    } catch {
        return undefined;
    }
    if (
        !isRecord(output) ||
        output.deploymentId !== expectedDeploymentId ||
        !isRecord(output.releaseCutover)
    ) {
        return undefined;
    }
    const value = output.releaseCutover;
    const allowedKeys = new Set([
        "candidateCommit",
        "databaseSnapshotId",
        "formatVersion",
        "preActivationCommit",
        "preActivationPreviousCommit",
        "rollbackCommit",
    ]);
    if (
        Object.keys(value).some((key) => !allowedKeys.has(key)) ||
        value.formatVersion !== DEPLOYMENT_CUTOVER_CONTEXT_FORMAT_VERSION ||
        typeof value.candidateCommit !== "string" ||
        value.candidateCommit !== expectedCandidateCommit ||
        typeof value.databaseSnapshotId !== "string" ||
        typeof value.preActivationCommit !== "string" ||
        typeof value.rollbackCommit !== "string" ||
        (value.preActivationPreviousCommit !== undefined &&
            typeof value.preActivationPreviousCommit !== "string")
    ) {
        return undefined;
    }
    try {
        return createDeploymentCutoverContext(
            value.candidateCommit,
            value.databaseSnapshotId,
            value.preActivationCommit,
            value.rollbackCommit,
            value.preActivationPreviousCommit
        );
    } catch {
        return undefined;
    }
}

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { resolveRepositoryBuildPath } from "./buildPaths.ts";
import { withExclusiveProcessLock } from "./exclusiveProcessLock.ts";

const buildAdmissionDeadlineMs = 2 * 60 * 1000;
const buildAdmissionRetryMs = 10;
const buildLockFileName = ".bun-build.lock";
const buildAdmissionFailureMessage = "Bun build admission failed";

/**
 * Serializes Bun builds across test workers and processes for one repository.
 * @param repositoryRoot Canonical future-root checkout owning the build.
 * @param operation One complete build plus its artifact post-processing.
 * @returns The operation result after prior builds have released admission.
 */
export async function withBunBuildAdmission<T>(
    repositoryRoot: string,
    operation: () => Promise<T>
): Promise<T> {
    const lockPath = resolveRepositoryBuildPath(
        repositoryRoot,
        path.join(repositoryRoot, "dist", buildLockFileName),
        buildAdmissionFailureMessage
    ).output;
    await mkdir(path.dirname(lockPath), { mode: 0o700, recursive: true });
    return withExclusiveProcessLock(
        {
            deadlineMs: buildAdmissionDeadlineMs,
            failureMessage: buildAdmissionFailureMessage,
            lockPath,
            retryMs: buildAdmissionRetryMs,
        },
        operation
    );
}

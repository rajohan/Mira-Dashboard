import type {
    PullRequestPreviewCleanupResult,
    PullRequestPreviewStatus,
} from "../../../../contracts/delivery.ts";
import { resolveGatewayToken } from "../../gatewayToken.ts";
import { errorMessage } from "../../lib/errors.ts";
import { hasLineBreakOrNullByte } from "../../lib/values.ts";
import {
    isPullRequestPreviewAuthorAllowed,
} from "./policy.ts";
import { resolvePullRequestPreviewConfig } from "./config.ts";
import {
    materializeGatewayCredentials,
    removeMaterializedGatewayTokenFile,
} from "./credentials.ts";
import { runCommand } from "./commands.ts";
import {
    ensureRealDirectory,
} from "./fileSystem.ts";
import type {
    PullRequestPreviewCandidate,
    PullRequestPreviewConfig,
    PullRequestPreviewRecord,
} from "./types.ts";
import { PREVIEW_RECORD_FORMAT_VERSION } from "./types.ts";
import { readPreviewRecord, writePreviewRecord } from "./record.ts";
import {
    buildPullRequestPreviewSandboxCommand,
    preparePreviewState,
} from "./sandbox.ts";
export { buildPullRequestPreviewSandboxCommand } from "./sandbox.ts";
import {
    didRemoveManagedPreviewState,
    didRemovePreviewRecord,
} from "./state.ts";
export { listManagedPullRequestPreviewStateNumbers } from "./state.ts";
import {
    disableOwnedTailscaleServe,
    enableTailscaleServe,
    inspectTailscaleServe,
} from "./tailscale.ts";
import {
    cleanupPreviewResources,
    previewUnitState,
    publicPreviewStatus,
    readPullRequestPreviewStatus,
    startPreviewGatewayProxyUnit,
    startPreviewUnit,
    waitForPreviewGatewayProxyReady,
    waitForPreviewReady,
} from "./systemdRuntime.ts";
import {
    ensurePreviewWorktree,
    installPreviewDependencies,
    PREVIEW_REFERENCE,
    previewWorktreePath,
    removePreviewWorktree,
} from "./worktree.ts";

const COMMIT_PATTERN = /^[\da-f]{40}$/u;

export { parsePreviewUnitState } from "./systemdRuntime.ts";

/**
 * Reads the active preview and reconciles resources left by a stopped unit.
 * @param config Config value.
 * @returns Read the active preview and reconciles resources left by a stopped unit.
 */
export async function getPullRequestPreviewStatus(
    config = resolvePullRequestPreviewConfig()
): Promise<PullRequestPreviewStatus> {
    return readPullRequestPreviewStatus(config);
}

function validatePreviewPullRequest(
    pullRequest: PullRequestPreviewCandidate,
    config: PullRequestPreviewConfig
): PullRequestPreviewCandidate {
    if (
        !Number.isSafeInteger(pullRequest.number) ||
        pullRequest.number <= 0 ||
        pullRequest.number > 2_147_483_647
    ) {
        throw new TypeError("Preview pull request number is invalid");
    }
    if (pullRequest.rootBaseRefName !== "main") {
        throw Object.assign(
            new Error("Only main-rooted pull requests can be previewed"),
            { statusCode: 409 }
        );
    }
    if (
        pullRequest.authorLogins.length === 0 ||
        pullRequest.authorLogins.length > 100 ||
        pullRequest.authorLogins.some(
            (authorLogin) =>
                !isPullRequestPreviewAuthorAllowed(authorLogin, config.allowedAuthors)
        )
    ) {
        throw Object.assign(
            new Error(
                "Every pull request included in a host preview must have an allowed author"
            ),
            { statusCode: 403 }
        );
    }
    if (!COMMIT_PATTERN.test(pullRequest.commitSha)) {
        throw new Error("Pull request does not expose a valid head commit");
    }
    if (
        !pullRequest.title.trim() ||
        pullRequest.title.length > 1024 ||
        hasLineBreakOrNullByte(pullRequest.title)
    ) {
        throw new TypeError("Pull request title is invalid");
    }
    return pullRequest;
}

/**
 * Starts or updates the single managed preview slot for one validated PR.
 * @returns Promise resolving to the start pull request preview result.
 */
export async function startPullRequestPreview(
    candidate: PullRequestPreviewCandidate,
    options: {
        config?: PullRequestPreviewConfig;
        protectFromCancellation?: () => void;
        readGatewayToken?: () => string | undefined;
        signal?: AbortSignal;
    } = {}
): Promise<PullRequestPreviewStatus> {
    const config = options.config ?? resolvePullRequestPreviewConfig();
    const signal = options.signal;
    const pullRequest = validatePreviewPullRequest(candidate, config);
    const { number } = pullRequest;
    ensureRealDirectory(config.previewRoot);
    const current = await getPullRequestPreviewStatus(config);
    if (
        ["running", "starting", "stopping"].includes(current.status) &&
        current.number !== number
    ) {
        throw Object.assign(
            new Error(
                `PR #${current.number} already owns the preview slot; stop it first`
            ),
            { statusCode: 409 }
        );
    }
    const existingRecord = readPreviewRecord(config);
    const timestamp = new Date().toISOString();
    const tailscaleRoute = await inspectTailscaleServe(config, signal);
    if (tailscaleRoute.enabled && existingRecord?.ownsTailscaleServe !== true) {
        throw Object.assign(
            new Error(
                `Tailscale Serve port ${config.frontendPort} is active outside the managed preview`
            ),
            { statusCode: 409 }
        );
    }
    if (
        current.status === "running" &&
        current.number === number &&
        current.commitSha === pullRequest.commitSha &&
        existingRecord?.status === "running" &&
        existingRecord.ownsTailscaleServe &&
        tailscaleRoute.enabled
    ) {
        return current;
    }
    let isTailscaleServeOwned =
        existingRecord?.ownsTailscaleServe === true && tailscaleRoute.enabled;
    if (isTailscaleServeOwned) {
        await disableOwnedTailscaleServe(config, true);
        isTailscaleServeOwned = false;
    }
    const publicOrigin = tailscaleRoute.url;
    const worktreePath = previewWorktreePath(config);
    const startingRecord: PullRequestPreviewRecord = {
        backendPort: config.backendPort,
        commitSha: pullRequest.commitSha,
        formatVersion: PREVIEW_RECORD_FORMAT_VERSION,
        frontendPort: config.frontendPort,
        number,
        ownsTailscaleServe: false,
        status: "starting",
        title: pullRequest.title,
        updatedAt: timestamp,
        url: publicOrigin,
        worktreePath,
    };
    try {
        const staleResourceCleanup = await cleanupPreviewResources(config, false);
        if (staleResourceCleanup.errors.length > 0) {
            throw new Error(
                `Could not clean stale PR dev resources: ${staleResourceCleanup.errors.join(". ")}`
            );
        }
        const preparedWorktree = await ensurePreviewWorktree(
            config,
            number,
            pullRequest.commitSha,
            signal
        );
        await installPreviewDependencies(config, preparedWorktree, signal);
        const stateRoot = preparePreviewState(config, number, publicOrigin);
        writePreviewRecord(config, startingRecord);
        materializeGatewayCredentials(
            config,
            resolveGatewayToken(process.env, options.readGatewayToken)
        );
        const sandboxCommand = buildPullRequestPreviewSandboxCommand({
            config,
            publicOrigin,
            stateRoot,
            worktreePath: preparedWorktree,
        });
        options.protectFromCancellation?.();
        await startPreviewGatewayProxyUnit(config, signal);
        await waitForPreviewGatewayProxyReady(config, signal);
        removeMaterializedGatewayTokenFile(
            config.gatewayUpstreamTokenFile,
            "PR dev upstream Gateway token"
        );
        await startPreviewUnit(config, sandboxCommand, signal);
        await waitForPreviewReady(config, signal);
        await enableTailscaleServe(
            config,
            publicOrigin,
            (isOwned) => {
                isTailscaleServeOwned = isOwned;
                writePreviewRecord(config, {
                    ...startingRecord,
                    ownsTailscaleServe: isOwned,
                    updatedAt: new Date().toISOString(),
                });
            },
            signal
        );
        const startedAt = new Date().toISOString();
        const runningRecord: PullRequestPreviewRecord = {
            ...startingRecord,
            ownsTailscaleServe: isTailscaleServeOwned,
            startedAt,
            status: "running",
            updatedAt: startedAt,
        };
        writePreviewRecord(config, runningRecord);
        return publicPreviewStatus(runningRecord, await previewUnitState(config));
    } catch (error) {
        const cleanup = await cleanupPreviewResources(config, isTailscaleServeOwned);
        const startupMessage = errorMessage(error, "PR preview startup failed");
        const failedRecord: PullRequestPreviewRecord = {
            ...startingRecord,
            message:
                cleanup.errors.length > 0
                    ? `${startupMessage}. Cleanup: ${cleanup.errors.join(". ")}`
                    : startupMessage,
            ownsTailscaleServe: cleanup.ownsTailscaleServe,
            status: "failed",
            updatedAt: new Date().toISOString(),
        };
        writePreviewRecord(config, failedRecord);
        throw error;
    }
}

/**
 * Stops the managed preview slot, optionally enforcing its owning PR number.
 * @param number Number value.
 * @param options Operation options.
 * @returns Promise resolving to the stop pull request preview result.
 */
export async function stopPullRequestPreview(
    number: number | undefined,
    options: {
        config?: PullRequestPreviewConfig;
        protectFromCancellation?: () => void;
    } = {}
): Promise<PullRequestPreviewStatus> {
    const config = options.config ?? resolvePullRequestPreviewConfig();
    const record = readPreviewRecord(config);
    if (!record) return { status: "stopped" };
    if (number !== undefined && record.number !== number) {
        throw Object.assign(
            new Error(`PR #${number} does not own the active preview slot`),
            { statusCode: 409 }
        );
    }
    options.protectFromCancellation?.();
    writePreviewRecord(config, {
        ...record,
        status: "stopping",
        updatedAt: new Date().toISOString(),
    });
    const cleanup = await cleanupPreviewResources(config, record.ownsTailscaleServe);
    if (cleanup.errors.length > 0) {
        const failedRecord: PullRequestPreviewRecord = {
            ...record,
            message: `PR dev stop cleanup failed: ${cleanup.errors.join(". ")}`,
            ownsTailscaleServe: cleanup.ownsTailscaleServe,
            status: "failed",
            updatedAt: new Date().toISOString(),
        };
        writePreviewRecord(config, failedRecord);
        throw Object.assign(
            new AggregateError(
                cleanup.errors.map((message) => new Error(message)),
                failedRecord.message
            ),
            { statusCode: 500 }
        );
    }
    const stoppedRecord: PullRequestPreviewRecord = {
        ...record,
        message: undefined,
        ownsTailscaleServe: false,
        status: "stopped",
        updatedAt: new Date().toISOString(),
    };
    writePreviewRecord(config, stoppedRecord);
    return publicPreviewStatus(stoppedRecord);
}

/**
 * Removes the shared checkout and isolated state after its owning PR closes.
 * @param number Number value.
 * @param options Operation options.
 * @returns Promise resolving to the cleanup closed pull request preview result.
 */
export async function cleanupClosedPullRequestPreview(
    number: number,
    options: { config?: PullRequestPreviewConfig } = {}
): Promise<PullRequestPreviewCleanupResult> {
    let didRemove = false;
    try {
        const config = options.config ?? resolvePullRequestPreviewConfig();
        const record = readPreviewRecord(config);
        const hasManagedSlotOwnership = record?.number === number;
        if (hasManagedSlotOwnership) {
            await stopPullRequestPreview(number, { config });
            didRemove =
                (await removePreviewWorktree(config, previewWorktreePath(config))) ||
                didRemove;
            await runCommand("git", [
                "-C",
                config.dashboardRoot,
                "update-ref",
                "-d",
                PREVIEW_REFERENCE,
            ]);
            didRemove = didRemovePreviewRecord(config) || didRemove;
        }
        didRemove = didRemoveManagedPreviewState(config, number) || didRemove;
        return {
            message: didRemove
                ? `Removed managed PR dev data for #${number}`
                : `No managed PR dev data found for #${number}`,
            number,
            status: didRemove ? "removed" : "skipped",
        };
    } catch (error) {
        return {
            message: `PR dev cleanup warning for #${number}: ${errorMessage(error, "cleanup failed")}`,
            number,
            status: "warning",
        };
    }
}

import {
    type OpenClawServiceActionsExecutionPort,
    OpenClawServiceActionsExecutionError,
    type OpenClawServiceActionsExecutionErrorReason,
    type OpenClawSessionsCleanupSummary,
} from "../../../shared/openClawServiceActions.ts";
import {
    type PersistentGatewayOpenClawCleanupStoreProjection,
    persistentGatewayOpenClawServiceActionRequestTimeoutMs,
    persistentGatewayOpenClawUpdateTimeoutMs,
} from "./persistentGatewayProtocol.ts";
import {
    PersistentGatewayUnknownOutcomeError,
    type PersistentGatewayTaskNotificationTransport,
} from "./persistentGatewayTransport.ts";

/** Constant worker-facing failure with no upstream message, path, or output. */
export class OpenClawServiceActionsProviderError extends OpenClawServiceActionsExecutionError {
    public constructor(reason: OpenClawServiceActionsExecutionErrorReason) {
        super(reason);
        this.name = "OpenClawServiceActionsProviderError";
    }
}

type OpenClawServiceActionTransport = Pick<
    PersistentGatewayTaskNotificationTransport,
    "requestOpenClawServiceAction"
>;

function addCount(left: number, right: number): number {
    const total = left + right;
    if (!Number.isSafeInteger(total) || total < 0) {
        throw new OpenClawServiceActionsProviderError("unavailable");
    }
    return total;
}

function aggregateCleanup(
    stores: readonly PersistentGatewayOpenClawCleanupStoreProjection[]
): OpenClawSessionsCleanupSummary {
    let artifactsRemoved = 0;
    let bytesFreed = 0;
    let diskEntriesRemoved = 0;
    let diskFilesRemoved = 0;
    let dmScopesRetired = 0;
    let entriesAfter = 0;
    let entriesBefore = 0;
    let entriesCapped = 0;
    let entriesPruned = 0;
    let missingEntriesRemoved = 0;
    let modelRunsPruned = 0;
    let storesProcessed = 0;
    for (const store of stores) {
        artifactsRemoved = addCount(artifactsRemoved, store.artifactsRemoved);
        bytesFreed = addCount(bytesFreed, store.bytesFreed);
        diskEntriesRemoved = addCount(diskEntriesRemoved, store.diskEntriesRemoved);
        diskFilesRemoved = addCount(diskFilesRemoved, store.diskFilesRemoved);
        dmScopesRetired = addCount(dmScopesRetired, store.dmScopesRetired);
        entriesAfter = addCount(entriesAfter, store.entriesAfter);
        entriesBefore = addCount(entriesBefore, store.entriesBefore);
        entriesCapped = addCount(entriesCapped, store.entriesCapped);
        entriesPruned = addCount(entriesPruned, store.entriesPruned);
        missingEntriesRemoved = addCount(
            missingEntriesRemoved,
            store.missingEntriesRemoved
        );
        modelRunsPruned = addCount(modelRunsPruned, store.modelRunsPruned);
        storesProcessed = addCount(storesProcessed, 1);
    }
    return Object.freeze({
        artifactsRemoved,
        bytesFreed,
        diskEntriesRemoved,
        diskFilesRemoved,
        dmScopesRetired,
        entriesAfter,
        entriesBefore,
        entriesCapped,
        entriesPruned,
        missingEntriesRemoved,
        modelRunsPruned,
        status: "completed",
        storesProcessed,
    });
}

function mapProviderFailure(error: unknown): never {
    if (error instanceof OpenClawServiceActionsProviderError) throw error;
    throw new OpenClawServiceActionsProviderError(
        error instanceof PersistentGatewayUnknownOutcomeError
            ? "unknown-outcome"
            : "unavailable"
    );
}

/**
 * Creates the worker-only fixed OpenClaw operations adapter. The transport has
 * already stripped raw paths, commands, process metadata, and command output.
 * @returns A worker-only fixed-operation execution port.
 */
export function createPersistentGatewayOpenClawServiceActionsProvider(
    transport: OpenClawServiceActionTransport
): OpenClawServiceActionsExecutionPort {
    return Object.freeze({
        async cleanupSessions(signal?: AbortSignal) {
            try {
                const response = await transport.requestOpenClawServiceAction(
                    "sessions.cleanup",
                    { allAgents: true, enforce: true },
                    {
                        signal,
                        timeoutMs:
                            persistentGatewayOpenClawServiceActionRequestTimeoutMs[
                                "sessions.cleanup"
                            ],
                    }
                );
                if (response.method !== "sessions.cleanup") {
                    throw new OpenClawServiceActionsProviderError("unavailable");
                }
                return aggregateCleanup(response.stores);
            } catch (error) {
                mapProviderFailure(error);
            }
        },
        async updateInstallation(signal?: AbortSignal) {
            try {
                const response = await transport.requestOpenClawServiceAction(
                    "update.run",
                    { timeoutMs: persistentGatewayOpenClawUpdateTimeoutMs },
                    {
                        signal,
                        timeoutMs:
                            persistentGatewayOpenClawServiceActionRequestTimeoutMs[
                                "update.run"
                            ],
                    }
                );
                if (response.method !== "update.run") {
                    throw new OpenClawServiceActionsProviderError("unavailable");
                }
                if (response.status === "failed") {
                    throw new OpenClawServiceActionsProviderError("operation-failed");
                }
                return Object.freeze({
                    ...(response.afterVersion === undefined
                        ? {}
                        : { afterVersion: response.afterVersion }),
                    ...(response.beforeVersion === undefined
                        ? {}
                        : { beforeVersion: response.beforeVersion }),
                    status: response.status,
                });
            } catch (error) {
                mapProviderFailure(error);
            }
        },
    });
}

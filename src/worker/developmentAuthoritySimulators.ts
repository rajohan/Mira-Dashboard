import {
    constants,
    closeSync,
    fstatSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    writeSync,
} from "node:fs";
import path from "node:path";

import type { HostOperationId } from "../shared/hostOperations.ts";
import type { OpenClawGatewayLifecycleExecutionPort } from "../shared/openClawGatewayLifecycle.ts";
import type {
    OpenClawInstallationUpdateSummary,
    OpenClawServiceActionsExecutionPort,
    OpenClawSessionsCleanupSummary,
} from "../shared/openClawServiceActions.ts";

const developmentStateMarkerFileName = ".mira-dashboard-development-state.json";
const simulatorDirectoryName = "development-authority-simulator";
const simulatorJournalFileName = "receipts.ndjson";
const simulatorOwner = "mira-dashboard-source-development-v1";

interface DevelopmentStateMarker {
    readonly formatVersion: 1;
    readonly owner: typeof simulatorOwner;
}

type FixedHostOperationResult =
    | Readonly<{ status: "accepted" }>
    | Readonly<{ status: "completed" }>;

/** Structural worker-side port matching the server executor boundary. */
export interface DevelopmentHostOperationsExecutionPort {
    readonly availableOperations: () => Promise<readonly HostOperationId[]>;
    readonly request: (
        operationId: HostOperationId,
        signal?: AbortSignal
    ) => Promise<FixedHostOperationResult>;
}

interface DevelopmentSimulatorReceipt {
    readonly completedAtMs: number;
    readonly operation: DevelopmentSimulationOperation;
    readonly outcome: DevelopmentSimulationOutcome;
}

export type DevelopmentSimulationOperation =
    | HostOperationId
    | "backup:kopia-clear-attention"
    | "backup:kopia-run"
    | "backup:walg-clear-attention"
    | "backup:walg-run"
    | "database:observe"
    | `delivery:${
          | "approve-review"
          | "create-pull-request-stack"
          | "deploy"
          | "merge-pull-request"
          | "reject-pull-request"
          | "rollback-release"
          | "start-preview"
          | "stop-preview"
          | "update-branch"}`
    | `docker:${
          | "container-restart"
          | "container-start"
          | "container-stop"
          | "image-delete"
          | "prune-execute"
          | "stack-restart"
          | "stack-start"
          | "stack-stop"
          | "updater-run"
          | "updater-scan"
          | "updater-update-service"
          | "volume-delete"}`
    | "openclaw-cleanup"
    | "openclaw-restart"
    | "openclaw-update";

export type DevelopmentSimulationOutcome = "conflict" | "simulated" | "unknown-outcome";

export interface DevelopmentAuthoritySimulators {
    readonly hostOperations: DevelopmentHostOperationsExecutionPort;
    readonly openClawGateway: OpenClawGatewayLifecycleExecutionPort;
    readonly openClawServiceActions: OpenClawServiceActionsExecutionPort;
    readonly record: (
        operation: DevelopmentSimulationOperation,
        outcome?: DevelopmentSimulationOutcome
    ) => void;
}

function markerIsExact(value: unknown): value is DevelopmentStateMarker {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { readonly formatVersion?: unknown }).formatVersion === 1 &&
        (value as { readonly owner?: unknown }).owner === simulatorOwner &&
        Object.keys(value).length === 2
    );
}

function assertMarkedDevelopmentStateRoot(stateRoot: string): string {
    const canonical = realpathSync(stateRoot);
    if (
        canonical !== stateRoot ||
        !path.isAbsolute(canonical) ||
        canonical === path.parse(canonical).root
    ) {
        throw new Error("Development simulator state root is invalid");
    }
    const markerPath = path.join(canonical, developmentStateMarkerFileName);
    let descriptor: number;
    try {
        descriptor = openSync(
            markerPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
    } catch {
        throw new Error("Development simulator state marker is invalid");
    }
    let markerText: string;
    try {
        const status = fstatSync(descriptor);
        if (!status.isFile() || status.nlink !== 1) {
            throw new Error("Development simulator state marker is invalid");
        }
        markerText = readFileSync(descriptor, "utf8");
    } finally {
        closeSync(descriptor);
    }
    let marker: unknown;
    try {
        marker = JSON.parse(markerText) as unknown;
    } catch {
        throw new Error("Development simulator state marker is invalid");
    }
    if (!markerIsExact(marker)) {
        throw new Error("Development simulator state marker is invalid");
    }
    return canonical;
}

function safeNow(nowMs: () => number): number {
    const now = nowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error("Development simulator clock is invalid");
    }
    return now;
}

/**
 * Creates explicit development-only privileged-operation simulators. Every accepted
 * call writes only an aggregate receipt beneath the held, marked development state;
 * no Docker, systemd, OpenClaw, shell, or production filesystem port is retained.
 * @param input Marked development-state location and optional deterministic clock.
 * @returns Fixed-operation simulator ports with no production authority.
 */
export function createDevelopmentAuthoritySimulators(input: {
    readonly nowMs?: () => number;
    readonly stateRoot: string;
}): DevelopmentAuthoritySimulators {
    const nowMs = input.nowMs ?? Date.now;
    const stateRoot = assertMarkedDevelopmentStateRoot(input.stateRoot);
    const simulatorDirectory = path.join(stateRoot, simulatorDirectoryName);
    mkdirSync(simulatorDirectory, { mode: 0o700, recursive: true });
    if (realpathSync(simulatorDirectory) !== simulatorDirectory) {
        throw new Error("Development simulator directory is invalid");
    }
    const journalPath = path.join(simulatorDirectory, simulatorJournalFileName);
    const appendReceipt = (
        operation: DevelopmentSimulatorReceipt["operation"],
        outcome: DevelopmentSimulationOutcome = "simulated"
    ): void => {
        const receipt = Object.freeze({
            completedAtMs: safeNow(nowMs),
            operation,
            outcome,
        });
        const descriptor = openSync(
            journalPath,
            constants.O_APPEND |
                constants.O_CREAT |
                constants.O_NOFOLLOW |
                constants.O_WRONLY,
            0o600
        );
        try {
            const status = fstatSync(descriptor);
            if (!status.isFile() || status.nlink !== 1) {
                throw new Error("Development simulator journal is invalid");
            }
            writeSync(descriptor, `${JSON.stringify(receipt)}\n`, undefined, "utf8");
            fsyncSync(descriptor);
        } finally {
            closeSync(descriptor);
        }
    };
    const hostOperationIds = Object.freeze([
        "system-cleanup",
        "system-restart",
        "system-update",
    ] as const);
    const hostOperations: DevelopmentHostOperationsExecutionPort = Object.freeze({
        availableOperations: () => Promise.resolve(hostOperationIds),
        request: (operationId: HostOperationId, signal?: AbortSignal) =>
            Promise.resolve().then(() => {
                signal?.throwIfAborted();
                appendReceipt(operationId);
                signal?.throwIfAborted();
                return Object.freeze({
                    status: operationId === "system-restart" ? "accepted" : "completed",
                });
            }),
    });
    const openClawGateway: OpenClawGatewayLifecycleExecutionPort = Object.freeze({
        async restart(signal?: AbortSignal) {
            await Promise.resolve();
            signal?.throwIfAborted();
            appendReceipt("openclaw-restart");
            signal?.throwIfAborted();
        },
    });
    const openClawServiceActions: OpenClawServiceActionsExecutionPort = Object.freeze({
        cleanupSessions: (
            signal?: AbortSignal
        ): Promise<OpenClawSessionsCleanupSummary> =>
            Promise.resolve().then(() => {
                signal?.throwIfAborted();
                appendReceipt("openclaw-cleanup");
                signal?.throwIfAborted();
                return Object.freeze({
                    artifactsRemoved: 0,
                    bytesFreed: 0,
                    diskEntriesRemoved: 0,
                    diskFilesRemoved: 0,
                    dmScopesRetired: 0,
                    entriesAfter: 0,
                    entriesBefore: 0,
                    entriesCapped: 0,
                    entriesPruned: 0,
                    missingEntriesRemoved: 0,
                    modelRunsPruned: 0,
                    status: "completed",
                    storesProcessed: 0,
                });
            }),
        updateInstallation: (
            signal?: AbortSignal
        ): Promise<OpenClawInstallationUpdateSummary> =>
            Promise.resolve().then(() => {
                signal?.throwIfAborted();
                appendReceipt("openclaw-update");
                signal?.throwIfAborted();
                return Object.freeze({ status: "accepted" });
            }),
    });
    return Object.freeze({
        hostOperations,
        openClawGateway,
        openClawServiceActions,
        record: appendReceipt,
    });
}

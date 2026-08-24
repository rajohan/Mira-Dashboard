import path from "node:path";

import { hasNoUnicodeControlOrFormat } from "../../shared/validation.ts";
import {
    createBunTerminalBrokerIpcLifecycle,
    createTerminalBrokerSocketPathOperations,
} from "./bunTerminalBrokerIpc.ts";
import {
    startTerminalBrokerServer,
    type TerminalBrokerByteConnection,
    type TerminalBrokerIpcLifecycle,
    type TerminalBrokerIpcListener,
    type TerminalBrokerServer,
    type TerminalBrokerSocketMetadata,
    type TerminalBrokerSocketPathOperations,
} from "./terminalBrokerServer.ts";
import {
    createWorkerTerminalSessionBroker,
    type WorkerTerminalSessionBroker,
    type WorkerTerminalSessionBrokerDependencies,
} from "./terminalSessionBroker.ts";

const terminalBrokerDirectorySegments = [
    "production",
    "state",
    "terminal-broker",
] as const;
const terminalBrokerSocketFileName = "terminal.sock";
const hostPathMaximumLength = 4096;

export interface WorkerTerminalBrokerLifecycleOptions {
    /** Stable canonical Dashboard project root, never a release or worktree path. */
    readonly projectRoot: string;
    readonly sessionBrokerDependencies?: WorkerTerminalSessionBrokerDependencies;
}

export interface WorkerTerminalBrokerLifecycleDependencies {
    readonly createIpcLifecycle?: () => TerminalBrokerIpcLifecycle;
    readonly createSessionBroker?: (
        dependencies: WorkerTerminalSessionBrokerDependencies
    ) => WorkerTerminalSessionBroker;
    readonly createSocketPathOperations?: () => TerminalBrokerSocketPathOperations;
    readonly getUserId?: () => number;
    readonly platform?: NodeJS.Platform;
}

export interface WorkerTerminalBrokerLifecycle {
    readonly broker: WorkerTerminalSessionBroker;
    readonly socketPath: string;
    stop(): Promise<void>;
}

export class WorkerTerminalBrokerLifecycleError extends Error {
    public readonly reason: "invalid-runtime" | "start-failed" | "stop-failed";

    public constructor(reason: WorkerTerminalBrokerLifecycleError["reason"]) {
        super("Terminal worker lifecycle failed");
        this.name = "WorkerTerminalBrokerLifecycleError";
        this.reason = reason;
    }
}

function lifecycleError(
    reason: WorkerTerminalBrokerLifecycleError["reason"]
): WorkerTerminalBrokerLifecycleError {
    return new WorkerTerminalBrokerLifecycleError(reason);
}

function exactProjectPaths(projectRoot: string): {
    readonly socketDirectory: string;
    readonly socketPath: string;
} {
    if (
        projectRoot.length === 0 ||
        projectRoot.length > hostPathMaximumLength ||
        !path.isAbsolute(projectRoot) ||
        projectRoot === path.parse(projectRoot).root ||
        path.resolve(projectRoot) !== projectRoot ||
        !hasNoUnicodeControlOrFormat(projectRoot)
    ) {
        throw lifecycleError("invalid-runtime");
    }
    const socketDirectory = path.join(projectRoot, ...terminalBrokerDirectorySegments);
    const socketPath = path.join(socketDirectory, terminalBrokerSocketFileName);
    if (
        socketDirectory.length > hostPathMaximumLength ||
        socketPath.length > hostPathMaximumLength ||
        path.dirname(socketPath) !== socketDirectory ||
        path.basename(socketPath) !== terminalBrokerSocketFileName
    ) {
        throw lifecycleError("invalid-runtime");
    }
    return Object.freeze({ socketDirectory, socketPath });
}

function defaultUserId(): number {
    if (typeof process.getuid !== "function") {
        throw lifecycleError("invalid-runtime");
    }
    return process.getuid();
}

function runtimeUserId(dependencies: WorkerTerminalBrokerLifecycleDependencies): number {
    const platform = dependencies.platform ?? process.platform;
    if (platform !== "linux") throw lifecycleError("invalid-runtime");
    const userId = (dependencies.getUserId ?? defaultUserId)();
    if (!Number.isSafeInteger(userId) || userId < 0) {
        throw lifecycleError("invalid-runtime");
    }
    return userId;
}

function isExactSocketDirectory(
    metadata: TerminalBrokerSocketMetadata | undefined,
    expectedUserId: number
): boolean {
    return (
        metadata !== undefined &&
        metadata.kind === "directory" &&
        metadata.ownerUserId === expectedUserId &&
        Number.isSafeInteger(metadata.linkCount) &&
        metadata.linkCount >= 1 &&
        metadata.mode === 0o700
    );
}

async function assertExactSocketDirectory(input: {
    readonly expectedUserId: number;
    readonly operations: TerminalBrokerSocketPathOperations;
    readonly socketDirectory: string;
}): Promise<void> {
    const canonicalDirectory = await input.operations.realpath(input.socketDirectory);
    if (canonicalDirectory !== input.socketDirectory) {
        throw lifecycleError("invalid-runtime");
    }
    const metadata = await input.operations.inspect(canonicalDirectory);
    if (!isExactSocketDirectory(metadata, input.expectedUserId)) {
        throw lifecycleError("invalid-runtime");
    }
}

function isOwnedSocket(
    metadata: TerminalBrokerSocketMetadata | undefined,
    expectedUserId: number
): boolean {
    return (
        metadata !== undefined &&
        metadata.kind === "socket" &&
        metadata.ownerUserId === expectedUserId &&
        metadata.linkCount === 1
    );
}

interface TrackedIpcLifecycle {
    readonly lifecycle: TerminalBrokerIpcLifecycle;
    closeListener(): Promise<void>;
    listenerWasAttempted(): boolean;
    stopAccepting(): void;
}

function trackIpcLifecycle(lifecycle: TerminalBrokerIpcLifecycle): TrackedIpcLifecycle {
    let accepting = true;
    let listenerAttempted = false;
    let concreteListener: TerminalBrokerIpcListener | undefined;
    let listenerClosePromise: Promise<void> | undefined;

    const closeListener = (): Promise<void> => {
        if (concreteListener === undefined) return Promise.resolve();
        listenerClosePromise ??= concreteListener.close();
        return listenerClosePromise;
    };
    const trackedLifecycle: TerminalBrokerIpcLifecycle = Object.freeze({
        async listen(input: Parameters<TerminalBrokerIpcLifecycle["listen"]>[0]) {
            listenerAttempted = true;
            const listener = await lifecycle.listen({
                onConnection(connection: TerminalBrokerByteConnection) {
                    if (!accepting) {
                        connection.close();
                        return;
                    }
                    input.onConnection(connection);
                },
                socketPath: input.socketPath,
            });
            concreteListener = listener;
            return Object.freeze({ close: closeListener });
        },
    });
    return Object.freeze({
        closeListener,
        lifecycle: trackedLifecycle,
        listenerWasAttempted: () => listenerAttempted,
        stopAccepting() {
            accepting = false;
        },
    });
}

async function removeOwnedListeningSocket(input: {
    readonly expectedUserId: number;
    readonly listenerWasAttempted: boolean;
    readonly operations: TerminalBrokerSocketPathOperations;
    readonly socketDirectory: string;
    readonly socketPath: string;
}): Promise<void> {
    if (!input.listenerWasAttempted) return;
    await assertExactSocketDirectory(input);
    const metadata = await input.operations.inspect(input.socketPath);
    if (metadata === undefined) return;
    if (!isOwnedSocket(metadata, input.expectedUserId)) {
        throw lifecycleError("stop-failed");
    }
    await input.operations.remove(input.socketPath);
    if ((await input.operations.inspect(input.socketPath)) !== undefined) {
        throw lifecycleError("stop-failed");
    }
}

async function closeAfterFailedStart(input: {
    readonly broker: WorkerTerminalSessionBroker;
    readonly expectedUserId: number;
    readonly operations: TerminalBrokerSocketPathOperations;
    readonly socketDirectory: string;
    readonly socketPath: string;
    readonly trackedIpc: TrackedIpcLifecycle;
}): Promise<void> {
    input.trackedIpc.stopAccepting();
    await input.trackedIpc.closeListener().catch(() => {});
    await input.broker.shutdown().catch(() => {});
    await removeOwnedListeningSocket({
        expectedUserId: input.expectedUserId,
        listenerWasAttempted: input.trackedIpc.listenerWasAttempted(),
        operations: input.operations,
        socketDirectory: input.socketDirectory,
        socketPath: input.socketPath,
    }).catch(() => {});
}

/**
 * Composes the worker's only interactive Terminal authority around one exact
 * project-local Unix socket. Startup is fail closed; stop order is listener,
 * live PTYs, then socket removal.
 * @returns The worker-owned broker and its idempotent stop lifecycle.
 */
export async function startWorkerTerminalBrokerLifecycle(
    options: WorkerTerminalBrokerLifecycleOptions,
    dependencies: WorkerTerminalBrokerLifecycleDependencies = {}
): Promise<WorkerTerminalBrokerLifecycle> {
    let paths: ReturnType<typeof exactProjectPaths>;
    let expectedUserId: number;
    try {
        paths = exactProjectPaths(options.projectRoot);
        expectedUserId = runtimeUserId(dependencies);
    } catch {
        throw lifecycleError("invalid-runtime");
    }

    let operations: TerminalBrokerSocketPathOperations;
    try {
        operations = (
            dependencies.createSocketPathOperations ??
            createTerminalBrokerSocketPathOperations
        )();
    } catch {
        throw lifecycleError("start-failed");
    }
    try {
        await assertExactSocketDirectory({
            expectedUserId,
            operations,
            socketDirectory: paths.socketDirectory,
        });
    } catch {
        throw lifecycleError("invalid-runtime");
    }

    let broker: WorkerTerminalSessionBroker;
    try {
        broker = (dependencies.createSessionBroker ?? createWorkerTerminalSessionBroker)(
            options.sessionBrokerDependencies ?? {}
        );
    } catch {
        throw lifecycleError("start-failed");
    }
    let ipcLifecycle: TerminalBrokerIpcLifecycle;
    try {
        ipcLifecycle = (
            dependencies.createIpcLifecycle ?? createBunTerminalBrokerIpcLifecycle
        )();
    } catch {
        await broker.shutdown().catch(() => {});
        throw lifecycleError("start-failed");
    }
    const trackedIpc = trackIpcLifecycle(ipcLifecycle);
    let server: TerminalBrokerServer;
    try {
        server = await startTerminalBrokerServer({
            broker,
            expectedUserId,
            lifecycle: trackedIpc.lifecycle,
            projectLocalDirectory: paths.socketDirectory,
            socketPath: paths.socketPath,
            socketPathOperations: operations,
        });
    } catch {
        await closeAfterFailedStart({
            broker,
            expectedUserId,
            operations,
            socketDirectory: paths.socketDirectory,
            socketPath: paths.socketPath,
            trackedIpc,
        });
        throw lifecycleError("start-failed");
    }

    let stopPromise: Promise<void> | undefined;
    const lifecycle: WorkerTerminalBrokerLifecycle = {
        broker,
        socketPath: paths.socketPath,
        stop() {
            stopPromise ??= (async () => {
                trackedIpc.stopAccepting();
                let failed = false;
                try {
                    await server.close();
                } catch {
                    failed = true;
                }
                try {
                    await broker.shutdown();
                } catch {
                    failed = true;
                }
                try {
                    await removeOwnedListeningSocket({
                        expectedUserId,
                        listenerWasAttempted: trackedIpc.listenerWasAttempted(),
                        operations,
                        socketDirectory: paths.socketDirectory,
                        socketPath: paths.socketPath,
                    });
                } catch {
                    failed = true;
                }
                if (failed) throw lifecycleError("stop-failed");
            })();
            return stopPromise;
        },
    };
    return Object.freeze(lifecycle);
}

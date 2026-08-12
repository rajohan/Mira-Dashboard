import path from "node:path";

import {
    developmentFrontendEnvironment,
    developmentProcessEnvironments,
} from "./developmentEnvironment.ts";
import {
    isDevelopmentMigrationIdentityFailure,
    observeDevelopmentMigrationIdentity,
    readDevelopmentMigrationIdentity,
    type ObserveDevelopmentMigrationIdentity,
} from "./developmentMigrationIdentity.ts";
import { guardedDevelopmentChildCommand } from "./developmentProcessGuard.ts";
import type { DevelopmentStackConfig } from "./developmentStackConfig.ts";
import {
    prepareDevelopmentRuntimeState,
    type PreparedDevelopmentState,
    type PreparedDevelopmentStateSession,
} from "./developmentState.ts";

type DevelopmentProcessName = "frontend" | "web" | "worker";

export interface DevelopmentChildProcess {
    readonly exited: Promise<number>;
    readonly exitCode: number | null;
    kill(signal?: number | NodeJS.Signals): void;
}

export interface DevelopmentRuntimeDependencies {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly observeMigrationIdentity?: ObserveDevelopmentMigrationIdentity;
    readonly readMigrationIdentity?: typeof readDevelopmentMigrationIdentity;
    readonly resolveSourceCommit: (repositoryRoot: string) => Promise<string>;
    readonly spawn: (
        command: readonly string[],
        options: {
            readonly cwd: string;
            readonly env: Readonly<Record<string, string>>;
        }
    ) => DevelopmentChildProcess;
}

interface DevelopmentStopController {
    children: DevelopmentChildProcess[];
    forceRequested: boolean;
    readonly requestStop: () => void;
    settling?: Promise<void>;
    stopRequested: boolean;
    readonly stopped: Promise<void>;
}

const defaultDependencies: DevelopmentRuntimeDependencies = Object.freeze({
    observeMigrationIdentity: observeDevelopmentMigrationIdentity,
    readMigrationIdentity: readDevelopmentMigrationIdentity,
    resolveSourceCommit: readSourceCommit,
    spawn(
        command: readonly string[],
        options: {
            readonly cwd: string;
            readonly env: Readonly<Record<string, string>>;
        }
    ) {
        return Bun.spawn([...guardedDevelopmentChildCommand(command)], {
            cwd: options.cwd,
            env: options.env,
            stderr: "inherit",
            stdin: "inherit",
            stdout: "inherit",
        });
    },
});

async function readSourceCommit(repositoryRoot: string): Promise<string> {
    const child = Bun.spawn(["git", "rev-parse", "--verify", "HEAD"], {
        cwd: repositoryRoot,
        env: { LANG: "C", LC_ALL: "C", PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
    ]);
    const commit = stdout.trim();
    if (exitCode !== 0 || !/^[\da-f]{40}$/u.test(commit)) {
        throw new Error(
            `Could not resolve development source commit${
                stderr.trim() === "" ? "" : ": git failed"
            }`
        );
    }
    return commit;
}

function stopChild(child: DevelopmentChildProcess, force: boolean): void {
    if (child.exitCode !== null) return;
    try {
        child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
        // The process may have exited at the same boundary.
    }
}

async function settleChildren(
    children: readonly DevelopmentChildProcess[],
    force: boolean
): Promise<void> {
    for (const child of children) stopChild(child, force);
    if (force) {
        await Promise.allSettled(children.map(({ exited }) => exited));
        return;
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
        deadline = setTimeout(() => resolve("timeout"), 10_000);
        deadline.unref?.();
    });
    const settled = Promise.allSettled(children.map(({ exited }) => exited)).then(
        () => "settled" as const
    );
    const outcome = await Promise.race([settled, timedOut]);
    if (deadline !== undefined) clearTimeout(deadline);
    if (outcome === "timeout") {
        for (const child of children) stopChild(child, true);
        await Promise.allSettled(children.map(({ exited }) => exited));
    }
}

function childExit(
    child: DevelopmentChildProcess,
    processName: DevelopmentProcessName
): Promise<
    Readonly<{
        code: number;
        processName: DevelopmentProcessName;
        status: "child-exited";
    }>
> {
    return child.exited.then((code) =>
        Object.freeze({ code, processName, status: "child-exited" })
    );
}

async function startDevelopmentChildren(
    config: DevelopmentStackConfig,
    state: PreparedDevelopmentState,
    sourceCommit: string,
    dependencies: DevelopmentRuntimeDependencies,
    stopController: DevelopmentStopController
): Promise<
    | readonly [DevelopmentChildProcess, DevelopmentChildProcess, DevelopmentChildProcess]
    | undefined
> {
    const environments = await developmentProcessEnvironments(
        config,
        state.keyring,
        dependencies.environment ?? process.env
    );
    if (stopController.stopRequested) return;
    const bun = process.execPath;
    const watch = config.hotReload ? ["--watch"] : [];
    const web = dependencies.spawn(
        [bun, ...watch, "src/app/developmentWeb.ts", sourceCommit],
        { cwd: config.repositoryRoot, env: environments.web }
    );
    stopController.children.push(web);
    const worker = dependencies.spawn(
        [bun, ...watch, "src/app/developmentWorker.ts", sourceCommit],
        { cwd: config.repositoryRoot, env: environments.worker }
    );
    stopController.children.push(worker);
    const frontend = dependencies.spawn([bun, "scripts/developmentFrontend.ts"], {
        cwd: config.repositoryRoot,
        env: developmentFrontendEnvironment(config),
    });
    stopController.children.push(frontend);
    return [frontend, web, worker];
}

function createStopController(): DevelopmentStopController {
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
    });
    const controller: DevelopmentStopController = {
        children: [],
        forceRequested: false,
        requestStop: () => {
            if (controller.stopRequested) {
                controller.forceRequested = true;
                for (const child of controller.children) stopChild(child, true);
                return;
            }
            controller.stopRequested = true;
            resolveStopped();
            controller.settling = settleChildren(controller.children, false);
        },
        stopRequested: false,
        stopped,
    };
    return controller;
}

async function coordinateDevelopmentChildren(
    config: DevelopmentStackConfig,
    state: PreparedDevelopmentState,
    sourceCommit: string,
    children: readonly [
        DevelopmentChildProcess,
        DevelopmentChildProcess,
        DevelopmentChildProcess,
    ],
    stopController: DevelopmentStopController,
    migrationIdentityChanged?: Promise<string>
): Promise<
    | Readonly<{
          fingerprint: string;
          status: "migration-identity-changed";
      }>
    | Awaited<ReturnType<typeof childExit>>
    | Readonly<{ status: "stopped" }>
> {
    const [frontend, web, worker] = children;
    process.stdout.write(
        `${JSON.stringify({
            backend: config.apiTarget,
            browser: config.publicOrigin,
            database: state.database,
            hotReload: config.hotReload,
            sourceCommit,
            stateRoot: config.stateRoot,
            status: "STARTED",
            worker: "enabled-safe-development",
        })}\n`
    );

    const migrationChange = migrationIdentityChanged?.then((fingerprint) =>
        Object.freeze({
            fingerprint,
            status: "migration-identity-changed" as const,
        })
    );
    const exited = await Promise.race([
        childExit(frontend, "frontend"),
        childExit(web, "web"),
        childExit(worker, "worker"),
        ...(migrationChange === undefined ? [] : [migrationChange]),
    ]);
    stopController.settling ??= settleChildren(children, false);
    await stopController.settling;
    if (stopController.forceRequested) await settleChildren(children, true);
    if (stopController.stopRequested) {
        return Object.freeze({ status: "stopped" });
    }
    return exited;
}

async function runPreparedDevelopmentStack(
    config: DevelopmentStackConfig,
    state: PreparedDevelopmentState,
    sourceCommit: string,
    dependencies: DevelopmentRuntimeDependencies,
    stopController: DevelopmentStopController,
    migrationIdentityChanged?: Promise<string>
): Promise<Awaited<ReturnType<typeof coordinateDevelopmentChildren>>> {
    const children = await startDevelopmentChildren(
        config,
        state,
        sourceCommit,
        dependencies,
        stopController
    );
    if (children === undefined) {
        return Object.freeze({ status: "stopped" });
    }
    return coordinateDevelopmentChildren(
        config,
        state,
        sourceCommit,
        children,
        stopController,
        migrationIdentityChanged
    );
}

async function waitForReadableMigrationIdentity(
    repositoryRoot: string,
    dependencies: DevelopmentRuntimeDependencies,
    stopController: DevelopmentStopController
): Promise<string | undefined> {
    const readIdentity =
        dependencies.readMigrationIdentity ?? readDevelopmentMigrationIdentity;
    while (!stopController.stopRequested) {
        try {
            return await readIdentity(repositoryRoot);
        } catch {
            const outcome = await Promise.race([
                Bun.sleep(100).then(() => "retry" as const),
                stopController.stopped.then(() => "stopped" as const),
            ]);
            if (outcome === "stopped") return;
        }
    }
    return;
}

async function refreshDevelopmentState(
    config: DevelopmentStackConfig,
    stateSession: PreparedDevelopmentStateSession,
    dependencies: DevelopmentRuntimeDependencies,
    stopController: DevelopmentStopController
): Promise<PreparedDevelopmentState | undefined> {
    while (!stopController.stopRequested) {
        try {
            const previousFingerprint = stateSession.migrationFingerprint;
            const state = await stateSession.refresh();
            if (
                state.database === "reused" &&
                stateSession.migrationFingerprint !== previousFingerprint
            ) {
                throw new Error(
                    "Development migration identity changed without safe SQLite state"
                );
            }
            const currentFingerprint = await waitForReadableMigrationIdentity(
                config.repositoryRoot,
                dependencies,
                stopController
            );
            if (currentFingerprint === undefined) return;
            if (currentFingerprint !== stateSession.migrationFingerprint) continue;
            return state;
        } catch (error) {
            if (!isDevelopmentMigrationIdentityFailure(error)) throw error;
            const currentFingerprint = await waitForReadableMigrationIdentity(
                config.repositoryRoot,
                dependencies,
                stopController
            );
            if (currentFingerprint === undefined) return;
        }
    }
    return;
}

async function runPreparedDevelopmentLifecycle(
    config: DevelopmentStackConfig,
    stateSession: PreparedDevelopmentStateSession,
    sourceCommit: string,
    dependencies: DevelopmentRuntimeDependencies,
    stopController: DevelopmentStopController
): Promise<number> {
    let state = stateSession.state;
    while (!stopController.stopRequested) {
        const observation = (
            dependencies.observeMigrationIdentity ?? observeDevelopmentMigrationIdentity
        )(config.repositoryRoot, stateSession.migrationFingerprint);
        const initialIdentityChange = await Promise.race([
            observation.ready,
            stopController.stopped.then(() => "stopped" as const),
        ]);
        if (initialIdentityChange === "stopped") {
            observation.close();
            return 0;
        }
        if (initialIdentityChange !== undefined) {
            observation.close();
            const refreshed = await refreshDevelopmentState(
                config,
                stateSession,
                dependencies,
                stopController
            );
            if (refreshed === undefined) return 0;
            state = refreshed;
            continue;
        }

        let outcome: Awaited<ReturnType<typeof runPreparedDevelopmentStack>>;
        try {
            outcome = await runPreparedDevelopmentStack(
                config,
                state,
                sourceCommit,
                dependencies,
                stopController,
                observation.changed
            );
        } finally {
            observation.close();
        }
        if (outcome.status === "stopped") return 0;

        stopController.children = [];
        stopController.settling = undefined;
        if (outcome.status === "child-exited") {
            const currentFingerprint = await waitForReadableMigrationIdentity(
                config.repositoryRoot,
                dependencies,
                stopController
            );
            if (currentFingerprint === undefined) return 0;
            if (currentFingerprint === stateSession.migrationFingerprint) {
                const reportedExitCode = outcome.code || 1;
                process.stderr.write(
                    `Development ${outcome.processName} process exited with code ${reportedExitCode}\n`
                );
                return reportedExitCode;
            }
        }
        const refreshed = await refreshDevelopmentState(
            config,
            stateSession,
            dependencies,
            stopController
        );
        if (refreshed === undefined) return 0;
        state = refreshed;
    }
    return 0;
}

async function settleRemainingChildren(
    stopController: DevelopmentStopController
): Promise<void> {
    if (stopController.children.some(({ exitCode }) => exitCode === null)) {
        stopController.settling ??= settleChildren(
            stopController.children,
            stopController.forceRequested
        );
        await stopController.settling;
    }
}

/**
 * Starts the stack with a caller-owned prepared state lease.
 * @param config Validated development stack configuration.
 * @param stateSession Prepared state whose lease remains owned by the caller.
 * @param dependencies Process adapter used to spawn child runtimes.
 * @returns The coordinated stack process exit code.
 */
export async function runDevelopmentStackWithPreparedState(
    config: DevelopmentStackConfig,
    stateSession: PreparedDevelopmentStateSession,
    dependencies: DevelopmentRuntimeDependencies = defaultDependencies
): Promise<number> {
    const stopController = createStopController();
    process.on("SIGINT", stopController.requestStop);
    process.on("SIGTERM", stopController.requestStop);
    try {
        const sourceCommit = await dependencies.resolveSourceCommit(
            config.repositoryRoot
        );
        if (stopController.stopRequested) return 0;
        return await runPreparedDevelopmentLifecycle(
            config,
            stateSession,
            sourceCommit,
            dependencies,
            stopController
        );
    } finally {
        await settleRemainingChildren(stopController);
        process.removeListener("SIGINT", stopController.requestStop);
        process.removeListener("SIGTERM", stopController.requestStop);
    }
}

/**
 * Starts browser HMR plus watched web and worker children with one coupled lifecycle.
 * @param config Validated development stack configuration.
 * @param dependencies Process adapter used to spawn child runtimes.
 * @returns The coordinated stack process exit code.
 */
export async function runDevelopmentStack(
    config: DevelopmentStackConfig,
    dependencies: DevelopmentRuntimeDependencies = defaultDependencies
): Promise<number> {
    const stopController = createStopController();
    process.on("SIGINT", stopController.requestStop);
    process.on("SIGTERM", stopController.requestStop);
    let stateSession:
        | Awaited<ReturnType<typeof prepareDevelopmentRuntimeState>>
        | undefined;
    try {
        const sourceCommit = await dependencies.resolveSourceCommit(
            config.repositoryRoot
        );
        if (stopController.stopRequested) return 0;
        stateSession = await prepareDevelopmentRuntimeState(config);
        return await runPreparedDevelopmentLifecycle(
            config,
            stateSession,
            sourceCommit,
            dependencies,
            stopController
        );
    } finally {
        await settleRemainingChildren(stopController);
        process.removeListener("SIGINT", stopController.requestStop);
        process.removeListener("SIGTERM", stopController.requestStop);
        await stateSession?.release();
    }
}

/**
 * Derives the stable remote HTTPS state root, separate from localhost auth.
 * @param localStateRoot Configured localhost development state root.
 * @returns A sibling state root reserved for remote HTTPS development.
 */
export function remoteDevelopmentStateRoot(localStateRoot: string): string {
    return path.join(path.dirname(localStateRoot), "source-remote");
}

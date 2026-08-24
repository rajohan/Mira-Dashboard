import path from "node:path";

import {
    developmentFrontendEnvironment,
    developmentProcessEnvironments,
} from "./developmentEnvironment.ts";
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
    readonly children: DevelopmentChildProcess[];
    forceRequested: boolean;
    readonly requestStop: () => void;
    settling?: Promise<void>;
    stopRequested: boolean;
}

const defaultDependencies: DevelopmentRuntimeDependencies = Object.freeze({
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
): Promise<Readonly<{ code: number; processName: DevelopmentProcessName }>> {
    return child.exited.then((code) => Object.freeze({ code, processName }));
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
    const environments = await developmentProcessEnvironments(config, state.keyring);
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
            controller.settling = settleChildren(controller.children, false);
        },
        stopRequested: false,
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
    stopController: DevelopmentStopController
): Promise<number> {
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

    const exited = await Promise.race([
        childExit(frontend, "frontend"),
        childExit(web, "web"),
        childExit(worker, "worker"),
    ]);
    stopController.settling ??= settleChildren(children, false);
    await stopController.settling;
    if (stopController.forceRequested) await settleChildren(children, true);
    if (stopController.stopRequested) return 0;
    const reportedExitCode = exited.code || 1;
    process.stderr.write(
        `Development ${exited.processName} process exited with code ${reportedExitCode}\n`
    );
    return reportedExitCode;
}

async function runPreparedDevelopmentStack(
    config: DevelopmentStackConfig,
    state: PreparedDevelopmentState,
    sourceCommit: string,
    dependencies: DevelopmentRuntimeDependencies,
    stopController: DevelopmentStopController
): Promise<number> {
    const children = await startDevelopmentChildren(
        config,
        state,
        sourceCommit,
        dependencies,
        stopController
    );
    if (children === undefined) return 0;
    return coordinateDevelopmentChildren(
        config,
        state,
        sourceCommit,
        children,
        stopController
    );
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
        return await runPreparedDevelopmentStack(
            config,
            stateSession.state,
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
        return await runPreparedDevelopmentStack(
            config,
            stateSession.state,
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

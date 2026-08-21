import { userInfo } from "node:os";
import path from "node:path";

import type { OpenClawGatewayLifecycleExecutionPort } from "../../shared/openClawGatewayLifecycle.ts";

const defaultRestartTimeoutMs = 30_000;

export interface OpenClawGatewayRestartProcess {
    readonly run: (
        argv: readonly [string, "gateway", "restart"],
        environment: Readonly<Record<string, string>>,
        signal: AbortSignal
    ) => Promise<number>;
}

export interface FixedOpenClawGatewayLifecycleOptions {
    readonly openClawRoot: string;
    readonly process?: OpenClawGatewayRestartProcess;
    readonly timeoutMs?: number;
}

function requiredOpenClawRoot(value: string): string {
    if (
        process.platform !== "linux" ||
        !path.isAbsolute(value) ||
        value === path.parse(value).root ||
        path.resolve(value) !== value
    ) {
        throw new TypeError("OpenClaw Gateway lifecycle root is invalid");
    }
    return value;
}

function requiredTimeout(value: number | undefined): number {
    const timeoutMs = value ?? defaultRestartTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) {
        throw new RangeError("OpenClaw Gateway restart timeout is invalid");
    }
    return timeoutMs;
}

function runtimeIdentity(): Readonly<{ homeDirectory: string; userId: number }> {
    if (typeof process.getuid !== "function") {
        throw new TypeError("OpenClaw Gateway lifecycle requires a POSIX runtime");
    }
    const identity = userInfo();
    if (
        identity.uid !== process.getuid() ||
        !path.isAbsolute(identity.homedir) ||
        identity.homedir === path.parse(identity.homedir).root ||
        path.resolve(identity.homedir) !== identity.homedir ||
        identity.homedir.includes("\0")
    ) {
        throw new TypeError("OpenClaw Gateway lifecycle home is invalid");
    }
    return Object.freeze({
        homeDirectory: identity.homedir,
        userId: identity.uid,
    });
}

function fixedEnvironment(
    homeDirectory: string,
    openClawRoot: string,
    userId: number
): Readonly<Record<string, string>> {
    const runtimeDirectory = `/run/user/${userId}`;
    return Object.freeze({
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
        HOME: homeDirectory,
        LANG: "C",
        LC_ALL: "C",
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_STATE_DIR: openClawRoot,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        XDG_RUNTIME_DIR: runtimeDirectory,
    });
}

const defaultProcess: OpenClawGatewayRestartProcess = Object.freeze({
    async run(
        argv: readonly [string, "gateway", "restart"],
        environment: Readonly<Record<string, string>>,
        signal: AbortSignal
    ): Promise<number> {
        const child = Bun.spawn([...argv], {
            env: { ...environment },
            killSignal: "SIGKILL",
            signal,
            stderr: "ignore",
            stdin: "ignore",
            stdout: "ignore",
        });
        return child.exited;
    },
});

/**
 * Creates the worker-only fixed-argv OpenClaw Gateway restart adapter.
 * No caller-controlled arguments, output, shell, or ambient secret environment are accepted.
 * @returns A fixed Gateway lifecycle adapter.
 */
export function createFixedOpenClawGatewayLifecycle(
    options: FixedOpenClawGatewayLifecycleOptions
): OpenClawGatewayLifecycleExecutionPort {
    const openClawRoot = requiredOpenClawRoot(options.openClawRoot);
    const { homeDirectory, userId } = runtimeIdentity();
    const executable = path.join(homeDirectory, ".local", "bin", "openclaw");
    const argv: readonly [string, "gateway", "restart"] = Object.freeze([
        executable,
        "gateway",
        "restart",
    ]);
    const environment = fixedEnvironment(homeDirectory, openClawRoot, userId);
    const restartProcess = options.process ?? defaultProcess;
    const timeoutMs = requiredTimeout(options.timeoutMs);

    return Object.freeze({
        async restart(signal?: AbortSignal): Promise<void> {
            const deadline = AbortSignal.timeout(timeoutMs);
            const operationSignal =
                signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
            let exitCode: number;
            try {
                exitCode = await restartProcess.run(argv, environment, operationSignal);
            } catch (error) {
                throw new Error("OpenClaw Gateway restart process failed", {
                    cause: error,
                });
            }
            if (exitCode !== 0) {
                throw new Error("OpenClaw Gateway restart process failed");
            }
        },
    });
}

import path from "node:path";

import { sseMemoryEvidencePolicy } from "./resourcePolicy.ts";
import { assertSseMemoryUnitName } from "./unitIdentity.ts";

const launcherEnvironmentNames = [
    "DBUS_SESSION_BUS_ADDRESS",
    "HOME",
    "LANG",
    "PATH",
    "XDG_RUNTIME_DIR",
] as const;

/** Fixed uncapped-parent process limits used around the capped child. */
export const systemdLauncherProcessPolicy = Object.freeze({
    launcherOutputMaxBytes: 64 * 1024,
    systemctlOutputMaxBytes: 16 * 1024,
    systemctlTimeoutMs: 2000,
});

/** Absolute executables and paths used by one transient evidence unit. */
export interface SystemdLauncherOptions {
    bunExecutable: string;
    childEntrypoint: string;
    environment: Readonly<Record<string, string | undefined>>;
    envExecutable: string;
    repositoryRoot: string;
    resultPath: string;
    systemctlExecutable: string;
    systemdRunExecutable: string;
    unitName: string;
}

/** Fully resolved command with the only host environment values it may inherit. */
export interface SystemdLauncherCommand {
    argv: readonly string[];
    environment: Readonly<Record<string, string>>;
    systemctlExecutable: string;
    unitName: string;
}

/** Result returned after the transient unit exits. */
export interface SystemdLauncherResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}

/** Complete bounded subprocess specification. */
export interface SystemdSubprocessSpecification {
    argv: readonly string[];
    options: Readonly<{
        env: Readonly<Record<string, string>>;
        killSignal: "SIGKILL";
        maxBuffer: number;
        stderr: "pipe";
        stdout: "pipe";
        timeout: number;
    }>;
}

function assertAbsolutePath(label: string, value: string): void {
    if (!path.isAbsolute(value) || value.includes("\0")) {
        throw new TypeError(`${label} must be an absolute path`);
    }
}

function childEnvironment(options: SystemdLauncherOptions): readonly string[] {
    const home = options.environment.HOME;
    if (!home) {
        throw new Error("HOME is required to launch the SSE memory evidence");
    }
    return [
        "-i",
        `HOME=${home}`,
        "LANG=C.UTF-8",
        "NODE_ENV=test",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "TMPDIR=/tmp",
        options.bunExecutable,
        options.childEntrypoint,
        "--child",
        `--result=${options.resultPath}`,
        `--unit=${options.unitName}`,
    ];
}

/**
 * Builds the argv-only systemd launcher and its sanitised host environment.
 * @param options Resolved executables, paths, and unit identity.
 * @returns Immutable launcher command.
 */
export function buildSystemdLauncherCommand(
    options: SystemdLauncherOptions
): SystemdLauncherCommand {
    assertAbsolutePath("Bun executable", options.bunExecutable);
    assertAbsolutePath("Child entrypoint", options.childEntrypoint);
    assertAbsolutePath("env executable", options.envExecutable);
    assertAbsolutePath("Repository root", options.repositoryRoot);
    assertAbsolutePath("Result path", options.resultPath);
    assertAbsolutePath("systemctl executable", options.systemctlExecutable);
    assertAbsolutePath("systemd-run executable", options.systemdRunExecutable);
    assertSseMemoryUnitName(options.unitName);

    const environment = Object.fromEntries(
        launcherEnvironmentNames.flatMap((name) => {
            const value = options.environment[name];
            return value === undefined ? [] : [[name, value]];
        })
    );
    const cgroup = sseMemoryEvidencePolicy.cgroup;
    const argv = [
        options.systemdRunExecutable,
        "--user",
        "--wait",
        "--pipe",
        "--quiet",
        `--unit=${options.unitName}`,
        "--slice=app.slice",
        "--expand-environment=no",
        "--nice=10",
        `--working-directory=${options.repositoryRoot}`,
        "--property=MemoryAccounting=yes",
        "--property=CPUAccounting=yes",
        "--property=TasksAccounting=yes",
        `--property=MemoryHigh=${cgroup.memoryHighBytes}`,
        `--property=MemoryMax=${cgroup.memoryMaxBytes}`,
        `--property=MemorySwapMax=${cgroup.memorySwapMaxBytes}`,
        `--property=TasksMax=${cgroup.tasksMax}`,
        `--property=CPUQuota=${cgroup.cpuQuotaPercent}%`,
        `--property=RuntimeMaxSec=${cgroup.runtimeMaxSeconds}s`,
        `--property=OOMPolicy=${cgroup.oomPolicy}`,
        "--property=KillMode=control-group",
        "--property=TimeoutStopSec=5s",
        options.envExecutable,
        ...childEnvironment(options),
    ];

    return Object.freeze({
        argv: Object.freeze(argv),
        environment: Object.freeze(environment),
        systemctlExecutable: options.systemctlExecutable,
        unitName: options.unitName,
    });
}

/**
 * Builds the bounded subprocess specification for one `systemctl` operation.
 * @param command Sanitised launcher command and systemctl identity.
 * @param arguments_ Exact systemctl operation arguments.
 * @returns Immutable argv and process limits used by `Bun.spawn`.
 */
export function buildSystemctlSubprocessSpecification(
    command: SystemdLauncherCommand,
    arguments_: readonly string[]
): SystemdSubprocessSpecification {
    return Object.freeze({
        argv: Object.freeze([
            command.systemctlExecutable,
            "--user",
            "--no-ask-password",
            "--no-pager",
            ...arguments_,
        ]),
        options: Object.freeze({
            env: command.environment,
            killSignal: "SIGKILL" as const,
            maxBuffer: systemdLauncherProcessPolicy.systemctlOutputMaxBytes,
            stderr: "pipe" as const,
            stdout: "pipe" as const,
            timeout: systemdLauncherProcessPolicy.systemctlTimeoutMs,
        }),
    });
}

/**
 * Builds the bounded subprocess specification for the outer `systemd-run` launcher.
 * @param command Sanitised launcher command.
 * @returns Immutable argv and process limits used by `Bun.spawn`.
 */
export function buildSystemdRunSubprocessSpecification(
    command: SystemdLauncherCommand
): SystemdSubprocessSpecification {
    return Object.freeze({
        argv: command.argv,
        options: Object.freeze({
            env: command.environment,
            killSignal: "SIGKILL" as const,
            maxBuffer: systemdLauncherProcessPolicy.launcherOutputMaxBytes,
            stderr: "pipe" as const,
            stdout: "pipe" as const,
            timeout: sseMemoryEvidencePolicy.cgroup.outerDeadlineMs,
        }),
    });
}

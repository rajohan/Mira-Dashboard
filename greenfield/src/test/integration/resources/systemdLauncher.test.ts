import { describe, expect, test } from "bun:test";

import { sseMemoryEvidencePolicy } from "./resourcePolicy.ts";
import {
    buildSystemdLauncherCommand,
    buildSystemdRunSubprocessSpecification,
    buildSystemctlSubprocessSpecification,
    classifySystemdLauncherTermination,
    createSystemdLauncherDeadline,
    createSseMemoryUnitName,
    ensureTransientUnitStopped,
    formatSystemdLauncherFailure,
    parseSystemdUnitState,
    systemdLauncherProcessPolicy,
    type SystemdLauncherOptions,
} from "./systemdLauncher.ts";

const unitIdentifier = "019fcb3d-6cf6-7000-8000-000000000001";

function launcherOptions(): SystemdLauncherOptions {
    return {
        bunExecutable: "/opt/mira/bin/bun",
        childEntrypoint: "/opt/mira/src/test/integration/run.ts",
        envExecutable: "/usr/bin/env",
        environment: {
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
            DOPPLER_TOKEN: "must-not-leak",
            HOME: "/home/ubuntu",
            LANG: "nb_NO.UTF-8",
            MIRA_GITHUB_TOKEN: "must-not-leak",
            PATH: "/untrusted/path",
            XDG_RUNTIME_DIR: "/run/user/1001",
        },
        repositoryRoot: "/opt/mira/checkout",
        resultPath: "/tmp/mira-result/result.json",
        systemctlExecutable: "/usr/bin/systemctl",
        systemdRunExecutable: "/usr/bin/systemd-run",
        unitName: createSseMemoryUnitName(unitIdentifier),
    };
}

describe("SSE memory systemd launcher", () => {
    test("builds an argv-only capped service with sanitized environments", () => {
        const command = buildSystemdLauncherCommand(launcherOptions());
        const policy = sseMemoryEvidencePolicy.cgroup;

        expect(command.environment).toEqual({
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
            HOME: "/home/ubuntu",
            LANG: "nb_NO.UTF-8",
            PATH: "/untrusted/path",
            XDG_RUNTIME_DIR: "/run/user/1001",
        });
        expect(command.argv).toContain(`--property=MemoryHigh=${policy.memoryHighBytes}`);
        expect(command.argv).toContain(`--property=MemoryMax=${policy.memoryMaxBytes}`);
        expect(command.argv).toContain("--property=MemorySwapMax=0");
        expect(command.argv).toContain("--property=TasksMax=32");
        expect(command.argv).toContain("--property=CPUQuota=50%");
        expect(command.argv).toContain("--property=RuntimeMaxSec=30s");
        expect(command.argv).toContain("--property=OOMPolicy=kill");
        expect(command.argv).toContain("--property=KillMode=control-group");
        expect(command.argv).toContain("--property=TimeoutStopSec=5s");
        expect(command.argv).toContain("--property=MemoryAccounting=yes");
        expect(command.argv).toContain("--property=CPUAccounting=yes");
        expect(command.argv).toContain("--property=TasksAccounting=yes");
        expect(command.argv).toContain("--slice=app.slice");
        expect(command.argv).not.toContain("--collect");

        const envIndex = command.argv.indexOf("/usr/bin/env");
        expect(envIndex).toBeGreaterThan(0);
        expect(command.argv.slice(envIndex)).toEqual([
            "/usr/bin/env",
            "-i",
            "HOME=/home/ubuntu",
            "LANG=C.UTF-8",
            "NODE_ENV=test",
            "PATH=/usr/local/bin:/usr/bin:/bin",
            "TMPDIR=/tmp",
            "/opt/mira/bin/bun",
            "/opt/mira/src/test/integration/run.ts",
            "--child",
            "--result=/tmp/mira-result/result.json",
            `--unit=${launcherOptions().unitName}`,
        ]);
        expect(JSON.stringify(command)).not.toContain("must-not-leak");
        expect(systemdLauncherProcessPolicy).toEqual({
            launcherOutputMaxBytes: 65_536,
            systemctlOutputMaxBytes: 16_384,
            systemctlTimeoutMs: 2000,
        });

        const launcherProcess = buildSystemdRunSubprocessSpecification(command);
        expect(launcherProcess.argv).toEqual(command.argv);
        expect(launcherProcess.options).toEqual({
            env: command.environment,
            killSignal: "SIGKILL",
            maxBuffer: 65_536,
            stderr: "pipe",
            stdout: "pipe",
            timeout: policy.outerDeadlineMs,
        });

        const systemctlProcess = buildSystemctlSubprocessSpecification(command, [
            "show",
            `${command.unitName}.service`,
        ]);
        expect(systemctlProcess).toEqual({
            argv: [
                "/usr/bin/systemctl",
                "--user",
                "--no-ask-password",
                "--no-pager",
                "show",
                `${command.unitName}.service`,
            ],
            options: {
                env: command.environment,
                killSignal: "SIGKILL",
                maxBuffer: 16_384,
                stderr: "pipe",
                stdout: "pipe",
                timeout: 2000,
            },
        });
    });

    test("rejects ambiguous unit identities and relative executable paths", () => {
        expect(() => createSseMemoryUnitName("not-a-uuid")).toThrow(
            "unit identifier is invalid"
        );
        expect(() =>
            buildSystemdLauncherCommand({
                ...launcherOptions(),
                bunExecutable: "bun",
            })
        ).toThrow("Bun executable must be an absolute path");
    });

    test("owns deadline firing, abort, and idempotent cancellation", () => {
        const handle = Object.freeze({ kind: "manual-deadline" });
        let scheduledCallback: (() => void) | undefined;
        let scheduledDelayMs: number | undefined;
        const cancelledHandles: unknown[] = [];
        const deadline = createSystemdLauncherDeadline(35_000, {
            cancel(receivedHandle) {
                cancelledHandles.push(receivedHandle);
            },
            schedule(callback, delayMs) {
                scheduledCallback = callback;
                scheduledDelayMs = delayMs;
                return handle;
            },
        });

        expect(scheduledDelayMs).toBe(35_000);
        expect(deadline.didFire()).toBeFalse();
        expect(deadline.signal.aborted).toBeFalse();
        if (scheduledCallback === undefined) {
            throw new Error("Expected the manual deadline callback to be scheduled");
        }
        scheduledCallback();
        expect(deadline.didFire()).toBeTrue();
        expect(deadline.signal.aborted).toBeTrue();
        deadline.cancel();
        deadline.cancel();
        expect(cancelledHandles).toEqual([handle]);
    });

    test("rejects invalid launcher deadlines before scheduling", () => {
        for (const delayMs of [0, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
            expect(() => createSystemdLauncherDeadline(delayMs)).toThrow(
                "Systemd launcher deadline must be a positive integer"
            );
        }
    });

    test("classifies only the owned deadline signal as a deadline", () => {
        expect(classifySystemdLauncherTermination(null, true, "SIGKILL")).toBeUndefined();
        expect(classifySystemdLauncherTermination("SIGKILL", true, "SIGKILL")).toEqual({
            kind: "deadline",
            signalCode: "SIGKILL",
        });
        expect(classifySystemdLauncherTermination("SIGKILL", false, "SIGKILL")).toEqual({
            kind: "signal",
            signalCode: "SIGKILL",
        });
        expect(classifySystemdLauncherTermination("SIGTERM", false, "SIGKILL")).toEqual({
            kind: "signal",
            signalCode: "SIGTERM",
        });
        expect(classifySystemdLauncherTermination("SIGTERM", true, "SIGKILL")).toEqual({
            kind: "signal",
            signalCode: "SIGTERM",
        });
    });

    test("preserves bounded launcher and post-mortem diagnostics", () => {
        expect(
            formatSystemdLauncherFailure(
                "launcher was terminated",
                "phase=load\n",
                "child warning\n",
                "Result=signal\nMemoryPeak=1048576\n"
            )
        ).toBe(
            [
                "launcher was terminated",
                "launcher stdout:\nphase=load",
                "launcher stderr:\nchild warning",
                "systemd post-mortem:\nResult=signal\nMemoryPeak=1048576",
            ].join("\n")
        );
    });

    test("requires HOME only for the child while keeping secrets out", () => {
        expect(() =>
            buildSystemdLauncherCommand({
                ...launcherOptions(),
                environment: { XDG_RUNTIME_DIR: "/run/user/1001" },
            })
        ).toThrow("HOME is required");
    });

    test("parses only complete systemd unit state output", () => {
        expect(parseSystemdUnitState("LoadState=loaded\nActiveState=inactive\n")).toEqual(
            {
                activeState: "inactive",
                loadState: "loaded",
            }
        );
        expect(() => parseSystemdUnitState("ActiveState=active\n")).toThrow("Incomplete");
        expect(() =>
            parseSystemdUnitState(
                "LoadState=loaded\nActiveState=active\nActiveState=failed\n"
            )
        ).toThrow("Duplicate");
        expect(() =>
            parseSystemdUnitState(
                "LoadState=loaded\nActiveState=active\nUnexpected=value\n"
            )
        ).toThrow("Incomplete");
    });

    test("accepts verified graceful shutdown and escalates an active unit", async () => {
        const command = buildSystemdLauncherCommand(launcherOptions());
        const gracefulCalls: string[][] = [];
        const gracefulResults = [
            { exitCode: 0, stderr: "", stdout: "" },
            {
                exitCode: 0,
                stderr: "",
                stdout: "LoadState=loaded\nActiveState=inactive\n",
            },
        ];
        await ensureTransientUnitStopped(command, (_command, arguments_) => {
            gracefulCalls.push([...arguments_]);
            return Promise.resolve(
                gracefulResults.shift() ?? { exitCode: 1, stderr: "missing", stdout: "" }
            );
        });
        expect(gracefulCalls.map((arguments_) => arguments_[0])).toEqual([
            "stop",
            "show",
        ]);

        const forcedCalls: string[][] = [];
        const forcedResults = [
            { exitCode: 1, stderr: "stop failed", stdout: "" },
            {
                exitCode: 0,
                stderr: "",
                stdout: "LoadState=loaded\nActiveState=active\n",
            },
            { exitCode: 0, stderr: "", stdout: "" },
            { exitCode: 0, stderr: "", stdout: "" },
            {
                exitCode: 0,
                stderr: "",
                stdout: "LoadState=loaded\nActiveState=failed\n",
            },
        ];
        await ensureTransientUnitStopped(command, (_command, arguments_) => {
            forcedCalls.push([...arguments_]);
            return Promise.resolve(
                forcedResults.shift() ?? { exitCode: 1, stderr: "missing", stdout: "" }
            );
        });
        const unit = `${command.unitName}.service`;
        expect(forcedCalls).toEqual([
            ["stop", unit],
            ["show", unit, "--property=LoadState", "--property=ActiveState"],
            ["kill", "--kill-whom=all", "--signal=SIGKILL", unit],
            ["stop", unit],
            ["show", unit, "--property=LoadState", "--property=ActiveState"],
        ]);
    });

    test("rejects an unverified transient-unit shutdown", async () => {
        const command = buildSystemdLauncherCommand(launcherOptions());
        const results = [
            { exitCode: 1, stderr: "stop failed", stdout: "" },
            {
                exitCode: 0,
                stderr: "",
                stdout: "LoadState=loaded\nActiveState=active\n",
            },
            { exitCode: 1, stderr: "kill failed", stdout: "" },
            { exitCode: 1, stderr: "stop failed", stdout: "" },
            {
                exitCode: 0,
                stderr: "",
                stdout: "LoadState=loaded\nActiveState=deactivating\n",
            },
        ];
        let failure: unknown;
        try {
            await ensureTransientUnitStopped(command, () =>
                Promise.resolve(
                    results.shift() ?? {
                        exitCode: 1,
                        stderr: "missing",
                        stdout: "",
                    }
                )
            );
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("Transient unit did not stop");
    });
});

import { describe, expect, test } from "bun:test";

import {
    fixedHostOperationUnits,
    type HostOperationId,
} from "../../shared/hostOperations.ts";
import type { FixedHostOperationProcess } from "./fixedHostOperationsBroker.ts";
import { createFixedHostOperationsBroker } from "./fixedHostOperationsBroker.ts";

const encoder = new TextEncoder();

describe("fixed host operations broker", () => {
    test("projects exact loaded units and dispatches fixed argv without a shell", async () => {
        const calls: Array<{
            readonly arguments_: readonly string[];
            readonly executable: string;
        }> = [];
        const process: FixedHostOperationProcess = (executable, arguments_) => {
            calls.push({ arguments_, executable });
            return Promise.resolve({
                exitCode: 0,
                stderr: new Uint8Array(),
                stdout:
                    arguments_[0] === "show"
                        ? encoder.encode("loaded\n")
                        : new Uint8Array(),
            });
        };
        const broker = createFixedHostOperationsBroker({ process });

        expect(await broker.availableOperations()).toEqual([
            "system-cleanup",
            "system-restart",
            "system-update",
        ]);
        expect(await broker.request("system-restart")).toEqual({
            status: "accepted",
        });
        expect(await broker.request("system-update")).toEqual({
            status: "completed",
        });
        expect(await broker.request("system-cleanup")).toEqual({
            status: "completed",
        });
        expect(calls).toEqual([
            {
                arguments_: [
                    "show",
                    "--property=LoadState",
                    "--value",
                    fixedHostOperationUnits["system-cleanup"],
                ],
                executable: "/usr/bin/systemctl",
            },
            {
                arguments_: [
                    "show",
                    "--property=LoadState",
                    "--value",
                    fixedHostOperationUnits["system-restart"],
                ],
                executable: "/usr/bin/systemctl",
            },
            {
                arguments_: [
                    "show",
                    "--property=LoadState",
                    "--value",
                    fixedHostOperationUnits["system-update"],
                ],
                executable: "/usr/bin/systemctl",
            },
            {
                arguments_: [
                    "start",
                    "--no-block",
                    "mira-dashboard-host-system-restart.service",
                ],
                executable: "/usr/bin/systemctl",
            },
            {
                arguments_: [
                    "start",
                    "--wait",
                    "mira-dashboard-host-system-update.service",
                ],
                executable: "/usr/bin/systemctl",
            },
            {
                arguments_: [
                    "start",
                    "--wait",
                    "mira-dashboard-host-system-cleanup.service",
                ],
                executable: "/usr/bin/systemctl",
            },
        ]);
    });

    test("omits unavailable units and never exposes host diagnostics", async () => {
        const broker = createFixedHostOperationsBroker({
            process: (_executable, arguments_) =>
                Promise.resolve({
                    exitCode:
                        arguments_[0] === "start" ||
                        arguments_.at(-1)?.includes("restart")
                            ? 1
                            : 0,
                    stderr: encoder.encode("private /etc/apt failure"),
                    stdout: encoder.encode("loaded\n"),
                }),
        });

        expect(await broker.availableOperations()).toEqual([
            "system-cleanup",
            "system-update",
        ]);
        try {
            await broker.request("system-update");
            throw new Error("Expected broker failure");
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe("Fixed host operations broker failed");
            expect(JSON.stringify(error)).not.toContain("/etc/apt");
        }
    });

    test("rejects unsafe operation IDs, executables, deadlines, and oversized output", () => {
        let invocations = 0;
        const process: FixedHostOperationProcess = () => {
            invocations += 1;
            return Promise.resolve({
                exitCode: 0,
                stderr: new Uint8Array(),
                stdout: new Uint8Array(64 * 1024 + 1),
            });
        };
        const broker = createFixedHostOperationsBroker({ process });
        expect(broker.request("../../evil.service" as HostOperationId)).rejects.toThrow(
            "Fixed host operations broker failed"
        );
        expect(invocations).toBe(0);
        expect(broker.request("system-update")).rejects.toThrow(
            "Fixed host operations broker failed"
        );
        expect(() =>
            createFixedHostOperationsBroker({ systemctlExecutable: "systemctl" })
        ).toThrow("Fixed host operations broker failed");
        expect(() =>
            createFixedHostOperationsBroker({ availabilityDeadlineMs: 0 })
        ).toThrow("Fixed host operations broker failed");
        expect(() =>
            createFixedHostOperationsBroker({ cleanupDeadlineMs: 35 * 60_000 + 1 })
        ).toThrow("Fixed host operations broker failed");
    });

    test("bounds execution with a deadline and preserves caller abort", () => {
        const observedSignals: AbortSignal[] = [];
        const process: FixedHostOperationProcess = (_executable, _arguments, signal) =>
            new Promise((_resolve, reject) => {
                observedSignals.push(signal);
                signal.addEventListener("abort", () => reject(new Error("Aborted")), {
                    once: true,
                });
            });
        const broker = createFixedHostOperationsBroker({
            process,
            restartDeadlineMs: 1,
        });
        expect(broker.request("system-restart")).rejects.toThrow(
            "Fixed host operations broker failed"
        );
        expect(observedSignals[0]?.aborted).toBe(true);

        const caller = new AbortController();
        const waiting = createFixedHostOperationsBroker({ process }).request(
            "system-update",
            caller.signal
        );
        caller.abort();
        expect(waiting).rejects.toThrow("Fixed host operations broker failed");
        expect(observedSignals[1]?.aborted).toBe(true);
    });
});
